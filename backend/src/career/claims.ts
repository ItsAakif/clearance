// =====================================================================================
// career/claims.ts - create / read / update CareerClaim rows (T1011, ADR-036).
//
// ADR-036 IS THE INVARIANT THIS MODULE EXISTS TO PROTECT: "AI inference is never the
// same as user-confirmed experience, and the system must never silently convert one
// into the other (including an LLM re-extracting a claim and quietly upgrading it)".
// Three mechanical rules, all enforced HERE, in code, not in prompt prose:
//
//   1. `status = user_confirmed` is UNREACHABLE from this module. The database CANNOT
//      enforce the rule on its own: "user_confirmed requires a ClaimVerification row
//      with action IN (confirm, edit_confirm) and a non-null actorUserId" is not
//      expressible in Prisma (05 sec.8), and the T1010 migration deliberately ships no
//      raw trigger. So that guarantee lives in the service layer: the write types below
//      have no `status` member, `updateClaimAttributes` THROWS when one is smuggled in
//      at runtime, and `career/verification.ts` is the only module permitted to set
//      claim status (asserted by source guards in `claimWriterAI.test.ts`).
//   2. A claim is identified by `fingerprint = sha256(kind + normalize(statement))`
//      under `@@unique([profileId, fingerprint])`. Re-observing a fingerprint is a
//      NO-OP: no duplicate row, no status change, no resurrection of a rejected claim
//      (ADR-036 item 4, 05 sec.2.4). `createClaim` is the single implementation of
//      that dedupe for every writer, AI and human alike.
//   3. `confidence` is producer metadata, ORTHOGONAL to `status` (05 sec.4). A claim
//      the model is 0.99 sure about is still `inferred` and still cannot enter a
//      rendered resume.
//
// The DB seam is INJECTED (`CareerStore`), never imported: these services are unit
// testable with no live database (repo convention, cf. `evaluation/pipeline.ts`), and
// the career layer cannot reach the `prisma` singleton by accident. `prisma.ts` is not
// referenced anywhere under `backend/src/career/`.
// =====================================================================================

import { createHash } from 'node:crypto';
import {
  ClaimKind,
  ClaimStatus,
  type CareerClaim,
  type ClaimProvenance,
  type ClaimVerification,
  type EvidenceSource,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// The injected DB seam
// ---------------------------------------------------------------------------

/**
 * Narrowest seam each module needs, `Pick`ed from the generated client so a service
 * can never drift from a real column name while still being trivially fakeable.
 * `CareerStore` (below) is assignable to every one of them, so a caller can always
 * hand the whole client to any function in `backend/src/career/`.
 */
export type CareerClaimStore = Pick<PrismaClient, 'careerClaim'>;
export type CareerVerificationStore = Pick<PrismaClient, 'claimVerification'>;
export type CareerEvidenceStore = Pick<PrismaClient, 'evidenceSource'>;

/** Everything a transaction callback receives (what Prisma hands it). */
export type CareerTxStore = CareerClaimStore & CareerVerificationStore & CareerEvidenceStore;

/**
 * The seam every function in `backend/src/career/` takes as its LAST argument.
 * `$transaction` is spelled out rather than picked from `PrismaClient` so the
 * callback parameter can be typed as `CareerTxStore` (Prisma's own interactive
 * transaction callback does not get `$transaction` back).
 */
export interface CareerStore extends CareerTxStore {
  $transaction<T>(fn: (tx: CareerTxStore) => Promise<T>): Promise<T>;
}

/** Row shapes, taken from the generated client so no column name can drift. */
export type CareerClaimRow = CareerClaim;
export type ClaimVerificationRow = ClaimVerification;
export type EvidenceSourceRow = EvidenceSource;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An attempt to break ADR-036 (or another documented hard rule of this layer). */
export class ClaimInvariantError extends Error {
  readonly code = 'claim_invariant' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ClaimInvariantError';
  }
}

export class ClaimNotFoundError extends Error {
  readonly code = 'claim_not_found' as const;

  constructor(claimId: string) {
    super(`career claim not found: ${claimId}`);
    this.name = 'ClaimNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

/**
 * The ONLY statuses a claim may be CREATED with. `user_confirmed`, `rejected` and
 * `superseded` are unreachable by construction: they are neither members of this
 * tuple nor accepted by `assertAIWritableClaimStatus`, and the transition table in
 * `career/verification.ts` is the only place they are ever written.
 */
export const AI_WRITABLE_CLAIM_STATUSES = [ClaimStatus.inferred, ClaimStatus.contextual] as const;

/** The narrowed status type used by every create/write input in this layer. */
export type AIWritableClaimStatus = (typeof AI_WRITABLE_CLAIM_STATUSES)[number];

export function isAIWritableClaimStatus(value: unknown): value is AIWritableClaimStatus {
  return (
    typeof value === 'string' &&
    (AI_WRITABLE_CLAIM_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Runtime half of the "type AND guard" defence (ADR-036 item 2). The TypeScript type
 * `AIWritableClaimStatus` already excludes every other literal; this function closes
 * the hole that untyped/JSON callers (a route body, an LLM JSON blob, `as any`) would
 * otherwise walk straight through.
 */
export function assertAIWritableClaimStatus(value: unknown, context: string): AIWritableClaimStatus {
  if (!isAIWritableClaimStatus(value)) {
    throw new ClaimInvariantError(
      `${context}: status must be one of ${AI_WRITABLE_CLAIM_STATUSES.join('|')}, got ${JSON.stringify(
        value,
      )} - a claim is only ever CREATED as inferred or contextual; a confirming status is reachable only through career/verification.ts with a ClaimVerification row (ADR-036)`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fingerprint + normalization
// ---------------------------------------------------------------------------

/**
 * ASCII Unit Separator between the hashed fields: `kind` and the statement can never
 * be confused with one another by concatenation ("ach" + "ievement" vs ...).
 */
const FIELD_SEPARATOR = '\u001f';

const CLAIM_KIND_VALUES: readonly string[] = Object.values(ClaimKind);

/**
 * Canonical form of an atomic statement, used ONLY for the fingerprint. The stored
 * text keeps the caller's wording (`statement.trim()`), so the audit trail and the
 * pre-render gate compare what the user actually read.
 *
 * NFKC -> lowercase -> whitespace collapse -> trim. Punctuation is deliberately NOT
 * stripped: "Managed a team." and "Managed a team" are near-certainly the same fact,
 * but a rule that guesses wrongly silently merges two claims, and the fingerprint is
 * the identity of the claim. Whitespace and case never change the fact.
 */
export function normalizeStatement(statement: string): string {
  if (typeof statement !== 'string') {
    throw new ClaimInvariantError('a claim statement must be a string');
  }
  return statement.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Stable identity of a claim: `sha256(kind + US + normalized statement)`, hex.
 * Stable across processes and runs (no clock, no random salt, no locale), which is
 * what makes re-observation idempotent (ADR-036 item 4).
 */
export function claimFingerprint(kind: ClaimKind, statement: string): string {
  const normalized = normalizeStatement(statement);
  if (normalized.length === 0) {
    throw new ClaimInvariantError('a claim fingerprint needs a non-empty statement');
  }
  return fingerprintOf(kind, normalized);
}

function fingerprintOf(kind: ClaimKind, normalizedStatement: string): string {
  return createHash('sha256')
    .update(`${kind}${FIELD_SEPARATOR}${normalizedStatement}`, 'utf8')
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

export function isClaimKind(value: unknown): value is ClaimKind {
  return typeof value === 'string' && CLAIM_KIND_VALUES.includes(value);
}

/** `confidence` is a producer belief in [0,1] and never touches `status`. */
export function assertConfidence(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ClaimInvariantError(
      `confidence must be a finite number in [0,1] (it is producer metadata, never a status); got ${JSON.stringify(
        value,
      )}`,
    );
  }
  return value;
}

/** The six optional entity attachments of `CareerClaim`; at most one may be set. */
export const CLAIM_ENTITY_FIELDS = [
  'experienceId',
  'educationId',
  'projectId',
  'skillId',
  'certificationId',
  'achievementId',
] as const;

export type ClaimEntityField = (typeof CLAIM_ENTITY_FIELDS)[number];

function assertSingleEntityAttachment(values: Record<string, unknown>, context: string): void {
  const set = CLAIM_ENTITY_FIELDS.filter((field) => {
    const value = values[field];
    return value !== undefined && value !== null;
  });
  if (set.length > 1) {
    throw new ClaimInvariantError(
      `${context}: at most one entity attachment may be set (05 sec.5), got ${set.join(', ')}`,
    );
  }
}

function assertProfileId(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ClaimInvariantError(`${context}: a non-empty profileId is required`);
  }
}

function assertStatement(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string' || normalizeStatement(value).length === 0) {
    throw new ClaimInvariantError(`${context}: a non-empty statement is required`);
  }
}

function assertClaimId(value: unknown, context: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ClaimInvariantError(`${context}: a non-empty claimId is required`);
  }
}

function assertNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new ClaimInvariantError(`${field} must be a string or null`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Create (the single dedupe implementation, shared by every writer)
// ---------------------------------------------------------------------------

/**
 * What may be written at CREATE time. Note what is ABSENT:
 * - `status` is `AIWritableClaimStatus` only (so `user_confirmed` does not compile);
 * - there is no `supersedesClaimId`: 05 sec.2.4 - a re-observation leaves
 *   `supersedesClaimId` unset unless the USER confirms the replacement.
 */
export interface ClaimCreateInput {
  profileId: string;
  kind: ClaimKind;
  statement: string;
  /** `inferred` (default) or `contextual`. Nothing else is assignable. */
  status?: AIWritableClaimStatus;
  provenance: ClaimProvenance;
  confidence?: number | null;
  inferenceMethod?: string | null;
  producedByModel?: string | null;
  evidenceSourceId?: string | null;
  experienceId?: string | null;
  educationId?: string | null;
  projectId?: string | null;
  skillId?: string | null;
  certificationId?: string | null;
  achievementId?: string | null;
}

export type ClaimWriteOutcome = 'created' | 'deduped';

export interface ClaimWriteResult {
  outcome: ClaimWriteOutcome;
  claim: CareerClaimRow;
}

/** Validate an input and render it as the row shape Prisma expects. */
function claimCreateData(input: ClaimCreateInput): Prisma.CareerClaimUncheckedCreateInput {
  if (input === null || typeof input !== 'object') {
    throw new ClaimInvariantError('createClaim needs an input object');
  }
  const context = 'createClaim';
  assertProfileId(input.profileId, context);
  if (!isClaimKind(input.kind)) {
    throw new ClaimInvariantError(
      `${context}: kind must be a ClaimKind enum value, got ${JSON.stringify(input.kind)}`,
    );
  }
  assertStatement(input.statement, context);
  const status = assertAIWritableClaimStatus(input.status ?? ClaimStatus.inferred, context);
  assertSingleEntityAttachment(input as unknown as Record<string, unknown>, context);

  return {
    profileId: input.profileId,
    kind: input.kind,
    statement: input.statement.trim(),
    fingerprint: fingerprintOf(input.kind, normalizeStatement(input.statement)),
    status,
    provenance: input.provenance,
    confidence: assertConfidence(input.confidence),
    inferenceMethod: assertNullableString(input.inferenceMethod, 'inferenceMethod'),
    producedByModel: assertNullableString(input.producedByModel, 'producedByModel'),
    evidenceSourceId: assertNullableString(input.evidenceSourceId, 'evidenceSourceId'),
    experienceId: assertNullableString(input.experienceId, 'experienceId'),
    educationId: assertNullableString(input.educationId, 'educationId'),
    projectId: assertNullableString(input.projectId, 'projectId'),
    skillId: assertNullableString(input.skillId, 'skillId'),
    certificationId: assertNullableString(input.certificationId, 'certificationId'),
    achievementId: assertNullableString(input.achievementId, 'achievementId'),
  };
}

/**
 * Create a claim, or return the existing one when the fingerprint was already
 * observed. The dedupe is a pure NO-OP on the existing row: no update, no status
 * change, no confidence rewrite. A second observation of identical content is
 * therefore idempotent, and a `rejected` claim is never resurrected to `inferred`
 * by a re-run (ADR-036 items 4-5).
 *
 * Hand-entered claims go through here too: a fresh user_entered claim is `inferred`
 * (unconfirmed) until the user confirms it through `verification.confirmClaim`,
 * which is the only path that can write `user_confirmed` and it always writes the
 * audit row in the same transaction.
 */
export async function createClaim(
  input: ClaimCreateInput,
  store: CareerClaimStore,
): Promise<ClaimWriteResult> {
  const data = claimCreateData(input);
  const existing = await store.careerClaim.findFirst({
    where: { profileId: data.profileId, fingerprint: data.fingerprint },
  });
  if (existing) return { outcome: 'deduped', claim: existing };
  const claim = await store.careerClaim.create({ data });
  return { outcome: 'created', claim };
}

// ---------------------------------------------------------------------------
// Update (never a status)
// ---------------------------------------------------------------------------

/**
 * Fields an ordinary update may touch. `status`, `profileId`, `kind` and
 * `fingerprint` are OMITTED FROM THE TYPE and refused at runtime:
 * - `status` belongs to `career/verification.ts` (ADR-036 item 3);
 * - `fingerprint` is derived, so it moves only with `updateClaimStatement`;
 * - `kind` likewise (a different kind is a different claim, not an edit);
 * - `profileId` would move a claim between people.
 */
export type ClaimAttributePatch = Omit<
  Prisma.CareerClaimUncheckedUpdateInput,
  'status' | 'profileId' | 'id' | 'fingerprint' | 'kind' | 'createdAt' | 'updatedAt'
>;

/** Keys `updateClaimAttributes` refuses even if they arrive from untyped input. */
export const FORBIDDEN_ATTRIBUTE_PATCH_KEYS = [
  'status',
  'profileId',
  'id',
  'fingerprint',
  'kind',
  'createdAt',
  'updatedAt',
] as const;

/**
 * Update the non-status attributes of a claim (confidence, evidence link, entity
 * attachment, `jobRelevance`, `inferenceMethod`, ...).
 *
 * Throws `ClaimInvariantError` when the patch carries `status` (or any other
 * reserved key). This is the runtime half of the ADR-036 guarantee: the type has no
 * `status` member, and an `as any` / JSON body cannot slip one past the type.
 */
export async function updateClaimAttributes(
  claimId: string,
  patch: ClaimAttributePatch,
  store: CareerClaimStore,
): Promise<CareerClaimRow> {
  assertClaimId(claimId, 'updateClaimAttributes');
  if (patch === null || typeof patch !== 'object') {
    throw new ClaimInvariantError('updateClaimAttributes needs a patch object');
  }
  const record = patch as Record<string, unknown>;
  for (const key of FORBIDDEN_ATTRIBUTE_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ClaimInvariantError(
        `updateClaimAttributes refuses to write "${key}": claim status is owned exclusively by career/verification.ts, which writes a ClaimVerification row in the same transaction (ADR-036 - AI inference is never user-confirmed experience)`,
      );
    }
  }
  if ('confidence' in record) assertConfidence(record.confidence);
  return store.careerClaim.update({ where: { id: claimId }, data: patch });
}

/**
 * Re-word a claim and move its fingerprint with it. Status is untouched (ADR-036
 * item 4: only `ClaimVerification` changes status).
 *
 * A `user_confirmed` claim is REFUSED: the text the user approved may only change
 * through `verification.editConfirmClaim`, so the audit row always describes the
 * text that is actually in the row. Editing it silently here would keep a
 * `user_confirmed` status on words the user never saw - the exact "silent upgrade /
 * silent drift" failure mode ADR-036 exists to stop.
 */
export async function updateClaimStatement(
  claimId: string,
  statement: string,
  store: CareerClaimStore,
): Promise<CareerClaimRow> {
  assertClaimId(claimId, 'updateClaimStatement');
  assertStatement(statement, 'updateClaimStatement');
  const existing = await requireClaimById(claimId, store);
  if (existing.status === ClaimStatus.user_confirmed) {
    throw new ClaimInvariantError(
      `claim ${claimId} is user_confirmed: re-word it through verification.editConfirmClaim (action=edit_confirm) so the audit row matches the confirmed text (ADR-036)`,
    );
  }
  const fingerprint = fingerprintOf(existing.kind, normalizeStatement(statement));
  if (fingerprint !== existing.fingerprint) {
    const clash = await store.careerClaim.findFirst({
      where: { profileId: existing.profileId, fingerprint },
    });
    // A hand-seeded row can already disagree with its own fingerprint; only a
    // DIFFERENT claim holding the identity is a real collision.
    if (clash && clash.id !== claimId) {
      throw new ClaimInvariantError(
        `claim ${claimId} would collide with existing claim ${clash.id} (same kind + statement)`,
      );
    }
  }
  return store.careerClaim.update({
    where: { id: claimId },
    data: { statement: statement.trim(), fingerprint },
  });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export const DEFAULT_CLAIM_PAGE = 100;
export const MAX_CLAIM_PAGE = 500;

export interface ListClaimsQuery {
  profileId: string;
  status?: ClaimStatus;
  statuses?: readonly ClaimStatus[];
  kind?: ClaimKind;
  limit?: number;
  offset?: number;
}

function clampPage(limit: unknown, fallback: number, max: number): number {
  if (limit === undefined || limit === null) return fallback;
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return fallback;
  return Math.min(Math.floor(limit), max);
}

export async function getClaimById(
  claimId: string,
  store: CareerClaimStore,
): Promise<CareerClaimRow | null> {
  assertClaimId(claimId, 'getClaimById');
  return store.careerClaim.findFirst({ where: { id: claimId } });
}

export async function requireClaimById(
  claimId: string,
  store: CareerClaimStore,
): Promise<CareerClaimRow> {
  const claim = await getClaimById(claimId, store);
  if (!claim) throw new ClaimNotFoundError(claimId);
  return claim;
}

export async function findClaimByFingerprint(
  profileId: string,
  kind: ClaimKind,
  statement: string,
  store: CareerClaimStore,
): Promise<CareerClaimRow | null> {
  assertProfileId(profileId, 'findClaimByFingerprint');
  return store.careerClaim.findFirst({
    where: { profileId, fingerprint: claimFingerprint(kind, statement) },
  });
}

export async function listClaims(
  query: ListClaimsQuery,
  store: CareerClaimStore,
): Promise<CareerClaimRow[]> {
  if (query === null || typeof query !== 'object') {
    throw new ClaimInvariantError('listClaims needs a query object');
  }
  assertProfileId(query.profileId, 'listClaims');
  if (query.kind !== undefined && !isClaimKind(query.kind)) {
    throw new ClaimInvariantError(`listClaims: kind must be a ClaimKind enum value`);
  }
  const statuses = query.statuses ?? (query.status !== undefined ? [query.status] : undefined);
  return store.careerClaim.findMany({
    where: {
      profileId: query.profileId,
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(statuses !== undefined ? { status: { in: [...statuses] } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: clampPage(query.limit, DEFAULT_CLAIM_PAGE, MAX_CLAIM_PAGE),
    ...(query.offset !== undefined && query.offset > 0 ? { skip: Math.floor(query.offset) } : {}),
  });
}
