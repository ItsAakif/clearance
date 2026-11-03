// Catalogue snapshot import surface.
//
//   POST /catalogue/import  (auth + admin)  - upload or download-and-import a
//                                             `catalogue.jsonl.gz` + manifest.
//   POST /catalogue/sync    (auth + admin)  - download the configured daily
//                                             feed and import it in one click.
//   GET  /catalogue/status  (auth)          - catalogue total + last import.
//
// The import is a local catalogue UPDATE, not a DB restore: it goes through
// `upsertDiscoveredJobs` (see `search/importSnapshot.ts`), so canonical keys
// and search documents are recomputed and closed rows that reappear are
// reactivated. The manifest sha256 is verified before a single line is parsed.
//
// Accepted request shapes:
//   * multipart/form-data: `file` (.jsonl.gz) + `manifest` (manifest JSON text)
//   * application/octet-stream: raw gzip body + `x-snapshot-manifest` header
//   * application/json: `{ "url": "https://..." }` (optionally `manifestUrl`);
//     the manifest defaults to the sibling `manifest.json`.
// Downloads are https-only, size-capped and time-limited.

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { BadRequestError, handleApiError, HttpError } from '../shared/errors.js';
import { importSnapshot as importSnapshotImpl, type ImportSnapshotDeps } from '../search/importSnapshot.js';
import {
  parseSnapshotManifest,
  SnapshotError,
  SNAPSHOT_MANIFEST_FILENAME,
  type SnapshotManifest,
} from '../search/snapshot.js';
import {
  createPrismaSnapshotImportDeps,
  readCatalogueImportedAt,
  recordCatalogueImport,
} from '../search/catalogueImportService.js';

/** Compressed snapshot cap (12k rows is a few MB; 50 MB leaves room). */
export const SNAPSHOT_IMPORT_MAX_BYTES = 50 * 1024 * 1024;
export const SNAPSHOT_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface CatalogueStatus {
  total: number;
  active: number;
  importedAt: string | null;
}

export interface CatalogueRouterDeps {
  maxBytes: number;
  downloadTimeoutMs: number;
  importSnapshot: typeof importSnapshotImpl;
  importDeps: ImportSnapshotDeps;
  recordImportedAt: (iso: string) => Promise<void>;
  readStatus: () => Promise<CatalogueStatus>;
  fetchImpl: typeof fetch;
  /** Published feed URL (`CATALOGUE_FEED_URL`, defaulting to the GitHub release). */
  feedUrl: string;
  /** NODE_ENV; loopback http feeds are allowed outside production only. */
  nodeEnv: string;
}

/** ADR-030: the singleton session is the admin. Explicit check, explicit 403. */
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.isAdmin !== true) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

function isTooLarge(error: unknown): boolean {
  const shaped = error as { code?: string; type?: string; status?: number } | null;
  return (
    shaped?.code === 'LIMIT_FILE_SIZE' ||
    shaped?.type === 'entity.too.large' ||
    shaped?.status === 413
  );
}

function requireHttps(raw: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError(`${label} is not a valid URL`);
  }
  if (url.protocol !== 'https:') {
    throw new BadRequestError(`${label} must use https`);
  }
  return url;
}

/**
 * Feed URL policy: https everywhere, plus loopback http in development so the
 * Settings button can be exercised against a locally served snapshot.
 */
function requireFeedUrl(raw: string, nodeEnv: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError('Catalogue feed URL is not a valid URL');
  }
  if (url.protocol === 'https:') return url;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && loopback && nodeEnv !== 'production') return url;
  throw new BadRequestError(
    'Catalogue feed URL must use https (http localhost is allowed in development only)',
  );
}

function statusDeps(): Promise<CatalogueStatus> {
  return Promise.all([
    prisma.jobListing.count(),
    prisma.jobListing.count({ where: { isActive: true } }),
    readCatalogueImportedAt(),
  ]).then(([total, active, importedAt]) => ({ total, active, importedAt }));
}

function defaultDeps(): CatalogueRouterDeps {
  return {
    maxBytes: SNAPSHOT_IMPORT_MAX_BYTES,
    downloadTimeoutMs: SNAPSHOT_DOWNLOAD_TIMEOUT_MS,
    importSnapshot: importSnapshotImpl,
    importDeps: createPrismaSnapshotImportDeps(),
    recordImportedAt: recordCatalogueImport,
    readStatus: statusDeps,
    fetchImpl: fetch,
    feedUrl: env.CATALOGUE_FEED_URL,
    nodeEnv: env.NODE_ENV,
  };
}

export function createCatalogueRouter(overrides: Partial<CatalogueRouterDeps> = {}): Router {
  const deps: CatalogueRouterDeps = { ...defaultDeps(), ...overrides };
  const router = Router();

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.maxBytes },
  });
  const rawBody = express.raw({
    type: 'application/octet-stream',
    limit: deps.maxBytes,
  });

  /** Parse multipart/octet-stream bodies (JSON is parsed by the app). */
  function parseBody(req: Request, res: Response, next: NextFunction): void {
    const run = (middleware: express.RequestHandler): void => {
      middleware(req, res, (error?: unknown) => {
        if (!error) return next();
        if (isTooLarge(error)) {
          res.status(413).json({
            error: `Snapshot exceeds the ${deps.maxBytes} byte limit`,
            code: 'snapshot_too_large',
          });
          return;
        }
        res.status(400).json({ error: 'Unreadable snapshot upload', code: 'snapshot_upload_invalid' });
      });
    };
    if (req.is('multipart/form-data')) return run(upload.single('file'));
    if (req.is('application/octet-stream')) return run(rawBody);
    return next();
  }

  async function downloadBytes(url: URL): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.downloadTimeoutMs);
    try {
      const response = await deps.fetchImpl(url.toString(), {
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new BadRequestError(`Snapshot download failed with HTTP ${response.status}`);
      }
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > deps.maxBytes) {
        throw new HttpError(413, `Snapshot exceeds the ${deps.maxBytes} byte limit`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > deps.maxBytes) {
        throw new HttpError(413, `Snapshot exceeds the ${deps.maxBytes} byte limit`);
      }
      return bytes;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new HttpError(504, 'Snapshot download timed out');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The one-click feed download. A missing release/asset is an expected state
   * (the workflow has not published yet), so it is a readable 502 rather than
   * an unhandled 500. Timeouts keep their 504.
   */
  async function downloadFeedBytes(url: URL): Promise<Buffer> {
    try {
      return await downloadBytes(url);
    } catch (error) {
      // A size cap or a timeout is a different failure than "not published";
      // keep the 413/504 the caller can act on.
      if (error instanceof HttpError && (error.statusCode === 413 || error.statusCode === 504)) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : 'download failed';
      throw new HttpError(502, `The daily snapshot is not published yet (${detail})`);
    }
  }

  function readManifest(raw: unknown): SnapshotManifest {
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      throw new BadRequestError(
        'A snapshot manifest is required (multipart "manifest" field, ' +
          '"x-snapshot-manifest" header, or JSON "manifest"/"manifestUrl")',
      );
    }
    try {
      return parseSnapshotManifest(raw as string | object);
    } catch (error) {
      if (error instanceof SnapshotError) throw new BadRequestError(error.message);
      throw error;
    }
  }

  router.get('/status', requireAuth, async (_req: Request, res: Response) => {
    try {
      res.json(await deps.readStatus());
    } catch (error) {
      handleApiError(error, res);
    }
  });

  router.post('/sync', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
    try {
      const feedUrl = requireFeedUrl(deps.feedUrl, deps.nodeEnv);
      const manifestUrl = new URL(SNAPSHOT_MANIFEST_FILENAME, feedUrl);
      const gzip = await downloadFeedBytes(feedUrl);
      const manifest = readManifest((await downloadFeedBytes(manifestUrl)).toString('utf8'));

      if (gzip.length > deps.maxBytes) {
        throw new HttpError(413, `Snapshot exceeds the ${deps.maxBytes} byte limit`);
      }

      const result = await deps.importSnapshot({ gzip, manifest }, deps.importDeps);
      await deps.recordImportedAt(new Date().toISOString());
      res.json({
        imported: result.imported,
        reactivated: result.reactivated,
        skipped: result.skipped,
        generatedAt: result.snapshotGeneratedAt,
        feedUrl: feedUrl.toString(),
      });
    } catch (error) {
      if (error instanceof SnapshotError) {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
      handleApiError(error, res);
    }
  });

  router.post(
    '/import',
    requireAuth,
    requireAdmin,
    parseBody,
    async (req: Request, res: Response) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        let gzip: Buffer;
        let manifest: SnapshotManifest;

        if (req.file) {
          gzip = req.file.buffer;
          manifest = readManifest(body.manifest);
        } else if (Buffer.isBuffer(req.body)) {
          gzip = req.body;
          manifest = readManifest(req.header('x-snapshot-manifest'));
        } else {
          const rawUrl = body.url;
          if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
            throw new BadRequestError(
              'Provide a multipart file, an octet-stream body, or JSON { "url": "https://..." }',
            );
          }
          const snapshotUrl = requireHttps(rawUrl, 'Snapshot URL');
          const manifestUrl =
            typeof body.manifestUrl === 'string' && body.manifestUrl.trim().length > 0
              ? requireHttps(body.manifestUrl, 'Manifest URL')
              : new URL(SNAPSHOT_MANIFEST_FILENAME, snapshotUrl);
          gzip = await downloadBytes(snapshotUrl);
          manifest = readManifest((await downloadBytes(manifestUrl)).toString('utf8'));
        }

        if (gzip.length > deps.maxBytes) {
          throw new HttpError(413, `Snapshot exceeds the ${deps.maxBytes} byte limit`);
        }

        const result = await deps.importSnapshot({ gzip, manifest }, deps.importDeps);
        await deps.recordImportedAt(new Date().toISOString());
        res.json({
          imported: result.imported,
          reactivated: result.reactivated,
          skipped: result.skipped,
          snapshotGeneratedAt: result.snapshotGeneratedAt,
        });
      } catch (error) {
        if (error instanceof SnapshotError) {
          res.status(400).json({ error: error.message, code: error.code });
          return;
        }
        handleApiError(error, res);
      }
    },
  );

  return router;
}

export default createCatalogueRouter;
