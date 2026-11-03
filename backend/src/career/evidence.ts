// =====================================================================================
// career/evidence.ts - EvidenceSource create / read (T1011, 05 sec.5, ADR-041 D2).
//
// An EvidenceSource is "where a claim came from": an uploaded resume, a URL, a
// pasted note, a JSON Resume import, a GitHub repo, a job posting. It is the
// provenance anchor of the claim layer, and it is the FIRST place idempotency
// matters, because a user re-uploads the same file:
//
//   `@@unique([profileId, contentHash])` + a pure no-op on an existing hash means
//   re-importing the same document is a NO-OP (05 sec.5 index rationale:
//   "EvidenceSource(profileId,contentHash) @unique - re-import is a no-op").
//   Exactly like `createClaim`, a re-observation never rewrites the stored row.
//
// ADR-041 D2: BYTES NEVER LIVE IN POSTGRES. This module has no binary field to
// write even by accident - `byteSize` is metadata, the object itself is addressed by
// `storageKey` in the storage abstraction, exactly like `ResumeDocument`.
//
// The DB seam is injected (`CareerStore`, from `career/claims.ts`); this module never
// imports the `prisma` singleton, so it is unit testable with no live database.
// =====================================================================================

import { createHash } from 'node:crypto';
import { EvidenceKind, type Prisma } from '@prisma/client';
import {
  ClaimInvariantError,
  type CareerStore,
  type EvidenceSourceRow,
} from './claims.js';

const EVIDENCE_KIND_VALUES: readonly string[] = Object.values(EvidenceKind);

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === 'string' && EVIDENCE_KIND_VALUES.includes(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Canonical form of an evidence document's text, used ONLY for `contentHash`.
 * Line endings are unified, trailing whitespace is dropped per line, and runs of
 * blank lines collapse - so the same file uploaded from Windows, macOS or through a
 * text editor is recognised as the same source. Interior spacing is NOT collapsed:
 * a resume's layout is part of what a reviewer is looking at, and over-normalising
 * would merge two genuinely different files.
 */
export function normalizeEvidenceText(text: string): string {
  if (typeof text !== 'string') {
    throw new ClaimInvariantError('evidence text must be a string');
  }
  return text
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `sha256` of the normalized text: the `(profileId, contentHash)` dedupe key. */
export function evidenceContentHash(text: string): string {
  const normalized = normalizeEvidenceText(text);
  if (normalized.length === 0) {
    throw new ClaimInvariantError('an evidence content hash needs non-empty text');
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Create / dedupe
// ---------------------------------------------------------------------------

export interface EvidenceCreateInput {
  profileId: string;
  kind: EvidenceKind;
  title: string;
  /**
   * The extracted text to hash. Supply either this or a pre-computed `contentHash`
   * (a caller that already hashed the bytes, e.g. the storage adapter).
   */
  text?: string | null;
  contentHash?: string | null;
  url?: string | null;
  mimeType?: string | null;
  /** ADR-041 D2: the object lives in the storage abstraction; this is its key. */
  storageKey?: string | null;
  /** Metadata only - never the bytes (there is no `Bytes` field on this model). */
  byteSize?: number | null;
  uploadedFileId?: string | null;
  extractedText?: string | null;
  /** Informational only (05 sec.5: "trustLevel informational only"). */
  trustLevel?: number | null;
  capturedAt?: Date | null;
}

export type EvidenceWriteOutcome = 'created' | 'deduped';

export interface EvidenceWriteResult {
  outcome: EvidenceWriteOutcome;
  source: EvidenceSourceRow;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ClaimInvariantError(`${field} must be a string or null`);
  }
  return value;
}

function evidenceCreateData(input: EvidenceCreateInput): Prisma.EvidenceSourceUncheckedCreateInput {
  if (input === null || typeof input !== 'object') {
    throw new ClaimInvariantError('createEvidenceSource needs an input object');
  }
  const context = 'createEvidenceSource';
  if (typeof input.profileId !== 'string' || input.profileId.length === 0) {
    throw new ClaimInvariantError(`${context}: a non-empty profileId is required`);
  }
  if (!isEvidenceKind(input.kind)) {
    throw new ClaimInvariantError(
      `${context}: kind must be an EvidenceKind enum value, got ${JSON.stringify(input.kind)}`,
    );
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    throw new ClaimInvariantError(`${context}: a non-empty title is required`);
  }
  const hash =
    input.contentHash === undefined || input.contentHash === null
      ? input.text === undefined || input.text === null
        ? null
        : evidenceContentHash(input.text)
      : input.contentHash;
  if (hash === null) {
    throw new ClaimInvariantError(
      `${context}: supply either text (hashed into contentHash) or an explicit contentHash - it is the (profileId, contentHash) dedupe key`,
    );
  }
  if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
    throw new ClaimInvariantError(
      `${context}: contentHash must be 64 lowercase hex characters (sha256), got ${JSON.stringify(hash)}`,
    );
  }
  if (
    input.byteSize !== undefined &&
    input.byteSize !== null &&
    (typeof input.byteSize !== 'number' || !Number.isInteger(input.byteSize) || input.byteSize < 0)
  ) {
    throw new ClaimInvariantError(`${context}: byteSize must be a non-negative integer (metadata only)`);
  }
  if (
    input.trustLevel !== undefined &&
    input.trustLevel !== null &&
    (typeof input.trustLevel !== 'number' || !Number.isInteger(input.trustLevel))
  ) {
    throw new ClaimInvariantError(`${context}: trustLevel must be an integer (informational only)`);
  }

  return {
    profileId: input.profileId,
    kind: input.kind,
    title: input.title.trim(),
    contentHash: hash,
    url: nullableString(input.url, 'url'),
    mimeType: nullableString(input.mimeType, 'mimeType'),
    storageKey: nullableString(input.storageKey, 'storageKey'),
    byteSize: input.byteSize ?? null,
    uploadedFileId: nullableString(input.uploadedFileId, 'uploadedFileId'),
    extractedText: nullableString(input.extractedText, 'extractedText'),
    trustLevel: input.trustLevel ?? undefined,
    capturedAt: input.capturedAt ?? undefined,
  };
}

/**
 * Register an evidence source, or return the existing one when the same
 * `(profileId, contentHash)` was already registered. The dedupe is a pure NO-OP on
 * the existing row - a re-uploaded file is not re-titled, re-hashed or re-dated, so
 * the claims that point at the source keep pointing at the same row.
 */
export async function createEvidenceSource(
  input: EvidenceCreateInput,
  store: CareerStore,
): Promise<EvidenceWriteResult> {
  const data = evidenceCreateData(input);
  const existing = await store.evidenceSource.findFirst({
    where: { profileId: data.profileId, contentHash: data.contentHash },
  });
  if (existing) return { outcome: 'deduped', source: existing };
  const source = await store.evidenceSource.create({ data });
  return { outcome: 'created', source };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const DEFAULT_EVIDENCE_PAGE = 100;
export const MAX_EVIDENCE_PAGE = 500;

export async function getEvidenceSourceById(
  sourceId: string,
  store: CareerStore,
): Promise<EvidenceSourceRow | null> {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    throw new ClaimInvariantError('getEvidenceSourceById needs a non-empty sourceId');
  }
  return store.evidenceSource.findFirst({ where: { id: sourceId } });
}

export async function findEvidenceSourceByHash(
  profileId: string,
  contentHash: string,
  store: CareerStore,
): Promise<EvidenceSourceRow | null> {
  if (typeof profileId !== 'string' || profileId.length === 0) {
    throw new ClaimInvariantError('findEvidenceSourceByHash needs a non-empty profileId');
  }
  if (typeof contentHash !== 'string' || !SHA256_HEX.test(contentHash)) {
    throw new ClaimInvariantError('findEvidenceSourceByHash needs a sha256 contentHash');
  }
  return store.evidenceSource.findFirst({ where: { profileId, contentHash } });
}

export interface ListEvidenceQuery {
  profileId: string;
  kind?: EvidenceKind;
  limit?: number;
  offset?: number;
}

function clampPage(limit: unknown, fallback: number, max: number): number {
  if (limit === undefined || limit === null) return fallback;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(Math.floor(limit), max);
}

export async function listEvidenceSources(
  query: ListEvidenceQuery,
  store: CareerStore,
): Promise<EvidenceSourceRow[]> {
  if (query === null || typeof query !== 'object') {
    throw new ClaimInvariantError('listEvidenceSources needs a query object');
  }
  if (typeof query.profileId !== 'string' || query.profileId.length === 0) {
    throw new ClaimInvariantError('listEvidenceSources needs a non-empty profileId');
  }
  if (query.kind !== undefined && !isEvidenceKind(query.kind)) {
    throw new ClaimInvariantError('listEvidenceSources: kind must be an EvidenceKind enum value');
  }
  return store.evidenceSource.findMany({
    where: {
      profileId: query.profileId,
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
    },
    orderBy: { capturedAt: 'desc' },
    take: clampPage(query.limit, DEFAULT_EVIDENCE_PAGE, MAX_EVIDENCE_PAGE),
    ...(query.offset !== undefined && query.offset > 0 ? { skip: Math.floor(query.offset) } : {}),
  });
}
