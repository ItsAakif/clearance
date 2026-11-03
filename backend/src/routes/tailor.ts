// Tailor Routes - the LEGACY whole-document tailor is RETIRED; the V2 operation surface is not.
//
// T1110 (FREEZE A-39). This file used to hold two things: the V1 whole-document tailor on the
// `/tailor` prefix (`POST /pipeline`, `POST /`, `GET /:id/export`, `GET /`), which leased a key,
// rewrote the resume as prose and wrote a `TailoredResume` row, and the V2 operation surface
// mounted at `/resumes` (T1080), which proposes OPERATIONS and applies them through the one
// revision writer.
//
// The V1 half is GONE. Its four paths stay published and answer `410 Gone` with the V2 successor
// named in the body - see the deprecation table below for why 410 rather than 404. Deleting those
// four handlers is what made `backend/src/ats/improver.ts` and `backend/src/ats/refiner.ts`
// unreachable (FREEZE A-41) and therefore deletable, and it is also what removed this file's last
// import of Playwright and `html-to-docx`: the Letter export pipeline behind `GET /:id/export` left
// with it.
//
// THE V2 SURFACE BELOW IS UNTOUCHED by that retirement. Its three routes never read a flag, so
// "the tailoring engine still works" is a structural property rather than a conditional.

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput } from '../shared/validation.js';
import {
  leaseNextLlmKey, markKeySuccess, markKeyFailure,
} from '../ai/keyManager.js';
import { getProviderModel, runLlmCompletion, createLlmClient } from '../ai/providerModels.js';
import { z } from 'zod';
import { ResumeChangeSource, type CareerClaim } from '@prisma/client';

import {
  RENDER_DEFAULT_TEMPLATE_ID,
  loadTemplateRegistry,
  type TemplateRegistry,
} from '../render/templates.js';
import {
  createRevision,
  getCurrentRevision,
  listRevisionChanges,
  type CreateChangeInput,
} from '../resume/revisions.js';
import { readClearanceBlock, type ResumeJson } from '../resume/json/jsonresume.js';
import { evaluateRevisionPreRenderGate, isRenderableClaimStatus } from '../career/claimUsage.js';
import {
  TAILOR_OPS,
  parseOperation,
  renderTailorPrompt,
  type TailorOperation,
  type OpRejection,
} from '../tailor/ops.js';
import { validate, validateOperation, type ValidationContext } from '../tailor/validate.js';
import { applyOperations, applySummary, type ReviewedOperation } from '../tailor/apply.js';

const router = Router();

// =====================================================================================
// THE RETIRED V1 SURFACE (FREEZE A-39) - 410 Gone, four published paths
// =====================================================================================
//
// WHY THESE ANSWER 410 RATHER THAN 404. All four were published for the life of the V1 app and
// `src/services/api/jobs.ts` (`tailorApi.create` / `.list` / `.export`) called all three of the
// reachable ones from the Jobs detail panel. A caller holding that client must be told the truth:
// the path existed, it is deliberately gone, and here is the replacement. 404 would read as a
// typo and send an integrator looking for one.
//
// WHY 410 IS ALSO A SAFETY PROPERTY, not only a courtesy. The old handlers wrote a `TailoredResume`
// row from unvalidated model prose, and `GET /:id/export` rendered that row's HTML through
// Playwright. Retiring the handlers before the row format could be re-read means no caller can
// mint a new one; the rows already stored are untouched historical data and `GET /tailor` used to
// list them, so the list is kept as a deprecation too rather than being quietly dropped while the
// data survives.
//
// WHAT REPLACES EACH PATH. The V2 tailoring surface is three routes under `/resumes`:
//   POST /resumes/:id/tailor          propose OPERATIONS (never a document)
//   POST /resumes/:id/tailor/apply    apply accepted operations -> a NEW revision
//   GET  /resumes/:id/tailor/changes  the change log: before / after / reason / source claims
// They require a V2 resume (`modelVersion >= 2` AND a `profileId`); a legacy row is refused with
// 404 because there is nothing behind it to tailor from. Upgrade a legacy row by opening it in the
// Studio, which calls `POST /resumes/:id/upgrade`.
//
const LEGACY_TAILOR_DEPRECATION = {
  error:
    'The legacy tailor rewrote your whole document as prose and saved the result as a new resume, ' +
    'with nothing to review and nothing recorded about why. It is retired. Tailoring now proposes ' +
    'individual operations - each with its before text, its after text, the reason, and the confirmed ' +
    'statement that grounds it - and a claim you cannot evidence is refused rather than written.',
  code: 'legacy_whole_document_tailor_retired',
  retired: true,
  httpStatus: 410,
  reason: 'unguarded_whole_document_rewrite',
  successor: {
    propose: { method: 'POST', route: '/resumes/:id/tailor', surface: 'tailoring operations' },
    apply: { method: 'POST', route: '/resumes/:id/tailor/apply', surface: 'apply accepted operations' },
    changes: { method: 'GET', route: '/resumes/:id/tailor/changes', surface: 'the operation log' },
  },
  successorUi: '/app/tailor',
  operationsContainDocument: false,
} as const;

/**
 * Register ONE retired legacy tailor path. Auth runs first, for the same reason as in `ai.ts`:
 * the handler it replaces read and wrote the caller's own rows.
 */
function retiredLegacy(method: 'POST' | 'GET', route: string): void {
  const handler = (_req: Request, res: Response) => {
    res.status(410).json({ ...LEGACY_TAILOR_DEPRECATION, endpoint: `${method} /tailor${route}` });
  };
  if (method === 'POST') router.post(route, requireAuth, handler);
  else router.get(route, requireAuth, handler);
}

retiredLegacy('POST', '/pipeline');
retiredLegacy('POST', '/');
retiredLegacy('GET', '/:id/export');
retiredLegacy('GET', '/');

export default router;

// =====================================================================================
// THE V2 TAILORING SURFACE (T1080; 06-design sec.E.3, sec.E.10)
// =====================================================================================
//
// WHAT IS BELOW, AND WHY IT LIVES IN THE SAME FILE AS THE RETIRED SURFACE ABOVE. T1110 turned
// the whole legacy V1 half above into four `410` deprecation handlers, so the only code left in
// this file is the V2 tailoring surface. It is a SEPARATE router with its own paths, mounted at
// `/resumes`, and NEITHER router reads a flag - so "the tailoring engine is unaffected by the
// retirement" is a structural property (two routers, disjoint paths, no conditional) rather than
// a claim about a flag state. Nothing in the code below was edited to retire anything above.
//
// THREE ROUTES, AND WHAT EACH ONE IS FOR:
//   POST /resumes/:id/tailor          propose OPERATIONS (never a document)
//   POST /resumes/:id/tailor/apply    apply accepted operations -> a NEW revision
//   GET  /resumes/:id/tailor/changes  the change log: before / after / reason / source claims
//
// `GET /resumes/:id/diff` is T1030's STRUCTURAL diff and is untouched: it answers "what text
// moved between these two snapshots, and which claim changed status". The route below answers
// "what did the tailoring engine try to do, why, and which confirmed claim says it may".
//
// THE DESIGN RULES, restated from 06 sec.E.3:
//   1. `POST /tailor` NEVER RETURNS A DOCUMENT. It returns operations, and the response says
//      so explicitly (`operationsContainDocument: false`) so a client can assert it. A
//      proposal the user cannot review op by op is not a review step.
//   2. THE PROPOSAL STAGE IS AI-OPTIONAL (ADR-041 D5). With no provider configured the
//      response says `proposal.status = 'skipped'`, `reason = 'no_ai_provider_configured'`,
//      and carries an EMPTY operation list - and everything else still works, because
//      `POST /tailor/apply` takes operations straight from the request body. A deployment
//      with no key is not a deployment without tailoring; it is one whose proposals are the
//      user's own.
//   3. APPLYING GOES THROUGH `createRevision`. This file has no `resumeRevision.update`, no
//      second insert and no transaction of its own: it produces a document and a change log
//      and hands both to the one writer, which runs the same schema validation, the same
//      claim cross-check and the same pre-render belt as any other revision. A tailored
//      revision is not a privileged snapshot, and this route cannot become a side door around
//      the gate.
//   4. EVERYTHING IS SCOPED TO THE BLOCK'S OWN `profileId`, so an operation cannot be
//      grounded in another tenant's confirmed claim.
//   5. A REFUSED OPERATION IS RECORDED, NOT APPLIED, and stays visible (`accepted: false`).
//
// ERROR CLASSIFICATION: a refusal about the REQUEST is a 400 with a machine code; a stale
// base revision is a 409 (the request was valid, the resume moved); an unreadable template
// registry propagates as the render layer's own refusal (the operator's filesystem, not the
// caller). No operation can reach a 500 here.
// =====================================================================================

const tailorRouter = Router();

// ---------------------------------------------------------------------------
// Request envelopes
// ---------------------------------------------------------------------------

const proposeSchema = z
  .object({
    /** The `Job` whose requirements the operations answer. Optional: a pass may be structural. */
    jobId: z.string().min(1).max(100).optional(),
    /** The template whose `requiredDictKeys` rule 4 is checked against. Defaults to the default. */
    templateId: z.string().min(1).max(60).optional(),
  })
  .strict();

const applySchema = z
  .object({
    /**
     * The operations, in the shape the proposal stage returns. `z.array(z.unknown())` rather
     * than a strict object schema, ON PURPOSE: the refusal vocabulary belongs to
     * `tailor/validate.ts`, which is the one module that decides it, and a zod schema here
     * would be a SECOND place an operation shape is defined. An entry that does not parse
     * comes back as a refusal with a code, not as a 400 for the whole batch.
     */
    operations: z.array(z.unknown()).max(50),
    /** Which revision the caller believed it was tailoring. Refused if it is not the current one. */
    baseRevisionId: z.string().min(1).max(100).optional(),
    templateId: z.string().min(1).max(60).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();

const changesSchema = z
  .object({
    revision: z.coerce.number().int().min(1).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Ownership and the registry
// ---------------------------------------------------------------------------

/**
 * Load the resume and prove the caller owns it. 404/403, never `null`.
 *
 * The V2 shape is required (`modelVersion >= 2` AND a `profileId`): a `modelVersion = 1`
 * legacy row has no career profile behind it, so there is nothing to tailor from and the
 * legacy `TailoredResume` surface is the one that serves it.
 */
async function requireOwnedV2Resume(req: Request): Promise<{ id: string; modelVersion: number; profileId: string }> {
  const resume = await prisma.resume.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, modelVersion: true, profileId: true },
  });
  if (!resume) throw new NotFoundError('Resume');
  await ensureOwnership(req.user!.id, resume.userId, 'Resume');
  if (resume.modelVersion < 2 || !resume.profileId) {
    throw new NotFoundError('V2 resume');
  }
  return { id: resume.id, modelVersion: resume.modelVersion, profileId: resume.profileId };
}

/**
 * ONE registry load for the process, memoised on first use - the same discipline as
 * `render/renderPort.ts`, for the same reason: the registry is I/O-backed and every request
 * that needs `requiredDictKeys` would otherwise re-read and re-validate every template file.
 *
 * A LOAD FAILURE IS PROPAGATED, not swallowed. Rule 4 (`SECTION_REQUIRED_BY_TEMPLATE`) is a
 * control, and running the control with an empty `requiredDictKeys` because the templates
 * directory is missing would disable it silently - the tailoring pass would happily empty a
 * required section on a deployment whose registry an operator had broken.
 */
let registryPromise: Promise<TemplateRegistry> | null = null;
function registry(): Promise<TemplateRegistry> {
  if (registryPromise === null) registryPromise = loadTemplateRegistry();
  return registryPromise;
}

/** Reset the memoised registry. For a test that installs a different templates root. */
export function resetTailorTemplateRegistry(): void {
  registryPromise = null;
}

// ---------------------------------------------------------------------------
// The context every validation shares
// ---------------------------------------------------------------------------

/**
 * Assemble the `ValidationContext` for a document.
 *
 * The claims are read from the BLOCK'S `profileId`, not from the resume's, and that is the
 * whole of the tenant bound for the grounding rule: the document is what an operation claims
 * to be editing, so the document decides which profile's claims may ground it. A block with
 * no `profileId` - a hand-written document - resolves against the resume's own profile,
 * which is the more permissive of the two readings and is still a single tenant.
 */
async function contextFor(
  document: unknown,
  fallbackProfileId: string,
  templateId: string,
): Promise<ValidationContext> {
  const block = readClearanceBlock(document);
  const profileId = block?.profileId && block.profileId.length > 0 ? block.profileId : fallbackProfileId;
  const [claims, experiences, templates] = await Promise.all([
    prisma.careerClaim.findMany({ where: { profileId } }),
    prisma.experience.findMany({ where: { profileId }, select: { company: true } }),
    registry(),
  ]);
  const record = templates.get(templateId);
  return {
    document,
    profileId,
    claims: claims as CareerClaim[],
    // `requiredDictKeys` names SECTIONS (see `tailor/validate.ts#rule4`), so an entry the
    // resume does not have cannot be emptied - but the employer vocabulary is real data and
    // is read from the profile's own `Experience.company` rows.
    requiredDictKeys: record.metadata.requiredDictKeys,
    templateId,
    knownEmployers: experiences
      .map((row) => row.company)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
    knownTemplateIds: templates.templates.map((entry) => entry.id),
  };
}

/** The wire shape of one operation in a response. Never the document. */
function presentOperation(
  operation: TailorOperation,
  before: unknown,
  rejection: OpRejection | null,
  factDelta: boolean,
): Record<string, unknown> {
  return {
    op: operation.op,
    target: operation.target,
    before,
    after: rejection === null ? operation.after : null,
    reason: operation.reason,
    targetRequirementIds: [...operation.targetRequirementIds],
    sourceClaimIds: [...operation.sourceClaimIds],
    factDelta,
    accepted: rejection === null,
    rejection,
  };
}

// ---------------------------------------------------------------------------
// POST /resumes/:id/tailor - PROPOSE OPERATIONS
// ---------------------------------------------------------------------------

interface ProposalOutcome {
  status: 'ok' | 'skipped' | 'failed';
  reason: string;
  provider: string;
  /** The raw model text is NEVER echoed: it is untrusted and may contain the JD verbatim. */
  operations: unknown[];
}

/**
 * Ask the provider for operations.
 *
 * EVERY FAILURE DEGRADES TO `skipped` WITH A REASON, never to an exception (ADR-041 D5): the
 * deterministic half of tailoring is validation and apply, and a key quota must not take it
 * away. The reason carries an ERROR NAME and never a message, because a provider error's
 * message can contain key-adjacent text and this response goes to a browser.
 */
async function proposeOperations(
  document: unknown,
  job: { id: string; rawText: string } | null,
  confirmedClaims: readonly CareerClaim[],
  userId: string,
): Promise<ProposalOutcome> {
  let key;
  try {
    key = await leaseNextLlmKey(userId);
  } catch {
    return {
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      provider: 'none',
      operations: [],
    };
  }
  const prompt = renderTailorPrompt({
    job_description: job?.rawText?.slice(0, 20_000) ?? '(no job description supplied)',
    requirements: confirmedClaims.length === 0 ? '' : '',
    confirmed_claims: confirmedClaims
      .map((claim) => `- ${claim.id} [${claim.kind}] ${claim.statement}`)
      .join('\n')
      .slice(0, 20_000),
    current_resume: JSON.stringify(document).slice(0, 40_000),
  });
  try {
    const model = await getProviderModel(key.provider);
    const response = await runLlmCompletion(key.provider, model, () =>
      createLlmClient(key).chat.completions.create({
        model,
        max_tokens: 2000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          // The STATIC half: it is the rendered prompt minus any variable value, so a job
          // description can never be read as an instruction (06 sec.E.9.5 mitigation 1).
          { role: 'system', content: prompt },
        ],
      }),
    );
    await markKeySuccess(key);
    const content = response.choices[0]?.message?.content ?? '';
    const parsed = JSON.parse(content) as { operations?: unknown };
    if (!Array.isArray(parsed.operations)) {
      return { status: 'failed', reason: 'MODEL_DID_NOT_RETURN_OPERATIONS', provider: key.provider, operations: [] };
    }
    return { status: 'ok', reason: 'ok', provider: key.provider, operations: parsed.operations };
  } catch (error) {
    await markKeyFailure(key, false);
    return {
      status: 'failed',
      reason: `proposal_failed:${error instanceof Error ? error.name : 'unknown'}`,
      provider: key.provider,
      operations: [],
    };
  }
}

tailorRouter.post('/:id/tailor', requireAuth, async (req: Request, res: Response) => {
  try {
    const resume = await requireOwnedV2Resume(req);
    const data = validateInput(proposeSchema, req.body ?? {});
    const templateId = data.templateId ?? RENDER_DEFAULT_TEMPLATE_ID;

    const revision = await getCurrentRevision(resume.id, prisma);
    if (!revision) throw new NotFoundError('Resume revision');
    const document = revision.resumeJson as unknown as ResumeJson;

    const block = readClearanceBlock(document);
    const profileId = block?.profileId ?? resume.profileId;
    const confirmed = (await prisma.careerClaim.findMany({ where: { profileId } })).filter((claim) =>
      // The career layer owns the confirming-status vocabulary; a route that spelled the
      // status itself is exactly what `career/claimWriterAI.test.ts`'s source guard exists to
      // catch, so the PREDICATE is imported rather than written.
      isRenderableClaimStatus(claim.status),
    );
    const job = data.jobId
      ? await prisma.job.findFirst({ where: { id: data.jobId, userId: req.user!.id }, select: { id: true, rawText: true } })
      : null;

    const proposal = await proposeOperations(document, job, confirmed, req.user!.id);

    // THE PROPOSAL IS VALIDATED BEFORE IT IS RETURNED. Not because the model needed it, but
    // because a proposal the user cannot act on is a worse answer than no proposal: every
    // operation below carries its own verdict, so a caller sees which ops would be applied and
    // which would be refused, and with which code.
    const ctx = await contextFor(document, resume.profileId, templateId);
    const operations = proposal.operations.map((raw) => {
      const parsed = parseOperation(raw);
      if ('code' in parsed) {
        return { op: null, target: null, accepted: false, rejection: parsed, reason: null };
      }
      const verdict = validateOperation(parsed, ctx);
      return {
        ...presentOperation(parsed, parsed.before, verdict.ok ? null : verdict.rejection, false),
        // `presentOperation` is the response shape; this adds the validator's own grounding.
        ...(verdict.ok ? { groundingClaimIds: verdict.validated.groundingClaims.map((claim) => claim.id) } : {}),
      };
    });

    res.json({
      proposal: { status: proposal.status, reason: proposal.reason, provider: proposal.provider },
      baseRevision: { id: revision.id, revisionNumber: revision.revisionNumber, jsonHash: revision.jsonHash },
      templateId,
      // Named so a client can assert it: a proposal response contains no resume document.
      operationsContainDocument: false,
      operations,
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ---------------------------------------------------------------------------
// POST /resumes/:id/tailor/apply - ACCEPTED OPERATIONS -> A NEW REVISION
// ---------------------------------------------------------------------------

/**
 * The apply stage. The whole of E.3's "Derived-variant semantics": a new revision, one
 * `ResumeChange` per operation, the master untouched.
 *
 * ORDER, and it is load-bearing:
 *   1. resolve the current revision and read the BEFORE document;
 *   2. refuse a stale `baseRevisionId` (409) - two tailoring passes over one resume would
 *      otherwise silently overwrite each other, which is the same class of bug as mutating a
 *      revision and is prevented the same way;
 *   3. parse and validate EVERY operation against that document, once, in order;
 *   4. fold the accepted ones into a NEW document (pure, `apply.ts`);
 *   5. hand the document and the change log to `createRevision` - the only revision writer.
 *
 * Step 5 is where the belt runs, and a tailored revision is refused exactly as any other
 * would be. A tailored document that placed unconfirmed text cannot be written, so this route
 * cannot become a side door around the pre-render gate.
 */
tailorRouter.post('/:id/tailor/apply', requireAuth, async (req: Request, res: Response) => {
  try {
    const resume = await requireOwnedV2Resume(req);
    const data = validateInput(applySchema, req.body ?? {});
    const templateId = data.templateId ?? RENDER_DEFAULT_TEMPLATE_ID;

    const parent = await getCurrentRevision(resume.id, prisma);
    if (!parent) throw new NotFoundError('Resume revision');
    if (data.baseRevisionId !== undefined && data.baseRevisionId !== parent.id) {
      // 409, not 400: the request was well-formed and the user may do this; the resume just
      // moved on. Same reasoning as the gate's 409.
      res.status(409).json({
        error: 'the resume has a newer revision; reload it and tailor again',
        code: 'tailor_base_revision_stale',
        baseRevision: { id: parent.id, revisionNumber: parent.revisionNumber, jsonHash: parent.jsonHash },
      });
      return;
    }

    const document = parent.resumeJson as unknown as ResumeJson;
    const ctx = await contextFor(document, resume.profileId, templateId);

    // 3. Parse + validate. The parse failures and the refusals are BOTH reported, and a
    //    parse failure contributes no `ReviewedOperation` (see `apply.ts`), so it produces no
    //    change row - only the operations that parsed are recorded.
    const reviewed: ReviewedOperation[] = [];
    const unparsable: unknown[] = [];
    for (const raw of data.operations) {
      const parsed = parseOperation(raw);
      if ('code' in parsed) {
        unparsable.push({ rejection: parsed });
        continue;
      }
      const verdict = validate(parsed, ctx);
      if ('code' in verdict) reviewed.push({ accepted: false, rejection: verdict, operation: parsed });
      else reviewed.push({ accepted: true, validated: verdict });
    }

    // 4. The fold. Pure.
    const applied = applyOperations({ document, operations: reviewed });

    // 5. The ONE writer. `changes` carries one row per PARSED operation, accepted or not.
    const revision = await createRevision(
      {
        resumeId: resume.id,
        document: applied.document,
        createdBy: ResumeChangeSource.tailoring_engine,
        createdByUserId: req.user!.id,
        reason: data.reason ?? `tailored with ${applied.changes.length} operation(s)`,
        changes: applied.changes as readonly CreateChangeInput[],
      },
      prisma,
    );

    const gate = await evaluateRevisionPreRenderGate(revision.id, prisma);
    const rows = await listRevisionChanges({ revisionId: revision.id }, prisma);

    res.status(201).json({
      // The PARENT, so a client can prove the master is untouched: same id, same hash.
      parent: { id: parent.id, revisionNumber: parent.revisionNumber, jsonHash: parent.jsonHash },
      revision: {
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        jsonHash: revision.jsonHash,
        createdBy: revision.createdBy,
        reason: revision.reason,
      },
      summary: applySummary(applied, parent.jsonHash, revision.jsonHash),
      // The change rows as STORED, read back from the database rather than echoed from the
      // request: the audit trail a reviewer reads has to be the one that exists.
      changes: rows.map((row) => ({
        id: row.id,
        op: row.op,
        jsonPath: row.jsonPath,
        before: row.before,
        after: row.after,
        reason: row.reason,
        targetRequirementIds: row.targetRequirementIds,
        sourceClaimIds: row.sourceClaimIds,
        appliedBy: row.appliedBy,
        accepted: row.accepted,
      })),
      unparsable,
      gate,
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ---------------------------------------------------------------------------
// GET /resumes/:id/tailor/changes - THE DIFF VIEW'S DATA
// ---------------------------------------------------------------------------

/**
 * 06 sec.E.3's diff UX: "side-by-side `before`/`after` per op, with `reason` and
 * `sourceClaimIds` shown, and Accept/Reject per op".
 *
 * `sourceClaimIds` alone is not a review: an id is not a fact a person can check. So the
 * CLAIM STATEMENTS are resolved and returned beside them, scoped to the revision's own block
 * profile - the same scope the gate uses, and the same reason. The rejected rows come back
 * too, so a reviewer sees what the engine wanted and why it could not.
 *
 * `GET /resumes/:id/diff` (T1030) is the STRUCTURAL diff and is untouched by this task: it
 * reports the text changes and the claim-status movement between two snapshots. This route is
 * the OPERATION log, which is where the reason and the source claims live, and the two answer
 * different questions.
 */
tailorRouter.get('/:id/tailor/changes', requireAuth, async (req: Request, res: Response) => {
  try {
    const resume = await requireOwnedV2Resume(req);
    const query = validateInput(changesSchema, req.query);
    const revision = query.revision === undefined
      ? await getCurrentRevision(resume.id, prisma)
      : await prisma.resumeRevision.findFirst({
          where: { resumeId: resume.id, revisionNumber: query.revision },
        });
    if (!revision) throw new NotFoundError('Resume revision');

    const rows = await listRevisionChanges({ revisionId: revision.id }, prisma);
    const block = readClearanceBlock(revision.resumeJson);
    const claimIds = [
      ...new Set(
        rows.flatMap((row) =>
          Array.isArray(row.sourceClaimIds) ? row.sourceClaimIds.filter((id): id is string => typeof id === 'string') : [],
        ),
      ),
    ];
    const claims = claimIds.length === 0
      ? []
      : await prisma.careerClaim.findMany({
          where: block?.profileId ? { id: { in: claimIds }, profileId: block.profileId } : { id: { in: claimIds } },
          select: { id: true, kind: true, statement: true, status: true, provenance: true },
        });

    res.json({
      revision: { id: revision.id, revisionNumber: revision.revisionNumber, jsonHash: revision.jsonHash },
      changes: rows.map((row) => ({
        id: row.id,
        op: row.op,
        jsonPath: row.jsonPath,
        before: row.before,
        after: row.after,
        reason: row.reason,
        targetRequirementIds: row.targetRequirementIds,
        appliedBy: row.appliedBy,
        accepted: row.accepted,
        sourceClaimIds: Array.isArray(row.sourceClaimIds) ? row.sourceClaimIds : [],
        // The claims THEMSELVES, so the diff view can show why a wording is allowed.
        sourceClaims: claims
          .filter((claim) =>
            Array.isArray(row.sourceClaimIds) && (row.sourceClaimIds as string[]).includes(claim.id),
          )
          .map((claim) => ({
            id: claim.id,
            kind: claim.kind,
            statement: claim.statement,
            status: claim.status,
            provenance: claim.provenance,
          })),
      })),
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

/** The vocabulary, re-exported so a caller can build a request without a second import. */
export { TAILOR_OPS };

export const resumeTailorRouter = tailorRouter;
export { resumeTailorRouter as tailorV2Router };
