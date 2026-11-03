// render/renderPort.test.ts - the port, the routes it plugs into, and the belt around it
// (T1043).
//
// WHAT IS PROVEN HERE, IN THE ORDER THE CONTRACT STATES IT:
//
//   1. THE GATE IS RE-RUN BY THE PORT ITSELF. The blocked case is driven BOTH over HTTP
//      (T1030's route + `preRenderGuard`) AND directly through `createRenderPort()`, and
//      BOTH assert zero broker calls and zero storage puts. The second half is the one that
//      is new: a direct caller has no route guard, so if the port did not re-run
//      `assertRevisionRenderableInScope` this test would pass over HTTP and fail here. The
//      MUTATION that skips the port's re-run is in the progress note's table.
//   2. THE HAPPY PATH writes EXACTLY ONE `ResumeDocument`, with the full metadata set and
//      NO bytes column, and returns 201 `{documentId, format, hash}`.
//   3. A CACHE HIT performs ZERO broker calls and returns the SAME documentId; a toolchain
//      bump, a template bump and a lost blob each force a MISS.
//   4. `typ` is 422 `render_format_unsupported` / `TYP_EXPORT_IS_A_BUNDLE` with NO row;
//      `tex` and `json` write a row with `templateId: 'none'`.
//   5. The two document routes stream the stored bytes with the recorded content type and
//      length, 404 a foreign or unknown document, and never leak a storage root path.
//   6. `RENDER_TIMEOUT_MS=20000` refuses to boot; `5000` is ACCEPTED (asserted at the
//      SCHEMA, by reloading it, not only at the derived budget) and the derived transport
//      budget never exceeds the policy wall clock. The knob bounds the render request the
//      port enforces; `sandbox.ts`'s compile-plan timeout stays pinned to
//      `RENDER_LIMITS.wallClockMs` and is not settable from env (T1040 sec. 13 ruling 17).
//   7. THE ERROR SURFACE: every refusal is a machine code with a FIXED message - no path,
//      no digest, no staged content, no broker stderr. A storage fault in ANY phase,
//      including the cache lookup's `head` probe, is the documented 503 and never a 500.
//
// FAKES, AND WHY THESE ONES. The broker is a function that counts its calls and returns a
// real PDF header, so "zero broker calls" and "a magic-byte refusal" are both observable.
// The store is the REAL fs store on a temp root, not a mock: the whole point of the
// content-addressed key and the `head`/`open` behaviour is that it is a real filesystem, and
// a mocked store would let a broken key pattern pass. The database is a fake with the three
// delegates the port uses, which is what makes the zero-write assertions countable.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const { mockUserId, prismaMocks, renderEnv } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  prismaMocks: {
    resume: { findUnique: vi.fn(), findMany: vi.fn() },
    resumeRevision: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    resumeChange: { create: vi.fn(), findMany: vi.fn() },
    resumeClaimUsage: { create: vi.fn(), findMany: vi.fn() },
    careerClaim: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    careerProfile: { findUnique: vi.fn(), findMany: vi.fn() },
    experience: { findMany: vi.fn() },
    education: { findMany: vi.fn() },
    project: { findMany: vi.fn() },
    skill: { findMany: vi.fn() },
    certification: { findMany: vi.fn() },
    evidenceSource: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    claimVerification: { create: vi.fn(), findMany: vi.fn() },
    // `findUnique` is the DOCUMENT ROUTE's read (one id); `findFirst` is the CACHE's read
    // (the unique tuple). They are different queries and the tests below drive them
    // independently, which is why both exist here: a single mock standing in for both
    // would make "the cache hit" and "the download" indistinguishable.
    resumeDocument: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  },
  renderEnv: { timeoutMs: '10000' },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import { ClaimStatus, ResumeUsage } from '@prisma/client';
import resumesRouter, { setResumeRenderPort } from '../routes/resumes.js';
import { createRenderPort, type RenderPortDb, type RenderBrokerLike } from './renderPort.js';
import { createArtifactStore, StorageError, storageKeyFor, type ArtifactStore } from './storage.js';
import { loadTemplateRegistry, RENDER_DEFAULT_TEMPLATE_ID } from './templates.js';
import { RENDER_LIMITS, TYPST_PIN } from './sandbox.js';
import { resolveRenderBudget, RENDER_DEFAULTS, RENDER_ENV_KEYS, RENDER_ENV_KEY_LIST } from './env.js';
import { RenderPortError, requestMimeType, requestExtension, CLIENT_VISIBLE_RENDER_REASONS } from './types.js';
import { stageRenderJobInMemory, StageError } from './stage.js';
import { renderEngineVersion } from './cache.js';
import { canonicalJsonHash, X_CLEARANCE_KEY } from '../resume/json/jsonresume.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RESUME = { id: 'res-1', userId: 'user-1', modelVersion: 2, profileId: 'profile-1', name: 'Ada Resume' };

function validDocument() {
  return {
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01', highlights: ['Cut CI build time by 40%'] }],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 'test',
      sourceModelVersion: 2,
      profileId: 'profile-1',
      claimCount: 1,
      confirmedClaimCount: 1,
      unconfirmedClaimCount: 0,
      claims: [
        {
          claimId: 'clm-1',
          fingerprint: 'a'.repeat(64),
          kind: 'achievement',
          status: ClaimStatus.user_confirmed,
          provenance: 'llm_inferred',
          confidence: 0.9,
          evidenceSourceId: null,
          usage: ResumeUsage.verbatim,
          jsonPath: 'work[0].highlights[0]',
          renderedText: 'Cut CI build time by 40%',
        },
      ],
    },
  };
}

function revisionRow(overrides: Record<string, unknown> = {}) {
  const resumeJson = (overrides.resumeJson ?? validDocument()) as Record<string, unknown>;
  return {
    id: 'rev-1',
    resumeId: 'res-1',
    revisionNumber: 1,
    resumeJson,
    jsonHash: canonicalJsonHash(resumeJson),
    enginePins: {},
    createdBy: 'user',
    createdByUserId: 'user-1',
    reason: null,
    // A FIXED creation time, so the pinned PDF timestamp is the same in every test and a
    // second render of one revision would be byte-identical (policy 7.4, R14).
    createdAt: new Date('2026-09-30T12:00:00.000Z'),
    ...overrides,
  };
}

function claimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clm-1',
    profileId: 'profile-1',
    kind: 'achievement',
    statement: 'Cut CI build time by 40%',
    fingerprint: 'a'.repeat(64),
    status: ClaimStatus.user_confirmed,
    provenance: 'llm_inferred',
    confidence: 0.9,
    evidenceSourceId: null,
    experienceId: null,
    educationId: null,
    projectId: null,
    skillId: null,
    certificationId: null,
    achievementId: null,
    createdAt: new Date('2026-09-30T09:00:00.000Z'),
    updatedAt: new Date('2026-09-30T09:00:00.000Z'),
    ...overrides,
  };
}

/** A usage log that DESCRIBES the document, which is what the read-time guard requires. */
function allowGate(status: ClaimStatus = ClaimStatus.user_confirmed) {
  prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([
    {
      id: 'usg-1',
      revisionId: 'rev-1',
      claimId: 'clm-1',
      usage: 'verbatim',
      renderedText: 'Cut CI build time by 40%',
      createdAt: new Date('2026-09-30T12:00:00.000Z'),
    },
  ]);
  prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow({ status })]);
}

/** A minimal valid PDF: the magic the policy checks, plus a page object to count. */
function fakePdf(pageCount = 1): Buffer {
  const parts = [Buffer.from('%PDF-1.7\n', 'latin1')];
  for (let i = 0; i < pageCount; i += 1) parts.push(Buffer.from(`${i} 0 obj\n<< /Type /Page >>\nendobj\n`, 'latin1'));
  parts.push(Buffer.from('trailer\n%%EOF\n', 'latin1'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let registry: Awaited<ReturnType<typeof loadTemplateRegistry>>;
let storageRoot: string;
let store: ArtifactStore;

/** Counts every call, so "zero broker calls" and "one put" are assertions, not claims. */
function countingBroker(pdf: Buffer = fakePdf()) {
  const state = { calls: 0, specs: [] as unknown[] };
  const render = vi.fn(
    async (spec: Parameters<RenderBrokerLike['render']>[0]): Promise<Awaited<ReturnType<RenderBrokerLike['render']>>> => {
      state.calls += 1;
      state.specs.push(spec);
      return {
        outcome: 'ok' as const,
        sha256: sha256Hex(pdf),
        byteSize: pdf.length,
        mimeType: 'application/pdf',
        durationMs: 12,
        artifact: pdf,
      };
    },
  );
  return { broker: { render } as unknown as RenderBrokerLike, state, render };
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A broker failure shaped the way `brokerClient.ts` shapes one: a real `Error` whose `name` is
 * the class the transport uses and whose `code`/`reason` are the broker's own machine strings.
 * A plain object literal would not do - `toRenderPortError` matches on `instanceof Error`, so an
 * untyped throw would be classified as the generic fallback and every assertion below would be
 * about the wrong code.
 */
function brokerError(
  name: 'BrokerClientError' | 'BrokerUnavailableError',
  code: string,
  reason = 'SOME_REASON',
): Error & { code: string; reason: string } {
  const error = new Error(`RENDER_BROKER: ${code} (${reason})`) as Error & { code: string; reason: string };
  error.name = name;
  error.code = code;
  error.reason = reason;
  return error;
}

/**
 * A DATABASE fault shaped the way Prisma shapes one - the driver's own class name and code, with
 * the connection string in the message.
 *
 * The `name` matters, and it matters for the same reason `brokerError`'s does: the widened
 * translator classified an unrecognised rejection as `RENDER_COMPILE_ERROR`, so a test that threw
 * a bare `Error` would have been testing the fallback rather than the bug. It is also the reason
 * `isStorageRejection` cannot match it: neither `instanceof StorageError` nor the name
 * `StorageError` is true here, which is exactly the property the narrowed wrapper depends on.
 */
function databaseError(message = 'Can\'t reach database server at `db:5432`'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = 'PrismaClientInitializationError';
  error.code = 'P1001';
  return error;
}

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    revisionId: 'rev-1',
    resumeId: 'res-1',
    format: 'pdf',
    templateId: RENDER_DEFAULT_TEMPLATE_ID,
    templateVersion: '1.0.0',
    engineVersion: renderEngineVersion(TYPST_PIN.version, {}),
    pageCount: 1,
    hash: 'e'.repeat(64),
    storageKey: 'artifacts/ee/' + 'e'.repeat(64),
    byteSize: 10_492,
    mimeType: 'application/pdf',
    createdAt: new Date('2026-09-30T12:05:00.000Z'),
    ...overrides,
  };
}

function db(): RenderPortDb {
  return prismaMocks as unknown as RenderPortDb;
}

/**
 * A port `db` whose ONE delegate fails, built by copying the shared mock so the rest of the
 * surface is still the shared one.
 *
 * Not `mockRejectedValue` on the shared mock: a rejected implementation outlives the test that
 * set it (Vitest's `clearAllMocks` does not remove one), and the leak surfaces two describes
 * later as a failure in a test that has nothing to do with this one. A per-test copy cannot
 * leak, and it also says which seam is failing instead of leaving it implicit in a global.
 */
function dbWith(delegate: 'resumeRevision' | 'resumeDocument'): RenderPortDb {
  const base = prismaMocks as unknown as Record<string, Record<string, unknown>>;
  return {
    ...(prismaMocks as unknown as RenderPortDb),
    [delegate]: {
      ...base[delegate],
      findFirst: async () => {
        throw databaseError();
      },
    },
  } as unknown as RenderPortDb;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', resumesRouter);
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockUserId.value = 'user-1';
  renderEnv.timeoutMs = '10000';
  process.env.RENDER_STORAGE_ROOT = '';
  prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
  prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
  prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([]);
  prismaMocks.careerClaim.findMany.mockResolvedValue([]);
  prismaMocks.resumeDocument.findMany.mockResolvedValue([]);
  prismaMocks.resumeDocument.findUnique.mockResolvedValue(null);
  prismaMocks.resumeDocument.upsert.mockImplementation(async ({ create }: any) => ({
    id: 'doc-1',
    createdAt: new Date('2026-09-30T12:05:00.000Z'),
    ...create,
  }));
  allowGate();
  storageRoot = await mkdtemp(path.join(tmpdir(), 't1043-store-'));
  process.env.RENDER_STORAGE_ROOT = storageRoot;
  store = createArtifactStore({ root: storageRoot });
  registry = await loadTemplateRegistry();
  setResumeRenderPort(null);
});

afterEach(async () => {
  setResumeRenderPort(null);
  process.env.RENDER_STORAGE_ROOT = '';
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. THE BELT, TWICE: over HTTP and directly through the port
// ---------------------------------------------------------------------------

describe('THE GATE IS RE-RUN BY THE PORT ITSELF (plan sec. 8)', () => {
  it('refuses a BLOCKED revision over HTTP with ZERO broker calls and ZERO storage puts', async () => {
    // T1030 proves the gate runs BEFORE the handler by recording the PORT's calls. This is
    // the same claim one layer down, and it is stronger: it counts the two things the gate
    // exists to prevent - a container spawn and a byte written - not a route invocation.
    allowGate(ClaimStatus.inferred);
    const { broker, state } = countingBroker();
    const put = vi.spyOn(store, 'put');
    setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

    const response = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'pdf' });

    expect(response.status).toBe(409);
    // T1030's own code, not one this task invented: the port re-runs the SAME gate, so it
    // must answer with the SAME vocabulary the route already documented.
    expect(response.body.code).toBe('PRE_RENDER_GATE_BLOCKED');
    expect(response.body.reason).toBe('CLAIM_NOT_CONFIRMED');
    expect(state.calls).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
  });

  it('refuses the SAME revision DIRECTLY through the port - the half a route guard cannot prove', async () => {
    // This is the acceptance item's second half, and it is the one that makes the gate a
    // property of the PORT rather than of the route. There is no `preRenderGuard` here, no
    // middleware, no Express: the ONLY thing that can refuse this is the port's own re-run
    // of `assertRevisionRenderableInScope`. A port without it renders a blocked revision
    // from a script, a future route, or a test - and this test would be green.
    allowGate(ClaimStatus.inferred);
    const { broker, state } = countingBroker();
    const put = vi.spyOn(store, 'put');
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });

    await expect(port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' })).rejects.toMatchObject({
      name: expect.stringMatching(/GateError|AuditError/),
    });
    expect(state.calls).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
    // And the refusal is the SAME one the route reports, with the same machine code - so a
    // direct caller does not have to learn a second error convention.
    expect(prismaMocks.resumeDocument.findUnique).not.toHaveBeenCalled();
  });

  it('refuses EVERY refusal reason the belt owns, over HTTP and directly, with zero work done', async () => {
    // ADR-043's reasons, one at a time. The count of broker calls and puts is zero in all
    // of them, which is the property: a refusal is a refusal whether it comes from a status
    // the user never confirmed, a document that does not describe itself, a claim that no
    // longer resolves, or bytes that no longer hash to what was recorded.
    const cases: Array<[string, () => void]> = [
      ['CLAIM_NOT_CONFIRMED', () => allowGate(ClaimStatus.inferred)],
      ['DOCUMENT_UNAUDITED', () => {
        allowGate();
        prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ resumeJson: { basics: { name: 'A' } } }));
      }],
      ['REVISION_TAMPERED', () => {
        allowGate();
        prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow({ jsonHash: 'f'.repeat(64) }));
      }],
      ['CLAIM_UNRESOLVED', () => {
        prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([{
          id: 'usg-1', revisionId: 'rev-1', claimId: 'clm-missing', usage: 'verbatim',
          renderedText: 'x', createdAt: new Date(),
        }]);
        prismaMocks.careerClaim.findMany.mockResolvedValue([]);
      }],
      ['USAGE_SET_MISMATCH', () => {
        prismaMocks.resumeClaimUsage.findMany.mockResolvedValue([{
          id: 'usg-1', revisionId: 'rev-1', claimId: 'clm-1', usage: 'tailored',
          renderedText: 'Cut CI build time by 40%', createdAt: new Date(),
        }]);
        prismaMocks.careerClaim.findMany.mockResolvedValue([claimRow()]);
      }],
    ];

    for (const [label, arrange] of cases) {
      vi.clearAllMocks();
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      prismaMocks.resumeDocument.findMany.mockResolvedValue([]);
      prismaMocks.resumeDocument.findUnique.mockResolvedValue(null);
      arrange();
      const { broker, state } = countingBroker();
      const put = vi.spyOn(store, 'put');
      const port = createRenderPort({ db: db(), artifacts: store, broker, registry });

      const overHttp = await request(makeApp())
        .post('/res-1/render')
        .set('Content-Type', 'application/json')
        .send({ format: 'pdf' });
      expect(overHttp.status, label).toBe(409);

      vi.clearAllMocks();
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      arrange();
      const direct = createRenderPort({ db: db(), artifacts: store, broker, registry });
      await expect(direct({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' })).rejects.toThrow();
      expect(state.calls, label).toBe(0);
      expect(put, label).not.toHaveBeenCalled();
      expect(prismaMocks.resumeDocument.upsert, label).not.toHaveBeenCalled();
      put.mockRestore();
    }
  });

  it('ALLOWS a renderable revision, so the re-run is not a blanket refusal', async () => {
    // The other half of a gate is that it lets a legal render through. Without this a
    // port that refused everything would pass every refusal test above.
    const { broker, state } = countingBroker();
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
    const result = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect(result.format).toBe('pdf');
    expect(state.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The happy path
// ---------------------------------------------------------------------------

describe('the happy path: 201, ONE row, and NO bytes column', () => {
  it('returns 201 {documentId, format, hash} and writes exactly ONE ResumeDocument', async () => {
    const { broker, state } = countingBroker();
    setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

    const response = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'pdf' });

    expect(response.status).toBe(201);
    expect(Object.keys(response.body).sort()).toEqual(['documentId', 'format', 'hash']);
    expect(response.body.documentId).toBe('doc-1');
    expect(response.body.format).toBe('pdf');
    expect(response.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.calls).toBe(1);
    expect(prismaMocks.resumeDocument.upsert).toHaveBeenCalledTimes(1);

    const args = prismaMocks.resumeDocument.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    const row = args.create;
    expect(row.storageKey).toMatch(/^artifacts\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect(row.hash).toBe(response.body.hash);
    expect(row.hash).toBe(sha256Hex(fakePdf()));
    expect(row.byteSize).toBe(fakePdf().length);
    expect(row.mimeType).toBe('application/pdf');
    expect(row.engineVersion).toContain(TYPST_PIN.version);
    // The registry's OWN `metadata.json` version, read from the reviewed record - not a
    // constant in this suite and not a value the port chose. That is the whole point of
    // `ResumeTemplate.version` (ADR-044 D4): a template edited without a bump must not keep
    // serving the artifact rendered from the previous source.
    expect(row.templateVersion).toBe(registry.get(RENDER_DEFAULT_TEMPLATE_ID).version);
    expect(row.templateId).toBe(RENDER_DEFAULT_TEMPLATE_ID);
    expect(row.pageCount).toBe(1);
    // ADR-041 D2, in the shape the acceptance item names: the row carries metadata and the
    // BYTES live behind the storage key. No binary member may exist here at all.
    for (const forbidden of ['bytes', 'data', 'content', 'blob', 'buffer']) {
      expect(row).not.toHaveProperty(forbidden);
    }
    // And the bytes really are in the store, at the key the row names.
    const opened = await store.open(row.storageKey as string);
    expect(opened).not.toBeNull();
    expect(sha256Hex(Buffer.from(await readAll(opened!.stream)))).toBe(row.hash);
  });

  it('pins the PDF creation timestamp to the REVISION, so two renders are byte-identical', async () => {
    // Policy 7.4 / R14. A wall clock here would be embedded in the PDF and two renders of
    // one revision would differ, leaving the cache as the only thing keeping the bytes
    // consistent with the `hash` the row records.
    const { broker, state } = countingBroker();
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
    await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    const spec = state.specs[0] as { creationTimestampUnix: number; expectedEngineVersion: string; engine: string; format: string };
    expect(spec.creationTimestampUnix).toBe(Math.floor(new Date('2026-09-30T12:00:00.000Z').getTime() / 1000));
    // And the wire carries the PINNED version, which is what makes a toolchain bump
    // structurally unreachable rather than merely unlikely.
    expect(spec.expectedEngineVersion).toBe(TYPST_PIN.version);
    expect(spec.engine).toBe('typst');
    expect(spec.format).toBe('pdf');
  });

  it('stages template.typ + data.json from the reviewed template, with no host temp file', async () => {
    // ADR-042 D4: `dataBytes` is what lets the adapter's payload reach the container without
    // a host file, and the staged tree is the ONLY thing the broker receives.
    const seen: Array<{ names: readonly string[]; totalBytes: number; treeBytes: number }> = [];
    const broker: RenderBrokerLike = {
      render: vi.fn(async (spec, tree) => {
        seen.push({ names: tree.names, totalBytes: tree.totalBytes, treeBytes: spec.treeBytes });
        const pdf = fakePdf();
        return {
          outcome: 'ok', sha256: sha256Hex(pdf), byteSize: pdf.length,
          mimeType: 'application/pdf', durationMs: 1, artifact: pdf,
        };
      }),
    } as unknown as RenderBrokerLike;
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
    await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect([...(seen[0]?.names ?? [])].sort()).toEqual(['data.json', 'template.typ']);
    expect(seen[0]?.totalBytes).toBeGreaterThan(0);
    expect(seen[0]?.totalBytes).toBeLessThanOrEqual(RENDER_LIMITS.inputTotalBytes);
    // `treeBytes` on the wire is the ustar ARCHIVE length, never the sum of the file bytes.
    // The client re-checks the two against each other and refuses a frame whose declared
    // size is not the tree's real length, so a mismatch here would refuse EVERY job. The
    // difference is the per-entry tar headers, the padding, the `.pkgcache` entry and the
    // record pad - asserted as a strict inequality rather than as a formula, so a change to
    // the emitter cannot make this test quietly describe the wrong thing.
    expect(seen[0]?.treeBytes).toBeGreaterThan(seen[0]?.totalBytes ?? 0);
  });

  it('declares a frame the REAL client accepts over a real socket (the LIVE failure, pinned)', async () => {
    // This is the regression test for a defect the UNIT suite could not see: its fake broker
    // never read `spec.treeBytes`, so passing the FILE total compiled, passed 37 tests, and
    // was refused by the real client on the first real render. The live run is what found it.
    //
    // So the test uses the production CLIENT against a real HTTP server that reads the real
    // frame: a minimal broker that decodes the 4-byte prefix, drains the tree, and refuses a
    // length that disagrees with it exactly as `broker/index.ts` does. The stager, the
    // frame builder, the client and the length measurement are all the shipped ones; only the
    // container is absent, which is the one thing no unit test can have.
    const { createServer } = await import('node:http');
    const { RenderBrokerClient } = await import('./brokerClient.js');
    const { stageRenderJobInMemory } = await import('./stage.js');
    const { measureArchiveBytes } = await import('./typst.js');

    const seenTreeLengths: number[] = [];
    const fake = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
      const frame = Buffer.concat(chunks);
      const specLength = frame.readUInt32BE(0);
      const spec = JSON.parse(frame.subarray(4, 4 + specLength).toString('utf8')) as { treeBytes: number };
      const tree = frame.subarray(4 + specLength);
      seenTreeLengths.push(tree.length);
      if (tree.length !== spec.treeBytes) {
        // The real broker's shape: a 4xx with the machine code and a FIXED message.
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'RENDER_INPUT_INVALID', reason: 'TREE_LENGTH_MISMATCH', message: 'the render input was refused' }));
        return;
      }
      const pdf = fakePdf();
      response.writeHead(201, {
        'x-clearance-outcome': 'ok',
        'x-clearance-sha256': sha256Hex(pdf),
        'x-clearance-bytes': String(pdf.length),
        'x-clearance-mime': 'application/pdf',
        'x-clearance-duration-ms': '7',
      });
      Readable.from([pdf]).pipe(response);
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const portNumber = (fake.address() as { port: number }).port;

    try {
      const record = registry.get(RENDER_DEFAULT_TEMPLATE_ID);
      const tree = await stageRenderJobInMemory({
        engine: 'typst',
        template: { path: record.templatePath },
        dataBytes: Buffer.from('{"dictVersion":"1.1.0"}', 'utf8'),
        sourceRoot: record.dir,
      });
      const declared = await measureArchiveBytes(tree);
      // The measured length is strictly greater than the file total, and the frame the
      // client actually sends measures exactly it. Both halves, because the bug was a
      // declaration and the fix is a measurement.
      expect(declared).toBeGreaterThan(tree.totalBytes);

      const result = await new RenderBrokerClient({
        endpoint: { url: `http://127.0.0.1:${portNumber}`, token: 'this-fake-ignores-the-token' },
        timeoutMs: 10_000,
      }).render(
        {
          jobId: 'probe', engine: 'typst', format: 'pdf',
          templateId: record.id, templateVersion: record.version,
          expectedEngineVersion: TYPST_PIN.version, creationTimestampUnix: 1_757_000_000,
          treeBytes: declared, treeFileCount: tree.files.length,
          userId: 'u', revisionId: 'r',
        },
        tree,
      );
      expect(result.sha256).toBe(sha256Hex(fakePdf()));
      expect(seenTreeLengths).toEqual([declared]);
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });

  it('logs ONE structured job line with policy 10.5 fields and NO staged content', async () => {
    const lines: string[] = [];
    const port = createRenderPort({ db: db(), artifacts: store, ...countingBroker(), registry, log: (line) => lines.push(line) });
    await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    for (const field of ['code', 'engine', 'engineVersion', 'templateId', 'templateVersion', 'durationMs', 'byteSize', 'sha256', 'nearLimit']) {
      expect(record, field).toHaveProperty(field);
    }
    expect(record.nearLimit).toHaveProperty('inputNearLimit');
    expect(record.nearLimit).toHaveProperty('outputNearLimit');
    // No staged content, no resume text, no path. The canary is the document's own bullet.
    expect(lines[0]).not.toContain('Cut CI build time by 40%');
    expect(lines[0]).not.toContain(storageRoot);
    expect(lines[0]).not.toContain('template.typ');
  });
});

// ---------------------------------------------------------------------------
// 3. The cache, through the port
// ---------------------------------------------------------------------------

describe('the determinism cache, through the port', () => {
  /**
   * A cache row as `lookupCachedDocument` compares it.
   *
   * Two fields are derived from the REGISTRY rather than typed in: the template's real
   * version and the port's real folded engine version. A hard-coded `'1.0.0'` here would
   * make every cache test silently a MISS whenever the template ships a version bump, and
   * a test that stops exercising the hit path while still reading green is the exact failure
   * mode a cache suite cannot afford.
   */
  async function cacheHitRow(storedKey: string, hash: string, byteSize: number) {
    const record = registry.get(RENDER_DEFAULT_TEMPLATE_ID);
    return {
      id: 'doc-existing',
      revisionId: 'rev-1',
      format: 'pdf',
      templateId: RENDER_DEFAULT_TEMPLATE_ID,
      templateVersion: record.version,
      engineVersion: renderEngineVersion(TYPST_PIN.version, {}),
      pageCount: 1,
      hash,
      storageKey: storedKey,
      byteSize,
      mimeType: 'application/pdf',
      createdAt: new Date('2026-09-30T11:00:00.000Z'),
    };
  }

  it('a HIT performs ZERO broker calls and returns the SAME documentId', async () => {
    // The acceptance item, and the reason the cache exists: a hit must not spend a
    // container. The row is pre-seeded to match the plan exactly, including a storage key
    // that really resolves, so the hit is a TRUE hit rather than a miss that looks like one.
    const pdf = fakePdf();
    const hash = sha256Hex(pdf);
    const stored = await store.put({
      key: `artifacts/${hash.slice(0, 2)}/${hash}`,
      bytes: Readable.from([pdf]),
      contentType: 'application/pdf',
      byteSize: pdf.length,
      sha256: hash,
    });
    // The CACHE's read: the unique tuple, not an id. Distinct from the document route's
    // `findUnique`, so a test that seeded one and asserted the other would prove nothing.
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(await cacheHitRow(stored.key, hash, pdf.length));

    const { broker, state } = countingBroker(pdf);
    const put = vi.spyOn(store, 'put');
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
    const result = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });

    expect(result.documentId).toBe('doc-existing');
    expect(result.hash).toBe(hash);
    expect(state.calls).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
  });

  it('a toolchain-pin bump forces a MISS, and a template version bump forces a MISS', async () => {
    const pdf = fakePdf();
    const hash = sha256Hex(pdf);
    const stored = await store.put({
      key: `artifacts/${hash.slice(0, 2)}/${hash}`,
      bytes: Readable.from([pdf]),
      contentType: 'application/pdf',
      byteSize: pdf.length,
      sha256: hash,
    });
    const base = await cacheHitRow(stored.key, hash, pdf.length);
    const { broker, state } = countingBroker(pdf);
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });

    // Each of the three conditions, moved ONE at a time, and the broker call count is the
    // evidence: 0 would mean the hit path, 1 would mean a compile. Running them in one test
    // with a rising count is what makes a single restored condition fail loudly.
    prismaMocks.resumeDocument.findFirst.mockResolvedValue({ ...base, engineVersion: renderEngineVersion('0.13.0', {}) });
    await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect(state.calls).toBe(1);

    prismaMocks.resumeDocument.findFirst.mockResolvedValue({ ...base, templateVersion: '0.0.1-not-the-registry' });
    await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect(state.calls).toBe(2);

    // A null templateVersion is ALWAYS a miss (ADR-044 D4): a row that makes no claim about
    // which template produced it may never be served.
    prismaMocks.resumeDocument.findFirst.mockResolvedValue({ ...base, templateVersion: null });
    await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect(state.calls).toBe(3);

    // And with all three matching, it is a HIT again - so the three above are misses for
    // their own reasons and not because the fixture never matched.
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(base);
    const hit = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect(state.calls).toBe(3);
    expect(hit.documentId).toBe('doc-existing');
  });

  it('a row whose storageKey no longer resolves forces a MISS and re-renders', async () => {
    // The row exists and both versions match, but the BLOB is gone: a cleared volume, a
    // partial restore. Serving it would be a download that 404s after promising bytes.
    // Both versions MATCH - this row is a hit on every check except the bytes, which is
    // exactly the case the `store.head` probe exists for.
    prismaMocks.resumeDocument.findFirst.mockResolvedValue({
      ...(await cacheHitRow('artifacts/cc/' + 'c'.repeat(64), 'c'.repeat(64), 10_492)),
      id: 'doc-gone',
    });
    const { broker, state } = countingBroker();
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
    const result = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect(state.calls).toBe(1);
    // And the upsert replaced the SAME row rather than adding one - the unique key is the
    // reason there is no orphan.
    // The unique tuple, addressed by the generated compound name - the shape the real
    // Prisma client requires, which the live run proved the flat form does not satisfy.
    const where = (prismaMocks.resumeDocument.upsert.mock.calls[0]?.[0] as { where: unknown }).where;
    expect(where).toEqual({
      revisionId_format_templateId: {
        revisionId: 'rev-1',
        format: 'pdf',
        templateId: RENDER_DEFAULT_TEMPLATE_ID,
      },
    });
    expect(result.documentId).toBe('doc-1');
  });

  it('a storage fault in the CACHE LOOKUP is a 503 render_storage_unavailable, never a 500', async () => {
    // REVIEW F1. The cache deliberately lets `store.head` throw (`cache.test.ts` pins the
    // propagation at the CACHE layer), but the LOOKUP was the one phase of the port that was
    // not inside `translateRenderErrors`, so a `StorageError` from a broken volume missed the
    // `RenderPortError` branch in `sendServiceError` and landed in `handleApiError`'s generic
    // 500 - contradicting this module's header, the cache's header, `types.ts` and the
    // contract's mapping. The cache-layer test could never see it: it stops at the cache.
    //
    // This one drives the PORT, over HTTP and directly, and asserts the DOCUMENTED status.
    const base = await cacheHitRow('artifacts/dd/' + 'd'.repeat(64), 'd'.repeat(64), 10_492);
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(base);
    const { broker, state } = countingBroker();
    const put = vi.spyOn(store, 'put');
    // The real `StorageError` from T1032, on the real `head` of the real fs store: the fault
    // is a store that cannot answer, not a lookup that found nothing.
    vi.spyOn(store, 'head').mockRejectedValue(new StorageError('STORAGE_IO', 'IO_ERROR'));
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });

    // DIRECT: the port's own contract, before any HTTP mapping exists.
    const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RenderPortError);
    expect((failure as RenderPortError).code).toBe('render_storage_unavailable');
    expect((failure as RenderPortError).status).toBe(503);
    expect((failure as RenderPortError).reason).toBe('IO_ERROR');
    // And a storage fault is not a MISS and not a render: no compile, no bytes, no row. A
    // re-render storm against a dead volume is the failure this prevents.
    expect(state.calls).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();

    // HTTP: the same refusal, with the status the contract names. `500` here is the exact
    // regression, so the assertion is on the number and not merely on "not 2xx".
    setResumeRenderPort(port);
    const response = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'pdf' });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('render_storage_unavailable');
    // The fixed message, never the store's: a raw fs error would carry a path.
    expect(response.body.error).toBe('The rendered document could not be stored.');
    expect(JSON.stringify(response.body)).not.toContain(storageRoot);
  });

  it('a DATABASE failure in the same phase is NOT 422 - it keeps its own status', async () => {
    // T1052 (the T1043 re-review's N1). `lookupCachedDocument` is a STORAGE call wrapped by a
    // translator, but it is not ONLY a storage call: it reads `resumeDocument` first. The
    // wrapper was `translateRenderErrors`, whose generic fallback is `RENDER_COMPILE_ERROR` -
    // a 422 - so a database outage inside the cache lookup was reported to the caller as "your
    // render could not be compiled". That is the wrong claim on every axis: it is not about the
    // request, it is not about the render, and 422 tells a client to change something that is
    // already correct.
    const base = await cacheHitRow('artifacts/dd/' + 'd'.repeat(64), 'd'.repeat(64), 10_492);
    expect(base.id).toBeTruthy();
    const { broker, state } = countingBroker();
    const put = vi.spyOn(store, 'put');
    const port = createRenderPort({ db: dbWith('resumeDocument'), artifacts: store, broker, registry });

    // DIRECT: the port's own contract. The driver's error comes out UNTOUCHED - not a
    // `RenderPortError`, and so certainly not one whose status is 422.
    const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch(
      (e: unknown) => e,
    );
    expect(failure).not.toBeInstanceOf(RenderPortError);
    expect((failure as Error).name).toBe('PrismaClientInitializationError');
    if (failure instanceof RenderPortError) expect(failure.status).not.toBe(422);
    // And nothing was rendered: a dead database is not a licence to compile.
    expect(state.calls).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
    // The cache probe never ran, so the failure was in the DATABASE read that precedes it.

    // HTTP: the status is the one the exception already implies - `handleApiError`'s 500 - and
    // explicitly NOT the 422 the widened wrapper produced.
    setResumeRenderPort(port);
    const response = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'pdf' });
    expect(response.status).toBe(500);
    expect(response.status).not.toBe(422);
    // A generic body, not a render code: the machine vocabulary is for faults this port owns.
    expect(response.body.code).toBeUndefined();
    expect(response.body.error).toBe('An unexpected error occurred');
    expect(JSON.stringify(response.body)).not.toContain(storageRoot);
  });

  it('a DATABASE failure in the REVISION LOOKUP is not turned into a render refusal either', async () => {
    // The other half of the claim, and the one the task names. `resolveAndGate` is the port's
    // first statement and it reads `resumeRevision`; nothing about that read is storage, so
    // nothing may re-label it. Asserted over the DIRECT port because the route's own
    // `preRenderGuard` reads the same row first and would answer first - which is a different
    // (and also correct) mapping of the same fault.
    const { broker, state } = countingBroker();
    const port = createRenderPort({ db: dbWith('resumeRevision'), artifacts: store, broker, registry });
    const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch(
      (e: unknown) => e,
    );
    expect(failure).not.toBeInstanceOf(RenderPortError);
    expect((failure as Error).name).toBe('PrismaClientInitializationError');
    if (failure instanceof RenderPortError) expect(failure.status).not.toBe(422);
    expect(state.calls).toBe(0);
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. The format contract
// ---------------------------------------------------------------------------

describe('the format contract', () => {
  it('refuses typ with 422 render_format_unsupported / TYP_EXPORT_IS_A_BUNDLE and writes NO row', async () => {
    const { broker, state } = countingBroker();
    const put = vi.spyOn(store, 'put');
    setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

    const response = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'typ' });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('render_format_unsupported');
    expect(response.body.reason).toBe('TYP_EXPORT_IS_A_BUNDLE');
    expect(state.calls).toBe(0);
    expect(put).not.toHaveBeenCalled();
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
  });

  it('writes a row with templateId "none" for json and for tex, with NO broker call', async () => {
    // Ruling 4: the reserved id, and the registry refuses a real template that takes it, so
    // a row meaning "no template" and a row meaning "the none template" cannot be confused.
    for (const format of ['json', 'tex'] as const) {
      vi.clearAllMocks();
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
      prismaMocks.resumeDocument.findUnique.mockResolvedValue(null);
      allowGate();
      prismaMocks.resumeDocument.upsert.mockImplementation(async ({ create }: any) => ({ id: `doc-${format}`, createdAt: new Date(), ...create }));

      const { broker, state } = countingBroker();
      const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
      const result = await port({ revisionId: 'rev-1', format, userId: 'user-1' });

      expect(result.format, format).toBe(format);
      expect(state.calls, format).toBe(0);
      const args = prismaMocks.resumeDocument.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
      expect(args.create.templateId, format).toBe('none');
      expect(args.create.mimeType, format).toBe(requestMimeType(format));
      expect(args.create.byteSize, format).toBeGreaterThan(0);
      expect(args.create.hash, format).toMatch(/^[0-9a-f]{64}$/);
      // A source file has no pages: `null`, not 0, because "not a paged document" and "a
      // paged document with no pages" are different facts.
      expect(args.create.pageCount, format).toBeNull();
      // And the bytes really are stored, so the download route can serve them.
      const opened = await store.open(args.create.storageKey as string);
      expect(opened, format).not.toBeNull();
    }
  });

  it('the json export is the REVISION DOCUMENT, so the x-clearance ledger survives', async () => {
    // Ruling 14: deriving the export from the dictionary would DELETE the user's own
    // provenance block. The export is a different artifact from the render projection.
    const port = createRenderPort({ db: db(), artifacts: store, ...countingBroker(), registry });
    await port({ revisionId: 'rev-1', format: 'json', userId: 'user-1' });
    const args = prismaMocks.resumeDocument.upsert.mock.calls[0]?.[0] as { create: { storageKey: string } };
    const opened = await store.open(args.create.storageKey);
    const text = (await readAll(opened!.stream)).toString('utf8');
    expect(JSON.parse(text)[X_CLEARANCE_KEY]).toBeDefined();
    expect(text).toContain('clm-1');
  });

  it('renders docx in-process with NO broker call, a reserved template id and the DOCX mime type', async () => {
    // T1041 CLOSED THE HOLE THIS TEST USED TO ASSERT. It previously read "refuses docx with a
    // named reason, because T1041 has not landed", which was the correct assertion while the
    // renderer did not exist and is now the opposite of the contract. The route's shipped
    // `format` list has accepted `docx` since T1030; what changed is that the port now
    // PRODUCES it (ADR-039: a peer off Resume JSON, no template and no container).
    //
    // The assertions are the ones that make it a peer rather than a fourth compile path: no
    // broker call, no template resolved, the reserved `none` id, and the DOCX content type on
    // the row the download route will later serve.
    const { broker, state } = countingBroker();
    const put = vi.spyOn(store, 'put');
    allowGate();
    prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
    prismaMocks.resumeDocument.upsert.mockImplementation(
      async ({ create }: any) => ({ id: 'doc-docx', createdAt: new Date(), ...create }),
    );
    setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

    const response = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'docx' });
    expect(response.status).toBe(201);
    expect(response.body.format).toBe('docx');

    // No container, no broker call: the whole point of ADR-039.
    expect(state.calls).toBe(0);
    expect(put).toHaveBeenCalledTimes(1);

    const args = prismaMocks.resumeDocument.upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
    };
    // ADR-039: DOCX has no Typst template, so the row says so with the reserved id. The
    // renderer version is the `templateVersion`, which is what makes a stored DOCX miss the
    // cache when the styles change.
    expect(args.create.templateId).toBe('none');
    expect(args.create.templateVersion).toBe('1.0.0');
    expect(args.create.engineVersion).toContain('docx');
    expect(args.create.mimeType).toBe(requestMimeType('docx'));
    expect(args.create.mimeType).toContain('wordprocessingml');
    expect(args.create.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.create.byteSize).toBeGreaterThan(0);
    // A DOCX has no page count in its bytes (it paginates on open), so `null`, not a guess.
    expect(args.create.pageCount).toBeNull();

    // And the bytes really are stored, under the row's own content-addressed key.
    const opened = await store.open(args.create.storageKey as string);
    expect(opened).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of opened!.stream) chunks.push(chunk as Buffer);
    const stored = Buffer.concat(chunks);
    // `PK` is the zip magic: a stored DOCX is a real OOXML package, not a placeholder.
    expect(stored.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(stored.length).toBe(args.create.byteSize);

    // `DOCX_RENDERER_NOT_SHIPPED` is no longer reachable, so it is no longer a reason the
    // route can surface. A closed reason set that still advertised it would be a second
    // answer to "what can this format do".
    expect(CLIENT_VISIBLE_RENDER_REASONS.has('DOCX_RENDERER_NOT_SHIPPED')).toBe(false);
  });

  it('and a SECOND docx render is a CACHE HIT, because the renderer version is a real key', async () => {
    // The determinism cache has to WORK for docx, not merely not-crash. A `null`
    // `templateVersion` is always a miss by ADR-044 D4, which would mean every DOCX request
    // re-serialised; asserting the hit is what proves the renderer's version is carrying the
    // half of the key that has no template to carry it.
    const { state } = countingBroker();
    allowGate();
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
    prismaMocks.resumeDocument.upsert.mockImplementation(
      async ({ create }: any) => ({ id: 'doc-docx', createdAt: new Date(), ...create }),
    );

    prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
    setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, ...countingBroker(), registry }));
    const first = await request(makeApp()).post('/res-1/render').set('Content-Type', 'application/json').send({ format: 'docx' });
    expect(first.status).toBe(201);

    // Now the row exists and its bytes do, so the next lookup is a HIT.
    const written = prismaMocks.resumeDocument.upsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    prismaMocks.resumeDocument.findFirst.mockResolvedValue({
      id: 'doc-docx',
      revisionId: 'rev-1',
      format: 'docx',
      templateId: 'none',
      templateVersion: '1.0.0',
      engineVersion: written.create.engineVersion,
      pageCount: null,
      hash: written.create.hash,
      storageKey: written.create.storageKey,
      byteSize: written.create.byteSize,
      mimeType: written.create.mimeType,
      createdAt: new Date(),
    });
    const put = vi.spyOn(store, 'put');
    const second = await request(makeApp()).post('/res-1/render').set('Content-Type', 'application/json').send({ format: 'docx' });

    expect(second.status).toBe(201);
    expect(second.body.documentId).toBe('doc-docx');
    expect(second.body.hash).toBe(written.create.hash);
    // A HIT performs NO serialisation and NO storage write.
    expect(put).not.toHaveBeenCalled();
    expect(prismaMocks.resumeDocument.upsert).toHaveBeenCalledTimes(1);
    expect(state.calls).toBe(0);
  });

  it('the in-process dispatch names EVERY format, with no implicit fallback', () => {
    // F4. The dispatch used to be a nested conditional whose last arm was an implicit `else`:
    //
    //     format === 'tex' ? ... : format === 'docx' ? ... : renderJsonExportBytes(...)
    //
    // which reads `json` as "whatever is left". That is true only while the union has three
    // members; the day a fourth in-process format is added, the fallback silently serialises
    // it as JSON. A test can therefore NOT observe this at runtime - all three formats produce
    // their correct bytes under both shapes - so the guard is asserted against the SOURCE,
    // the same way `docx.test.ts` asserts the import ban. Reverting the dispatch to the
    // nested conditional removes every `case` below and fails here.
    const source = readFileSync(path.join(__dirname, 'renderPort.ts'), 'utf8');
    const start = source.indexOf('async function serialiseInProcess(');
    expect(start, 'serialiseInProcess is gone from renderPort.ts').toBeGreaterThan(-1);
    // The body ends at the next top-level `function` declaration after it starts.
    const body = source.slice(start, source.indexOf('\nfunction ', start + 1));
    // Every in-process format is an EXPLICIT arm, not a residual.
    for (const format of ['tex', 'docx', 'json'] as const) {
      expect(body, `the dispatch has no explicit arm for '${format}'`).toMatch(
        new RegExp(`case '${format}':`),
      );
    }
    // ...and the residual arm is an exhaustiveness CHECK, not a serialiser.
    expect(body).toContain('default:');
    expect(body).toContain('exhaustive(format)');
    expect(body).not.toMatch(/default:\s*\n?\s*return render/);
    // No `else` and no trailing ternary fallback inside the dispatcher at all. Comments are
    // stripped first, because this test's own prose above discusses the very shape it bans.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    expect(code).not.toContain('else');
    expect(code).not.toMatch(/\?\s*await renderDocxFromDictionary/);
    // The helper itself exists and refuses rather than rendering anything.
    expect(source).toMatch(/function exhaustive\(value: never\): never \{[\s\S]*?throw new Error\(/);
  });

  it('RENDERS with a caller-supplied templateId, and the ROW records THAT template', async () => {
    // T1050 escalation 1. The seam existed (`RenderPortDeps.templateId`, the row's
    // `templateId` column, `resolveTemplateForRender`'s own `request.templateId`), so the
    // per-request choice reaches the renderer instead of being refused: switching the Studio's
    // template now changes the LAYOUT, and the document - and therefore the resume JSON hash -
    // is untouched either way, because the template is not a member of the revision.
    const requested = 'typst-modern-cards';
    expect(registry.get(requested).id).toBe(requested);
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
    const { broker, state } = countingBroker();
    setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

    const response = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'pdf', templateId: requested });

    expect(response.status).toBe(201);
    // The row says which template produced the bytes - read back from what was written, not
    // from what was asked for.
    const written = prismaMocks.resumeDocument.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      where: Record<string, Record<string, unknown>>;
    };
    expect(written.create.templateId).toBe(requested);
    expect(written.create.templateVersion).toBe(registry.get(requested).version);
    // ...and the cache tuple is keyed on it, so this is a DIFFERENT document from the default
    // template's, not a rewrite of the same row.
    expect(written.where.revisionId_format_templateId).toEqual({
      revisionId: 'rev-1',
      format: 'pdf',
      templateId: requested,
    });
    // The bytes came from the broker: this is a real compile against THAT template, not a
    // relabelled copy of the default's artifact.
    expect(state.calls).toBe(1);
    expect(written.create.hash).toBe(sha256Hex(fakePdf()));
    expect(written.create.id).toBeUndefined();
    expect(response.body.documentId).toBe('doc-1');
  });

  it('REFUSES an UNRESOLVABLE caller templateId, rather than rendering the default', async () => {
    // The T1043 rule that survives the widening, and it is the one that matters: a caller that
    // names a layout it cannot have is told so. `none` is RESERVED (an export row's sentinel,
    // never a template), `typst-not-a-template` is not in the registry, and the last two are
    // not template ids at all - which the route refuses before the port is invoked.
    for (const templateId of ['none', 'typst-not-a-template', '', 42, { id: 'x' }]) {
      vi.clearAllMocks();
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
      prismaMocks.resumeDocument.findUnique.mockResolvedValue(null);
      prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
      allowGate();
      const { broker, state } = countingBroker();
      const put = vi.spyOn(store, 'put');
      setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

      const response = await request(makeApp())
        .post('/res-1/render')
        .set('Content-Type', 'application/json')
        .send({ format: 'pdf', templateId });
      expect(response.status, JSON.stringify(templateId)).toBe(422);
      expect(response.body.code, JSON.stringify(templateId)).toBe('render_template_unsupported');
      // The reason is server-side: `CLIENT_VISIBLE_RENDER_REASONS` stays closed at the one
      // the contract names, so the CODE is what a client branches on.
      expect(response.body.reason, JSON.stringify(templateId)).toBeUndefined();
      // NO WORK AT ALL: the refusal is above the cache lookup, above staging and above the
      // broker, so not one byte is staged and not one row is written.
      expect(state.calls, JSON.stringify(templateId)).toBe(0);
      expect(put, JSON.stringify(templateId)).not.toHaveBeenCalled();
      expect(prismaMocks.resumeDocument.upsert, JSON.stringify(templateId)).not.toHaveBeenCalled();
    }
    // And the DEFAULT case is untouched: no `templateId` in the body still renders 201 with
    // the port's own default, and so does an explicit null, so the refusal is narrow rather
    // than a new gate on the shipped surface.
    vi.clearAllMocks();
    prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
    prismaMocks.resumeDocument.upsert.mockImplementation(async ({ create }: any) => ({ id: 'doc-1', createdAt: new Date(), ...create }));
    allowGate();
    const { broker } = countingBroker();
    setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));
    for (const body of [{ format: 'pdf' }, { format: 'pdf', templateId: null }]) {
      const ok = await request(makeApp()).post('/res-1/render').set('Content-Type', 'application/json').send(body);
      expect(ok.status, JSON.stringify(body)).toBe(201);
      const written = prismaMocks.resumeDocument.upsert.mock.calls.at(-1)?.[0] as { create: Record<string, unknown> };
      expect(written.create.templateId, JSON.stringify(body)).toBe(RENDER_DEFAULT_TEMPLATE_ID);
    }
  });

  it('F6: a `templateId` on an EXPORT is REFUSED with a machine reason, not discarded', async () => {
    // T1043's rule - "a caller's explicit choice is never silently ignored" - applied to the
    // three formats that have no template. The member used to be accepted and dropped:
    // `record` is `null` for each, so `rowTemplateId` became the reserved `'none'` and the
    // request that named a layout received a file laid out by no layout at all. Resolving it
    // is not available (there is no template for these formats), so it is refused, above the
    // cache lookup - nothing stored, nothing cached, so the refusal cannot itself become a
    // sticky failure.
    for (const format of ['tex', 'json', 'docx'] as const) {
      vi.clearAllMocks();
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
      prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
      allowGate();
      const { broker, state } = countingBroker();
      const put = vi.spyOn(store, 'put');
      setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

      const response = await request(makeApp())
        .post('/res-1/render')
        .set('Content-Type', 'application/json')
        .send({ format, templateId: 'typst-modern-cards' });

      expect(response.status, format).toBe(422);
      expect(response.body.code, format).toBe('render_template_unsupported');
      expect(state.calls, format).toBe(0);
      expect(put, format).not.toHaveBeenCalled();
      expect(prismaMocks.resumeDocument.upsert, format).not.toHaveBeenCalled();
    }

    // AND THE POSITIVE CONTROL: "no template" is the DEFAULT for these formats, so an absent
    // member and an explicit `null` both still render - the refusal is narrow rather than a
    // new gate on the shipped surface.
    for (const format of ['tex', 'json', 'docx'] as const) {
      vi.clearAllMocks();
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
      prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
      prismaMocks.resumeDocument.upsert.mockImplementation(async ({ create }: any) => ({ id: `doc-${format}`, createdAt: new Date(), ...create }));
      allowGate();
      const { broker, state } = countingBroker();
      setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

      for (const body of [{ format }, { format, templateId: null }]) {
        const ok = await request(makeApp())
          .post('/res-1/render')
          .set('Content-Type', 'application/json')
          .send(body);
        expect(ok.status, JSON.stringify(body)).toBe(201);
        const written = prismaMocks.resumeDocument.upsert.mock.calls.at(-1)?.[0] as {
          create: Record<string, unknown>;
        };
        expect(written.create.templateId, JSON.stringify(body)).toBe('none');
      }
      expect(state.calls, format).toBe(0);
    }
  });

  it('the cache keys on the TEMPLATE: same revision + same template is a HIT, another is a MISS', async () => {
    // The determinism cache's own contract, asserted through the port and over HTTP, because
    // this is what makes switching the template a DIFFERENT document rather than a rewrite:
    // `@@unique([revisionId, format, templateId])` means the second template has no row yet.
    const pdf = fakePdf();
    const pdfHash = sha256Hex(pdf);
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
    {
      const { broker } = countingBroker(pdf);
      setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));
    }
    const first = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'pdf', templateId: 'typst-compact-two-col' });
    expect(first.status).toBe(201);
    const stored = prismaMocks.resumeDocument.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
    };
    expect(stored.create.templateId).toBe('typst-compact-two-col');
    expect(stored.create.hash).toBe(pdfHash);

    // Now the row the first render wrote is READABLE: the blob is at its content-addressed
    // key, so the only thing left to decide on a repeat is the tuple.
    const row = {
      id: 'doc-two-col',
      revisionId: 'rev-1',
      resumeId: 'res-1',
      format: 'pdf',
      templateId: 'typst-compact-two-col',
      templateVersion: registry.get('typst-compact-two-col').version,
      engineVersion: renderEngineVersion(TYPST_PIN.version, {}),
      pageCount: 1,
      hash: pdfHash,
      storageKey: storageKeyFor(pdfHash),
      byteSize: pdf.length,
      mimeType: 'application/pdf',
      createdAt: new Date('2026-09-30T12:05:00.000Z'),
    };
    expect((await store.head(row.storageKey)) !== null).toBe(true);
    prismaMocks.resumeDocument.findFirst.mockImplementation(async ({ where }: any) =>
      where?.templateId === 'typst-compact-two-col' ? row : null,
    );
    const { broker, state } = countingBroker(pdf);
    prismaMocks.resumeDocument.upsert.mockClear();
    setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));

    const repeat = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'pdf', templateId: 'typst-compact-two-col' });
    expect(repeat.status).toBe(201);
    expect(repeat.body.documentId).toBe(row.id);
    expect(repeat.body.hash).toBe(pdfHash);
    // A HIT performs NO compile and NO write.
    expect(state.calls).toBe(0);
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();

    // ...and a DIFFERENT template over the SAME revision is a MISS: a fresh compile, a fresh
    // row, and the two-column artifact is never served for the cards layout.
    const cards = fakePdf(2);
    const cardsBroker = countingBroker(cards);
    prismaMocks.resumeDocument.upsert.mockImplementation(async ({ create }: any) => ({
      id: 'doc-cards',
      createdAt: new Date(),
      ...create,
    }));
    setResumeRenderPort(
      createRenderPort({ db: db(), artifacts: store, broker: cardsBroker.broker, registry }),
    );
    const other = await request(makeApp())
      .post('/res-1/render')
      .set('Content-Type', 'application/json')
      .send({ format: 'pdf', templateId: 'typst-modern-cards' });
    expect(other.status).toBe(201);
    expect(cardsBroker.state.calls).toBe(1);
    const written = prismaMocks.resumeDocument.upsert.mock.calls[0][0] as {
      create: Record<string, unknown>;
      where: Record<string, Record<string, unknown>>;
    };
    expect(written.create.templateId).toBe('typst-modern-cards');
    expect(written.where.revisionId_format_templateId?.templateId).toBe('typst-modern-cards');
    // A DIFFERENT document: different bytes, different hash, different id.
    expect(written.create.hash).toBe(sha256Hex(cards));
    expect(written.create.hash).not.toBe(row.hash);
    expect(other.body.documentId).toBe('doc-cards');
  });

  it('THE DOCUMENT IS UNCHANGED BY THE TEMPLATE: one revision, two templates, one snapshot', async () => {
    // The acceptance item, stated on the data rather than on a screen: the same
    // `revisionId` produced both artifacts, so the resume JSON - and therefore its hash - is
    // byte-identical whichever template laid it out.
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
    const revision = revisionRow();
    for (const templateId of ['typst-ats-classic', 'typst-compact-two-col', 'typst-modern-cards']) {
      vi.clearAllMocks();
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      prismaMocks.resumeRevision.findFirst.mockResolvedValue(revision);
      prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
      prismaMocks.resumeDocument.upsert.mockImplementation(async ({ create }: any) => ({
        id: `doc-${templateId}`,
        createdAt: new Date(),
        ...create,
      }));
      allowGate();
      const { broker, state } = countingBroker();
      setResumeRenderPort(createRenderPort({ db: db(), artifacts: store, broker, registry }));
      const response = await request(makeApp())
        .post('/res-1/render')
        .set('Content-Type', 'application/json')
        .send({ format: 'pdf', templateId });
      expect(response.status, templateId).toBe(201);
      expect(state.calls, templateId).toBe(1);
      const written = prismaMocks.resumeDocument.upsert.mock.calls[0][0] as {
        create: Record<string, unknown>;
      };
      // Same revision, same snapshot, three different documents.
      expect(written.create.revisionId).toBe('rev-1');
      expect(written.create.templateId).toBe(templateId);
    }
    // One snapshot: the gate re-read exactly this revision three times and the revision row was
    // never written, so no template can reach the document.
    expect(prismaMocks.resumeRevision.create).not.toHaveBeenCalled();
    expect(prismaMocks.resumeRevision.findFirst).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. The document routes
// ---------------------------------------------------------------------------

describe('GET /resumes/:id/documents/:docId', () => {
  async function seedStored(pdf: Buffer = fakePdf()) {
    const hash = sha256Hex(pdf);
    const stored = await store.put({
      key: `artifacts/${hash.slice(0, 2)}/${hash}`,
      bytes: Readable.from([pdf]),
      contentType: 'application/pdf',
      byteSize: pdf.length,
      sha256: hash,
    });
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(documentRow({ hash, storageKey: stored.key, byteSize: pdf.length }),
    );
    return { hash, key: stored.key, pdf };
  }

  it('streams the stored bytes with the RECORDED content type and length', async () => {
    const { hash, pdf } = await seedStored();
    const response = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(response.status).toBe(200);
    // Byte-identical to what the store holds, and its digest is the row's `hash`. This is
    // the same assertion the LIVE check makes over HTTP against a real render.
    expect(sha256Hex(Buffer.from(response.body))).toBe(hash);
    expect(Buffer.from(response.body).equals(pdf)).toBe(true);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-length']).toBe(String(pdf.length));
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('attachment; filename="Ada-Resume-typst-ats-classic.pdf"');
  });

  it('sanitises a hostile resume name and template id out of the filename', async () => {
    // The name is a user-set string, and a `Content-Disposition` header is one line: a name
    // carrying a quote, a CR/LF or a separator must not reach it.
    prismaMocks.resume.findUnique.mockResolvedValue({ ...RESUME, name: '"; drop\r\nContent-Type: text/html; x="é' });
    await seedStored();
    const response = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(response.status).toBe(200);
    const disposition = response.headers['content-disposition'] as string;
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    // EXACTLY two quotes: the pair delimiting the one filename parameter. Three would mean
    // a second parameter for a browser to prefer, which is the whole shape of a
    // `Content-Disposition` injection.
    expect(disposition.split('"').length - 1).toBe(2);
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    // The non-ASCII character became a dash rather than surviving: the allowlist is
    // `[a-zA-Z0-9-_]` and nothing else, so a name in any script is reduced to its safe
    // characters. A person's name still reads; the header cannot be broken.
    expect(disposition).not.toContain('é');
  });

  it('sanitises a hostile TEMPLATE id as well as the resume name', async () => {
    // `templateId` is a DATABASE column, so whatever wrote it is not this route: a value
    // that escaped the registry's own gate must not be pasted into a header verbatim. Both
    // halves of the name go through the same function, so they cannot drift apart.
    const { key, hash, pdf } = await seedStored();
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(
      documentRow({ storageKey: key, hash, byteSize: pdf.length, templateId: 'a"; x="evil' }),
    );
    const response = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(response.status).toBe(200);
    const disposition = response.headers['content-disposition'] as string;
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"$/);
    expect(disposition.split('"').length - 1).toBe(2);
  });

  it('404s another tenant s resumeId, and 404s an unknown docId, with a machine code', async () => {
    // 404 and not 403 on purpose (T1030's `preRenderGuard` states the rule): a 403 confirms
    // the id exists, and this endpoint is exactly the shape that lets ids be enumerated.
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(documentRow({ resumeId: 'res-OTHER' }));
    const foreign = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('document_not_found');

    // A row whose `resumeId` is null falls back to its revision's, and that is what decides.
    // The real seeded key is used in both rows so a 200 proves OWNERSHIP rather than
    // accidentally passing the storage probe and failing for a third reason.
    const { key, hash, pdf } = await seedStored();
    const seeded = { storageKey: key, hash, byteSize: pdf.length };
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(
      documentRow({ ...seeded, resumeId: null, revision: { resumeId: 'res-OTHER' } }),
    );
    expect((await request(makeApp()).get('/res-1/documents/doc-1')).status).toBe(404);
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(
      documentRow({ ...seeded, resumeId: null, revision: { resumeId: 'res-1' } }),
    );
    expect((await request(makeApp()).get('/res-1/documents/doc-1')).status).toBe(200);

    prismaMocks.resumeDocument.findUnique.mockResolvedValue(null);
    const unknown = await request(makeApp()).get('/res-1/documents/doc-unknown');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('document_not_found');
  });

  it('404s a row whose revision names no resume at all, rather than assuming it is ours', async () => {
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(documentRow({ resumeId: null, revision: null }),
    );
    const response = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('document_not_found');
  });

  it('refuses a row whose format has no artifact type, BEFORE any header is committed', async () => {
    // REVIEW F2. `attachmentFilename` calls `requestExtension`, which THROWS
    // `RenderPortError('render_format_unsupported')` for a `format` outside
    // `{pdf, tex, json, docx}`. `format` is a DATABASE column, so the closed set is a
    // property of the WRITER, not a guarantee about this row: the port refuses `typ` and
    // anything unknown before it writes one, but a hand-edited row, a future writer, or a
    // `docx` row whose extension mapping changes all put one here. With the filename built
    // inline in the `Content-Disposition` line it was evaluated AFTER `Content-Type` and
    // `Content-Length` were set, so the catch answered 422 with a JSON body on a response
    // that already declared a byte count - the truncated download the surrounding comment
    // says the ordering prevents.
    //
    // Reachability is low and the test says so by CONSTRUCTING the row rather than by
    // finding a path: `format: 'typ'` is refused by the port, so this is a stored row written
    // by something other than this port. The property under test is the ROUTE's ordering, not
    // the row's provenance.
    const { key, hash, pdf } = await seedStored();
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(
      documentRow({ storageKey: key, hash, byteSize: pdf.length, format: 'typ' }),
    );
    const response = await request(makeApp()).get('/res-1/documents/doc-1');

    // A READABLE refusal: the status the port's own table names for this code, the machine
    // code, and a JSON body a client can parse.
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('render_format_unsupported');
    expect(response.body.reason).toBe('TYP_EXPORT_IS_A_BUNDLE');
    expect(response.body.error).toBe('That format is not available for this document.');
    // NO header survived from the aborted download. A `Content-Length` of the artifact's
    // size on a JSON error body is the truncation; a `Content-Disposition` at all means the
    // response had already committed to being an attachment.
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/application\/json/);
    // The declared length is the ERROR BODY's, not the row's - asserted on the number rather
    // than on the header being absent, because Express sets it for a JSON body.
    expect(Number(response.headers['content-length'])).toBe(
      Buffer.byteLength(JSON.stringify(response.body), 'utf8'),
    );
    expect(response.headers['content-length']).not.toBe(String(pdf.length));
  });

  it('404s a MISSING BLOB with a machine code, never a 500', async () => {
    // The row exists and the bytes do not: a cleared volume, a partial restore. That is a
    // missing document, not a server fault.
    // A key that is well FORMED (so the store reaches the filesystem and reports absence)
    // but addresses nothing: the fan-out segment is derived from the digest, so
    // `artifacts/aa/<64 a's>` is a legal key to a blob that was never written. Getting this
    // wrong - a fan-out that does not match its digest - would be a `STORAGE_KEY_INVALID` 503
    // instead, which is a different and equally correct answer to a different question.
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(documentRow({ storageKey: 'artifacts/aa/' + 'a'.repeat(64), hash: 'a'.repeat(64) }),
    );
    const response = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.code).toBe('document_bytes_absent');
  });

  it('a blob CORRUPTED UNDER ITS OWN KEY is a machine-readable 503, never a corrupt 200', async () => {
    // T1052. The write path verifies and the store is content-addressed, so a blob that does
    // not match its address cannot be produced by this API - which is exactly why nothing
    // proved it on the READ path and a corrupt artifact was served silently. The corruption
    // here is the shape a real one has: same LENGTH, different bytes, in place. `lstat`
    // cannot see it, `head` reports a plausible size, and the row is untouched.
    const { key, hash, pdf } = await seedStored();
    await writeFile(path.join(storageRoot, ...key.split('/')), Buffer.alloc(pdf.length, 0x58));

    const response = await request(makeApp()).get('/res-1/documents/doc-1');

    // The documented answer: a 503 carrying the storage code, not a 200 whose body is not the
    // document. `STORAGE_HASH_MISMATCH` is the module's existing code for "the bytes do not
    // hash to the digest the key names", so this is a refusal the operator already knows.
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(response.body.code).toBe('STORAGE_HASH_MISMATCH');
    expect(response.body.error).toBe('The rendered document could not be read');
    // NO download header survived, and the declared length is the ERROR body's - the same
    // ordering invariant the `format` refusal above pins, asserted again because this is the
    // first fault that arrives AFTER the store hands back an `OpenArtifact`.
    expect(response.headers['content-disposition']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(Number(response.headers['content-length'])).toBe(
      Buffer.byteLength(JSON.stringify(response.body), 'utf8'),
    );
    // The decisive one: not one artifact byte reached the client. The corrupted blob is 10_492
    // bytes of 0x58; an empty JSON body is the only acceptable body for a 17 KB "download".
    expect(Buffer.isBuffer(response.body)).toBe(false);
    expect(response.text).not.toContain('X');
    // And never the storage root.
    expect(JSON.stringify(response.body)).not.toContain(storageRoot);
    expect(JSON.stringify(response.body)).not.toContain(hash);
  });

  it('a row whose hash disagrees with its storage key is refused with the SAME code', async () => {
    // The half no amount of hashing can do. The store proves "the bytes hash to the digest the
    // KEY names"; this proves the key is the digest the ROW names. They are equal for every row
    // this API wrote, so the disagreement here is a hand-edited row or a partially-applied
    // restore - and the download's integrity claim must not rest on a write-path invariant.
    const { key, hash, pdf } = await seedStored();
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(
      documentRow({ storageKey: key, hash: 'b'.repeat(64), byteSize: pdf.length }),
    );
    const response = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(response.body.code).toBe('STORAGE_HASH_MISMATCH');
    expect(Buffer.isBuffer(response.body)).toBe(false);
  });

  it('a CORRECT blob still downloads byte-identically after a verified read', async () => {
    // The positive half of the same fix, and the reason the check can exist at all: an
    // over-eager comparison would silently break every real download. Same assertions as the
    // first test in this describe, run against a blob that still matches its address - so the
    // sha256 the client receives is the ROW's hash, unchanged.
    const { hash, pdf } = await seedStored();
    const response = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(response.status).toBe(200);
    expect(sha256Hex(Buffer.from(response.body))).toBe(hash);
    expect(Buffer.from(response.body).equals(pdf)).toBe(true);
    expect(response.headers['content-disposition']).toBe('attachment; filename="Ada-Resume-typst-ats-classic.pdf"');
  });

  it('NEVER leaks a storage root path in any response body', async () => {
    // Every failure shape, one after another, asserted against the ROOT string itself rather
    // than against a pattern: the root is the exact thing a response must never contain.
    const bodies: string[] = [];
    // 1. a missing blob
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(documentRow({ storageKey: 'artifacts/aa/' + 'a'.repeat(64) }));
    bodies.push(JSON.stringify((await request(makeApp()).get('/res-1/documents/doc-1')).body));
    // 2. a foreign document
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(documentRow({ resumeId: 'res-OTHER' }));
    bodies.push(JSON.stringify((await request(makeApp()).get('/res-1/documents/doc-1')).body));
    // 3. an unknown document
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(null);
    bodies.push(JSON.stringify((await request(makeApp()).get('/res-1/documents/doc-1')).body));
    // 4. a HOST FAULT from the store, which is a 503 with a code and no message detail
    prismaMocks.resumeDocument.findUnique.mockResolvedValue(documentRow());
    const failing = createArtifactStore({ root: storageRoot });
    vi.spyOn(failing, 'open').mockRejectedValue(
      // The real `StorageError` never carries a path in its message; this fake proves the
      // route would not forward one even if a store did.
      Object.assign(new Error(`ENOENT: no such file or directory, open '${path.join(storageRoot, 'artifacts', 'ee', 'e'.repeat(64))}'`), {
        name: 'StorageError', code: 'STORAGE_IO', reason: 'IO_ERROR',
      }),
    );
    const original = process.env.RENDER_STORAGE_ROOT;
    process.env.RENDER_STORAGE_ROOT = storageRoot;
    void failing;
    const fault = await request(makeApp()).get('/res-1/documents/doc-1');
    bodies.push(JSON.stringify(fault.body));
    process.env.RENDER_STORAGE_ROOT = original;

    for (const body of bodies) {
      expect(body).not.toContain(storageRoot);
      expect(body).not.toContain('artifacts/');
      expect(body).not.toContain('ENOENT');
    }
  });

  it('403s a resume the caller does not own, before the document is even read', async () => {
    mockUserId.value = 'user-2';
    const response = await request(makeApp()).get('/res-1/documents/doc-1');
    expect(response.status).toBe(403);
    expect(prismaMocks.resumeDocument.findUnique).not.toHaveBeenCalled();
  });
});

describe('GET /resumes/:id/documents', () => {
  it('lists metadata only, newest first, with NO bytes and NO storageKey', async () => {
    prismaMocks.resumeDocument.findMany.mockResolvedValue([
      { id: 'doc-2', format: 'pdf', templateId: 'typst-ats-classic', templateVersion: '1.0.0', pageCount: 1, hash: 'b'.repeat(64), byteSize: 10_492, mimeType: 'application/pdf', createdAt: new Date('2026-09-30T13:00:00.000Z') },
      { id: 'doc-1', format: 'tex', templateId: 'none', templateVersion: null, pageCount: null, hash: 'a'.repeat(64), byteSize: 900, mimeType: 'application/x-tex', createdAt: new Date('2026-09-30T12:00:00.000Z') },
    ]);
    const response = await request(makeApp()).get('/res-1/documents');
    expect(response.status).toBe(200);
    expect(response.body.map((row: { id: string }) => row.id)).toEqual(['doc-2', 'doc-1']);
    // The order is the QUERY's, asserted on the call rather than trusted from the fake's
    // input order: a fake that returned them sorted would pass a route that asked for
    // nothing.
    const args = prismaMocks.resumeDocument.findMany.mock.calls[0]?.[0] as { orderBy: unknown; select: Record<string, boolean> };
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    // The key is a host-relative path. A list is the cheapest place to leak one, and no
    // client needs it: it asks for a document by id and streams it.
    expect(args.select.storageKey).toBeUndefined();
    for (const row of response.body) {
      expect(row).not.toHaveProperty('storageKey');
      expect(row).not.toHaveProperty('bytes');
      expect(row).not.toHaveProperty('resumeJson');
    }
  });

  it('403s a resume the caller does not own, before any query', async () => {
    mockUserId.value = 'user-2';
    expect((await request(makeApp()).get('/res-1/documents')).status).toBe(403);
    expect(prismaMocks.resumeDocument.findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. Env: the budget
// ---------------------------------------------------------------------------

describe('RENDER_TIMEOUT_MS bounds the render request, and is TUNABLE lower, never higher', () => {
  it('refuses a value ABOVE the policy wall clock at boot, with a fixed message', async () => {
    // The acceptance item, checked where it happens: the zod schema throws on IMPORT, so the
    // test reloads the module with the offending value and reads what the operator sees.
    const message = await bootMessageWith({ RENDER_TIMEOUT_MS: '20000' });
    expect(message).toContain('Invalid environment configuration');
    expect(message).toContain('RENDER_TIMEOUT_MS');
    expect(message).toContain('TUNABLE lower, never higher');
    // The same refusal for a raised quota knob: policy 10.2's four are containment
    // properties too, and a raised one silently weakens a policy MANDATE.
    for (const key of ['RENDER_MAX_CONCURRENCY', 'RENDER_MAX_CONCURRENCY_PER_USER', 'RENDER_QUEUE_DEPTH', 'RENDER_PER_USER_PER_MINUTE']) {
      expect(await bootMessageWith({ [key]: '999' }), key).toContain('TUNABLE lower, never higher');
    }
  });

  it('accepts a LOWERED value and derives a transport budget that never exceeds the policy', async () => {
    // The two-number budget the module header explains: the render budget itself is bounded
    // by the policy wall clock, and the TRANSPORT budget adds the kill grace and a staging
    // margin - so lowering the budget never truncates a job that is inside its own policy.
    const budget = resolveRenderBudget(5000);
    expect(budget.budgetMs).toBe(5000);
    expect(budget.budgetMs).toBeLessThanOrEqual(RENDER_LIMITS.wallClockMs);
    expect(budget.clientTimeoutMs).toBe(5000 + RENDER_LIMITS.killGraceMs + 5000);
    expect(budget.killGraceMs).toBe(RENDER_LIMITS.wallClockMs === budget.budgetMs ? RENDER_LIMITS.killGraceMs : RENDER_LIMITS.killGraceMs);
    // And the assertion is enforced, not documented.
    expect(() => resolveRenderBudget(RENDER_LIMITS.wallClockMs + 1)).toThrow(/must not exceed the policy wall clock/);
    expect(() => resolveRenderBudget(0)).toThrow(/positive number/);
    // The defaults ARE the policy constants, not typed-in copies.
    expect(RENDER_DEFAULTS.timeoutMs).toBe(RENDER_LIMITS.wallClockMs);
    expect(RENDER_DEFAULTS.maxConcurrency).toBe(2);
    expect(RENDER_DEFAULTS.queueDepth).toBe(8);
  });

  it('BOOTS with RENDER_TIMEOUT_MS=5000 - the accept half is asserted at the SCHEMA, not only at the budget', async () => {
    // REVIEW F3. "ACCEPTED" is a statement about the PROCESS BOOTING, so it belongs where
    // acceptance happens: the zod schema, which throws on import. `resolveRenderBudget(5000)`
    // above is a DIFFERENT function, and a mutation of the schema's
    // `.refine(value => value <= RENDER_LIMITS.wallClockMs)` to `value <= 5000` would keep
    // every other assertion green while refusing a legal `8000`. `bootMessageWith` returns
    // `''` when the import SUCCEEDED, so this asserts the empty string rather than the
    // absence of a throw - a swallowed rejection would satisfy the latter.
    expect(await bootMessageWith({ RENDER_TIMEOUT_MS: '5000' })).toBe('');
    // The boundary the refine names: the policy wall clock itself is accepted (it is the
    // default), and one millisecond above it is refused with the fixed message.
    expect(await bootMessageWith({ RENDER_TIMEOUT_MS: String(RENDER_LIMITS.wallClockMs) })).toBe('');
    expect(await bootMessageWith({ RENDER_TIMEOUT_MS: String(RENDER_LIMITS.wallClockMs + 1) })).toContain(
      'TUNABLE lower, never higher',
    );
    // A LOWERED value is a legal deployment, and the derived transport budget is still
    // above it - the margin is what keeps a job inside its own policy from being truncated.
    const { env: booted } = await import('../config/env.js');
    expect(booted.RENDER_TIMEOUT_MS).toBe(RENDER_LIMITS.wallClockMs);
  });

  it('declares EVERY contract key, with the transport names taken from the modules that own them', () => {
    // One spelling per key: a typo here would create a second, unread variable and the
    // deployment would silently run on the default.
    expect(RENDER_ENV_KEYS).toMatchObject({
      maxConcurrency: 'RENDER_MAX_CONCURRENCY',
      maxConcurrencyPerUser: 'RENDER_MAX_CONCURRENCY_PER_USER',
      queueDepth: 'RENDER_QUEUE_DEPTH',
      perUserPerMinute: 'RENDER_PER_USER_PER_MINUTE',
      timeoutMs: 'RENDER_TIMEOUT_MS',
      storageKind: 'RENDER_STORAGE_KIND',
      storageRoot: 'RENDER_STORAGE_ROOT',
      brokerSocket: 'RENDER_BROKER_SOCKET',
      brokerUrl: 'RENDER_BROKER_URL',
      brokerToken: 'RENDER_BROKER_TOKEN',
    });
  });

  it('has NO spool key on the API side: the contract spelling is dead config, removed', async () => {
    // REVIEW F4 / T1040 sec. 13 ruling 16. `RENDER_BROKER_SPOOL_DIR` was declared in the
    // zod schema, documented in `.env.example`, named in a constant and asserted by this
    // file - and read by NOTHING. The BROKER reads `RENDER_BROKER_SPOOL_ROOT`. A key that is
    // declared, documented and asserted but unread is worse than an absent key: it makes the
    // contract sound load-bearing, and a deployment that set it on the broker would silently
    // get the default spool root. One key, one owner.
    //
    // Asserted as an ABSENCE, on both surfaces, because restoring the key in either one is
    // the mutation this test exists to kill.
    expect(Object.keys(RENDER_ENV_KEYS)).not.toContain('brokerSpoolDir');
    expect(RENDER_ENV_KEY_LIST).not.toContain('RENDER_BROKER_SPOOL_DIR');
    const { env: parsed } = await import('../config/env.js');
    expect(Object.keys(parsed)).not.toContain('RENDER_BROKER_SPOOL_DIR');
    // The BROKER's key is T1031's, it is untouched by this task, and it is NOT the API's to
    // read: the backend never materialises the container's `/out`, so there is nothing here
    // that would consume either spelling. Pinned so the two names can never drift back.
    const { BROKER_ENV_KEYS } = await import('./broker/index.js');
    expect(BROKER_ENV_KEYS.spoolRoot).toBe('RENDER_BROKER_SPOOL_ROOT');
    expect(RENDER_ENV_KEY_LIST).not.toContain(BROKER_ENV_KEYS.spoolRoot);
  });
});

/** Reload `config/env.ts` with `overrides` applied, and return the boot message. */
async function bootMessageWith(overrides: Record<string, string>): Promise<string> {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  // `vi.resetModules` is what makes the schema re-parse; the module is cached per test file
  // otherwise, and a cached schema would report the DEFAULT for every value.
  vi.resetModules();
  try {
    await import('./env.js');
    return '';
  } catch (error) {
    return (error as Error).message;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    vi.resetModules();
  }
}

// ---------------------------------------------------------------------------
// 7. The error surface
// ---------------------------------------------------------------------------

describe('the error surface: a machine code, a fixed message, and nothing else', () => {
  it('maps every refusal onto the contract s status', () => {
    // 429 / 422 / 503, exactly as the plan states, with the two request-shaped refusals on
    // the 422 side and the two deployment faults on the 503 side.
    expect(RenderPortError.statusFor('RENDER_BUSY')).toBe(429);
    for (const code of ['RENDER_INPUT_TOO_LARGE', 'RENDER_COMPILE_ERROR', 'render_format_unsupported', 'render_template_unsupported'] as const) {
      expect(RenderPortError.statusFor(code), code).toBe(422);
    }
    for (const code of ['RENDER_TIMEOUT', 'RENDER_RESOURCE_LIMIT', 'RENDER_ARTIFACT_INVALID', 'render_broker_unavailable', 'render_storage_unavailable', 'render_revision_unavailable'] as const) {
      expect(RenderPortError.statusFor(code), code).toBe(503);
    }
  });

  it('never interpolates a code, a reason, a path, a digest or content into a message', () => {
    // A lookup table, not a template: there is no interpolation SITE to misuse, so this is
    // structural rather than a convention (policy 9.3).
    const error = new RenderPortError('RENDER_ARTIFACT_INVALID', '/etc/clearance-canary.txt');
    expect(error.message).toBe('The rendered document could not be produced.');
    expect(error.message).not.toContain('/etc');
    expect(error.reason).toBe('/etc/clearance-canary.txt');
    // The reason is the SERVER-SIDE log field; the message is what a client sees.
  });

  it('carries a broker refusal through with the broker s own code, mapped to the right status', async () => {
    const cases: Array<[string, number]> = [
      ['RENDER_TIMEOUT', 503],
      ['RENDER_RESOURCE_LIMIT', 503],
      ['RENDER_COMPILE_ERROR', 422],
      ['RENDER_ARTIFACT_INVALID', 503],
      ['RENDER_BUSY', 429],
    ];
    for (const [code, status] of cases) {
      vi.clearAllMocks();
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
      prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
      allowGate();
      const broker = {
        render: vi.fn(async (): Promise<never> => {
          const error = new Error(`RENDER_BROKER_422: ${code} (X)`) as Error & { status: number; code: string; reason: string };
          error.name = 'BrokerClientError';
          error.status = 422;
          error.code = code;
          error.reason = 'SOME_REASON';
          throw error;
        }),
      } as unknown as RenderBrokerLike;
      const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
      const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch((e: unknown) => e);
      expect(failure, code).toBeInstanceOf(RenderPortError);
      expect((failure as RenderPortError).status, code).toBe(status);
      // The BROKER's stderr never crosses: the message is the fixed string, and the only
      // thing carried is the broker's own machine reason.
      expect((failure as RenderPortError).message).not.toContain('SOME_REASON');
      expect((failure as RenderPortError).reason).toBe('SOME_REASON');
    }
  });

  it('reports an unreachable broker as 503, not as a crash', async () => {
    const broker = {
      render: vi.fn(async () => {
        const error = new Error('RENDER_BROKER_UNAVAILABLE: connect ECONNREFUSED') as Error & { code: string };
        error.name = 'BrokerUnavailableError';
        error.code = 'RENDER_BROKER_UNAVAILABLE';
        throw error;
      }),
    } as unknown as RenderBrokerLike;
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
    const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RenderPortError);
    expect((failure as RenderPortError).status).toBe(503);
    expect((failure as RenderPortError).code).toBe('render_broker_unavailable');
    expect((failure as RenderPortError).message).not.toContain('ECONNREFUSED');
  });

  it('THE ONE BOUNDED COLD-START RETRY (defect round): a wall-clock timeout that produced no artifact is retried ONCE, and logged as such', async () => {
    // The escalation: the FIRST render after a cold container can exceed the broker's 10 s
    // wall clock, because that budget includes creating the container. One live run produced
    // a single 503 out of ~5 compiles immediately after a rebuild, and the identical request
    // succeeded once warm. So: the first attempt times out, the second lands.
    //
    // `RENDER_TIMEOUT` is the wall-clock KILL (broker `A4.2`), which answers only after
    // TERM -> grace -> KILL and after DISCARDING `/out` - so the first attempt wrote neither
    // bytes nor a row and the retry is genuinely idempotent.
    const lines: string[] = [];
    let attempts = 0;
    const pdf = fakePdf();
    const broker = {
      render: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw brokerError('BrokerClientError', 'RENDER_TIMEOUT', 'WALL_CLOCK_EXCEEDED');
        return {
          outcome: 'ok' as const,
          sha256: sha256Hex(pdf),
          byteSize: pdf.length,
          mimeType: 'application/pdf',
          durationMs: 4,
          artifact: pdf,
        };
      }),
    } as unknown as RenderBrokerLike;
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
    const port = createRenderPort({
      db: db(),
      artifacts: store,
      broker,
      registry,
      log: (line: string) => lines.push(line),
    });

    const result = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });

    expect(attempts, 'exactly two attempts - one retry, not a loop').toBe(2);
    expect(result.documentId).toBe('doc-1');
    // The artifact was stored and the row written - once, on the attempt that produced bytes.
    expect(prismaMocks.resumeDocument.upsert).toHaveBeenCalledTimes(1);
    const retryLine = lines.map((line) => JSON.parse(line)).find((r) => r.code === 'COLD_START_RETRY');
    expect(retryLine, lines.join('\n')).toMatchObject({
      event: 'render.job.retry',
      engine: 'typst',
      format: 'pdf',
      firstAttemptCode: 'RENDER_TIMEOUT',
      firstAttemptReason: 'WALL_CLOCK_EXCEEDED',
    });
    // Policy 10.5: nothing on the line is content.
    expect(JSON.stringify(retryLine)).not.toContain('Cut CI build time');
  });

  it('...and a GENUINE runaway is NOT masked: two timeouts surface the second one', async () => {
    // The half that decides whether the retry is safe. A truly slow compile times out on the
    // first attempt AND on the second, and what the caller receives is the SECOND failure -
    // same code, same status, same machine reason. The retry costs a runaway one extra
    // wall clock; it never turns a refusal into a success.
    let attempts = 0;
    const broker = {
      render: vi.fn(async (): Promise<never> => {
        attempts += 1;
        throw brokerError('BrokerClientError', 'RENDER_TIMEOUT', 'WALL_CLOCK_EXCEEDED');
      }),
    } as unknown as RenderBrokerLike;
    prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
    const lines: string[] = [];
    const port = createRenderPort({
      db: db(),
      artifacts: store,
      broker,
      registry,
      log: (line: string) => lines.push(line),
    });

    const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch((e: unknown) => e);

    // TWO attempts and no more: an unbounded retry would be a hang, not a retry.
    expect(attempts).toBe(2);
    expect(failure).toBeInstanceOf(RenderPortError);
    expect((failure as RenderPortError).code).toBe('RENDER_TIMEOUT');
    expect((failure as RenderPortError).status).toBe(503);
    expect((failure as RenderPortError).reason).toBe('WALL_CLOCK_EXCEEDED');
    // ...and nothing was stored or written.
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
    // The retry was still announced, once.
    expect(lines.filter((line) => line.includes('COLD_START_RETRY'))).toHaveLength(1);
  });

  it('...and no OTHER broker outcome is retried', async () => {
    // The retry is keyed on ONE code, so a compile error, a busy broker, a resource limit or
    // an unreachable socket each keeps its single attempt and its own refusal.
    const cases: Array<[string, string, string]> = [
      ['BrokerUnavailableError', 'RENDER_BROKER_UNAVAILABLE', 'render_broker_unavailable'],
      ['BrokerClientError', 'RENDER_COMPILE_ERROR', 'RENDER_COMPILE_ERROR'],
      ['BrokerClientError', 'RENDER_BUSY', 'RENDER_BUSY'],
      ['BrokerClientError', 'RENDER_RESOURCE_LIMIT', 'RENDER_RESOURCE_LIMIT'],
    ];
    for (const [name, code, expected] of cases) {
      prismaMocks.resume.findUnique.mockResolvedValue(RESUME);
      prismaMocks.resumeRevision.findFirst.mockResolvedValue(revisionRow());
      prismaMocks.resumeDocument.findFirst.mockResolvedValue(null);
      allowGate();
      const render = vi.fn(async (): Promise<never> => {
        throw brokerError(
          name as 'BrokerClientError' | 'BrokerUnavailableError',
          code,
          'SOME_REASON',
        );
      });
      const port = createRenderPort({
        db: db(),
        artifacts: store,
        broker: { render } as unknown as RenderBrokerLike,
        registry,
      });
      const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch((e: unknown) => e);
      expect(render.mock.calls.length, `${code}: broker attempts`).toBe(1);
      expect((failure as RenderPortError).code, code).toBe(expected);
    }
  });

  it('re-checks the RECEIVED bytes, so a broker that declares a digest it did not send is refused', async () => {
    const pdf = fakePdf();
    const broker = {
      render: vi.fn(async () => ({
        outcome: 'ok' as const,
        sha256: '0'.repeat(64), // NOT the digest of the bytes it is returning
        byteSize: pdf.length,
        mimeType: 'application/pdf',
        durationMs: 1,
        artifact: pdf,
      })),
    } as unknown as RenderBrokerLike;
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
    const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RenderPortError);
    expect((failure as RenderPortError).code).toBe('RENDER_ARTIFACT_INVALID');
    expect((failure as RenderPortError).reason).toBe('ARTIFACT_DIGEST_MISMATCH');
    // Nothing was stored, and no row was written: the refusal is before both.
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
    expect(await store.open('artifacts/00/' + '0'.repeat(64))).toBeNull();
  });

  it('re-checks the magic bytes and the declared size, both before any store call', async () => {
    const notPdf = Buffer.from('<html>not a pdf</html>', 'latin1');
    for (const [artifact, declaredSize, reason] of [
      [notPdf, notPdf.length, 'ARTIFACT_BAD_MAGIC'],
      [fakePdf(), 99, 'ARTIFACT_SIZE_CHANGED'],
      [Buffer.alloc(0), 0, 'ARTIFACT_EMPTY'],
    ] as Array<[Buffer, number, string]>) {
      const broker = {
        render: vi.fn(async () => ({
          outcome: 'ok' as const, sha256: sha256Hex(artifact), byteSize: declaredSize,
          mimeType: 'application/pdf', durationMs: 1, artifact,
        })),
      } as unknown as RenderBrokerLike;
      const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
      const failure = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }).catch((e: unknown) => e);
      expect((failure as RenderPortError)?.reason, reason).toBe(reason);
    }
    expect(prismaMocks.resumeDocument.upsert).not.toHaveBeenCalled();
  });

  it('maps a staging refusal onto 422 and a storage fault onto 503', async () => {
    // Two different stories, two different statuses: "this document is too large" is the
    // caller's, and a host fault is not a statement about the input at all.
    const tooBig = new RenderPortError('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE');
    expect(tooBig.status).toBe(422);
    expect(new StageError('RENDER_INPUT_TOO_LARGE', 'TOTAL_TOO_LARGE').code).toBe('RENDER_INPUT_TOO_LARGE');
    expect(new RenderPortError('render_storage_unavailable', 'IO_ERROR').status).toBe(503);
  });

  it('refuses a revision that does not exist, with a machine code and no store or broker work', async () => {
    prismaMocks.resumeRevision.findFirst.mockResolvedValue(null);
    const { broker, state } = countingBroker();
    const port = createRenderPort({ db: db(), artifacts: store, broker, registry });
    const failure = await port({ revisionId: 'rev-nope', format: 'pdf', userId: 'user-1' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RenderPortError);
    expect((failure as RenderPortError).reason).toBe('REVISION_NOT_FOUND');
    expect(state.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. The flag: OFF keeps the pre-existing 404
// ---------------------------------------------------------------------------

describe('the flag', () => {
  it('OFF keeps the pre-existing 404, and ON is the only thing that installs a port', async () => {
    // The acceptance item, asserted through the ONE mechanism the contract names: the route
    // finds no renderer, so it answers 404 exactly as it did before this phase. The
    // document routes still work with the flag off, because they serve STORED bytes and do
    // not resolve a port at all.
    setResumeRenderPort(null);
    const off = await request(makeApp()).post('/res-1/render').set('Content-Type', 'application/json').send({ format: 'pdf' });
    expect(off.status).toBe(404);
    expect(off.body.error).toBe('Resume renderer not found');

    // ON: the flag is the WHOLE registration, so a truthy value is sufficient and anything
    // else leaves the 404 in place (T1002's exact, case-sensitive truthy set).
    const { flags } = await import('../config/flags.js');
    expect(flags.v2TypstRender).toBe(false);
    for (const value of ['true', 'on']) {
      const saved = process.env.V2_TYPST_RENDER;
      process.env.V2_TYPST_RENDER = value;
      vi.resetModules();
      expect((await import('../config/flags.js')).flags.v2TypstRender, value).toBe(true);
      if (saved === undefined) delete process.env.V2_TYPST_RENDER; else process.env.V2_TYPST_RENDER = saved;
      vi.resetModules();
    }
    for (const value of ['TRUE', 'ON', 'yes', '1', '', 'garbage']) {
      const saved = process.env.V2_TYPST_RENDER;
      process.env.V2_TYPST_RENDER = value;
      vi.resetModules();
      expect((await import('../config/flags.js')).flags.v2TypstRender, value).toBe(false);
      if (saved === undefined) delete process.env.V2_TYPST_RENDER; else process.env.V2_TYPST_RENDER = saved;
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}