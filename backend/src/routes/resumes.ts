// Resume revision + JSON import routes (T1030; ADR-035, ADR-036; 05 sec.6, sec.7.7).
//
// WHAT THIS FILE IS. The HTTP surface of the resume derivation layer, and nothing else.
// Every decision - the projection, the immutability of a revision, the pre-render gate,
// the "an import is never a confirmation" rule - lives in a service module under
// `resume/` or `career/`, and this file only: validates the request envelope, checks
// ownership, calls the service, and maps its typed errors onto status codes.
//
// Follows the repo conventions exactly (`routes/applications.ts` is the model):
//   requireAuth on every route -> ensureOwnership on every user-owned resource ->
//   validateInput(zodSchema, req.body) -> service call -> res.json -> handleApiError.
//
// MOUNTING. The default export is mounted at `/resumes` ALONGSIDE the frozen legacy
// builder router (`routes/resume.ts`), not instead of it: 07 keeps the legacy CRUD
// serving during the transition. There is no path collision - the legacy router's
// `/:id` matches exactly one segment, so `/:id/revisions` and `/:id/diff` fall through
// to this one - and the V2 columns (`modelVersion = 2`) are what the new routes read.
// The second export is mounted at `/career` for the import, which is where 06-design's
// route table puts it.
//
// THE GATE IS A ROUTE GUARD, AND IT IS FIRST. `POST /resumes/:id/render` runs
// `preRenderGuard` as express middleware, so the gate executes before the handler body
// - before the renderer port is resolved, before a template is read, before a sandbox
// exists. The handler is unreachable on a blocked revision, and `resumes.test.ts`
// proves it with a render port that records every call: on a blocked revision the
// record is EMPTY, which is ordering evidence rather than a claim about it.
//
// Nothing here writes a CareerClaim with a status. The import route goes through
// `career/claims.ts#createClaim`, which is the only dedupe point and cannot be handed a
// confirming status, and the gate reads `CareerClaim.status` from the database rather
// than from the `x-clearance` block in the document. Those two facts are the invariant.
// =====================================================================================

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureOwnership } from '../shared/auth.js';
import {
  BadRequestError,
  NotFoundError,
  handleApiError,
} from '../shared/errors.js';
import {
  createResumeRevisionSchema,
  importJsonResumeSchema,
  listResumeRevisionsSchema,
  validateInput,
} from '../shared/validation.js';
import {
  claimFingerprint,
  createClaim,
  type CareerStore,
  type ClaimCreateInput,
} from '../career/claims.js';
import {
  createEvidenceSource,
} from '../career/evidence.js';
import {
  ClaimInvariantError,
  ClaimNotFoundError,
} from '../career/claims.js';
import {
  IMPORTED_CLAIM_PROVENANCE,
  IMPORTED_CLAIM_STATUS,
  PreRenderGateError,
  evaluatePreRenderGate,
  evaluateRevisionPreRenderGate,
  type ClaimUsageInput,
} from '../career/claimUsage.js';
import {
  EvidenceKind,
  ResumeChangeSource,
  ResumeUsage,
} from '@prisma/client';
import { lowerResumeJson, type ResumeJson } from '../resume/json/jsonresume.js';
import { validateResumeJson, ResumeJsonValidationError } from '../resume/json/validate.js';
import {
  StorageError,
  createArtifactStore,
  type ArtifactStore,
} from '../render/storage.js';
import {
  CLIENT_VISIBLE_RENDER_REASONS,
  RenderPortError,
  requestExtension,
} from '../render/types.js';
import { RENDER_DEFAULT_TEMPLATE_ID } from '../render/templates.js';
import {
  ProjectionError,
  loadProjectionInput,
  projectResumeJson,
  legacyResumeToClaimDrafts,
  loadLegacyResume,
} from '../resume/json/project.js';
import {
  ResumeRevisionError,
  RevisionAuditError,
  assertRevisionRenderableInScope,
  createRevision,
  diffRevisions,
  getCurrentRevision,
  getRevision,
  getRevisionByNumber,
  listRevisions,
  type CreateChangeInput,
} from '../resume/revisions.js';

const router = Router();
const careerRouter = Router();

// ---------------------------------------------------------------------------
// The render port
// ---------------------------------------------------------------------------

/** What a render is, from this layer's point of view. */
export interface RenderResult {
  documentId: string;
  format: string;
  hash: string;
}

/**
 * The renderer seam. T1030 ships the GATE, not the renderer: this port is where a later
 * task (T1042 and the typst/latex adapters) plugs in. It exists as a port rather than a
 * hard-coded 501 so the gate's ORDERING is a fact: the test installs a port that
 * records every call, and asserts the record is empty on a blocked revision.
 *
 * `templateId` is OPTIONAL and absent means "the port's own default". It is a render-time
 * choice and it is deliberately NOT a member of the resume document: the same revision rendered
 * with two templates is two artifacts of ONE snapshot, and `templateId` is already part of the
 * cache tuple (`@@unique([revisionId, format, templateId])`), so asking for another template is
 * a different document rather than a rewrite of the one on the server.
 */
export type ResumeRenderPort = (args: {
  revisionId: string;
  format: string;
  userId: string;
  /** The registry id to lay the revision out with. Omitted = the port's default. */
  templateId?: string;
}) => Promise<RenderResult>;

let renderPort: ResumeRenderPort | null = null;

/** Install the renderer. Called by the render adapter; overridable in tests. */
export function setResumeRenderPort(port: ResumeRenderPort | null): void {
  renderPort = port;
}

function requireRenderPort(): ResumeRenderPort {
  if (!renderPort) {
    throw new NotFoundError('Resume renderer');
  }
  return renderPort;
}

// ---------------------------------------------------------------------------
// Error mapping: one place, so every route classifies identically
// ---------------------------------------------------------------------------

/**
 * Translate a service error onto an HTTP status. Returning a response is preferred to
 * throwing so `handleApiError` never has to learn about these types, and so the
 * machine-readable `code`/`reason` survive to the client - the gate's reason is the
 * whole point of it, and a generic 500 would throw that away.
 */
function sendServiceError(res: Response, error: unknown): void {
  if (error instanceof PreRenderGateError) {
    // 409, not 403/422: the request was well-formed and the user IS allowed to do this
    // - the resume just is not renderable yet, and the fix is to confirm claims. A 422
    // would tell the client its request was malformed, which it was not.
    res.status(409).json({ error: error.message, ...error.toJSON() });
    return;
  }
  if (error instanceof RevisionAuditError) {
    // 409 as well, but for a different reason and with a different code: the revision's
    // audit trail does not describe its own document (a tampered row, a usage log that
    // disagrees with the block, a V2 document that declares no claim at all). A client
    // that sees `resume_revision_audit_failed` is looking at a server-side integrity
    // problem, not at "confirm your claims" - which is why it is a separate code rather
    // than another `PreRenderGateError` reason.
    res.status(409).json({ error: error.message, ...error.toJSON() });
    return;
  }
  if (error instanceof ResumeJsonValidationError) {
    res.status(400).json({ error: error.message, ...error.toJSON() });
    return;
  }
  if (error instanceof ResumeRevisionError) {
    const status = error.reason === 'RESUME_NOT_FOUND' || error.reason === 'REVISION_NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: error.message, ...error.toJSON() });
    return;
  }
  if (error instanceof ProjectionError) {
    const status = error.reason === 'PROFILE_NOT_FOUND' || error.reason === 'RESUME_NOT_FOUND' ? 404 : 400;
    res.status(status).json({ error: error.message, code: error.code, reason: error.reason });
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
  if (error instanceof RenderPortError) {
    // The one place a render refusal becomes an HTTP response. The STATUS comes from the
    // error's own lookup table (plan sec. 7: 429 for RENDER_BUSY, 422 for the input and
    // format refusals, 503 for the timeout / resource / artifact / broker / storage
    // failures), and the BODY is `code` plus - only for the reasons the contract names as
    // actionable - the reason. So a caller can branch on `render_format_unsupported` and
    // read WHY in `TYP_EXPORT_IS_A_BUNDLE`, while a broker refusal arrives as a code and
    // nothing else: a reason vocabulary is an internal taxonomy and a render refusal must
    // not become an information channel.
    const body: Record<string, string> = { error: error.message, code: error.code };
    if (CLIENT_VISIBLE_RENDER_REASONS.has(error.reason)) {
      body.reason = error.reason;
    }
    res.status(error.status).json(body);
    return;
  }
  handleApiError(error, res);
}

/** Load a resume and check the caller owns it. Throws 404/403, never returns null. */
async function requireOwnedResume(req: Request, id: string): Promise<{ id: string; userId: string; modelVersion: number; profileId: string | null; name: string }> {
  const resume = await prisma.resume.findUnique({
    where: { id },
    // `name` is selected for the attachment filename of the document routes. It is a
    // user-set string and is therefore SANITISED before it reaches a header - see
    // `attachmentFilename` - which is why selecting it here is not a new disclosure: the
    // owner already reads this row's name through the resume routes.
    select: { id: true, userId: true, modelVersion: true, profileId: true, name: true },
  });
  if (!resume) throw new NotFoundError('Resume');
  await ensureOwnership(req.user!.id, resume.userId, 'Resume');
  return resume;
}

// ---------------------------------------------------------------------------
// POST /resumes/from-profile - the V2 DATA PATH (T1050's enabler)
// ---------------------------------------------------------------------------
//
// WHY THIS ROUTE EXISTS, AND WHY IT IS SMALL. Until it existed there was NO way to create a
// `modelVersion = 2` `Resume` row: `routes/resume.ts` (the frozen legacy builder) creates
// `modelVersion = 1` rows only, and every V2 read path in this file keys on `modelVersion`/
// `profileId`. The Studio therefore had nothing to open. This route is the smallest thing
// that closes that gap and it is EXACTLY two writes:
//
//   1. the `Resume` row (`modelVersion: 2`, `profileId`, `kind: 'master'`) - a V2 shape. The
//      legacy columns are left at their DEFAULTS on purpose: `personalInfo: {}` is the only
//      one with no default, and the legacy builder's `templateId` default ('classic') is a
//      different registry namespace from the Typst one, so it is not touched.
//   2. revision 1, via the SAME `createRevision` the editor's autosave uses. So the first
//      revision is created through the immutable-snapshot path with the same five checks -
//      it is not a privileged shortcut that skips the belt.
//
// The document is `projectResumeJson(loadProjectionInput(profile))`, i.e. the EXISTING
// projector, so it carries the `x-clearance` block the gate reads and every claim keeps
// its REAL status. Creating a resume CONFIRMS NOTHING: the revision is a draft, the gate
// is REPORTED in the response (not enforced - see `/:id/revisions`), and a profile with
// nothing confirmed yields a resume the gate will refuse to render. That is the honest
// state (05 sec.2.5 / 06 E.11 flow 1's empty state), not an error.
//
// The V1 create path in `routes/resume.ts` is NOT touched, and the belt
// (`assertRevisionRenderableInScope`) is not weakened, widened or re-routed: this route
// calls `createRevision`, which runs the same pre-insert checks every other revision does.
//
// NOT IN THE 06-DESIGN ROUTE TABLE. It is a creation enabler for the Studio rather than a
// new capability, and it is deliberately the only addition: the projection surface already
// existed as `POST /resumes/:id/project` (a preview that writes nothing).
const createResumeFromProfileSchema = z
  .object({
    /** Display name for the row. Defaults to the profile's headline, then a fixed string. */
    name: z.string().max(200, 'Name too long').optional(),
    /** Defaults to the caller's OWN CareerProfile (there is at most one, `userId` unique). */
    profileId: z.string().min(1, 'profileId is required').max(100).optional(),
  })
  .strict();

router.post('/from-profile', requireAuth, async (req, res) => {
  try {
    const data = validateInput(createResumeFromProfileSchema, req.body ?? {});

    const profile = data.profileId
      ? await prisma.careerProfile.findUnique({
          where: { id: data.profileId },
          select: {
            id: true,
            userId: true,
            headline: true,
            summary: true,
            locationPref: true,
            links: true,
            user: { select: { name: true, email: true } },
          },
        })
      : await prisma.careerProfile.findUnique({
          where: { userId: req.user!.id },
          select: {
            id: true,
            userId: true,
            headline: true,
            summary: true,
            locationPref: true,
            links: true,
            user: { select: { name: true, email: true } },
          },
        });
    // No profile is a 404, not a 400: the request named a real resource that does not
    // exist yet, and the fix is in the career layer (import something), not in this body.
    if (!profile) throw new NotFoundError('Career profile');
    // Ownership even on the default path, so the two branches cannot diverge: a caller who
    // names another tenant's profileId is refused here rather than silently projecting their
    // own profile instead (the 404-or-403 distinction is `ensureOwnership`'s, not ours).
    await ensureOwnership(req.user!.id, profile.userId, 'Career profile');

    // `basics` must come from the PROFILE'S PERSON, not from its headline. The projector's
    // own fallback names the resume after the headline, which is why a resume created here
    // rendered with "Software Engineer" in the name field instead of the owner's name.
    const links =
      profile.links !== null && typeof profile.links === 'object' && !Array.isArray(profile.links)
        ? (profile.links as Record<string, unknown>)
        : {};
    const link = (key: string): string | null => {
      const value = links[key];
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    };
    const profileName = profile.user?.name?.trim() || profile.headline?.trim() || 'Unnamed';
    const github = link('github');
    const linkedin = link('linkedin');
    const basics = {
      name: profileName,
      label: profile.headline ?? null,
      email: profile.user?.email ?? link('email'),
      phone: link('phone'),
      url: link('website'),
      summary: profile.summary ?? null,
      ...(profile.locationPref ? { location: { city: profile.locationPref } } : {}),
      profiles: [
        ...(github
          ? [{ network: 'GitHub', url: github.startsWith('http') ? github : `https://${github}` }]
          : []),
        ...(linkedin
          ? [{ network: 'LinkedIn', url: linkedin.startsWith('http') ? linkedin : `https://${linkedin}` }]
          : []),
      ],
    };

    const input = await loadProjectionInput(profile.id, prisma, {
      sourceModelVersion: 2,
      basics,
    });
    const projection = projectResumeJson(input);
    // Structural validity is checked BEFORE either write, so a projection that does not
    // satisfy JSON Resume + `x-clearance` leaves no half-created resume behind.
    const validation = validateResumeJson(projection.document);
    if (!validation.valid) throw new ResumeJsonValidationError(validation.errors);

    const name = (data.name ?? profile.user?.name ?? profile.headline ?? 'My resume').trim() || 'My resume';
    // THE TWO WRITES ARE ONE UNIT (F4). The `Resume` row is inserted first because the
    // revision names it, and `createRevision` then runs its own pre-insert checks - the claim
    // usage belt, the document's `x-clearance` cross-check, the op-log validation - any of
    // which can throw. With two separate statements every such throw left a `modelVersion:
    // 2` resume behind with NO revision, contradicting this route's own comment above, and
    // each retry added another. A `$transaction` makes the pair all-or-nothing; the child
    // writes (`resumeChange`, `resumeClaimUsage`) ride inside the same transaction because
    // they go through the same client, so a refusal leaves NOTHING.
    //
    // The transaction client is what `createRevision` is handed, not `prisma`, so the
    // revision, its op log and its usage rows are written inside the transaction too rather
    // than escaping it. `createRevision`'s store type is a `Pick` of the delegates, which the
    // interactive-transaction client satisfies structurally.
    const { resume, revision } = await prisma.$transaction(async (tx) => {
      const created = await tx.resume.create({
        data: {
          userId: req.user!.id,
          name,
          // The only legacy column with NO default. `{}` rather than a fabricated personalInfo:
          // this row's canonical content lives in its revisions, and inventing contact
          // details here would put text in the document that no claim backs.
          personalInfo: {},
          modelVersion: 2,
          kind: 'master',
          profileId: profile.id,
          // A V2 row's template must be a render-registry id. The legacy column default
          // (`classic`) is a DIFFERENT namespace and the render registry refuses it, so a
          // resume created here without naming one used to reach the Studio with an
          // unresolvable template. The registry's own default is the honest value.
          templateId: RENDER_DEFAULT_TEMPLATE_ID,
        },
        select: { id: true, name: true, modelVersion: true, profileId: true, createdAt: true },
      });

      // Through the SAME writer the editor uses. `reason` says what created it, so the diff
      // view can distinguish "projected from the profile" from "the user edited a block".
      const first = await createRevision(
        {
          resumeId: created.id,
          document: projection.document,
          createdBy: ResumeChangeSource.user,
          createdByUserId: req.user!.id,
          reason: 'projected from the career profile',
        },
        tx as unknown as Parameters<typeof createRevision>[1],
      );
      return { resume: created, revision: first };
    });

    // Reported, not enforced - identical to `/:id/revisions`. A caller learns immediately
    // whether this snapshot is renderable without attempting a render to find out.
    const gate = await evaluateRevisionPreRenderGate(revision.id, prisma);
    res.status(201).json({
      resume,
      revision: {
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        jsonHash: revision.jsonHash,
        createdAt: revision.createdAt,
        document: revision.resumeJson,
      },
      validation,
      gate,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/revisions - create revision N+1 (an immutable snapshot)
// ---------------------------------------------------------------------------

router.post('/:id/revisions', requireAuth, async (req, res) => {
  try {
    const resume = await requireOwnedResume(req, req.params.id);
    const data = validateInput(createResumeRevisionSchema, req.body);

    const document = data.document as ResumeJson;
    // The gate is NOT run here. Creating a revision that quotes an unconfirmed claim is
    // LEGAL and NECESSARY: that is the draft the user reviews and confirms (05 sec.2.5
    // - an inferred claim "may be surfaced as a suggestion"). What is refused is
    // RENDERING it, which is `/render` below. Running the gate on create would make
    // the Studio unusable, which is the classic way this invariant gets "enforced" into
    // uselessness.
    // `usages` is passed through as a RESTATEMENT, not as the record. `createRevision`
    // derives the real set from the document's `x-clearance` block, REFRESHES the block's
    // row-derived members from the `CareerClaim` rows, and refuses a restatement that
    // disagrees - in either direction. (The status cross-check is a REFRESH now, not a
    // refusal: a stale-but-honest block is accepted and stored with the rows' values,
    // which is what makes Studio autosave work. Only the structural mismatches and an
    // unresolvable claim are still refusals.) `undefined` (a caller that sends none) is
    // the normal case and is exactly right: the document is the source, so there is nothing
    // to assert.
    const revision = await createRevision(
      {
        resumeId: resume.id,
        document,
        createdBy: ResumeChangeSource.user,
        createdByUserId: req.user!.id,
        reason: data.reason ?? null,
        enginePins: data.enginePins ?? {},
        usages: data.usages === undefined ? undefined : (data.usages as ClaimUsageInput[]),
        changes: (data.changes ?? []) as CreateChangeInput[],
      },
      prisma,
    );

    // The verdict is REPORTED, not enforced: a caller learns immediately whether this
    // snapshot is renderable, without having to attempt a render to find out.
    const gate = await evaluateRevisionPreRenderGate(revision.id, prisma);
    res.status(201).json({
      id: revision.id,
      resumeId: revision.resumeId,
      revisionNumber: revision.revisionNumber,
      jsonHash: revision.jsonHash,
      createdAt: revision.createdAt,
      document: revision.resumeJson,
      gate,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /resumes/:id/revisions - list, oldest first
// ---------------------------------------------------------------------------

router.get('/:id/revisions', requireAuth, async (req, res) => {
  try {
    const resume = await requireOwnedResume(req, req.params.id);
    const query = validateInput(listResumeRevisionsSchema, req.query);
    const revisions = await listRevisions(
      { resumeId: resume.id, limit: query.limit, offset: query.offset },
      prisma,
    );
    // `resumeJson` is omitted from the list: it is the largest member by far and the
    // list is for navigation. `GET /revisions/:n` returns the document.
    res.json(
      revisions.map((revision) => ({
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        jsonHash: revision.jsonHash,
        createdBy: revision.createdBy,
        createdByUserId: revision.createdByUserId,
        reason: revision.reason,
        createdAt: revision.createdAt,
      })),
    );
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /resumes/:id/revisions/:n - one revision + its document
// ---------------------------------------------------------------------------

router.get('/:id/revisions/:n', requireAuth, async (req, res) => {
  try {
    const resume = await requireOwnedResume(req, req.params.id);
    const revisionNumber = Number(req.params.n);
    const revision = await getRevisionByNumber(resume.id, revisionNumber, prisma);
    if (!revision) throw new NotFoundError('Resume revision');
    const gate = await evaluateRevisionPreRenderGate(revision.id, prisma);
    res.json({
      id: revision.id,
      resumeId: revision.resumeId,
      revisionNumber: revision.revisionNumber,
      jsonHash: revision.jsonHash,
      createdBy: revision.createdBy,
      createdByUserId: revision.createdByUserId,
      reason: revision.reason,
      createdAt: revision.createdAt,
      document: revision.resumeJson,
      gate,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /resumes/:id/diff?from=1&to=2 - the change log between two revisions
// ---------------------------------------------------------------------------

router.get('/:id/diff', requireAuth, async (req, res) => {
  try {
    const resume = await requireOwnedResume(req, req.params.id);

    const revisions = await listRevisions({ resumeId: resume.id }, prisma);
    if (revisions.length === 0) throw new NotFoundError('Resume revisions');

    const current = revisions[revisions.length - 1];
    const parseNumber = (raw: unknown, field: string): number => {
      if (raw === undefined || raw === null || raw === '') return NaN;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw new BadRequestError(`${field} must be an integer >= 1`);
      }
      return value;
    };
    // `to` defaults to the current revision and `from` to the one before it, so
    // `GET /diff` on a resume with a history is a useful answer with no parameters.
    const toNumber = Number.isNaN(parseNumber(req.query.to, 'to'))
      ? current.revisionNumber
      : parseNumber(req.query.to, 'to');
    const fromNumber = Number.isNaN(parseNumber(req.query.from, 'from'))
      ? revisions[Math.max(0, revisions.findIndex((r) => r.revisionNumber === toNumber) - 1)].revisionNumber
      : parseNumber(req.query.from, 'from');

    const from = revisions.find((r) => r.revisionNumber === fromNumber);
    const to = revisions.find((r) => r.revisionNumber === toNumber);
    if (!from || !to) throw new NotFoundError('Resume revision');
    if (from.revisionNumber > to.revisionNumber) {
      throw new BadRequestError('from must be <= to');
    }

    res.json(diffRevisions(from, to));
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/project - project the profile into a fresh document (no write)
// ---------------------------------------------------------------------------
//
// Not in the 06-design route table, and deliberately so: it is a PREVIEW surface. A
// caller can see what a revision WOULD contain - including the `x-clearance` statuses
// and the gate verdict - without creating a revision, which is what makes the Studio's
// "confirm before you save" flow possible. It writes nothing but the projection.

router.post('/:id/project', requireAuth, async (req, res) => {
  try {
    const resume = await requireOwnedResume(req, req.params.id);

    // A legacy row (modelVersion 1) has no CareerProfile behind it, so it goes through
    // the backfill path: the legacy bullets become INFERRED claim drafts, exactly as
    // 05 sec.7.7 requires, and the projection reports them as unconfirmed. The drafts
    // are NOT persisted here - a preview must not write claims - so the document is
    // built from the lowered statements with the imported status attached.
    if (resume.modelVersion < 2 || !resume.profileId) {
      const legacy = await loadLegacyResume(resume.id, prisma);
      const drafts = legacyResumeToClaimDrafts(legacy);
      const personalInfo = (legacy.personalInfo ?? {}) as Record<string, unknown>;
      const document = projectResumeJson({
        profileId: legacy.profileId ?? `legacy-${legacy.id}`,
        basics: {
          name: typeof personalInfo.fullName === 'string' ? personalInfo.fullName : legacy.name,
          email: typeof personalInfo.email === 'string' ? personalInfo.email : null,
          phone: typeof personalInfo.phone === 'string' ? personalInfo.phone : null,
          url: typeof personalInfo.website === 'string' ? personalInfo.website : null,
          location:
            typeof personalInfo.location === 'string' && personalInfo.location.length > 0
              ? { city: personalInfo.location }
              : null,
          summary: legacy.summary.length > 0 ? legacy.summary : null,
        },
        sourceModelVersion: 1,
        // A preview has no rows to project FROM, so the legacy statements are shown as
        // one `omitted` claim each. They are listed so the user can see what the backfill
        // WOULD create, and the gate verdict on the response says what it would block.
        // The FINGERPRINT is the real one the statement would get on import - the claim
        // layer owns that identity - so a preview and the import it previews agree.
        otherClaims: drafts.map((draft) => ({
          claim: {
            id: `draft:${draft.jsonPath}`,
            kind: draft.kind,
            statement: draft.statement,
            status: IMPORTED_CLAIM_STATUS,
            provenance: IMPORTED_CLAIM_PROVENANCE,
            confidence: null,
            evidenceSourceId: null,
            fingerprint: claimFingerprint(draft.kind, draft.statement),
          } as never,
          usage: ResumeUsage.omitted,
        })),
      });
      // F5: the verdict is what the gate WOULD say, computed by the gate. The old
      // response hand-wrote `{allowed: false, reason: 'CLAIM_NOT_CONFIRMED', violations:
      // [...every draft...]}` - but every draft is `usage: omitted`, which
      // `evaluatePreRenderGate` returns on BEFORE the status check, so the gate has no
      // branch that can ever produce that verdict. A client rendering
      // `gate.violations` as "these are blocking" was told that a class of claims can
      // block which in fact cannot. "Not renderable yet" is now stated as
      // `backfill.persisted: false`, which is the real reason and is a fact about the
      // request rather than a fabricated gate result.
      const previewGate = evaluatePreRenderGate(
        document.clearance.claims.map((entry) => ({
          claimId: entry.claimId,
          usage: entry.usage,
          claimStatus: entry.status,
        })),
      );
      res.json({
        modelVersion: 1,
        document: document.document,
        gate: previewGate,
        backfill: {
          claimDrafts: drafts.length,
          persisted: false,
          note:
            'preview only: these are claim DRAFTS, not rows, so there is no usage log for a gate to read; a revision created from this document will carry them as inferred claims and the gate will block them',
        },
      });
      return;
    }

    const input = await loadProjectionInput(resume.profileId, prisma, {
      sourceModelVersion: resume.modelVersion,
    });
    const projection = projectResumeJson(input);
    const validation = validateResumeJson(projection.document);
    // F5: as above - the same real verdict, from the same pure function, over the
    // usages the projection actually placed. `unconfirmed` stays as a separate count
    // because it is a useful hint ("how much is left to confirm") that is NOT a gate
    // verdict; conflating the two is what produced the fabricated branch above.
    const previewGate = evaluatePreRenderGate(
      projection.clearance.claims.map((entry) => ({
        claimId: entry.claimId,
        usage: entry.usage,
        claimStatus: entry.status,
      })),
    );
    res.json({
      modelVersion: resume.modelVersion,
      document: projection.document,
      jsonHash: projection.canonical,
      validation,
      gate: {
        ...previewGate,
        unconfirmed: projection.clearance.unconfirmedClaimCount,
        note: 'preview only: the gate reads ResumeClaimUsage rows, which exist once a revision is created; this verdict is what it would say over the usages this document declares',
      },
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/upgrade - UPGRADE-ON-OPEN (T1110)
// ---------------------------------------------------------------------------
//
// WHY THIS ROUTE EXISTS, AND WHY IT IS THE SMALLEST THING THAT WORKS. The frontend cutover
// deleted the V1 builder and made `/app/build/:resumeId` REDIRECT to `/app/studio/:resumeId`. A
// redirect to a screen that cannot show the row is a dead end, and the Studio cannot show a V1
// row: `Studio.tsx` reads `GET /resumes/:id/revisions`, and a `modelVersion = 1` row has none -
// `GET /revisions` returns `[]`, and the page says "nothing to edit". So something has to turn
// the row into a first V2 revision, and the smallest correct place is here.
//
// EVERY STEP REUSES EXISTING CODE. Nothing in this handler writes a row directly:
//
//   1. `loadLegacyResume` + `legacyResumeToClaimDrafts` (05 sec.7.7) - the EXISTING legacy
//      projection, which hard-codes `IMPORTED_CLAIM_STATUS` / `IMPORTED_CLAIM_PROVENANCE` and
//      has no parameter that could influence either.
//   2. `createClaim` - the only dedupe point, and its input type has no confirming member at
//      all. `ClaimVerification` rows are NOT written by anything here: the only writer of that
//      table is the user's own decision, so "the upgrade auto-confirms a claim" is not merely
//      untrue, it is unrepresentable.
//   3. `loadProjectionInput` + `projectResumeJson` - the projector reading the REAL claim rows,
//      so the document's `x-clearance` block carries real ids, real statuses and real usages
//      rather than the placeholder block `POST /:id/project` (a preview) builds.
//   4. `createRevision` - the belt. Revision 1 goes through the same five pre-insert checks as
//      every other revision; this is not a privileged shortcut.
//
// IDEMPOTENT, NOT ADOPTIVE. A second call on an already-upgraded row writes NOTHING and returns
// the current revision (200, not 201). Re-running an upgrade must never re-project a document,
// because a user's edits to revision 1 would be replaced by a fresh projection of the same
// legacy row - the backfill would silently undo work. That is also why the route refuses rather
// than merges when a row already has revisions.
//
// THE RESULT IS A DRAFT AND THE RESPONSE SAYS SO. `claims.statusAssigned` is echoed so a caller
// can prove the block did not decide anything, exactly as `POST /career/import/json` does. A
// gate verdict is REPORTED, not enforced: an all-inferred revision is the honest state
// (05 sec.2.5 / ADR-036), and the user confirms in the verification UI.
const upgradeResumeSchema = z
  .object({
    /**
     * Which `CareerProfile` to attach the backfilled claims to. Defaults to the caller's own
     * profile (`CareerProfile.userId` is unique, so there is at most one) and CREATES it when
     * there is none - a V1-era user upgrading their first resume has no profile yet, and
     * refusing them would make the redirect a dead end for exactly the people the cutover is
     * for.
     */
    profileId: z.string().min(1, 'profileId is required').max(100).optional(),
  })
  .strict();

router.post('/:id/upgrade', requireAuth, async (req, res) => {
  try {
    const resume = await requireOwnedResume(req, req.params.id);
    const data = validateInput(upgradeResumeSchema, req.body ?? {});

    // ALREADY UPGRADED. Returning the current revision is the whole idempotency contract: no
    // claim, no evidence source, no revision, no `Resume` update.
    if (resume.modelVersion >= 2 && resume.profileId) {
      const current = await getCurrentRevision(resume.id, prisma);
      if (current) {
        const gate = await evaluateRevisionPreRenderGate(current.id, prisma);
        res.json({
          upgraded: false,
          reason: 'already_upgraded',
          resume: { id: resume.id, modelVersion: resume.modelVersion, profileId: resume.profileId },
          revision: {
            id: current.id,
            revisionNumber: current.revisionNumber,
            jsonHash: current.jsonHash,
            createdAt: current.createdAt,
            document: current.resumeJson,
          },
          gate,
          claims: null,
          statusAssigned: IMPORTED_CLAIM_STATUS,
        });
        return;
      }
      // A V2 row with NO revision cannot happen through this API (`POST /from-profile` writes
      // both), but if it does, falling THROUGH to the backfill is the right repair: the row
      // claims to be V2 and has nothing to show, and re-projecting the legacy row gives it one.
    }

    // 1. THE PROFILE. Ownership is checked even on the default path, so a caller who names
    //    another tenant's profileId is refused here rather than silently backfilling into it.
    const profile = data.profileId
      ? await prisma.careerProfile.findUnique({
          where: { id: data.profileId },
          select: { id: true, userId: true, headline: true },
        })
      : await prisma.careerProfile.findUnique({
          where: { userId: req.user!.id },
          select: { id: true, userId: true, headline: true },
        });
    if (data.profileId && !profile) throw new NotFoundError('Career profile');
    if (profile) {
      await ensureOwnership(req.user!.id, profile.userId, 'Career profile');
    }
    const profileId =
      profile?.id ??
      (
        await prisma.careerProfile.create({
          data: { userId: req.user!.id },
          select: { id: true, userId: true, headline: true },
        })
      ).id;
    const store: CareerStore = prisma;

    // 2. THE LEGACY PROJECTION - the existing backfill, unmodified. It returns DRAFTS; nothing
    //    here can change the status they carry.
    const legacy = await loadLegacyResume(resume.id, prisma);
    const drafts = legacyResumeToClaimDrafts(legacy);

    // 3. THE PROVENANCE ANCHOR. The legacy row's own content is the source - it is not an
    //    uploaded file, but it IS where the text came from, and a claim with no source cannot
    //    be shown with its evidence. Hash-deduped by `createEvidenceSource`, so upgrading twice
    //    reuses the same source row.
    const contentText = JSON.stringify({
      name: legacy.name,
      personalInfo: legacy.personalInfo ?? {},
      summary: legacy.summary,
      experience: legacy.experience ?? [],
      education: legacy.education ?? [],
      skills: legacy.skills ?? [],
    });
    const source = await createEvidenceSource(
      {
        profileId,
        kind: EvidenceKind.document,
        title: `${legacy.name} (upgraded legacy resume)`,
        text: contentText,
        mimeType: 'application/json',
      },
      store,
    );

    // 4. THE CLAIMS, through `createClaim` - the single dedupe point. `status` and `provenance`
    //    are the import constants, and `ClaimCreateInput` has no confirming member, so every row
    //    this writes is `inferred` BY CONSTRUCTION rather than by a decision taken here.
    //    NO `ClaimVerification` ROW IS WRITTEN, for the same reason.
    let created = 0;
    let deduped = 0;
    for (const draft of drafts) {
      const input: ClaimCreateInput = {
        profileId,
        kind: draft.kind,
        statement: draft.statement,
        status: IMPORTED_CLAIM_STATUS,
        provenance: IMPORTED_CLAIM_PROVENANCE,
        confidence: null,
        inferenceMethod: draft.inferenceMethod,
        evidenceSourceId: source.source.id,
        // Entity attachments stay null: a `role` claim naming an employer is useful, but
        // attaching it to an `Experience` row requires that row to exist, and creating
        // entities out of an unverified backfill is the line 05 sec.2.2 draws.
        experienceId: null,
        educationId: null,
        projectId: null,
        skillId: null,
        certificationId: null,
      };
      const result = await createClaim(input, store);
      if (result.outcome === 'created') created += 1;
      else deduped += 1;
    }

    // 5. THE DOCUMENT, from the projector reading the rows just written. Structural validity
    //    is checked BEFORE any revision is created, so a projection the belt would refuse
    //    leaves no half-upgraded resume behind.
    //
    //    `basics` comes from the LEGACY ROW, not from the profile - the same choice
    //    `POST /:id/project` makes for a V1 row, and for the same reason: the profile a V1-era
    //    user upgrades into is empty, so projecting their NAME and SUMMARY from it would replace
    //    what they actually wrote with `Unnamed` and nothing. The summary stays on the claim
    //    rail either way, because `legacyResumeToClaimDrafts` emits the summary as a `soft_skill`
    //    draft - so the string placed at `basics.summary` is backed by an inferred claim and the
    //    belt sees it, rather than being unattributed text (ADR-043 R-SUMMARY).
    const legacyPersonal = (legacy.personalInfo ?? {}) as Record<string, unknown>;
    const input = await loadProjectionInput(profileId, prisma, {
      sourceModelVersion: 1,
      basics: {
        name:
          typeof legacyPersonal.fullName === 'string' && legacyPersonal.fullName.trim().length > 0
            ? legacyPersonal.fullName.trim()
            : legacy.name,
        email: typeof legacyPersonal.email === 'string' ? legacyPersonal.email : null,
        phone: typeof legacyPersonal.phone === 'string' ? legacyPersonal.phone : null,
        url: typeof legacyPersonal.website === 'string' ? legacyPersonal.website : null,
        location:
          typeof legacyPersonal.location === 'string' && legacyPersonal.location.length > 0
            ? { city: legacyPersonal.location }
            : null,
        summary: legacy.summary.length > 0 ? legacy.summary : null,
      },
    });
    const projection = projectResumeJson(input);
    const validation = validateResumeJson(projection.document);
    if (!validation.valid) throw new ResumeJsonValidationError(validation.errors);

    // 6. THE TWO WRITES ARE ONE UNIT, for the reason `POST /from-profile` gives. The `Resume`
    //    update is first because the revision names it, and `createRevision` then runs its own
    //    pre-insert checks; a throw between them would otherwise leave a `modelVersion: 2` row
    //    with no revision - i.e. the dead end this route exists to remove.
    const upgraded = await prisma.$transaction(async (tx) => {
      const row = await tx.resume.update({
        where: { id: resume.id },
        data: { modelVersion: 2, profileId },
        select: { id: true, name: true, modelVersion: true, profileId: true },
      });
      const first = await createRevision(
        {
          resumeId: row.id,
          document: projection.document,
          createdBy: ResumeChangeSource.import,
          createdByUserId: req.user!.id,
          reason: 'upgraded from a legacy resume: every claim is inferred and awaits confirmation',
        },
        tx as unknown as Parameters<typeof createRevision>[1],
      );
      return { resume: row, revision: first };
    });

    const gate = await evaluateRevisionPreRenderGate(upgraded.revision.id, prisma);
    res.status(201).json({
      upgraded: true,
      resume: upgraded.resume,
      revision: {
        id: upgraded.revision.id,
        revisionNumber: upgraded.revision.revisionNumber,
        jsonHash: upgraded.revision.jsonHash,
        createdAt: upgraded.revision.createdAt,
        document: upgraded.revision.resumeJson,
      },
      validation,
      gate,
      claims: {
        created,
        deduped,
        total: drafts.length,
        evidenceSourceId: source.source.id,
        evidenceSource: source.outcome,
      },
      // Echoed so the caller can prove the block did NOT decide anything: every one of these is
      // the imported status, whatever the legacy row said.
      statusAssigned: IMPORTED_CLAIM_STATUS,
      provenanceAssigned: IMPORTED_CLAIM_PROVENANCE,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/render - THE GATE, as a route guard, before anything else
// ---------------------------------------------------------------------------

/**
 * The route guard. Express middleware, so it runs BEFORE the handler body: a render
 * that reaches the port has necessarily passed the gate, because the only path to the
 * port is through this function's `next()`.
 *
 * The gate reads `CareerClaim.status` from the DATABASE (`loadGateUsages`), not from
 * the `x-clearance` block in the document. A document is derived data that has crossed
 * a network and a file system; a status a renderer can read is a status a renderer can
 * be lied to.
 */
function preRenderGuard() {
  return async (req: Request, res: Response, next: (error?: unknown) => void): Promise<void> => {
    try {
      const resume = await requireOwnedResume(req, req.params.id);
      const revisionId =
        typeof req.query.revisionId === 'string' && req.query.revisionId.length > 0
          ? req.query.revisionId
          : null;
      const revision =
        revisionId === null
          ? // No revision named: the current one. Resolving it here, inside the guard, is
            // what makes "render" mean "render what the user last saved" rather than
            // "render whatever a stale id in a query string points at".
            await getCurrentRevision(resume.id, prisma)
          : await getRevision(revisionId, prisma);

      // F3: A REVISION ID IS NOT A SCOPE. The one thing this guard cannot do is trust a
      // caller-supplied id: `requireOwnedResume` proved the caller owns the RESUME in the
      // path, which says nothing about which of that resume's revisions - or whose -
      // they named. Without this check, `POST /my-resume/render?revisionId=<someone
      // else's revision>` evaluated that revision's usages and called the port, and an
      // id that resolved to nothing passed the gate on zero usage rows and rendered an
      // artifact for a revision that does not exist. Both are now a 404 - and it is a
      // 404 rather than a 403 deliberately, so a probe cannot use this endpoint to
      // discover that some other revision exists.
      if (!revision || revision.resumeId !== resume.id) {
        throw new NotFoundError('Resume revision');
      }

      // The gate, plus the read-time document -> usage binding.
      // `assertRevisionRenderable` alone would only look at the usage rows; this entry
      // point runs `assertRevisionRenderableInScope`, which re-derives the usage set from
      // the stored document, checks the stored bytes still hash to their recorded
      // `jsonHash`, requires every claim the block names to RESOLVE (scoped to the
      // block's own `profileId`), compares the recorded rows to the document as a
      // MULTISET of `(claimId, usage)`, and requires every claim-backed string in the
      // document to be named at that exact path by the document's own block. Only then
      // does the status gate run, over statuses read from the DATABASE.
      //
      // It deliberately does NOT cross-check the block's `status` against the claim rows:
      // a revision is an immutable snapshot, so a block that went stale when the user
      // confirmed a claim afterwards is history, not forgery, and refusing it would make
      // a resume stop being renderable because it got SAFER. The WRITE path
      // (`createRevision`) refreshes those members from the rows, and a FORGERED status
      // cannot reach a rendered artifact either way, because the gate below reads the
      // DATABASE and not this document.
      await assertRevisionRenderableInScope(revision, prisma);
      res.locals.revisionId = revision.id;
      next();
    } catch (error) {
      // No `next(error)`: the guard is the last thing that runs on a blocked revision,
      // and turning a refusal into a 500 would lose the machine-readable reason that
      // the whole design exists to surface.
      sendServiceError(res, error);
    }
  };
}

router.post('/:id/render', requireAuth, preRenderGuard(), async (req, res) => {
  try {
    const revisionId = res.locals.revisionId as string;
    const format = typeof req.body?.format === 'string' ? req.body.format : 'pdf';
    if (!['pdf', 'docx', 'tex', 'typ', 'json'].includes(format)) {
      throw new BadRequestError('format must be one of pdf|docx|tex|typ|json');
    }
    // A CALLER-SUPPLIED `templateId` IS NOW RESOLVED, AND A MALFORMED ONE IS STILL REFUSED.
    // The port resolves whatever string it is given through the registry's own review gate, so
    // switching the Studio's template actually changes the layout - and an id the registry does
    // not know, or a reserved one, is a 422 `render_template_unsupported` from step 4 of the
    // port, BEFORE the cache lookup, any staging, any broker call and any row. What is refused
    // HERE is the one thing the registry could never resolve: a value that is not a template id
    // at all. Silently dropping it would answer 201 with the default's layout for a body that
    // asked for something else, and that substitution is the answer that cannot be defended.
    //
    // The reason string is unchanged because it is server-side only: `CLIENT_VISIBLE_RENDER_REASONS`
    // stays closed, so a client branches on the CODE (`render_template_unsupported`) and never
    // sees this reason - which is why widening the seam did not also have to widen the
    // reason vocabulary the frontend mirrors.
    let templateId: string | undefined;
    if (req.body?.templateId !== undefined && req.body?.templateId !== null) {
      if (typeof req.body.templateId !== 'string' || req.body.templateId.trim().length === 0) {
        throw new RenderPortError('render_template_unsupported', 'TEMPLATE_SELECTION_NOT_PER_REQUEST');
      }
      templateId = req.body.templateId.trim();
    }
    // Reached ONLY through the guard. The renderer port is resolved here, after the
    // gate has already passed, so nothing about a render is touched before then.
    const port = requireRenderPort();
    const result = await port({
      revisionId,
      format,
      userId: req.user!.id,
      // Omitted rather than `undefined` in the body, so a port that inspects its own keys
      // cannot tell "no template named" from "an explicit undefined".
      ...(templateId === undefined ? {} : { templateId }),
    });
    res.status(201).json(result);
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /resumes/:id/documents/:docId - stream a rendered artifact
// ---------------------------------------------------------------------------
//
// WHY THE DOCUMENT ROUTES EXIST AT ALL, AND WHY THEY ARE NOT BEHIND `preRenderGuard`.
// They serve STORED BYTES, not a compile: no template is read, no container is created, no
// budget is spent and nothing the gate protects is produced. The gate governs RENDERING -
// a decision that turns a revision into a document the user will send to an employer - and
// re-running it on a download would mean a user could be locked out of an artifact they
// legitimately produced while their confirmation state moved under them. The gate's
// invariant is "no artifact is PRODUCED from a blocked revision", and it holds at the port.
//
// OWNERSHIP IS PROVED TWICE, and both halves are load-bearing:
//   1. the resume in the path is loaded and `ensureOwnership` is called on it, exactly as
//      every other user-owned route in this file does;
//   2. the document's OWN resume is compared to it. `ResumeDocument.resumeId` is
//      nullable (it is a denormalised convenience for the spec's ER diagram), so the
//      authoritative value is the revision's: `(doc.resumeId ?? doc.revision.resumeId) ===
//      resume.id`. Skipping the second half would let a caller read any document they
//      named by id while authenticated against a resume of their own; skipping the first
//      would leak a resume's existence. The fallback is spelled exactly as the contract
//      names it, so the two agree.
//
// A DOCUMENT THAT DOES NOT BELONG IS A 404, NOT A 403, for the same reason T1030's
// `preRenderGuard` returns 404 for a foreign revision: a 403 confirms the id exists, and
// this endpoint is exactly the shape that lets an attacker enumerate ids.
//
// NEVER A STORAGE ROOT, NEVER A PATH. Every failure below the ownership checks is answered
// from a FIXED vocabulary, so a `StorageError` whose `reason` is `PATH_ESCAPES_ROOT`, a
// `describe().root`, or a raw fs message can never reach a response body. That is the
// difference between "the document could not be read" and a disclosure of the image layout,
// and it is why this route does not use `handleApiError` for a storage fault: a generic 500
// would be safe but useless, and a raw rethrow would be neither.

/** The metadata a document route needs. Never the bytes, never a path. */
interface OwnedDocumentRow {
  id: string;
  resumeId: string | null;
  format: string;
  templateId: string;
  templateVersion: string | null;
  pageCount: number | null;
  hash: string;
  storageKey: string;
  byteSize: number;
  mimeType: string;
  createdAt: Date;
  revision: { resumeId: string } | null;
}

/** The fixed 404 body for a document that cannot be served, with a machine code. */
function documentNotFound(res: Response, code: string, message: string): void {
  res.status(404).json({ error: message, code });
}

/**
 * The store, built per request.
 *
 * NOT memoised, and that is deliberate. `createArtifactStore()` reads
 * `RENDER_STORAGE_ROOT` lazily at call time, so building it per request means a test (and an
 * operator who moves the root) sees the value that is configured NOW rather than the one
 * that was configured when the module loaded. The construction is two `path.resolve` calls
 * and a kind check - no I/O, no directory creation - so per-request cost is nil.
 */
function documentStore(): ArtifactStore {
  try {
    return createArtifactStore();
  } catch (error) {
    // `kind: 's3'` throws `STORAGE_UNAVAILABLE` here: the fail-closed seam (ADR-044 D2).
    // It becomes a 503 with a machine code, never a crash and never a fallback to the
    // local disk an operator believed was unused. The reason is carried through, never the
    // message: a `StorageError` message is already a fixed string, but a store kind this
    // build cannot serve is an operator problem (a 503) rather than a missing document
    // (a 404), and conflating them would send the triage to the wrong place.
    if (error instanceof StorageError) throw error;
    throw new DocumentStorageError('STORAGE_KIND_UNAVAILABLE');
  }
}

class DocumentStorageError extends Error {
  constructor(readonly reason: string) {
    super('the rendered document could not be read');
    this.name = 'DocumentStorageError';
  }
}

/**
 * The attachment filename stem: `<sanitised resume name>-<templateId>`.
 *
 * `sanitizeDocumentName`'s allowlist pattern from `routes/export.ts:75-81` - every
 * character outside `[a-zA-Z0-9-_]` collapses to `-`, runs collapse, leading and trailing
 * dashes are stripped.
 *
 * BOTH halves are sanitised, deliberately against the intuition for the template id. The
 * obvious alternative - "it is not caller data, it is a registry id, so append it raw" - is
 * the weaker choice for a different reason than it looks: `templateId` is a DATABASE column,
 * so whatever wrote it is not this route, and a value that arrived having escaped the
 * registry's own gate (a hand-edited row, a future writer) would be pasted into a response
 * header verbatim. Sanitising is IDEMPOTENT on a legal id (`^[a-z0-9-]+$` maps to itself), so
 * it costs a correct case nothing and closes the case where the id is wrong. The reserved
 * literal `none` is passed through unchanged for the same reason: it is a constant, and
 * sanitising it would be indistinguishable from not knowing it.
 *
 * The result is bounded in length, which matters more than it looks: a `Content-Disposition`
 * header is one line, and an unbounded resume name would put a 4 KB header on a response.
 * The cap is applied to the STEM, before the extension, so a truncated name still carries a
 * valid extension.
 */
function attachmentFilename(resumeName: string, templateId: string, format: string): string {
  const stem = sanitizeDocumentName(resumeName);
  const template = templateId === 'none' ? 'none' : sanitizeDocumentName(templateId, 'template');
  const base = `${stem}-${template}`.slice(0, 96).replace(/-+$/, '');
  return `${base}.${requestExtension(format)}`;
}

/** The repo's existing filename allowlist, copied rather than reinvented. */
function sanitizeDocumentName(value: string, fallback = 'resume'): string {
  return (value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

router.get('/:id/documents/:docId', requireAuth, async (req, res) => {
  try {
    const resume = await requireOwnedResume(req, req.params.id);
    const doc = (await prisma.resumeDocument.findUnique({
      where: { id: req.params.docId },
      include: { revision: { select: { resumeId: true } } },
    })) as OwnedDocumentRow | null;
    // 1 + 2. Ownership, both halves, in one condition. A document with no reachable
    //        resume on EITHER side is refused rather than served: `resumeId ?? revision
    //        .resumeId` is null only for a row written by something that knew neither, and
    //        "I cannot prove this is yours" is the answer, not "assume it is".
    //        MUTATION M-d: replace the condition with `if (!doc)`, keeping the lookup. The
    //        foreign-`resumeId` and revision-fallback cases in `renderPort.test.ts` fail.
    const owner = doc?.resumeId ?? doc?.revision?.resumeId ?? null;
    if (!doc || owner !== resume.id) {
      documentNotFound(res, 'document_not_found', 'Rendered document not found');
      return;
    }
    // The open happens BEFORE any header is set, and that ordering is load-bearing rather
    // than cosmetic: once `Content-Length` is decided the response is otherwise ready to
    // stream, so a `StorageError` thrown after that point would be answered by the outer
    // handler with a JSON body on a response that already declared a byte count. A 503 whose
    // body is shorter than its own `Content-Length` is a truncated download, not an error the
    // client can read. Deciding the length first and only then opening is what keeps a host
    // fault answerable - and the filename above is computed on the same principle, so the
    // only throw between `open` and the first byte is a template rejection the route
    // classifies itself, with no storage fault in that window at all.
    //
    // `verify: true` (T1052) is what makes this the READ-side twin of the write path's
    // verification: the store hashes the blob and refuses it unless it hashes to the digest
    // its key names, and it does so BEFORE this route has committed a single header - so a
    // corrupted artifact is a 503 with a machine code and NOT a 200 whose body is not the
    // document. The cost is one bounded read of a file that is about to be read again. The
    // option is passed by NAME rather than being the store's default because `open` also
    // serves callers that only want the bytes (see `storage.ts`'s header).
    const opened = await documentStore().open(doc.storageKey, { verify: true });
    // 3. A MISSING BLOB IS A 404 WITH A CODE, NEVER A 500. The row exists and the bytes do
    //    not - a cleared volume, a partial restore - and that is a missing document, not a
    //    server fault. `open` returns `null` for absence and THROWS for a host fault, so
    //    the two are distinguishable here and only the host fault is a 503.
    if (opened === null) {
      documentNotFound(res, 'document_bytes_absent', 'Rendered document not found');
      return;
    }
    // 4. THE ROW AND THE BYTES MUST AGREE, and this is the half no amount of hashing in the
    //    store can do. The store proved "the bytes hash to the digest the KEY names"; the key
    //    is derived from the digest the render produced, and `cache.ts` writes the same value
    //    into `ResumeDocument.hash` - so for every row this API wrote they are equal by
    //    construction. Asserting it here makes the download's integrity claim rest on what
    //    THIS route compared rather than on a write-path invariant, and it catches the case
    //    that invariant cannot: a row whose key and hash disagree (a hand-edited row, a
    //    partially-applied restore, a future writer). It is two string/number comparisons
    //    and no I/O, and the answer is the same machine code the store would have produced -
    //    which is what stops a second vocabulary for one fault.
    if (opened.sha256 !== doc.hash || opened.byteSize !== doc.byteSize) {
      throw new DocumentStorageError('STORAGE_HASH_MISMATCH');
    }

    // The filename is computed BEFORE the first `setHeader`, which is what makes the ordering
    // rule above actually hold. `attachmentFilename` calls `requestExtension`, and that
    // THROWS `RenderPortError('render_format_unsupported')` for a `format` outside
    // `{pdf, tex, json, docx}`. `format` is a DATABASE column read by this route, so the
    // closed set is a property of the WRITER, not a guarantee about this row: with the call
    // inline in the `Content-Disposition` line it ran AFTER `Content-Type` and
    // `Content-Length` were committed, and the catch below would have answered 422 with a
    // JSON body on a response that already declared a byte count - a truncated download
    // rather than a readable error. Computing it into a `const` first makes every throw land
    // before any header exists, so the invariant is a property of the ORDER rather than of a
    // comment. Pinned by "refuses a row whose format has no artifact type, BEFORE any header
    // is committed" in `renderPort.test.ts`.
    const filename = attachmentFilename(resume.name, doc.templateId, doc.format);
    // The recorded values, not the sniffed ones: `doc.mimeType` is what the row was written
    // with, and the store's content-type sniff is diagnostics only (T1032's deviation D2).
    // A `Content-Type` that disagreed with the row would be a worse bug than an
    // unregistered one.
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Length', String(doc.byteSize));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // `nosniff` is not optional on a download of a user-influenced content type: without
    // it a browser may execute an artifact the renderer produced, and the whole point of
    // `attachment` is advisory.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A short-lived private cache: the bytes are a render of a revision, so they must not be
    // held by a shared cache after the revision moves on. `private` (not `no-store`) so a
    // client re-downloading the same document does not re-run a render.
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200);
    // The store's OWN stream, piped directly. Not wrapped in `Readable.from`: the store
    // already resolved the path and opened the descriptor, and re-wrapping would add a
    // transform hop for no gain. And a stream error AFTER the headers is a truncated body,
    // which is the honest outcome for a file that stopped being readable mid-download - so
    // the error is logged and the socket closed rather than answered, because there is no
    // longer a response to answer.
    opened.stream.on('error', (streamError: Error) => {
      console.error('[resumes] a document stream failed after the response started:', streamError.name);
      res.destroy();
    });
    opened.stream.pipe(res);
  } catch (error) {
    if (error instanceof DocumentStorageError) {
      // An unimplemented storage KIND. 503 rather than 404: the document exists, this build
      // cannot serve it, and calling that "not found" sends an operator looking for a row
      // that is right there.
      res.status(503).json({ error: 'The rendered document could not be read', code: error.reason });
      return;
    }
    if (error instanceof StorageError) {
      // A host fault. 503, with the CODE (never the message, never `describe().root`, never
      // a path) so an operator can tell a refused path from an unreadable file.
      res.status(503).json({ error: 'The rendered document could not be read', code: error.code });
      return;
    }
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// GET /resumes/:id/documents - metadata only, newest first
// ---------------------------------------------------------------------------
//
// "NEWEST FIRST" MEANS NEWEST FIRST-CREATION, and that is the only thing the row can support.
// The upsert's `update` branch does not touch `createdAt` (`cache.ts`), because a re-render
// replaces the METADATA of an existing document rather than creating a second one - which is
// what keeps the `documentId` stable across renders. The consequence is that a document
// re-rendered today keeps the timestamp of the day it was first produced, so the list is
// ordered by "newest document created", not "most recently rendered". The contract says only
// "newest first", so this is conformant; it is stated here because a client reading it as
// "most recent render" would be wrong, and adding `updatedAt` is a schema migration that
// belongs to a later task rather than to this one.

router.get('/:id/documents', requireAuth, async (req, res) => {
  try {
    const resume = await requireOwnedResume(req, req.params.id);
    // `revisionId` is NOT a filter a caller can supply here: the list is "this resume's
    // documents", and the route deliberately has no query parameters, so there is no way
    // to ask for a subset by hand. A revision filter belongs on the revision's own route.
    const rows = (await prisma.resumeDocument.findMany({
      where: {
        OR: [{ resumeId: resume.id }, { revision: { resumeId: resume.id } }],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        format: true,
        templateId: true,
        templateVersion: true,
        pageCount: true,
        hash: true,
        byteSize: true,
        mimeType: true,
        createdAt: true,
      },
    })) as Array<Omit<OwnedDocumentRow, 'resumeId' | 'storageKey' | 'revision'>>;

    // NO BYTES, AND NO `storageKey`. The key is a host-relative path - `artifacts/<aa>/<64
    // hex>` - and while it carries no user data it does disclose the storage layout, and a
    // list endpoint is the cheapest place to leak one. The client that wants a document
    // asks for it by id and streams it; that is the only place a key is ever used.
    res.json(
      rows.map((row) => ({
        id: row.id,
        format: row.format,
        templateId: row.templateId,
        templateVersion: row.templateVersion,
        pageCount: row.pageCount,
        hash: row.hash,
        byteSize: row.byteSize,
        mimeType: row.mimeType,
        createdAt: row.createdAt,
      })),
    );
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// POST /career/import/json - a plain JSON Resume lowers into profile/claims
// ---------------------------------------------------------------------------
//
// ADR-035 item 4: "Import accepts plain JSON Resume and lowers it into profile/claim
// rows (all claims `inferred`)." 05 sec.7.7: "Never auto-confirm imported content."
//
// The order of the four steps is the design:
//   1. VALIDATE the document against JSON Resume + x-clearance. A malformed import is
//      rejected BEFORE any row is written - a half-imported profile is worse than a
//      rejected one, because the user cannot tell which half landed.
//   2. REGISTER an `EvidenceSource` of kind `import_json`. The provenance anchor: a
//      claim with no source cannot be shown with its evidence, and re-importing the
//      same bytes is a no-op on `@@unique([profileId, contentHash])`.
//   3. LOWER into drafts. `lowerResumeJson` hard-codes `IMPORTED_CLAIM_STATUS` and
//      `IMPORTED_CLAIM_PROVENANCE`; it does not read a status out of the document, so
//      a hand-edited `x-clearance` block that claims the confirming status changes
//      nothing about what is written.
//   4. PERSIST through `createClaim`, the single dedupe point. Re-importing the same
//      document dedupes on `(profileId, fingerprint)` and never touches an existing
//      claim, so a re-run cannot upgrade one (ADR-036 item 4).

careerRouter.post('/import/json', requireAuth, async (req, res) => {
  try {
    const data = validateInput(importJsonResumeSchema, req.body);
    const store: CareerStore = prisma;

    const profile = await prisma.careerProfile.findUnique({
      where: { id: data.profileId },
      select: { id: true, userId: true },
    });
    if (!profile) throw new NotFoundError('Career profile');
    await ensureOwnership(req.user!.id, profile.userId, 'Career profile');

    // 1. Structural validation, first, before anything is written.
    const validation = validateResumeJson(data.document);
    if (!validation.valid) throw new ResumeJsonValidationError(validation.errors);

    // 2. The evidence anchor. The document's canonical bytes are the content, so the
    //    same document imported twice is the same source and the second import is a
    //    no-op on the source AND on every claim.
    const lowered = lowerResumeJson(data.document);
    const contentText = JSON.stringify(data.document);
    const source = await createEvidenceSource(
      {
        profileId: data.profileId,
        kind: EvidenceKind.import_json,
        title: data.title ?? 'Imported JSON Resume',
        text: contentText,
        mimeType: 'application/json',
      },
      store,
    );

    // 3 + 4. Lower, then persist. `status` and `provenance` are the import constants,
    //       and `createClaim`'s input type has no confirming member at all, so the
    //       status of every row this route writes is `inferred` BY CONSTRUCTION.
    let created = 0;
    let deduped = 0;
    for (const draft of lowered.claims) {
      const input: ClaimCreateInput = {
        profileId: data.profileId,
        kind: draft.kind,
        statement: draft.statement,
        status: IMPORTED_CLAIM_STATUS,
        provenance: IMPORTED_CLAIM_PROVENANCE,
        confidence: null,
        inferenceMethod: draft.inferenceMethod,
        evidenceSourceId: source.source.id,
        // Entity attachments are deliberately NOT derived from the document: attaching
        // a claim to an `Experience` row requires that row to exist, and creating
        // entities from an unverified import is exactly the "a model/derived process
        // may only ever write inferred claims" line 05 sec.2.2 draws. The claim exists
        // and is unconfirmed; the user attaches it.
        experienceId: null,
        educationId: null,
        projectId: null,
        skillId: null,
        certificationId: null,
      };
      const result = await createClaim(input, store);
      if (result.outcome === 'created') created += 1;
      else deduped += 1;
    }

    res.status(201).json({
      profileId: data.profileId,
      evidenceSourceId: source.source.id,
      evidenceSource: source.outcome,
      claims: { created, deduped, total: lowered.claims.length },
      // Echoed back so the caller can prove the block did NOT decide anything. Every
      // one of these is the imported status, whatever the document said.
      statusAssigned: IMPORTED_CLAIM_STATUS,
      provenanceAssigned: IMPORTED_CLAIM_PROVENANCE,
      basics: lowered.basics,
      work: lowered.work,
      education: lowered.education,
      projects: lowered.projects,
      skills: lowered.skills,
      certificates: lowered.certificates,
      unsupported: lowered.unsupported,
    });
  } catch (error) {
    sendServiceError(res, error);
  }
});

// ---------------------------------------------------------------------------
// Compile-time evidence that the real client satisfies every seam used here
// ---------------------------------------------------------------------------
// Nothing runs these lines; `npx tsc --noEmit` does. They exist because a route that
// needs a cast to hand `prisma` to a service means the service's seam and the schema
// have drifted, and the drift should be a build failure rather than an `as unknown as`.
type RealClientSatisfiesCareerStore = typeof prisma extends CareerStore ? true : false;
type RealClientSatisfiesUsageStore = typeof prisma extends import('../career/claimUsage.js').ResumeClaimUsageStore
  ? true
  : false;
type RealClientSatisfiesRevisionStore = typeof prisma extends import('../resume/revisions.js').ResumeRevisionStore
  ? true
  : false;
type RealClientSatisfiesProjectionStore = typeof prisma extends import('../resume/json/project.js').ResumeProjectionStore
  ? true
  : false;
const SEAM_TYPECHECKS: [
  RealClientSatisfiesCareerStore,
  RealClientSatisfiesUsageStore,
  RealClientSatisfiesRevisionStore,
  RealClientSatisfiesProjectionStore,
] = [true, true, true, true];
void SEAM_TYPECHECKS;

export default router;
export { careerRouter };
