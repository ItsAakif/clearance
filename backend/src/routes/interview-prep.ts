// =====================================================================================
// routes/interview-prep.ts - THE HTTP SURFACE OF INTERVIEW PREP (T1090; 06 sec. E.4,
// E.10, E.11 flow 8).
//
// TWO ROUTES, AND WHAT EACH ONE IS FOR:
//   POST  /interview-prep           derive the risks for a resume, answer them, persist both
//   GET   /interview-prep/:resumeId  read back the last run's risks and questions
//
// THE DERIVATION IS NOT HERE. `interview/risks.ts` derives the risks from rows and
// `interview/questions.ts` builds and grounds the questions; this file LOADS the rows, calls
// those two modules, PERSISTS the result and builds the wire shape. That split is why the
// risk stage needs no provider and can be unit-tested with three literals: none of the logic
// is trapped behind an HTTP handler.
//
// WHY A FOREIGN RESUME IS A 404 AND NOT `ensureOwnership`'s 403. `shared/auth.ts` raises 403
// for a resource that belongs to somebody else, which confirms the row exists. The V2
// reading surface does not: `match/report.ts` and `routes/tailor.ts` both 404 a foreign id
// for the same reason, and a prep view is the most revealing read in the system - it quotes a
// person's career statements - so a probe must not be able to learn that one exists. The
// comparison is therefore inline, with the reason stated, rather than delegated.
//
// WHY POST REPLACES RATHER THAN APPENDS. `InterviewRisk` has no natural key of its own - a
// risk's identity is its derived ANCHOR, not a row id - so a second POST over the same
// revision would stack a duplicate list under the same resume and the user would see every
// risk twice under two different ids. The route therefore clears the resume's own risks (their
// questions go with them: `InterviewQuestion.riskId` cascades) and writes a fresh, internally
// consistent set. That is a REPLACEMENT OF A DERIVED VIEW, not a history - and the revision's
// own change log and claim usages remain the history, untouched.
//
// WHY GET READS THE STORED ROWS RATHER THAN RE-DERIVING, WHICH IS A DELIBERATE DIFFERENCE FROM
// `match/report.ts`. A match report is a pure function of the claims and the proposals, so
// re-deriving it on a read is free and always fresher. An interview run is NOT only that: it
// also records what the ANSWER STAGE did - that an answer named an ungrounded employer twice
// and was therefore refused, that no key was configured, which risk ids exist. Re-deriving on
// the read would erase exactly the evidence the feature exists to produce. So the risks are
// re-checked for anchoring on the way out (`assertRisksAreAnchored` is not an internal-only
// assertion) and the answer stage is reported as `not_evaluated` on a read, which is what
// `match/report.ts` does for its proposal stage: a read asked no provider anything, so it must
// not imply that it did.
//
// WHY `revision` AND THE MATCH COUNTS ARE NULL ON A READ. They are facts about the derivation
// this request did not run. Reporting zeros would be a claim ("this resume uses no claims")
// and reporting the previous run's numbers would be a claim about a derivation whose inputs
// may have changed. `null` means "not derived by this request", which is the only true thing
// to say.
//
// NO SCORE ANYWHERE. E.6 forbids a single derived number, and this response has no member that
// could become one: `riskCounts` is seven integers keyed by the seven kinds, `questionCounts` is
// four integers keyed by the four categories, and there is no `score`, `percentage` or
// `totalRisk` anywhere in the file. `interview-prep.test.ts` greps for those names.
//
// THE MANUAL `QuestionAnswer` BANK IS NOT INVOLVED. `routes/question-answers.ts` serves the
// hand-written bank at `/question-answers` and is not imported, mounted or shadowed here. The
// two models are unrelated - `QuestionAnswer` is user-authored, `InterviewQuestion` is derived
// and carries a risk anchor - and nothing in this file reads or writes the manual one.
// =====================================================================================

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { InterviewRiskKind, Prisma, PrismaClient, Severity } from '@prisma/client';

import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { BadRequestError, NotFoundError, handleApiError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import { deriveEvidenceLevels } from '../match/levels.js';
import {
  INTERVIEW_RISK_KINDS,
  InterviewRiskError,
  RISK_ANCHOR_SOURCES,
  RISK_KIND_FOCUS,
  assertRisksAreAnchored,
  deriveInterviewRisks,
  type DerivedRisk,
  type RiskAnchor,
  type RiskAnchorDetail,
  type RiskAnchorSource,
  type RiskChangeRow,
  type RiskClaimRow,
  type RiskRequirementRow,
} from '../interview/risks.js';
import {
  MAX_GROUNDING_EVIDENCE_CHARS,
  QUESTION_CATEGORIES,
  prepareInterview,
  type GroundedClaimText,
  type GroundedRequirementText,
  type PreparedQuestion,
  type QuestionCategory,
} from '../interview/questions.js';

const router = Router();

// ---------------------------------------------------------------------------
// The store seam
// ---------------------------------------------------------------------------

/**
 * The narrowest set of delegates this route touches, `Pick`ed from the generated client so a
 * column name cannot drift while the whole thing stays trivially fakeable in the test.
 *
 * IT IS NOT `PrismaClient`: the route reads ten models and writes two, and a wider seam would
 * be a wider promise than the code keeps.
 */
export type InterviewPrepStore = Pick<
  PrismaClient,
  | 'resume'
  | 'resumeRevision'
  | 'resumeClaimUsage'
  | 'resumeChange'
  | 'careerClaim'
  | 'evidenceSource'
  | 'matchReport'
  | 'job'
  | 'jobRequirement'
  | 'potentialMatch'
  | 'interviewRisk'
  | 'interviewQuestion'
>;

/** Compile-time proof the real client still satisfies the seam (nothing calls this). */
type RealClientSatisfiesInterviewPrepStore = PrismaClient extends InterviewPrepStore ? true : false;
const INTERVIEW_PREP_STORE_TYPECHECK: [RealClientSatisfiesInterviewPrepStore] = [true];
void INTERVIEW_PREP_STORE_TYPECHECK;

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/** One derived risk, as the client sees it. */
export interface InterviewRiskView {
  id: string | null;
  /** The deterministic anchor key, e.g. `resume_claim_usage:clm-ecs`. */
  key: string;
  kind: InterviewRiskKind;
  severity: Severity;
  statement: string;
  /** The rows this risk was read from. NEVER empty. */
  anchors: readonly RiskAnchor[];
  requirementId: string | null;
  claimId: string | null;
  /** The interviewer's angle: the derived probe, or the provider's grounded sharpening. */
  focus: string;
}

export interface InterviewQuestionView {
  id: string | null;
  /** Deterministic `<riskKey>#<category>`; stable across runs for the same derivation. */
  questionId: string;
  /** The `InterviewRisk.id` this question is anchored to. */
  riskId: string | null;
  requirementId: string | null;
  category: QuestionCategory;
  question: string;
  /** `null` when no answer was stored. NEVER an invented one. */
  modelAnswer: string | null;
  groundedClaimIds: readonly string[];
  focus: string;
  answerStage: PreparedQuestion['answerStage'];
}

export interface InterviewPrepView {
  resumeId: string;
  /** `null` on a READ: this request did not derive, so it has no revision to report. */
  revision: {
    id: string;
    revisionNumber: number;
    jsonHash: string;
    usageCount: number;
    changeCount: number;
  } | null;
  match: {
    matchReportId: string | null;
    jobId: string | null;
    /** `null` on a READ. See the header. */
    requirementCount: number | null;
    /** `null` on a READ. See the header. */
    gapCount: number | null;
  };
  /** Seven integers, one per risk kind. A count per kind, never a verdict. */
  riskCounts: Record<InterviewRiskKind, number>;
  /** Four integers, one per question category. */
  questionCounts: Record<QuestionCategory, number>;
  risks: InterviewRiskView[];
  questions: InterviewQuestionView[];
  /** What the optional risk-brief stage did, reported either way. */
  briefStage: {
    status: 'applied' | 'skipped';
    reason: string;
    provider: string | null;
    model: string | null;
    appliedCount: number;
    dropped: ReadonlyArray<{ reason: string; detail: string }>;
  };
  /**
   * Why the model answers are the way they are. `no_ai_provider_configured` is the case this
   * feature is designed around: the risks and the anchored questions are all still there.
   */
  answerStageSummary: {
    answered: number;
    skipped: number;
    rejected: number;
    /** The machine-readable reason per question, keyed by the deterministic question id. */
    reasons: Readonly<Record<string, string>>;
  };
  /** The two rules the UI states. CONSTANTS, so no body can be produced without them. */
  notes: typeof INTERVIEW_PREP_NOTES;
  rule: typeof INTERVIEW_PREP_RULE;
}

/** E.6's footer, restated for this surface. Constant, never a template. */
export const INTERVIEW_PREP_NOTES =
  'Risks are derived from your resume and your confirmed evidence. Every question names the risk or the requirement it came from.';

/** E.4's grounding rule, in the words the UI states it under the answers. */
export const INTERVIEW_PREP_RULE =
  'A model answer is stored only when every employer, technology, year and number in it appears in the evidence the question is grounded in.';

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * `POST /interview-prep`. `.strict()`, so an unknown member is a 400 rather than a silently
 * ignored field - the same reason `matches.ts` refuses `score: true`.
 */
const prepareSchema = z
  .object({
    resumeId: z.string().trim().min(1).max(100),
    /** The match report whose named gaps and levels become `gap` / `emphasized_tech` risks. */
    matchReportId: z.string().trim().min(1).max(100).optional(),
    /** A `Job` to derive the levels against when no report is named. */
    jobId: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const CLAIM_SELECT = {
  id: true,
  statement: true,
  kind: true,
  status: true,
  provenance: true,
  evidenceSourceId: true,
  confirmedAt: true,
} as const;

const CHANGE_SELECT = {
  id: true,
  revisionId: true,
  op: true,
  jsonPath: true,
  before: true,
  after: true,
  accepted: true,
  sourceClaimIds: true,
  targetRequirementIds: true,
} as const;

const REQUIREMENT_SELECT = {
  id: true,
  kind: true,
  importance: true,
  text: true,
  normalizedKey: true,
} as const;

/** A V2 resume the caller owns, plus its current revision. */
async function requireOwnedResume(
  userId: string,
  resumeId: string,
  store: Pick<InterviewPrepStore, 'resume'>,
): Promise<{ id: string; profileId: string }> {
  if (typeof resumeId !== 'string' || resumeId.length === 0) {
    throw new BadRequestError('a resumeId is required');
  }
  const resume = await store.resume.findUnique({
    where: { id: resumeId },
    select: { id: true, userId: true, modelVersion: true, profileId: true },
  });
  if (!resume || resume.userId !== userId) throw new NotFoundError('Resume');
  // The V2 shape is required: a `modelVersion = 1` row has no career profile and no revision
  // ledger, so there is no claim usage to derive a risk from - and answering questions about a
  // resume the evidence layer knows nothing about would be exactly the generic preparation
  // E.4 forbids.
  if (resume.modelVersion < 2 || !resume.profileId) throw new NotFoundError('V2 resume');
  return { id: resume.id, profileId: resume.profileId };
}

/** The current revision (`max(revisionNumber)`) of a resume. `null` when there is none. */
async function currentRevision(
  resumeId: string,
  store: Pick<InterviewPrepStore, 'resumeRevision'>,
): Promise<{ id: string; revisionNumber: number; jsonHash: string; resumeJson: unknown }> {
  const revision = await store.resumeRevision.findFirst({
    where: { resumeId },
    orderBy: { revisionNumber: 'desc' },
    select: { id: true, revisionNumber: true, jsonHash: true, resumeJson: true },
  });
  if (!revision) throw new NotFoundError('Resume revision');
  return revision;
}

interface LoadedRows {
  usages: Array<{ claimId: string; usage: string; renderedText: string | null }>;
  claims: RiskClaimRow[];
  changes: LoadedChange[];
  /** Every claim's text: the grounding an answer may draw from. */
  groundedClaims: Map<string, GroundedClaimText>;
  requirements: RiskRequirementRow[];
  groundedRequirements: Map<string, GroundedRequirementText>;
  match: { matchReportId: string | null; jobId: string | null };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/** A `ResumeChange`, as the derivation reads it. */
type LoadedChange = {
  id: string;
  op: string;
  jsonPath: string;
  before: unknown;
  after: unknown;
  accepted: boolean;
  sourceClaimIds: string[];
  revisionNumber: number;
};

/**
 * The cap on how far back the change-ledger walk goes. A bound rather than a full walk because
 * the walk is proportional to how many times a resume has been tailored, and a risk list has no
 * use for the wording of a bullet that was replaced a hundred edits ago.
 */
export const MAX_CHANGE_LEDGER_DEPTH = 50;

/**
 * THE WHOLE CHANGE LEDGER THAT EXPLAINS THE PAGE: every revision in the ancestry whose document
 * actually MOVED, plus nothing else. The ancestry walk is load-bearing, not tidiness.
 *
 * A `ResumeChange` describes how ONE revision differs from its parent. `apply.ts` writes a row
 * per PARSED operation, ACCEPTED OR NOT, so a pass whose only operations were declined - or a
 * `customize_style` pass - produces a revision whose `jsonHash` equals its parent's while its
 * change log holds only `accepted: false` rows. Reading the current revision's log alone would
 * therefore report NOTHING about the rewordings still on the page: every one of them belongs to
 * an ancestor. That was observed live - an accepted `rewrite_bullet` produced its risk, and then
 * the very next (declined) revision made the risk disappear while the reworded bullet stayed on
 * the page - so the walk now SKIPS the revisions that did not move the document and keeps going
 * down, rather than stopping at the first of them.
 */
async function loadChangeLedger(
  resumeId: string,
  store: Pick<InterviewPrepStore, 'resumeRevision' | 'resumeChange'>,
): Promise<LoadedChange[]> {
  const revisions = await store.resumeRevision.findMany({
    where: { resumeId },
    orderBy: { revisionNumber: 'desc' },
    take: MAX_CHANGE_LEDGER_DEPTH,
    select: { id: true, revisionNumber: true, jsonHash: true },
  });
  if (revisions.length === 0) return [];

  // KEEP a revision whose document differs from its PARENT'S, because then its own change rows
  // are what moved it. The rows arrive DESCENDING, so the parent of row `i` is row `i + 1` -
  // which is why the comparison runs from the OLDEST row upwards.
  //
  // A repeat hash is a no-op revision (every operation declined, or `customize_style` only):
  // its rows describe edits that are not on the page, so it is SKIPPED rather than treated as
  // the end of the history - the revisions below it may well have moved. The oldest row in the
  // window has no parent to compare against and is kept, which is the fail-OPEN end of the
  // `MAX_CHANGE_LEDGER_DEPTH` boundary: one extra revision's worth of rows at the oldest end,
  // never a missing one.
  const moved: typeof revisions = [];
  let parentHash: string | null = null;
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index] as (typeof revisions)[number];
    if (parentHash === null || revision.jsonHash !== parentHash) moved.push(revision);
    parentHash = revision.jsonHash;
  }
  moved.reverse();

  const rows = await store.resumeChange.findMany({
    where: { revisionId: { in: moved.map((entry) => entry.id) } },
    orderBy: { createdAt: 'asc' },
    select: CHANGE_SELECT,
  });
  const numberById = new Map(moved.map((entry) => [entry.id, entry.revisionNumber] as const));
  return rows.map((row) => ({
    id: row.id,
    op: row.op,
    jsonPath: row.jsonPath,
    before: row.before,
    after: row.after,
    accepted: row.accepted,
    sourceClaimIds: stringList(row.sourceClaimIds),
    revisionNumber: numberById.get(row.revisionId) ?? 0,
  }));
}

/**
 * Load everything the derivation reads, from the OWNER'S profile.
 *
 * THE PROFILE SCOPE IS NOT OPTIONAL. `usages` name claims, and a usage naming a claim from
 * another profile would produce a risk whose statement quotes somebody else's career. The
 * scope is the resume's own `profileId`, read here rather than inferred from a claim id.
 */
async function loadRows(
  userId: string,
  profileId: string,
  resumeId: string,
  revisionId: string,
  matchReportId: string | null,
  jobId: string | null,
  store: InterviewPrepStore,
): Promise<LoadedRows> {
  const [usageRows, claimRows, changeRows] = await Promise.all([
    store.resumeClaimUsage.findMany({
      where: { revisionId },
      select: { claimId: true, usage: true, renderedText: true },
    }),
    store.careerClaim.findMany({
      where: { profileId },
      orderBy: { createdAt: 'asc' },
      select: CLAIM_SELECT,
    }),
    loadChangeLedger(resumeId, store),
  ]);

  const evidenceSourceIds = [
    ...new Set(
      claimRows
        .map((claim) => claim.evidenceSourceId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const evidenceRows = evidenceSourceIds.length
    ? await store.evidenceSource.findMany({
        where: { id: { in: evidenceSourceIds }, profileId },
        select: { id: true, extractedText: true },
      })
    : [];
  const evidenceById = new Map(
    evidenceRows.map((row) => [row.id, (row.extractedText ?? '').slice(0, MAX_GROUNDING_EVIDENCE_CHARS)] as const),
  );

  const groundedClaims = new Map<string, GroundedClaimText>(
    claimRows.map((claim) => {
      const evidenceText =
        claim.evidenceSourceId === null ? [] : [evidenceById.get(claim.evidenceSourceId) ?? ''];
      return [
        claim.id,
        {
          id: claim.id,
          statement: claim.statement,
          evidenceText: evidenceText.filter((text) => text.trim().length > 0),
        },
      ] as const;
    }),
  );

  // THE MATCH SIDE. A report is preferred (it owns the levels); a bare `jobId` is accepted so
  // a caller who analysed a job but has not matched it still gets the requirement risks, with
  // every requirement treated as unsupported because nothing was matched yet. That is the
  // honest reading of "no report".
  const resolvedMatchReportId = matchReportId;
  let resolvedJobId = jobId;
  let requirements: RiskRequirementRow[] = [];
  const groundedRequirements = new Map<string, GroundedRequirementText>();

  if (matchReportId !== null) {
    const report = await store.matchReport.findUnique({
      where: { id: matchReportId },
      select: { id: true, userId: true, jobId: true, profileId: true },
    });
    // Same 404 rule as the resume, for the same reason: the report names a person's claims.
    if (!report || report.userId !== userId || report.profileId !== profileId) {
      throw new NotFoundError('Match report');
    }
    resolvedJobId = report.jobId;
  }

  if (resolvedJobId !== null) {
    const [requirementRows, potentialRows] = await Promise.all([
      store.jobRequirement.findMany({
        where: { jobId: resolvedJobId },
        orderBy: [{ importance: 'asc' }, { normalizedKey: 'asc' }],
        select: REQUIREMENT_SELECT,
      }),
      resolvedMatchReportId === null
        ? Promise.resolve([])
        : store.potentialMatch.findMany({
            where: { matchReportId: resolvedMatchReportId },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              requirementId: true,
              claimId: true,
              level: true,
              status: true,
              proposedEvidence: true,
              rationale: true,
            },
          }),
    ]);

    // The levels come from `match/levels.ts` - THE SAME derivation the match report shows, so
    // `direct` means here exactly what it means there. Not a re-join here: a second opinion
    // about what is `direct` is how two surfaces would start disagreeing about the user's own
    // evidence.
    const derived = deriveEvidenceLevels({
      requirements: requirementRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        importance: row.importance,
        text: row.text,
        normalizedKey: row.normalizedKey,
      })),
      claims: claimRows.map((row) => ({
        id: row.id,
        statement: row.statement,
        kind: row.kind,
        status: row.status,
      })),
      potentialMatches: potentialRows.map((row) => ({
        id: row.id,
        requirementId: row.requirementId,
        claimId: row.claimId ?? null,
        level: row.level,
        status: row.status,
        proposedEvidence: row.proposedEvidence,
        rationale: row.rationale,
      })),
    });

    requirements = derived.requirements.map((row) => ({
      requirementId: row.requirementId,
      kind: row.kind,
      importance: row.importance,
      text: row.text,
      level: row.level,
      evidence: row.evidence.map((entry) => ({ claimId: entry.claimId })),
    }));
    for (const row of requirementRows) {
      groundedRequirements.set(row.id, { requirementId: row.id, text: row.text });
    }
  }

  return {
    usages: usageRows.map((row) => ({
      claimId: row.claimId,
      usage: String(row.usage),
      renderedText: row.renderedText ?? null,
    })),
    claims: claimRows,
    changes: changeRows,
    groundedClaims,
    requirements,
    groundedRequirements,
    match: { matchReportId: resolvedMatchReportId, jobId: resolvedJobId },
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function emptyRiskCounts(): Record<InterviewRiskKind, number> {
  return {
    new_claim: 0,
    emphasized_tech: 0,
    inferred_claim: 0,
    rewritten_bullet: 0,
    gap: 0,
    overclaim: 0,
    thin_evidence: 0,
  };
}

function emptyQuestionCounts(): Record<QuestionCategory, number> {
  return {
    behavioral: 0,
    technical: 0,
    situational: 0,
    general: 0,
  };
}

/**
 * `evidenceRefs` -> anchors.
 *
 * The column stores the anchor OBJECTS (`{source, id, detail}`) rather than a packed string,
 * so a reader gets the machine-readable `detail` back and not just "something was here". An
 * entry this route did not write - a legacy row, a hand edit, a truncated write - is DROPPED,
 * and if that leaves nothing then the risk is refused by `assertRisksAreAnchored` below rather
 * than rendered as a risk that appears to be derived.
 */
function anchorsOf(value: unknown): RiskAnchor[] {
  if (!Array.isArray(value)) return [];
  const out: RiskAnchor[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const source = entry.source;
    const id = entry.id;
    const detail = entry.detail;
    if (
      typeof source !== 'string' ||
      !(RISK_ANCHOR_SOURCES as readonly string[]).includes(source) ||
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof detail !== 'string' ||
      detail.length === 0
    ) {
      continue;
    }
    out.push({
      source: source as RiskAnchorSource,
      id,
      detail: detail as RiskAnchorDetail,
    });
  }
  return out;
}

/** The anchor key of a stored risk: `<source>:<id>` of its first anchor. */
function anchorKeyOf(anchors: readonly RiskAnchor[], riskId: string): string {
  const first = anchors[0];
  return first ? `${first.source}:${first.id}` : `stored:${riskId}`;
}

function summarizeAnswerStage(
  questions: readonly InterviewQuestionView[],
): InterviewPrepView['answerStageSummary'] {
  const reasons: Record<string, string> = {};
  let answered = 0;
  let skipped = 0;
  let rejected = 0;
  for (const question of questions) {
    reasons[question.questionId] = question.answerStage.reason;
    if (question.answerStage.status === 'answered') answered += 1;
    else if (question.answerStage.status === 'rejected') rejected += 1;
    else skipped += 1;
  }
  return { answered, skipped, rejected, reasons: Object.freeze(reasons) };
}

// ---------------------------------------------------------------------------
// POST /interview-prep
// ---------------------------------------------------------------------------

/**
 * Derive the risks for a resume, answer them, and persist both.
 *
 * ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER:
 *   1. LOAD + OWNERSHIP. A foreign resume is a 404, and the V2 shape is required.
 *   2. READ THE ROWS: the revision's usages and changes, the profile's claims and evidence,
 *      and (when a job is named) the matcher's own derived levels.
 *   3. DERIVE, WITH NO PROVIDER IN SIGHT. `deriveInterviewRisks` cannot call one, so this is
 *      the step that cannot be skipped, degraded or invented.
 *   4. PREPARE the questions: the brief stage, then the answer stage with its post-check.
 *   5. REPLACE the resume's own risks, then write the questions. The write happens AFTER the
 *      derivation and the grounding, so a refused answer can never become a row carrying it,
 *      and a derivation that throws leaves the previous run intact.
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(prepareSchema, req.body ?? {});
    const userId = req.user!.id;
    const store = prisma as unknown as InterviewPrepStore;

    const resume = await requireOwnedResume(userId, body.resumeId, store);
    const revision = await currentRevision(resume.id, store);
    const rows = await loadRows(
      userId,
      resume.profileId,
      resume.id,
      revision.id,
      body.matchReportId ?? null,
      body.jobId ?? null,
      store,
    );

    const derived = deriveInterviewRisks({
      document: revision.resumeJson,
      usages: rows.usages,
      claims: rows.claims,
      changes: rows.changes,
      requirements: rows.requirements,
      now: new Date(),
    });

    const prepared = await prepareInterview({
      userId,
      risks: derived.risks,
      claims: rows.groundedClaims,
      requirements: rows.groundedRequirements,
    });

    // REPLACE, not append: a risk's identity is its anchor, so a second run over the same
    // revision would otherwise stack a duplicate list under the same resume.
    await store.interviewRisk.deleteMany({ where: { resumeId: resume.id, userId } });

    const focusByKey = new Map(
      prepared.questions.map((row) => [row.riskKey ?? '', row.focus] as const),
    );
    const riskIds = new Map<string, string>();
    const riskCounts = emptyRiskCounts();

    for (const risk of derived.risks) {
      const row = await store.interviewRisk.create({
        data: {
          userId,
          resumeId: resume.id,
          matchReportId: rows.match.matchReportId,
          jobId: rows.match.jobId,
          requirementId: risk.requirementId,
          claimId: risk.claimId,
          kind: risk.kind,
          severity: risk.severity,
          statement: risk.statement,
          evidenceRefs: risk.anchors as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      riskIds.set(risk.key, row.id);
      riskCounts[risk.kind] += 1;
    }

    const questionCounts = emptyQuestionCounts();
    const questions: InterviewQuestionView[] = [];
    for (const question of prepared.questions) {
      questionCounts[question.category] += 1;
      const riskId = question.riskKey === null ? null : (riskIds.get(question.riskKey) ?? null);
      // A question with no answer stores an EMPTY string, because the column is `NOT NULL`; the
      // VIEW reports `null`. The distinction matters: "no answer was stored" and "an empty
      // answer was stored" are different states, and the client must not infer one from the
      // other.
      const row = await store.interviewQuestion.create({
        data: {
          userId,
          riskId,
          jobId: rows.match.jobId,
          category: question.category,
          question: question.question,
          modelAnswer: question.modelAnswer ?? '',
          groundedClaimIds: [...question.groundedClaimIds] as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      questions.push({
        id: row.id,
        questionId: question.questionId,
        riskId,
        requirementId: question.requirementId,
        category: question.category,
        question: question.question,
        modelAnswer: question.modelAnswer,
        groundedClaimIds: question.groundedClaimIds,
        focus: focusByKey.get(question.riskKey ?? '') ?? question.focus,
        answerStage: question.answerStage,
      });
    }

    const risks: InterviewRiskView[] = derived.risks.map((risk) => ({
      id: riskIds.get(risk.key) ?? null,
      key: risk.key,
      kind: risk.kind,
      severity: risk.severity,
      statement: risk.statement,
      anchors: risk.anchors,
      requirementId: risk.requirementId,
      claimId: risk.claimId,
      focus: focusByKey.get(risk.key) ?? risk.focus,
    }));

    const view: InterviewPrepView = {
      resumeId: resume.id,
      revision: {
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        jsonHash: revision.jsonHash,
        usageCount: rows.usages.length,
        changeCount: rows.changes.length,
      },
      match: {
        matchReportId: rows.match.matchReportId,
        jobId: rows.match.jobId,
        requirementCount: rows.requirements.length,
        gapCount: rows.requirements.filter((row) => row.level === 'unsupported').length,
      },
      riskCounts,
      questionCounts,
      risks,
      questions,
      briefStage: prepared.briefStage,
      answerStageSummary: summarizeAnswerStage(questions),
      notes: INTERVIEW_PREP_NOTES,
      rule: INTERVIEW_PREP_RULE,
    };

    // 201: the run created rows. A repeat POST also creates them - it replaces the previous
    // set - so 201 is honest in both cases. Unlike the match report there is no natural key a
    // second POST could be idempotent against.
    res.status(201).json(view);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ---------------------------------------------------------------------------
// GET /interview-prep/:resumeId
// ---------------------------------------------------------------------------

/**
 * Read back the last run's risks and questions.
 *
 * THE ANCHOR IS RE-CHECKED ON THE WAY OUT. `assertRisksAreAnchored` is not internal-only: a
 * row whose `evidenceRefs` is empty, or whose kind or severity is outside the enums, is a risk
 * a client would render as if it were derived - so it is refused with the same machine-
 * readable code the derivation would have raised, rather than passed on as if it were fine.
 *
 * THE FOCUS IS RE-DERIVED, NOT STORED. It is prose about the risk, and an answer stage does not
 * carry it. Rebuilding it from the kind is the honest read; the alternative would be to keep
 * the model's wording in the audit trail, which is one more place a fabrication could hide.
 *
 * THE ANSWER STAGE IS REPORTED AS `not_evaluated`, because this request asked no provider
 * anything. The column still says whether an answer WAS stored, which is a fact about the
 * stored row rather than a claim about a derivation.
 */
router.get('/:resumeId', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const store = prisma as unknown as InterviewPrepStore;

    const resume = await requireOwnedResume(userId, req.params.resumeId, store);

    const stored = await store.interviewRisk.findMany({
      where: { resumeId: resume.id, userId },
      orderBy: [{ severity: 'desc' }, { kind: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        kind: true,
        severity: true,
        statement: true,
        evidenceRefs: true,
        requirementId: true,
        claimId: true,
        matchReportId: true,
        jobId: true,
      },
    });

    const anchorsByRiskId = new Map<string, RiskAnchor[]>();
    for (const row of stored) anchorsByRiskId.set(row.id, anchorsOf(row.evidenceRefs));

    // The invariant, re-asserted on the way out. A stored risk with no anchor fails HERE.
    assertRisksAreAnchored(
      stored.map(
        (row): DerivedRisk =>
          ({
            kind: row.kind,
            severity: row.severity,
            statement: row.statement,
            anchors: anchorsByRiskId.get(row.id) ?? [],
            key: anchorKeyOf(anchorsByRiskId.get(row.id) ?? [], row.id),
            groundedClaimIds: [],
            requirementId: row.requirementId,
            claimId: row.claimId,
            focus: INTERVIEW_RISK_KINDS.includes(row.kind)
              ? RISK_KIND_FOCUS[row.kind]
              : RISK_KIND_FOCUS.thin_evidence,
          }) as DerivedRisk,
      ),
    );

    const riskById = new Map(stored.map((row) => [row.id, row] as const));
    const keyByRiskId = new Map(
      stored.map((row) => [row.id, anchorKeyOf(anchorsByRiskId.get(row.id) ?? [], row.id)] as const),
    );
    const focusByRiskId = new Map(
      stored.map((row) => [
        row.id,
        INTERVIEW_RISK_KINDS.includes(row.kind)
          ? RISK_KIND_FOCUS[row.kind]
          : RISK_KIND_FOCUS.thin_evidence,
      ] as const),
    );

    const questionRows = await store.interviewQuestion.findMany({
      where: { userId, riskId: { in: stored.map((row) => row.id) } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        riskId: true,
        category: true,
        question: true,
        modelAnswer: true,
        groundedClaimIds: true,
      },
    });

    const questionCounts = emptyQuestionCounts();
    const questions: InterviewQuestionView[] = questionRows.map((row) => {
      const category = (QUESTION_CATEGORIES as readonly string[]).includes(row.category)
        ? (row.category as QuestionCategory)
        : 'general';
      questionCounts[category] += 1;
      const hasAnswer = row.modelAnswer.trim().length > 0;
      return {
        id: row.id,
        questionId:
          row.riskId === null
            ? row.id
            : `${keyByRiskId.get(row.riskId) ?? row.riskId}#${category}`,
        riskId: row.riskId,
        requirementId: row.riskId === null ? null : (riskById.get(row.riskId)?.requirementId ?? null),
        category,
        question: row.question,
        // An empty column is `null` in the view: "no answer was stored" is not "an empty answer
        // was stored", and the client renders them differently.
        modelAnswer: hasAnswer ? row.modelAnswer : null,
        groundedClaimIds: stringList(row.groundedClaimIds),
        focus: row.riskId === null ? '' : (focusByRiskId.get(row.riskId) ?? ''),
        answerStage: {
          status: hasAnswer ? 'answered' : 'skipped',
          reason: 'not_evaluated',
          provider: null,
          model: null,
          attempts: 0,
          rejectedEntities: [],
          dropped: [],
        },
      };
    });

    const riskCounts = emptyRiskCounts();
    const risks: InterviewRiskView[] = stored.map((row) => {
      riskCounts[row.kind] = (riskCounts[row.kind] ?? 0) + 1;
      return {
        id: row.id,
        key: keyByRiskId.get(row.id) ?? '',
        kind: row.kind,
        severity: row.severity,
        statement: row.statement,
        anchors: anchorsByRiskId.get(row.id) ?? [],
        requirementId: row.requirementId,
        claimId: row.claimId,
        focus: focusByRiskId.get(row.id) ?? '',
      };
    });

    const view: InterviewPrepView = {
      resumeId: resume.id,
      revision: null,
      match: {
        matchReportId: stored[0]?.matchReportId ?? null,
        jobId: stored[0]?.jobId ?? null,
        requirementCount: null,
        gapCount: null,
      },
      riskCounts,
      questionCounts,
      risks,
      questions,
      briefStage: {
        status: 'skipped',
        reason: 'not_evaluated',
        provider: null,
        model: null,
        appliedCount: 0,
        dropped: [],
      },
      answerStageSummary: summarizeAnswerStage(questions),
      notes: INTERVIEW_PREP_NOTES,
      rule: INTERVIEW_PREP_RULE,
    };

    res.status(200).json(view);
  } catch (error) {
    // A stored risk with no anchor is not an internal fault and not the caller's fault: it is a
    // row that exists and that this endpoint REFUSES to render as if it were derived. So it is
    // mapped onto a 409 whose body CARRIES THE CODE, rather than left to `handleApiError`'s
    // generic 500 - the machine-readable reason is the whole point of the invariant, and a
    // client that cannot read it cannot tell a data problem from a bug.
    if (error instanceof InterviewRiskError) {
      res.status(409).json({ error: `${error.code}: a stored interview risk names no data anchor`, reason: error.reason });
      return;
    }
    handleApiError(error, res);
  }
});

export default router;