// =====================================================================================
// routes/career.ts - the career IMPORT + VERIFICATION surface (T1020).
//
// WHAT THIS FILE IS. 06-design E.11 flows 1-3 turned into HTTP: a resume or notes file
// becomes an `EvidenceSource` plus candidate claims, and the user then decides on each
// one. Nothing here DECIDES anything. The repo convention, followed exactly
// (`routes/applications.ts` is the model): requireAuth -> ensureOwnership ->
// validateInput(zodSchema, body) -> service -> res.json -> sendServiceError. Every
// career decision lives in `backend/src/career/`, and this file maps its typed errors
// onto status codes.
//
// WHY THE CAREER LOGIC IS NOT HERE. `career/claimWriterAI.test.ts` guards that no route
// may import `career/verification.js` (the only status writer) or `career/claimWriterAI.js`
// (the only AI write path), and that nothing outside `backend/src/career/` may name a
// confirming status. Both guards are load-bearing, and both are also the right design: a
// route holding those imports could confirm a claim straight out of an HTTP body. So this
// file calls three career services - `resumeImport`, `userDecisions` and `claimCounts` -
// and spells no claim status of its own. The invariants are therefore structural:
//
//   1. AN IMPORT PRODUCES ONLY INFERRED CLAIMS (ADR-036 item 2, 05 sec.7.7). The status
//      comes from `IMPORTED_CLAIM_STATUS`, a literal the career layer owns, and
//      `ClaimCreateInput` has no confirming member for it to smuggle one through.
//   2. A STATUS IS ONLY EVER WRITTEN BY `career/verification.ts`, TOGETHER WITH ITS
//      `ClaimVerification` ROW. There is no `status` member in any request schema in this
//      file and no `prisma.careerClaim.update` call in it; `career.test.ts` pins both as
//      source guards, and pins the audit row behaviourally on all three decisions.
//   3. NO PROVIDER IS REQUIRED (ADR-041 D5). The deterministic extractor
//      (`resume/parser.ts#parseUploadedResume`) is the primary path and needs no key. The
//      AI enrichment below is attempted only when the key manager can lease a key, and
//      when it cannot the import still succeeds and says so in a machine-readable
//      `enrichment.reason`.
//
// MOUNTING. Registered at `/career` in `routes/index.ts`, ALONGSIDE the `/career` router
// T1030 declared in `routes/resumes.ts` (which owns `POST /career/import/json`). Express
// walks the mounts in registration order and the two path sets are disjoint -
// `/import/resume` vs `/import/json`, plus `/sources`, `/profile`, `/claims*` - so
// neither shadows the other and the V2 surface keeps the single `/career` prefix 06 sec.E.1
// names.
// =====================================================================================

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { type CareerClaim as CareerClaimRow } from '@prisma/client';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureOwnership } from '../shared/auth.js';
import { BadRequestError, NotFoundError, handleApiError } from '../shared/errors.js';
import {
  careerClaimDecisionSchema,
  careerClaimRejectSchema,
  createCareerClaimSchema,
  importCareerResumeSchema,
  listCareerClaimsSchema,
  listCareerSourcesSchema,
  validateInput,
} from '../shared/validation.js';
import {
  ClaimInvariantError,
  ClaimNotFoundError,
  listClaims,
  requireClaimById,
} from '../career/claims.js';
import { listEvidenceSources } from '../career/evidence.js';
import {
  attachClaimToEntity,
  attachClaimToEntitySchema,
  createCareerEntity,
  deleteCareerEntity,
  detachClaimFromEntity,
  detachClaimFromEntitySchema,
  ENTITY_KIND_CLAIM_FIELD,
  findCareerEntity,
  isCareerEntityKind,
  listCareerEntities,
  updateCareerEntity,
  CareerEntityClaimRefusedError,
  CareerEntityConflictError,
  CareerEntityInputError,
  CareerEntityNotFoundError,
  type CareerEntityKind,
  type CareerEntityStore,
} from '../career/entities.js';
import {
  careerClaimCountsFromRows,
  emptyCareerClaimCounts,
  readCareerClaimCounts,
  type CareerClaimCounts,
} from '../career/claimCounts.js';
import {
  importResumeClaims,
  noCareerEnrichment,
  resumeToCandidateClaims,
  writeEnrichedResumeClaims,
  RESUME_IMPORT_AI_INFERENCE_METHOD,
  RESUME_IMPORT_INFERENCE_METHOD,
  RESUME_IMPORT_PROVENANCE,
  RESUME_IMPORT_STATUS,
  type CareerEnrichmentOutcome,
  type CareerResumeEnricher,
  type ResumeExtraction,
} from '../career/resumeImport.js';
// T1021: the Career Interview. This router names no claim status and no provenance: the two
// constants it echoes are the career LAYER's, which is where ADR-036 item 2 puts them.
import {
  CAREER_INTERVIEW_INFERENCE_METHOD,
  CAREER_INTERVIEW_PROVENANCE,
  CAREER_INTERVIEW_STEPS,
  CAREER_INTERVIEW_STATUS,
  CAREER_INTERVIEW_TOTAL_STEPS,
  CareerInterviewError,
  createInterviewSessionId,
  isInterviewSessionId,
  leaseInterviewProvider,
  normalizeInterviewAnswers,
  recordInterviewClaims,
} from '../career/interview.js';
import {
  confirmUserClaim,
  createUserClaim,
  editUserClaim,
  rejectUserClaim,
  reopenUserClaim,
  ClaimVerificationError,
} from '../career/userDecisions.js';
import { parseResumeWithLLM, parseUploadedResume, validateUploadedFile } from '../resume/parser.js';
import { leaseNextLlmKey } from '../ai/keyManager.js';

const router = Router();

/** Mirrors `routes/uploaded-files.ts#MAX_EXTRACTED_TEXT_CAP`. */
export const MAX_CAREER_IMPORT_TEXT = 200_000;

// ---------------------------------------------------------------------------
// Upload handling (memory only - ADR-041 D2: no binary ever reaches Postgres)
// ---------------------------------------------------------------------------

// The same 10MB cap and the same in-memory storage `routes/uploaded-files.ts` uses.
// `memoryStorage` is the point: the buffer is parsed and hashed, then dropped.
// `EvidenceSource` carries `byteSize`/`mimeType`/`storageKey` and no binary column, so
// there is nowhere for the bytes to go even by mistake.
const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  storage: multer.memoryStorage(),
});

const ALLOWED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
] as const;

// ---------------------------------------------------------------------------
// Error mapping: one place, so every route classifies identically
// ---------------------------------------------------------------------------

/**
 * Translate a service error onto an HTTP status, keeping the machine-readable `code` so
 * a client can tell the three refusals apart:
 *   - `invalid_input`       400 - the request cannot be acted on as written;
 *   - `not_found`           404 - no such claim;
 *   - `illegal_transition`  409 - the claim is in a state this decision cannot move (e.g.
 *     confirming a `rejected` claim without reopening it first). 409 rather than 422,
 *     for the same reason T1030 chose it for the render gate: the request was
 *     well-formed and the user IS allowed to make this decision - the claim is simply not
 *     in a state that accepts it, which is a different answer from "your body was
 *     malformed", and a client has to be able to tell them apart.
 */
function sendServiceError(res: Response, error: unknown): void {
  if (error instanceof ClaimVerificationError) {
    const status =
      error.code === 'not_found' ? 404 : error.code === 'invalid_input' ? 400 : 409;
    res.status(status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ClaimNotFoundError) {
    res.status(404).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof ClaimInvariantError) {
    // A refused invariant is a 409: the request was valid, the state is not.
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  // The entity surface (T1054). Three shapes, three answers, and they are deliberately NOT
  // the claim decisions' three: an entity that is not yours is a 404 rather than a 403, so
  // this surface cannot be used to discover that another tenant's row exists.
  if (error instanceof CareerEntityNotFoundError) {
    res.status(404).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof CareerEntityInputError) {
    res.status(400).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof CareerEntityConflictError) {
    // The row already exists on this profile (a second `Skill` with the same canonical name).
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof CareerEntityClaimRefusedError) {
    // A rejected claim, or a pairing the model does not intend: the request was well formed
    // and the STATE refuses it, which is the same answer an illegal transition gets.
    res.status(409).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof CareerInterviewError) {
    // The interview's four refusals, and the STATUS CODE each one gets is the whole point of
    // keeping them apart. A client has to be able to tell them without parsing a message:
    //   503 the stage cannot run at all - no AI provider is configured. This is the HONEST
    //       refusal (ADR-041 D5 does not apply to an AI-only stage), and the UI points at the
    //       manual path instead of pretending the interview ran. 503 rather than 400 because
    //       the request is perfectly well formed; the SERVER is missing something.
    //   502 the provider was there and did not answer usefully, or answered in a shape the
    //       stage will not guess at. A retry is plausible; nothing was written.
    //   400 the submission cannot be acted on as written (a blank required answer, an
    //       unknown interview field, a session id that is not one).
    const status =
      error.code === 'interview_provider_required'
        ? 503
        : error.code === 'interview_invalid_input'
          ? 400
          : 502;
    res.status(status).json({
      error: error.message,
      code: error.code,
      // Said on the wire as well as in the message, because the client's pointer to the
      // manual path is a design decision about THIS code and nothing else.
      manualPath: error.code === 'interview_provider_required' ? '/career/claims' : undefined,
    });
    return;
  }
  handleApiError(error, res);
}

// ---------------------------------------------------------------------------
// Claim views: the response shapes, never the bytes
// ---------------------------------------------------------------------------

/** The claim's auditable fields. Never the fingerprints' inputs, never a blob. */
function claimView(claim: CareerClaimRow) {
  return {
    id: claim.id,
    profileId: claim.profileId,
    kind: claim.kind,
    statement: claim.statement,
    status: claim.status,
    provenance: claim.provenance,
    confidence: claim.confidence ?? null,
    inferenceMethod: claim.inferenceMethod ?? null,
    producedByModel: claim.producedByModel ?? null,
    evidenceSourceId: claim.evidenceSourceId ?? null,
    experienceId: claim.experienceId ?? null,
    educationId: claim.educationId ?? null,
    projectId: claim.projectId ?? null,
    skillId: claim.skillId ?? null,
    certificationId: claim.certificationId ?? null,
    achievementId: claim.achievementId ?? null,
    confirmedAt: claim.confirmedAt ?? null,
    rejectedAt: claim.rejectedAt ?? null,
    rejectedReason: claim.rejectedReason ?? null,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

/**
 * The audit row as the client needs it. `before`/`after` snapshots are deliberately NOT
 * echoed: they are server-side integrity data, and a client that rendered them would be
 * showing the user a diff of a row they already caused. The action, the actor and the
 * timestamp are the part a person can act on.
 */
function verificationView(row: unknown) {
  const record = row as {
    id: string;
    claimId: string | null;
    action: string;
    actorUserId: string | null;
    userId: string | null;
    targetType: string;
    targetId: string;
    note: string | null;
    createdAt: Date | string;
  };
  return {
    id: record.id,
    claimId: record.claimId,
    action: record.action,
    actorUserId: record.actorUserId,
    userId: record.userId,
    targetType: record.targetType,
    targetId: record.targetId,
    note: record.note,
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Ownership: a claim is owned THROUGH its profile
// ---------------------------------------------------------------------------

/**
 * The caller's CareerProfile row.
 *
 * `profileId` supplied -> load it and `ensureOwnership` it, so naming another tenant's
 * profile is a 403 and an import can never write into someone else's claims. Absent ->
 * resolve the caller's own profile (`userId` is `@unique`) and CREATE it on demand, the
 * same rule `PUT /profile` already applies, which is what lets the import wizard work for
 * a user who has never saved a profile. A `CareerProfile` is the user's own container,
 * not a career fact: creating one writes no claim and asserts nothing, so it is not a
 * place the "an import asserts nothing" rule has to hold.
 */
async function resolveCallerProfile(req: Request): Promise<{ id: string; userId: string }> {
  const requested = typeof req.body?.profileId === 'string' ? req.body.profileId : undefined;
  if (requested !== undefined && requested.length > 0) {
    const profile = await prisma.careerProfile.findUnique({
      where: { id: requested },
      select: { id: true, userId: true },
    });
    if (!profile) throw new NotFoundError('Career profile');
    await ensureOwnership(req.user!.id, profile.userId, 'Career profile');
    return profile;
  }
  const existing = await prisma.careerProfile.findUnique({
    where: { userId: req.user!.id },
    select: { id: true, userId: true },
  });
  if (existing) return existing;
  return prisma.careerProfile.create({
    data: { userId: req.user!.id },
    select: { id: true, userId: true },
  });
}

/**
 * Load a claim and prove the caller owns it, THROUGH the profile.
 *
 * `CareerClaim` has no `userId`, so a claim id on its own proves nothing - the ownership
 * check has to follow the `profileId`. A foreign claim is a 403 (the repo-wide
 * `ensureOwnership` behaviour, cf. `routes/uploaded-files.ts`) and an absent one a 404, so
 * the two cannot be confused.
 */
async function requireOwnedClaim(req: Request, claimId: string): Promise<CareerClaimRow> {
  const claim = await requireClaimById(claimId, prisma);
  const profile = await prisma.careerProfile.findUnique({
    where: { id: claim.profileId },
    select: { id: true, userId: true },
  });
  if (!profile) throw new NotFoundError('Career claim');
  await ensureOwnership(req.user!.id, profile.userId, 'Career claim');
  return claim;
}

/** The profile's counts, or a zeroed counter when there is no profile yet. */
async function countsForProfileId(profileId: string): Promise<CareerClaimCounts> {
  return readCareerClaimCounts(profileId, prisma);
}

// ---------------------------------------------------------------------------
// Entity ownership (T1054)
// ---------------------------------------------------------------------------

/**
 * The career store, structurally narrowed, ONCE.
 *
 * The cast is the same one `render/renderPort.ts` makes for the same reason: the career layer
 * takes its DB seam as an injected parameter (`backend/src/career/` may not import the prisma
 * singleton - `claimWriterAI.test.ts` asserts it), and Prisma computes each delegate's return
 * type from the `select` argument, so a hand-written row type here would be a second thing to
 * keep in step with the schema. Every row is returned to the caller exactly as Prisma produced
 * it and is never re-shaped.
 */
const entityStore = prisma as unknown as CareerEntityStore;

/**
 * The caller's OWN profile id, or `null` when they have none yet.
 *
 * Reads never CREATE a profile: "no profile" is an empty list here, the same answer
 * `GET /career/claims` gives, so a client never has to tell "no profile" from "profile with
 * nothing in it" by catching an error. A `profileId` in the body is loaded and
 * `ensureOwnership`-checked, so naming another tenant's profile is a 403 exactly as it is for
 * an import.
 */
async function callerProfileId(req: Request): Promise<string | null> {
  const requested = typeof req.body?.profileId === 'string' ? req.body.profileId : undefined;
  if (requested !== undefined && requested.length > 0) {
    const profile = await prisma.careerProfile.findUnique({
      where: { id: requested },
      select: { id: true, userId: true },
    });
    if (!profile) throw new NotFoundError('Career profile');
    await ensureOwnership(req.user!.id, profile.userId, 'Career profile');
    return profile.id;
  }
  const existing = await prisma.careerProfile.findUnique({
    where: { userId: req.user!.id },
    select: { id: true },
  });
  return existing?.id ?? null;
}

/**
 * The entity kind in the path, or a 404.
 *
 * A 404 rather than a 400 because the path names a RESOURCE CLASS that does not exist - the
 * same answer `/career/entities/nonexistent/abc` gives, so the six real kinds cannot be
 * enumerated by trying others against a valid id.
 */
function requireEntityKind(req: Request): CareerEntityKind {
  const kind = req.params.kind;
  if (!isCareerEntityKind(kind)) {
    throw new NotFoundError('Career entity kind');
  }
  return kind;
}

/**
 * The body as a plain record for the service to validate field by field.
 *
 * `profileId` is REMOVED, and that is not a convenience: it is the router's own addressing
 * member (which profile this write is scoped to, exactly as an import takes one), so it is
 * read here rather than being offered to the service as if it were a column. Leaving it in
 * would make every request that names a profile a 400 - "profileId is not a field of a
 * experience" - which is the right answer for a typo and the wrong one for a caller doing
 * exactly what this router documents.
 */
function bodyRecord(req: Request): Record<string, unknown> {
  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  const { profileId: _addressing, ...fields } = body as Record<string, unknown>;
  return fields;
}

// ---------------------------------------------------------------------------
// GET|POST /career/entities/:kind, PATCH|DELETE /career/entities/:kind/:id
// ---------------------------------------------------------------------------
//
// THE SIX ENDPOINTS, AND WHY THEY ARE USER-AUTHORED CRUD. `resume/json/project.ts` places a
// claim by its entity foreign key, so a profile with claims and no entities projects an empty
// document (`rendered: 0` - the T1050 live run found exactly this). T1030 judgement 7 keeps an
// IMPORT from creating entity rows, and nothing else in the graph owns creating them, so they
// are created HERE: by the person whose career they describe.
//
// NO AI, NO CONFIRMATION, NO FABRICATION. Nothing in this surface infers a field, and the two
// calls that touch a CLAIM (`attach` / `detach`) go through `career/entities.ts`, which writes
// the entity FK with `claims.ts#updateClaimAttributes` - a function whose type has no `status`
// member and which throws if one is smuggled in. So attaching writes NO `ClaimVerification`
// row and changes NO status (ADR-036 item 2), and `career.test.ts` asserts both by counting
// the writes the mock actually receives.
//
// SCOPING IS BY PROFILE, AND A FOREIGN ID IS A 404. Every read and write filters on
// `profileId` and NOTHING else, so "does this row exist" and "is it mine" are the same
// question, asked once: a foreign id is indistinguishable from an absent one. That is a
// different answer from the CLAIM routes above, which 403 a foreign claim - deliberately, and
// for the reason the claim surface has always given. An entity is a container the caller is
// about to create or delete rows in, so refusing to distinguish is the safer of the two and is
// asserted in both directions.

router.get('/entities/:kind', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = requireEntityKind(req);
    const profileId = await callerProfileId(req);
    // No profile yet is an EMPTY list, not a 404: "you have not built your profile yet" is a
    // state this page must be able to render rather than an error it has to catch.
    res.json({ kind, entities: profileId === null ? [] : await listCareerEntities(kind, profileId, entityStore) });
  } catch (error) {
    sendServiceError(res, error);
  }
});

router.post('/entities/:kind', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = requireEntityKind(req);
    // A write MAY create the caller's profile, exactly as an import does: a `CareerProfile` is
    // the user's own container, it writes no career fact and asserts nothing.
    const profile = await resolveCallerProfile(req);
    const entity = await createCareerEntity(kind, profile.id, bodyRecord(req), entityStore);
    res.status(201).json({ kind, entity });
  } catch (error) {
    sendServiceError(res, error);
  }
});

router.patch('/entities/:kind/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = requireEntityKind(req);
    const profile = await resolveCallerProfile(req);
    const entity = await updateCareerEntity(kind, req.params.id, profile.id, bodyRecord(req), entityStore);
    res.json({ kind, entity });
  } catch (error) {
    sendServiceError(res, error);
  }
});

router.delete('/entities/:kind/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = requireEntityKind(req);
    const profile = await resolveCallerProfile(req);
    res.json(await deleteCareerEntity(kind, req.params.id, profile.id, entityStore));
  } catch (error) {
    sendServiceError(res, error);
  }
});

/** One entity, for the claim picker's "which statements sit here" read. */
router.get('/entities/:kind/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const kind = requireEntityKind(req);
    const profileId = await callerProfileId(req);
    if (profileId === null) throw new CareerEntityNotFoundError(kind, req.params.id);
    res.json({ kind, entity: await findCareerEntity(kind, req.params.id, profileId, entityStore) });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// POST /career/claims/:id/{attach,detach} - BOOKKEEPING, NOT A DECISION (T1054)
// ---------------------------------------------------------------------------
//
// These two are the ONLY writes in this file that touch a claim, and neither is a decision.
// `career/entities.ts` owns the rules and the write; what is left here is ownership (the
// claim, exactly as every other claim route proves it) and the mapping of the request onto
// the service's arguments:
//
//   - NO `ClaimVerification` ROW. A `ClaimVerification` is the audit of a human DECISION about
//     a claim's truth. Moving a statement from "not placed" to "placed under this role" is
//     neither a confirmation nor a rejection, and recording it as one would put a second,
//     meaningless `confirm` in the claim's history and inflate the audit a reviewer reads.
//   - NO STATUS CHANGE. The write is `updateClaimAttributes`, whose type omits `status` and
//     which throws at runtime if one arrives anyway (ADR-036 item 2). `career.test.ts` asserts
//     the claim's status is byte-identical before and after, and that the mock's
//     `claimVerification.create` was never called.
//   - A REJECTED CLAIM IS REFUSED (409), not revived. Reopening is a separate, explicit
//     decision through `/claims/:id/reopen`; attaching a rejected claim to an entity would put
//     it back on the projection's rail without one.
//
// The FK column is chosen by the SERVICE from the `kind`, never taken from the body as a column
// name: a body that could name `careerClaim` column `status` would be a second writer, and
// `.strict()` on the schema means an unexpected member is a 400 rather than a silent no-op.

router.post('/claims/:id/attach', requireAuth, async (req: Request, res: Response) => {
  try {
    const claim = await requireOwnedClaim(req, req.params.id);
    const data = validateInput(attachClaimToEntitySchema, req.body ?? {});
    const result = await attachClaimToEntity(claim.id, data.kind, data.entityId, entityStore);
    res.json({
      claim: claimView(result.claim),
      attachment: { kind: data.kind, entityId: result.claim[ENTITY_KIND_CLAIM_FIELD[data.kind]] ?? null },
      changed: result.changed,
      field: result.field,
      note: 'Attaching places a statement under an entry. It is not a confirmation: the statement keeps the status it had.',
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

router.post('/claims/:id/detach', requireAuth, async (req: Request, res: Response) => {
  try {
    const claim = await requireOwnedClaim(req, req.params.id);
    const data = validateInput(detachClaimFromEntitySchema, req.body ?? {});
    const result = await detachClaimFromEntity(
      claim.id,
      { kind: data.kind ?? null, entityId: data.entityId ?? null },
      entityStore,
    );
    res.json({
      claim: claimView(result.claim),
      changed: result.changed,
      fields: result.fields,
      note: 'Detaching only removes the placement. The statement, and everything you have decided about it, stays exactly as it is.',
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// The optional AI enrichment (ADR-041 D5: attempted only with a key, always reported)
// ---------------------------------------------------------------------------

/**
 * The DEFAULT enricher: try the existing BYOK path, and degrade to "skipped" rather than
 * failing.
 *
 * The lease probe is what makes the reason PRECISE. `parseResumeWithLLM` returns `null`
 * for "no key", for "rate limited" and for "the model answered with something unusable",
 * and collapsing those would leave the response unable to answer the question the UI
 * actually asks: "is my missing key the reason this import was thinner than it should
 * be?". Asking the key manager first separates `no_ai_provider_configured` (nothing to
 * try) from `provider_unavailable` (tried, did not come back with a usable parse).
 *
 * The probe costs one extra rotation on a key that is about to be used anyway, and it is
 * the key manager's own lease rather than a raw table read, so no provider list is
 * duplicated here.
 */
const defaultEnricher: CareerResumeEnricher = async ({ rawText, userId, profileId, evidenceSourceId }) => {
  let provider = 'unknown';
  try {
    const key = await leaseNextLlmKey(userId);
    provider = key.provider;
  } catch {
    return { provider, status: 'skipped', reason: 'no_ai_provider_configured', created: 0, deduped: 0 };
  }
  let parsed: ResumeExtraction | null = null;
  try {
    parsed = (await parseResumeWithLLM(rawText, userId)) as ResumeExtraction | null;
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return { provider, status: 'skipped', reason: 'provider_unavailable', created: 0, deduped: 0 };
  }
  // The model's parse is written through the ONE career-layer bridge to the AI writer,
  // which hard-codes `status = inferred` and `provenance = llm_inferred`. A route that
  // could call `claimWriterAI` directly could re-label a model's sentence as something
  // it is not; going through here is what makes that impossible.
  const written = await writeEnrichedResumeClaims(
    { profileId, evidenceSourceId, provider, parsed },
    prisma,
  );
  return { provider, status: 'applied', reason: 'ok', created: written.created, deduped: written.deduped };
};

let enricher: CareerResumeEnricher = defaultEnricher;

/**
 * Install an enricher (an adapter, a test). `null` restores the shipped default.
 *
 * A SEAM rather than a flag because "is there a provider" is a runtime fact the key
 * manager already answers, and a second boolean that can disagree with it would be a
 * source of a wrong `enrichment` report. The default is also what a caller with no
 * override gets, so there is no code path where the enricher is silently absent.
 */
export function setCareerImportEnricher(next: CareerResumeEnricher | null): void {
  enricher = next ?? defaultEnricher;
}

/** Re-exported so an adapter or a test can reach the shipped default. */
export const defaultCareerImportEnricher = defaultEnricher;
/** Re-exported: the career layer's "do nothing, and say so" default. */
export const careerNoEnrichment = noCareerEnrichment;

// ---------------------------------------------------------------------------
// POST /career/import/resume - a file becomes an EvidenceSource + inferred claims
// ---------------------------------------------------------------------------

/**
 * The imported file, resolved exactly as `routes/uploaded-files.ts` resolves one: the
 * same allowed MIME set, the same `validateUploadedFile` (size, type, dangerous
 * extension), and the same stored `extractedText` when the file is already in
 * `UploadedFile`.
 *
 * Two sources are accepted because the product already has two: a NEW multipart upload
 * (the wizard's drop zone) and an `uploadedFileId` the user uploaded earlier through the
 * raw-upload surface. The second exists so the wizard does not force a re-upload of a file
 * the app already holds - and it re-parses the STORED extracted text deterministically
 * rather than trusting the upload path's parse, so the claim set is a function of the text
 * rather than of which route the bytes arrived on.
 */
interface ResolvedImportFile {
  buffer: Buffer;
  mimeType: string;
  originalName: string;
  byteSize: number;
  uploadedFileId: string | null;
}

async function resolveImportFile(req: Request): Promise<ResolvedImportFile> {
  const files = req.files as
    | Record<string, Array<{ buffer: Buffer; mimetype: string; originalname: string }>>
    | undefined;
  const uploaded = files?.file?.[0];

  if (uploaded) {
    if (!(ALLOWED_MIME as readonly string[]).includes(uploaded.mimetype)) {
      throw new BadRequestError('Invalid file type. Allowed: PDF, DOCX, TXT');
    }
    validateUploadedFile(uploaded.buffer, uploaded.mimetype, uploaded.originalname);
    return {
      buffer: uploaded.buffer,
      mimeType: uploaded.mimetype,
      originalName: uploaded.originalname || 'resume',
      byteSize: uploaded.buffer.length,
      uploadedFileId: null,
    };
  }

  const uploadedFileId =
    typeof req.body?.uploadedFileId === 'string' ? req.body.uploadedFileId.trim() : '';
  if (uploadedFileId.length === 0) {
    throw new BadRequestError('Upload a resume file, or name an uploadedFileId to import');
  }
  const stored = await prisma.uploadedFile.findUnique({ where: { id: uploadedFileId } });
  if (!stored) throw new NotFoundError('Uploaded file');
  await ensureOwnership(req.user!.id, stored.userId, 'Uploaded file');
  const extracted = stored.extractedText ?? '';
  if (extracted.trim().length === 0) {
    // The same reason `POST /profile/parse-from-uploaded-file/:fileId` uses: a file with
    // no extractable text has nothing to extract claims FROM, and importing it would
    // register an evidence source that silently yields zero claims.
    throw new BadRequestError('No text could be extracted from this file');
  }
  return {
    // Re-parsed through the SAME extractor a fresh upload takes, from the stored text.
    buffer: Buffer.from(extracted, 'utf-8'),
    mimeType: 'text/plain',
    originalName: stored.fileName,
    byteSize: Buffer.byteLength(extracted, 'utf-8'),
    uploadedFileId: stored.id,
  };
}

router.post(
  '/import/resume',
  requireAuth,
  upload.fields([{ name: 'file', maxCount: 1 }]),
  async (req: Request, res: Response) => {
    try {
      const data = validateInput(importCareerResumeSchema, {
        profileId: typeof req.body?.profileId === 'string' ? req.body.profileId : undefined,
        uploadedFileId:
          typeof req.body?.uploadedFileId === 'string' ? req.body.uploadedFileId : undefined,
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      });

      const file = await resolveImportFile(req);
      const profile = await resolveCallerProfile(req);

      // 1. EXTRACT, before anything is written. The deterministic extractor is the
      //    PRIMARY path (ADR-041 D5): no key, no provider, no network. Both refusals
      //    happen HERE rather than after the evidence source exists, because a source that
      //    yields zero claims is a row the user cannot tell apart from a failed import.
      const parsed = await parseUploadedResume(file.buffer, file.mimeType);
      const rawText = parsed.rawText ?? '';
      if (rawText.trim().length === 0) {
        throw new BadRequestError('No text could be extracted from this file');
      }
      if (resumeToCandidateClaims(parsed).length === 0) {
        throw new BadRequestError('No career statements could be extracted from this file');
      }

      // 2+3+4. The career service registers the provenance anchor, writes every claim
      //        inferred + document_import, and runs the optional enrichment. It owns all
      //        three rules; this route supplies the file and the actor.
      const imported = await importResumeClaims(
        {
          profileId: profile.id,
          rawText,
          parsed,
          evidence: {
            title: data.title ?? file.originalName,
            mimeType: file.mimeType,
            byteSize: file.byteSize,
            uploadedFileId: file.uploadedFileId,
          },
          userId: req.user!.id,
          enrich: enricher,
          maxStoredText: MAX_CAREER_IMPORT_TEXT,
        },
        prisma,
      );

      const counts = await countsForProfileId(profile.id);

      res.status(201).json({
        profileId: profile.id,
        evidenceSourceId: imported.source.id,
        evidenceSource: imported.sourceOutcome,
        claims: {
          created: imported.created,
          deduped: imported.deduped,
          extracted: imported.extracted,
          total: counts.total,
        },
        // Echoed so the caller can prove the import decided NOTHING about these claims.
        statusAssigned: RESUME_IMPORT_STATUS,
        provenanceAssigned: RESUME_IMPORT_PROVENANCE,
        counts,
        enrichment: imported.enrichment satisfies CareerEnrichmentOutcome,
        // The claims this import produced, so the wizard can render the verification list
        // without a second round trip.
        items: imported.items.map(claimView),
        note:
          'Every claim from this import is unconfirmed. Nothing here can enter a rendered resume until you confirm it (ADR-036).',
      });
    } catch (error) {
      sendServiceError(res, error);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /career/sources - the evidence anchors of this profile
// ---------------------------------------------------------------------------

router.get('/sources', requireAuth, async (req: Request, res: Response) => {
  try {
    const query = validateInput(listCareerSourcesSchema, req.query);
    const profile = await prisma.careerProfile.findUnique({
      where: { userId: req.user!.id },
      select: { id: true },
    });
    // No profile yet is an EMPTY list, not a 404: the page renders this list alongside
    // everything else, and "has not imported anything" is a state the UI must be able to
    // show rather than an error it has to catch.
    if (!profile) {
      res.json({ sources: [] });
      return;
    }
    const sources = await listEvidenceSources(
      { profileId: profile.id, limit: query.limit, offset: query.offset },
      prisma,
    );
    res.json({
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        title: source.title,
        url: source.url,
        mimeType: source.mimeType,
        storageKey: source.storageKey,
        byteSize: source.byteSize,
        uploadedFileId: source.uploadedFileId,
        contentHash: source.contentHash,
        trustLevel: source.trustLevel,
        capturedAt: source.capturedAt,
        createdAt: source.createdAt,
      })),
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /career/profile - the profile plus the counts the counter is built from
// ---------------------------------------------------------------------------

router.get('/profile', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await prisma.careerProfile.findUnique({
      where: { userId: req.user!.id },
      select: {
        id: true,
        headline: true,
        summary: true,
        seniority: true,
        targetRoles: true,
        topSkills: true,
        industries: true,
        locationPref: true,
        remoteOnly: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!profile) {
      // The empty state is an ANSWER (06 E.11: "Nothing confirmed yet - a resume built now
      // would be empty"), not an error, so it is a 200 with a zeroed counter. A client
      // never has to tell "no profile" from "profile with no claims" by catching.
      res.json({ profile: null, counts: emptyCareerClaimCounts(), unconfirmed: 0 });
      return;
    }
    const counts = await countsForProfileId(profile.id);
    res.json({ profile, counts, unconfirmed: counts.unconfirmed });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /career/claims?status=&kind= - the verification list
// ---------------------------------------------------------------------------

router.get('/claims', requireAuth, async (req: Request, res: Response) => {
  try {
    const query = validateInput(listCareerClaimsSchema, req.query);
    const profile = await prisma.careerProfile.findUnique({
      where: { userId: req.user!.id },
      select: { id: true },
    });
    if (!profile) {
      res.json({ claims: [], counts: emptyCareerClaimCounts(), unconfirmed: 0 });
      return;
    }
    const claims = await listClaims(
      {
        profileId: profile.id,
        status: query.status,
        kind: query.kind,
        limit: query.limit,
        offset: query.offset,
      },
      prisma,
    );
    const counts = await countsForProfileId(profile.id);
    res.json({
      claims: claims.map(claimView),
      // The counts describe the WHOLE profile, not the filtered page: the counter has to
      // stay put while the user filters, or it becomes a different number every time they
      // change their mind about the filter.
      counts,
      unconfirmed: counts.unconfirmed,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// POST /career/claims - a hand-entered claim, or an EDIT of an existing one
// ---------------------------------------------------------------------------

router.post('/claims', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = validateInput(createCareerClaimSchema, req.body);
    const actorUserId = req.user!.id;

    // --- EDIT ---------------------------------------------------------------
    // An edit is a DECISION (`action = edit` or `edit_confirm`), so it goes through the
    // verification service and writes an audit row whether or not it confirms. A plain
    // edit does NOT confirm: a user who re-words an inferred claim has still not asserted
    // it, and `edit_confirm` exists so the audit row records the text that was actually
    // approved rather than a confirmation of words that were then changed.
    if (data.id !== undefined) {
      await requireOwnedClaim(req, data.id);
      const result = await editUserClaim(
        {
          claimId: data.id,
          actorUserId,
          statement: data.statement,
          note: data.note ?? null,
          confirm: data.confirm === true,
        },
        prisma,
      );
      res.json({
        mode: data.confirm === true ? 'edit_confirm' : 'edit',
        claim: claimView(result.claim),
        verification: result.verification ? verificationView(result.verification) : null,
        changed: result.changed,
        action: result.action,
      });
      return;
    }

    // --- CREATE -------------------------------------------------------------
    const profile = await resolveCallerProfile(req);
    const created = await createUserClaim(
      {
        profileId: profile.id,
        kind: data.kind!,
        statement: data.statement,
        actorUserId,
        note: data.note ?? null,
        confirm: data.confirm === true,
      },
      prisma,
    );
    res.status(201).json({
      mode: created.confirmed ? 'create_confirm' : 'create',
      claim: claimView(created.claim),
      verification: created.verification ? verificationView(created.verification) : null,
      changed: created.changed,
      outcome: created.outcome,
      ...(created.action ? { action: created.action } : {}),
      ...(created.confirmed
        ? {}
        : {
            note: 'Created unconfirmed. Confirm it before it can enter a rendered resume.',
          }),
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// POST /career/claims/:id/{confirm,reject,reopen} - the three user decisions
// ---------------------------------------------------------------------------
//
// Each handler delegates to `career/userDecisions.ts` and to NOTHING else. There is no
// `prisma.careerClaim.update` in this file and no `status` in any body schema, so "a
// status changed" and "a ClaimVerification row was written" are the same event here by
// construction - and `career.test.ts` asserts the row, which is what makes that a fact
// rather than a claim about the code.

router.post('/claims/:id/confirm', requireAuth, async (req: Request, res: Response) => {
  try {
    const claim = await requireOwnedClaim(req, req.params.id);
    const data = validateInput(careerClaimDecisionSchema, req.body ?? {});
    const result = await confirmUserClaim(
      {
        claimId: claim.id,
        actorUserId: req.user!.id,
        statement: data.statement ?? null,
        note: data.note ?? null,
      },
      prisma,
    );
    res.json({
      claim: claimView(result.claim),
      verification: result.verification ? verificationView(result.verification) : null,
      changed: result.changed,
      action: result.action,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

router.post('/claims/:id/reject', requireAuth, async (req: Request, res: Response) => {
  try {
    const claim = await requireOwnedClaim(req, req.params.id);
    const data = validateInput(careerClaimRejectSchema, req.body ?? {});
    const result = await rejectUserClaim(
      {
        claimId: claim.id,
        actorUserId: req.user!.id,
        reason: data.reason ?? null,
        note: data.note ?? null,
      },
      prisma,
    );
    res.json({
      claim: claimView(result.claim),
      verification: result.verification ? verificationView(result.verification) : null,
      changed: result.changed,
      action: result.action,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

router.post('/claims/:id/reopen', requireAuth, async (req: Request, res: Response) => {
  try {
    const claim = await requireOwnedClaim(req, req.params.id);
    const data = validateInput(careerClaimDecisionSchema, req.body ?? {});
    const result = await reopenUserClaim(
      { claimId: claim.id, actorUserId: req.user!.id, note: data.note ?? null },
      prisma,
    );
    res.json({
      claim: claimView(result.claim),
      verification: result.verification ? verificationView(result.verification) : null,
      changed: result.changed,
      action: result.action,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// Re-exports: the career-layer vocabulary this surface is built on
// ---------------------------------------------------------------------------
// A route that re-derives these would restate the career layer's contract, so the pure
// helpers are re-exported for the test suite and for any future caller rather than
// reimplemented. `career.test.ts` pins them through this surface.
export { careerClaimCountsFromRows, emptyCareerClaimCounts, resumeToCandidateClaims };
export { RESUME_IMPORT_AI_INFERENCE_METHOD, RESUME_IMPORT_INFERENCE_METHOD };
export type { CareerClaimCounts, CareerEnrichmentOutcome, ResumeExtraction };

// ---------------------------------------------------------------------------
// POST /career/interview/start + POST /career/interview/:sessionId/answers (T1021)
// ---------------------------------------------------------------------------
//
// THE CAREER INTERVIEW, WHICH REPLACES THE FABRICATING AI WIZARD. What it is NOT is worth
// saying first, because the surface it replaces was the opposite of this one:
//
//   - IT NEVER WRITES A RESUME. There is no `Resume` insert in `career/interview.ts`, in
//     this router, or anywhere on this path. The output is candidate `CareerClaim` rows.
//   - IT NEVER CONFIRMS ANYTHING. The stage writes through `career/claimWriterAI`, which
//     hard-codes `status = inferred` and `provenance = llm_inferred` (ADR-036 item 2), and
//     this router writes no `ClaimVerification` row on either path. Confirming is
//     `POST /career/claims/:id/confirm`, a separate audited human decision.
//   - IT REFINES TO START WITHOUT A PROVIDER (ADR-041 D5 read the other way). The
//     deterministic import above works with no key; THIS stage is an AI feature and says so.
//     `start` refuses with `interview_provider_required` (503) BEFORE the user types
//     anything, and `answers` refuses the same way if the key went away in between. It never
//     falls back to a template questionnaire: a fake interview that looks like the real one
//     is precisely the defect being removed.
//   - A SCHEMA-INVALID RESPONSE IS A HARD FAILURE (502, `interview_schema_invalid`). Nothing
//     is salvaged, guessed, or back-filled from a template; the stage writes zero claims.
//
// WHAT THE ROUTE IS LEFT WITH. Envelope validation, ownership, status codes, and the counts.
// Everything that must be TRUE about an interview lives in `career/interview.ts`.
//
// WHY `start` RESOLVES A PROFILE AT ALL when it writes nothing. The answers call needs one,
// and a start that fails at the last step would be worse than one that fails at the first:
// the user would have typed five screens to learn there was no provider. Resolving here also
// keeps the two calls honest with each other - the wizard is told which profile its answers
// will land in.

/**
 * The interview's questionnaire, and the provider it will use.
 *
 * `requireAuth`, then the provider lease, then ownership (the caller's own profile, created
 * on demand exactly as an import does - a `CareerProfile` is a container, it asserts
 * nothing). The lease is the refusal point: `leaseInterviewProvider` throws
 * `interview_provider_required` when no key is configured for ANY provider, which
 * `sendServiceError` maps to 503 with the manual-path pointer.
 *
 * 201 rather than 200 because a session id was minted. It grants nothing - see
 * `career/interview.ts#createInterviewSessionId` - and the response says so, because a field
 * that looks like a capability and is not would be the more dangerous kind.
 */
router.post('/interview/start', requireAuth, async (req: Request, res: Response) => {
  try {
    // THE LEASE COMES FIRST, DELIBERATELY. With no provider this request must write
    // NOTHING, so the profile resolution that follows is unreachable on that path: a
    // refused start does not even create the container the answers would have landed in.
    const provider = await leaseInterviewProvider(req.user!.id);
    const profile = await resolveCallerProfile(req);
    res.status(201).json({
      sessionId: createInterviewSessionId(),
      profileId: profile.id,
      provider: provider.provider,
      model: provider.model,
      steps: CAREER_INTERVIEW_STEPS,
      totalSteps: CAREER_INTERVIEW_TOTAL_STEPS,
      // Echoed so the wizard can state what the rows WILL carry rather than what it hopes
      // they will. Both constants are the career layer's, imported above.
      statusAssigned: CAREER_INTERVIEW_STATUS,
      provenanceAssigned: CAREER_INTERVIEW_PROVENANCE,
      inferenceMethod: CAREER_INTERVIEW_INFERENCE_METHOD,
      requiresProvider: true,
      manualPath: '/career/claims',
      note:
        'These questions ask for facts you already have. Nothing you answer is confirmed by answering it: every claim that comes back is unconfirmed and you decide on each one.',
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

/**
 * The answers become candidate claims.
 *
 * The three refusals are all reachable here and all write NOTHING: no provider (503), a
 * schema-invalid response (502), a submission that cannot be acted on (400). The one that
 * can produce claims is `applied`, and even then every claim went through the guard: the
 * `dropped` array is in the response so the UI can say what was refused and WHY, which is
 * the difference between a tool that checked and a tool that silently lost your work.
 *
 * The counts are the WHOLE profile's, exactly as `/claims` reports them, so the number the
 * verification list shows after the wizard hands over is the number this response carried.
 */
router.post('/interview/:sessionId/answers', requireAuth, async (req: Request, res: Response) => {
  try {
    if (!isInterviewSessionId(req.params.sessionId)) {
      throw new CareerInterviewError(
        'interview_invalid_input',
        'that is not an interview session id: start an interview first',
      );
    }
    const answers = normalizeInterviewAnswers(req.body);
    const profile = await resolveCallerProfile(req);
    const recorded = await recordInterviewClaims(
      { profileId: profile.id, userId: req.user!.id, answers },
      prisma,
    );
    const counts = await countsForProfileId(profile.id);

    res.status(201).json({
      sessionId: req.params.sessionId,
      profileId: profile.id,
      provider: recorded.provider,
      model: recorded.model,
      claims: {
        extracted: recorded.extracted,
        accepted: recorded.accepted,
        created: recorded.created,
        deduped: recorded.deduped,
        total: counts.total,
      },
      counts,
      unconfirmed: counts.unconfirmed,
      statusAssigned: CAREER_INTERVIEW_STATUS,
      provenanceAssigned: CAREER_INTERVIEW_PROVENANCE,
      inferenceMethod: CAREER_INTERVIEW_INFERENCE_METHOD,
      // What the guard refused, with the reason. Present even when empty: "nothing was
      // dropped" is information, and its absence would read as "nothing was checked".
      dropped: recorded.dropped,
      // Where the user goes next. The wizard does not decide on its own that these are
      // usable; the verification list is where a person decides.
      nextPath: '/app/career',
      note:
        'Every claim above is unconfirmed and was written by a model from your answers. Confirm or reject each one on the Career Evidence page; nothing enters a resume until you do (ADR-036).',
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

export default router;
export { router as careerVerificationRouter };
