// =====================================================================================
// match/report.ts - the MatchReport: counts, named gaps, and the two decisions (T1070;
// 06-design sec. E.2, E.6, E.10).
//
// WHAT THIS MODULE IS. The I/O half of matching. It reads the `Job`'s requirements, the
// user's CONFIRMED claims and the `PotentialMatch` rows, derives the four evidence levels
// through `match/levels.ts` (the one definition), runs the proposal stage from
// `match/potential.ts`, and persists the counts + named gaps on a `MatchReport` row. It
// also owns the two decisions a person can make about a proposal.
//
// THE REPORT IS DERIVED, NEVER CACHED AS TRUTH. `POST /jobs/:id/match`, `GET /matches/:id`
// and both decision endpoints all call the SAME `deriveEvidenceLevels`, so a level can
// never be one thing in the body and another in the database. `MatchReport`'s four count
// columns are a SNAPSHOT of the last write (they exist because the schema declares them,
// and the interview-risk stage will read them); the response body is always derived, so a
// claim confirmed on the career page since the last match is reflected immediately rather
// than waiting for a re-match.
//
// NO SCORE, NO PERCENTAGE, NO WEIGHT (E.6). The response type has no such member, the
// derivation does not compute one, and `JobRequirement.weight` is never read - see the
// note in `levels.ts`. `report.test.ts` greps this file and the route for the field names
// so the day someone adds `matchScore` back fails a test instead of shipping a verdict.
//
// THE CONFIRM PATH IS NOT A SPECIAL CASE (ADR-036 item 3). Confirming a proposal calls
// `career/userDecisions.ts#createUserClaim({ confirm: true })` - the SAME function the
// career page's "Add as unconfirmed" + Confirm use - which reaches
// `career/verification.ts`, the only writer of `CareerClaim.status` in the system. There
// is no second promotion path here, no `status` literal in this file, and the audit row is
// inseparable from the status change because that module writes both in one transaction.
// `report.test.ts` asserts the row.
//
// REJECTING IS A DECISION, NOT A DELETE (E.2). The `PotentialMatch` row becomes
// `rejected`, a `ClaimVerification(targetType = potential_match)` row records who decided
// and why, and the requirement RE-DERIVES as `unsupported` - which is to say it appears in
// `gaps` BY NAME. Nothing about a rejection is silently swallowed, and nothing about it is
// reversible except through the claim-reopen path that already exists.
// =====================================================================================

import {
  ClaimKind,
  VerificationAction,
  VerificationTarget,
  type EvidenceLevel,
  type Prisma,
  type PrismaClient,
} from '@prisma/client';
import { BadRequestError, ConflictError, NotFoundError } from '../shared/errors.js';
import type { CareerStore, CareerTxStore } from '../career/claims.js';
import { createUserClaim } from '../career/userDecisions.js';
import {
  countsForPersistence,
  deriveEvidenceLevels,
  isConfirmedClaim,
  type MatchAction,
  type MatchClaimRow,
  type MatchGap,
  type MatchRequirementRow,
  type RequirementCounts,
  type RequirementLevel,
} from './levels.js';
import { proposeContextualMatches, type ProposalResult } from './potential.js';

// ---------------------------------------------------------------------------
// The store seam
// ---------------------------------------------------------------------------

/**
 * Everything a transaction callback needs: the models this module reads and writes,
 * `Pick`ed from the generated client so a column name cannot drift, plus the career layer's
 * transaction seam. It EXTENDS `CareerTxStore` because the Confirm path hands the same
 * store to `career/userDecisions.ts` - one seam, one transaction boundary, no `as any`.
 */
export type MatchTxStore = Pick<
  PrismaClient,
  'job' | 'jobRequirement' | 'matchReport' | 'potentialMatch' | 'careerProfile' | 'resume'
> &
  CareerTxStore;

/** The store every exported function takes as its last argument. */
export interface MatchStore extends MatchTxStore {
  $transaction<T>(fn: (tx: MatchTxStore) => Promise<T>): Promise<T>;
}

/** Compile-time proof the real client still satisfies the seam (nothing calls this). */
type RealClientSatisfiesMatchStore = PrismaClient extends MatchStore ? true : false;
const MATCH_STORE_TYPECHECK: [RealClientSatisfiesMatchStore] = [true];
void MATCH_STORE_TYPECHECK;

/**
 * Compile-time proof that a `MatchStore` may be handed to `career/userDecisions.ts`. The
 * Confirm path depends on it: if it were false, `createUserClaim` would need a cast, and a
 * cast is exactly how a second promotion path gets written later. `npx tsc --noEmit` proves
 * this line; nothing runs it.
 */
type MatchStoreSatisfiesCareerStore = MatchStore extends CareerStore ? true : false;
const CAREER_STORE_TYPECHECK: [MatchStoreSatisfiesCareerStore] = [true];
void CAREER_STORE_TYPECHECK;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MATCH_SCHEMA_VERSION = 'job_match_v1' as const;

/**
 * The footer every report carries (E.6, verbatim from the spec's example). It is a CONSTANT,
 * not a template, so there is no code path that can produce a report without the rule
 * stated on it.
 */
export const MATCH_REPORT_NOTES =
  'Gaps are named, not scored. Nothing here is combined into a single number.';

/**
 * The rule the UI states under the counters: E.11 flow 7. Constant, for the same reason.
 */
export const INFERENCE_RULE_NOTE =
  'We never count an inference as experience.';

/**
 * `RequirementKind` -> the `ClaimKind` a confirmed claim about it should carry.
 *
 * A requirement kind with NO honest claim kind is `null` rather than a guess:
 * `screening_criterion` is an employer's question ("are you authorised to work in the UK?"),
 * not a fact about a person, so there is no claim a user could confirm that would make the
 * requirement true. Confirming such a proposal is REFUSED with an explanation instead of
 * writing a claim of an invented kind; rejecting it works normally.
 */
export const CLAIM_KIND_FOR_REQUIREMENT: Readonly<Record<string, ClaimKind | null>> = {
  required_skill: ClaimKind.skill,
  preferred_skill: ClaimKind.skill,
  technology: ClaimKind.technology,
  domain: ClaimKind.domain,
  responsibility: ClaimKind.responsibility,
  soft_skill: ClaimKind.soft_skill,
  years_experience: ClaimKind.metric,
  education: ClaimKind.education,
  terminology: null,
  screening_criterion: null,
};

/** The reason string a refused Confirm reports, so the client can branch on it. */
export const UNMAPPED_REQUIREMENT_KIND_REASON =
  'a screening criterion is an employer question, not a fact about you: add the statement you want to confirm on the Career evidence page, or reject this suggestion';

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/** The proposal stage's report. `reason` is what the UI shows; there is no fourth state. */
export interface ProposalStageView {
  status: 'applied' | 'skipped';
  reason: ProposalResult['reason'];
  provider: string | null;
  model: string | null;
  createdCount: number;
  /** What the deterministic guards refused, with the reason for each. */
  dropped: ProposalResult['dropped'];
}

export interface MatchRequirementView extends RequirementLevel {
  /** `id` is the requirement id, named so a client does not have to guess the field. */
  id: string;
  action: MatchAction;
}

export interface MatchReportView {
  matchReportId: string;
  jobId: string;
  job: {
    id: string;
    title: string | null;
    company: string | null;
    seniority: string | null;
    sourceKind: string;
  };
  profileId: string;
  resumeId: string | null;
  /** ISO timestamp of the row. The LEVELS in this body are derived, not stored. */
  createdAt: string;
  /** How many claims were confirmed and therefore eligible to be evidence at all. */
  confirmedClaimCount: number;
  proposalStage: ProposalStageView;
  requirementCounts: RequirementCounts;
  requirements: MatchRequirementView[];
  gaps: MatchGap[];
  notes: typeof MATCH_REPORT_NOTES;
  rule: typeof INFERENCE_RULE_NOTE;
}

/** What the Confirm endpoint returns: the decision, both audit rows, and the fresh report. */
export interface PotentialDecisionView {
  changed: boolean;
  potentialMatch: {
    id: string;
    requirementId: string;
    claimId: string | null;
    level: string;
    status: string;
    resolvedAt: string | null;
  };
  /** The claim the decision created (Confirm) or left alone (Reject). */
  claim: { id: string; kind: string; statement: string; status: string } | null;
  /** The `career_claim` audit row written by `career/verification.ts` (Confirm only). */
  claimVerification: { id: string; action: string; targetType: string; targetId: string } | null;
  /** The `potential_match` audit row this module writes for the decision itself. */
  potentialVerification: { id: string; action: string; targetType: string; targetId: string } | null;
  report: MatchReportView;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const REQUIREMENT_SELECT = {
  id: true,
  kind: true,
  importance: true,
  text: true,
  normalizedKey: true,
} as const;

const CLAIM_SELECT = {
  id: true,
  statement: true,
  kind: true,
  status: true,
} as const;

async function requireOwnedJob(
  userId: string,
  jobId: string,
  store: Pick<MatchStore, 'job'>,
): Promise<{ id: string; userId: string; title: string | null; company: string | null; seniority: string | null; sourceKind: string }> {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new BadRequestError('a jobId is required');
  }
  const job = await store.job.findUnique({
    where: { id: jobId },
    select: { id: true, userId: true, title: true, company: true, seniority: true, sourceKind: true },
  });
  // A foreign job is a 404, not a 403: an id is an id, and 403 would confirm the row exists
  // (the same rule `jobs/analyze.ts` and `routes/career.ts` apply).
  if (!job || job.userId !== userId) throw new NotFoundError('Job');
  return job;
}

/**
 * The caller's `CareerProfile`, created on demand.
 *
 * `MatchReport.profileId` is NOT NULL, so a user with no profile still needs a row to
 * report against. `routes/career.ts#resolveCallerProfile` already applies exactly this rule
 * on the import path: a `CareerProfile` is the person's own container and writing one
 * asserts no fact about them - it creates no claim and confirms nothing.
 */
async function resolveProfileId(userId: string, store: Pick<MatchStore, 'careerProfile'>): Promise<string> {
  const existing = await store.careerProfile.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await store.careerProfile.create({
    data: { userId },
    select: { id: true },
  });
  return created.id;
}

async function loadClaims(
  profileId: string,
  store: Pick<MatchStore, 'careerClaim'>,
): Promise<MatchClaimRow[]> {
  const rows = await store.careerClaim.findMany({
    where: { profileId },
    orderBy: { createdAt: 'asc' },
    select: CLAIM_SELECT,
  });
  return rows.map((row) => ({
    id: row.id,
    statement: row.statement,
    kind: row.kind,
    status: row.status,
  }));
}

async function loadRequirements(
  jobId: string,
  store: Pick<MatchStore, 'jobRequirement'>,
): Promise<MatchRequirementRow[]> {
  const rows = await store.jobRequirement.findMany({
    where: { jobId },
    orderBy: [{ importance: 'asc' }, { normalizedKey: 'asc' }],
    select: REQUIREMENT_SELECT,
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    importance: row.importance,
    text: row.text,
    normalizedKey: row.normalizedKey,
  }));
}

async function loadPotentialMatches(
  matchReportId: string,
  store: Pick<MatchStore, 'potentialMatch'>,
): Promise<Array<{
  id: string;
  requirementId: string;
  claimId: string | null;
  level: EvidenceLevel;
  status: string;
  proposedEvidence: string;
  rationale: string;
}>> {
  const rows = await store.potentialMatch.findMany({
    where: { matchReportId },
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
  });
  return rows;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface ReportContext {
  matchReportId: string;
  job: { id: string; title: string | null; company: string | null; seniority: string | null; sourceKind: string };
  profileId: string;
  resumeId: string | null;
  createdAt: Date;
  requirements: MatchRequirementRow[];
  claims: MatchClaimRow[];
  potentialMatches: Awaited<ReturnType<typeof loadPotentialMatches>>;
  proposalStage: ProposalStageView;
}

function buildView(context: ReportContext): MatchReportView {
  const derived = deriveEvidenceLevels({
    requirements: context.requirements,
    claims: context.claims,
    potentialMatches: context.potentialMatches,
  });
  return {
    matchReportId: context.matchReportId,
    jobId: context.job.id,
    job: context.job,
    profileId: context.profileId,
    resumeId: context.resumeId,
    createdAt: context.createdAt.toISOString(),
    confirmedClaimCount: context.claims.filter(isConfirmedClaim).length,
    proposalStage: context.proposalStage,
    requirementCounts: derived.counts,
    requirements: derived.requirements.map((row) => ({ ...row, id: row.requirementId })),
    gaps: derived.gaps,
    notes: MATCH_REPORT_NOTES,
    rule: INFERENCE_RULE_NOTE,
  };
}

function skippedProposal(reason: ProposalResult['reason']): ProposalStageView {
  return { status: 'skipped', reason, provider: null, model: null, createdCount: 0, dropped: [] };
}

function proposalStageOf(result: ProposalResult): ProposalStageView {
  return {
    status: result.status,
    reason: result.reason,
    provider: result.provider,
    model: result.model,
    createdCount: result.created.length,
    dropped: result.dropped,
  };
}

// ---------------------------------------------------------------------------
// POST /jobs/:id/match
// ---------------------------------------------------------------------------

export interface MatchJobInput {
  userId: string;
  jobId: string;
  /** Optional: binds the report to a `Resume`. Must be the caller's own. */
  resumeId?: string | null;
  now?: Date;
}

/**
 * Match a job's requirements against the caller's confirmed claims.
 *
 * Order of operations, and why:
 *   1. LOAD + OWNERSHIP. A foreign job is a 404.
 *   2. RESOLVE THE PROFILE (created on demand) so the report row has its required owner.
 *   3. DERIVE ONCE, before any proposal: the `direct` set is what tells the proposal stage
 *      which requirements are still open, and deriving it from pre-proposal state means the
 *      model can never influence what counts as direct.
 *   4. FIND OR CREATE the `MatchReport` row for `(jobId, resumeId)` - it must exist before
 *      a `PotentialMatch` can point at it.
 *   5. DISCARD STALE PENDING PROPOSALS for requirements that are now `direct`, and record
 *      which pending proposals already exist so a re-run cannot duplicate them. Confirmed
 *      and rejected rows are NEVER touched (a rejection is permanent).
 *   6. RUN THE PROPOSAL STAGE. Skipped-with-a-reason when there is no provider, when there
 *      is nothing open, or when nothing is confirmed; in all three cases it writes nothing.
 *   7. RE-DERIVE and persist the counts + gaps. The response is that fresh derivation, so
 *      the body and the columns are the same numbers.
 */
export async function matchJob(input: MatchJobInput, store: MatchStore): Promise<MatchReportView> {
  const job = await requireOwnedJob(input.userId, input.jobId, store);
  const resumeId = input.resumeId ?? null;
  if (resumeId !== null) {
    // `Resume` is owned by the caller; naming somebody else's is indistinguishable from
    // naming none, so it is a 404 rather than a 403.
    const resume = await store.resume.findUnique({
      where: { id: resumeId },
      select: { userId: true },
    });
    if (!resume) throw new NotFoundError('Resume');
    if (resume.userId !== input.userId) throw new NotFoundError('Resume');
  }

  const profileId = await resolveProfileId(input.userId, store);
  const [requirements, claims] = await Promise.all([
    loadRequirements(job.id, store),
    loadClaims(profileId, store),
  ]);

  const existingReport = await store.matchReport.findFirst({
    where: { jobId: job.id, userId: input.userId, resumeId },
    select: { id: true, createdAt: true },
  });

  const preProposal = deriveEvidenceLevels({ requirements, claims, potentialMatches: [] });
  const directIds = new Set(
    preProposal.requirements.filter((row) => row.level === 'direct').map((row) => row.requirementId),
  );
  const openRequirements = requirements.filter((row) => !directIds.has(row.id));

  const persisted = existingReport
    ? await store.matchReport.update({
        where: { id: existingReport.id },
        data: countsForPersistence(preProposal.counts),
        select: { id: true, createdAt: true },
      })
    : await store.matchReport.create({
        data: {
          userId: input.userId,
          jobId: job.id,
          profileId,
          resumeId,
          ...countsForPersistence(preProposal.counts),
          gaps: preProposal.gaps as unknown as Prisma.InputJsonValue,
        },
        select: { id: true, createdAt: true },
      });

  // Stale pending proposals, then the fingerprints of the survivors.
  await store.$transaction(async (tx) => {
    const pending = await tx.potentialMatch.findMany({
      where: { matchReportId: persisted.id, status: 'pending' },
      select: { id: true, requirementId: true, claimId: true, level: true },
    });
    const stale = pending.filter((row) => directIds.has(row.requirementId));
    for (const row of stale) {
      await tx.potentialMatch.delete({ where: { id: row.id } });
    }
  });

  const survivors = await loadPotentialMatches(persisted.id, store);
  const result = await proposeContextualMatches(
    {
      userId: input.userId,
      matchReportId: persisted.id,
      requirements: openRequirements,
      claims,
      directRequirementIds: [...directIds],
      existingPending: survivors
        .filter((row) => row.status === 'pending')
        .map((row) => ({
          requirementId: row.requirementId,
          claimId: row.claimId ?? '',
          level: row.level,
        })),
    },
    store,
  );

  const potentialMatches = await loadPotentialMatches(persisted.id, store);
  const final = buildView({
    matchReportId: persisted.id,
    job,
    profileId,
    resumeId,
    createdAt: persisted.createdAt,
    requirements,
    claims,
    potentialMatches,
    proposalStage: proposalStageOf(result),
  });

  await store.matchReport.update({
    where: { id: persisted.id },
    data: {
      ...countsForPersistence(final.requirementCounts),
      gaps: final.gaps as unknown as Prisma.InputJsonValue,
    },
  });

  return final;
}

// ---------------------------------------------------------------------------
// GET /matches/:id
// ---------------------------------------------------------------------------

/**
 * Read one report back, RE-DERIVED.
 *
 * No write on a GET: the levels in the body come from the current claims and proposals, not
 * from the count columns, so a claim confirmed elsewhere is visible without a re-match. The
 * stored columns are refreshed by `matchJob` and by both decision endpoints, which is what
 * keeps them close to the truth without turning a read into a write.
 */
export async function getMatchReport(
  userId: string,
  matchReportId: string,
  store: MatchStore,
): Promise<MatchReportView> {
  const report = await store.matchReport.findUnique({
    where: { id: matchReportId },
    select: {
      id: true,
      userId: true,
      jobId: true,
      profileId: true,
      resumeId: true,
      createdAt: true,
    },
  });
  if (!report || report.userId !== userId) throw new NotFoundError('Match report');

  const job = await requireOwnedJob(userId, report.jobId, store);
  const [requirements, claims, potentialMatches] = await Promise.all([
    loadRequirements(job.id, store),
    loadClaims(report.profileId, store),
    loadPotentialMatches(report.id, store),
  ]);

  return buildView({
    matchReportId: report.id,
    job,
    profileId: report.profileId,
    resumeId: report.resumeId,
    createdAt: report.createdAt,
    requirements,
    claims,
    potentialMatches,
    // A read says nothing about the stage that produced the proposals it is reading, and it
    // must not imply a stage ran. `no_ai_provider_configured` would be a claim about the
    // user's configuration that this request never checked, so the read reports the state it
    // can actually verify.
    proposalStage: skippedProposal('not_evaluated'),
  });
}

// ---------------------------------------------------------------------------
// The two decisions
// ---------------------------------------------------------------------------

interface DecisionContext {
  userId: string;
  matchReportId: string;
  potentialMatchId: string;
  now: Date;
}

async function loadDecisionContext(
  input: DecisionContext,
  store: MatchStore,
): Promise<{
  report: { id: string; jobId: string; profileId: string; userId: string; createdAt: Date; resumeId: string | null };
  proposal: { id: string; requirementId: string; claimId: string | null; level: EvidenceLevel; status: string; proposedEvidence: string; rationale: string };
  requirement: MatchRequirementRow;
}> {
  if (typeof input.potentialMatchId !== 'string' || input.potentialMatchId.length === 0) {
    throw new BadRequestError('a potentialMatchId is required');
  }
  const report = await store.matchReport.findUnique({
    where: { id: input.matchReportId },
    select: { id: true, userId: true, jobId: true, profileId: true, resumeId: true, createdAt: true },
  });
  if (!report || report.userId !== input.userId) throw new NotFoundError('Match report');

  const proposal = await store.potentialMatch.findFirst({
    where: { id: input.potentialMatchId, matchReportId: report.id },
    select: {
      id: true,
      requirementId: true,
      claimId: true,
      level: true,
      status: true,
      proposedEvidence: true,
      rationale: true,
    },
  });
  // Scoped to the report on purpose: a proposal from ANOTHER report's id is not found, so
  // the two ids cannot be mixed to confirm something the user is not looking at.
  if (!proposal) throw new NotFoundError('Potential match');

  const requirement = await store.jobRequirement.findFirst({
    where: { id: proposal.requirementId, jobId: report.jobId },
    select: REQUIREMENT_SELECT,
  });
  if (!requirement) throw new NotFoundError('Job requirement');

  return {
    report,
    proposal: {
      id: proposal.id,
      requirementId: proposal.requirementId,
      claimId: proposal.claimId,
      level: proposal.level,
      status: proposal.status,
      proposedEvidence: proposal.proposedEvidence,
      rationale: proposal.rationale,
    },
    requirement: {
      id: requirement.id,
      kind: requirement.kind,
      importance: requirement.importance,
      text: requirement.text,
      normalizedKey: requirement.normalizedKey,
    },
  };
}

async function refreshReport(
  context: { id: string; jobId: string; profileId: string; userId: string; createdAt: Date; resumeId: string | null },
  proposalStage: ProposalStageView,
  store: MatchStore,
): Promise<MatchReportView> {
  const job = await requireOwnedJob(context.userId, context.jobId, store);
  const [requirements, claims, potentialMatches] = await Promise.all([
    loadRequirements(job.id, store),
    loadClaims(context.profileId, store),
    loadPotentialMatches(context.id, store),
  ]);
  const view = buildView({
    matchReportId: context.id,
    job,
    profileId: context.profileId,
    resumeId: context.resumeId,
    createdAt: context.createdAt,
    requirements,
    claims,
    potentialMatches,
    proposalStage,
  });
  await store.matchReport.update({
    where: { id: context.id },
    data: {
      ...countsForPersistence(view.requirementCounts),
      gaps: view.gaps as unknown as Prisma.InputJsonValue,
    },
  });
  return view;
}

export interface ConfirmPotentialInput {
  userId: string;
  matchReportId: string;
  potentialMatchId: string;
  /**
   * Optional: the statement the user wants to confirm, when the requirement's own wording
   * is not the statement they would stand behind. Defaults to the requirement text, whose
   * normalized key is exactly the requirement's - which is what makes the requirement
   * re-derive as `direct` afterwards.
   */
  statement?: string | null;
  note?: string | null;
  now?: Date;
}

/**
 * The user CONFIRMS a proposal.
 *
 * What happens, in this order, and why the order is load-bearing:
 *   1. Load + ownership. A proposal id from another report is a 404.
 *   2. `status = confirmed` is IDEMPOTENT (reported as `changed: false`); a REJECTED
 *      proposal is REFUSED, because a rejection is never cleared implicitly (ADR-036 item 5)
 *      and un-rejecting is the claim-reopen decision, not this one.
 *   3. A requirement kind with no honest `ClaimKind` is REFUSED with a reason. We do not
 *      invent a kind of fact in order to make a button work.
 *   4. CREATE + CONFIRM THE CLAIM through `career/userDecisions.ts#createUserClaim`, which
 *      calls `career/verification.ts#confirmClaim`: the status change and its
 *      `ClaimVerification` row commit in ONE transaction there. This is the same path the
 *      career page uses, and the only path in the system that can write a confirming
 *      status - so the audit row is not optional and cannot be skipped.
 *   5. Mark the proposal `confirmed` and record a SECOND audit row for the proposal itself
 *      (`targetType = potential_match`), so the decision on the inference is auditable
 *      separately from the claim it produced.
 *   6. Re-derive: the requirement is now backed by a confirmed claim and reports `direct`.
 *
 * Step 4 runs in its own transaction, before step 5. If step 5 fails, the user is left with
 * a confirmed CLAIM (a true record of a gesture they made) and a still-pending proposal,
 * which is retryable and idempotent - never the other way round, which would be a claim
 * marked confirmed with no audit row.
 */
export async function confirmPotentialMatch(
  input: ConfirmPotentialInput,
  store: MatchStore,
): Promise<PotentialDecisionView> {
  const now = input.now ?? new Date();
  const { report, proposal, requirement } = await loadDecisionContext(
    { userId: input.userId, matchReportId: input.matchReportId, potentialMatchId: input.potentialMatchId, now },
    store,
  );

  // The proposal stage did not RUN here, and this request checked nothing about the user's
  // keys. Reporting `no_ai_provider_configured` would tell a user with a working provider
  // that they have none - the same defect D4 removed from the read path (deviation D4), so
  // both decision endpoints report the state they can actually verify. Probing the key
  // manager to fill the field in was rejected deliberately: it would add a store + I/O
  // dependency this seam does not carry, on a field whose truthful value is already known.
  const stage = skippedProposal('not_evaluated');

  if (proposal.status === 'confirmed') {
    const existing = proposal.claimId
      ? await store.careerClaim.findUnique({
          where: { id: proposal.claimId },
          select: { id: true, kind: true, statement: true, status: true },
        })
      : null;
    return {
      changed: false,
      potentialMatch: {
        id: proposal.id,
        requirementId: proposal.requirementId,
        claimId: proposal.claimId,
        level: proposal.level,
        status: proposal.status,
        resolvedAt: null,
      },
      claim: existing
        ? { id: existing.id, kind: existing.kind, statement: existing.statement, status: existing.status }
        : null,
      claimVerification: null,
      potentialVerification: null,
      report: await refreshReport(report, stage, store),
    };
  }
  if (proposal.status === 'rejected') {
    throw new ConflictError(
      'this suggestion was already rejected; a rejection is never cleared implicitly - add the statement on the Career evidence page if it is true',
    );
  }
  if (proposal.status !== 'pending') {
    throw new ConflictError(`this suggestion is ${proposal.status} and cannot be confirmed`);
  }

  const kind = CLAIM_KIND_FOR_REQUIREMENT[requirement.kind] ?? null;
  const supplied = typeof input.statement === 'string' ? input.statement.trim() : '';
  if (kind === null && supplied.length === 0) {
    throw new ConflictError(UNMAPPED_REQUIREMENT_KIND_REASON);
  }

  // STEP 4: the one path to a confirmed claim in the whole system.
  const decision = await createUserClaim(
    {
      profileId: report.profileId,
      // THE USER GESTURE, as a flag and never as a status. `createUserClaim` creates the row
      // unconfirmed and then runs the verification service, so `confirm: true` is what
      // produces the status change and the audit row together - and there is no input on this
      // function through which a caller could simply declare a claim confirmed.
      confirm: true,
      // A requirement kind with no mapping is only reachable WITH a statement the user
      // wrote; it is then filed as the user's own skill, which is the narrowest honest
      // container for "a thing I satisfy" that the schema offers.
      kind: kind ?? ClaimKind.skill,
      statement: supplied.length > 0 ? supplied : requirement.text,
      actorUserId: input.userId,
      note:
        input.note ??
        `Confirmed from a ${proposal.level} match on "${requirement.text}" (proposal ${proposal.id}).`,
    },
    store,
  );

  const updated = await store.$transaction(async (tx) => {
    const row = await tx.potentialMatch.update({
      where: { id: proposal.id },
      data: {
        status: 'confirmed',
        resolvedAt: now,
        claimId: decision.claim.id,
      },
      select: { id: true, requirementId: true, claimId: true, level: true, status: true, resolvedAt: true },
    });
    const audit = await tx.claimVerification.create({
      data: {
        userId: input.userId,
        actorUserId: input.userId,
        targetType: VerificationTarget.potential_match,
        targetId: proposal.id,
        // Linked to the claim as well, so the decision is visible in that claim's own audit
        // history and not only on the proposal.
        claimId: decision.claim.id,
        action: VerificationAction.confirm,
        before: { status: 'pending', claimId: proposal.claimId ?? null } as Prisma.InputJsonValue,
        after: { status: 'confirmed', claimId: decision.claim.id } as Prisma.InputJsonValue,
        note: input.note ?? null,
        createdAt: now,
      },
      select: { id: true, action: true, targetType: true, targetId: true },
    });
    return { row, audit };
  });

  return {
    // `true`, deliberately, and NOT `decision.changed || true` (which was dead logic: `x ||
    // true` is always `true` and read as if it were computing something).
    //
    // The field means "did THIS call change anything", and its consumer is the client's
    // notice - `src/pages/Match.tsx` prints "is now direct evidence" on `true` and "was
    // already confirmed" on `false`. Two paths report `false`, both earlier: a proposal that
    // was ALREADY confirmed returns at the top of this function, and the reject path returns
    // `changed: true` for its single flip. So reaching here means this call resolved a
    // pending proposal, wrote its `potential_match` audit row and re-derived the report. That
    // is a change even when `createUserClaim` DEDUPED onto an existing fingerprint
    // (`decision.changed === false` means "no new CLAIM row", not "no decision"): the
    // proposal flipped and a confirmed statement now backs the requirement.
    changed: true,
    potentialMatch: {
      id: updated.row.id,
      requirementId: updated.row.requirementId,
      claimId: updated.row.claimId,
      level: updated.row.level,
      status: updated.row.status,
      resolvedAt: updated.row.resolvedAt ? updated.row.resolvedAt.toISOString() : null,
    },
    claim: {
      id: decision.claim.id,
      kind: decision.claim.kind,
      statement: decision.claim.statement,
      status: decision.claim.status,
    },
    claimVerification: decision.verification
      ? {
          id: decision.verification.id,
          action: decision.verification.action,
          targetType: decision.verification.targetType,
          targetId: decision.verification.targetId,
        }
      : null,
    potentialVerification: {
      id: updated.audit.id,
      action: updated.audit.action,
      targetType: updated.audit.targetType,
      targetId: updated.audit.targetId,
    },
    report: await refreshReport(report, stage, store),
  };
}

export interface RejectPotentialInput {
  userId: string;
  matchReportId: string;
  potentialMatchId: string;
  reason?: string | null;
  note?: string | null;
  now?: Date;
}

/**
 * The user REJECTS a proposal. Nothing is deleted and nothing is created: the row becomes
 * `rejected`, an audit row records it, and the requirement RE-DERIVES as `unsupported` -
 * which is to say it appears in `gaps` by name, where the user can see it and decide what
 * to do about it. The report the endpoint returns is the fresh derivation, so the UI can
 * show the new gap in the same gesture that created it.
 *
 * A CONFIRMED proposal cannot be rejected here: what is now true about the user is the
 * CLAIM, and undoing it is `POST /career/claims/:id/reject` - a different decision, with its
 * own audit row. This endpoint says so rather than quietly rejecting the proposal and
 * leaving the confirmed claim in place.
 */
export async function rejectPotentialMatch(
  input: RejectPotentialInput,
  store: MatchStore,
): Promise<PotentialDecisionView> {
  const now = input.now ?? new Date();
  const { report, proposal } = await loadDecisionContext(
    { userId: input.userId, matchReportId: input.matchReportId, potentialMatchId: input.potentialMatchId, now },
    store,
  );

  // Same reason as on the confirm path: this request did not evaluate the proposal stage, so
  // it does not report the user's provider configuration.
  const stage = skippedProposal('not_evaluated');

  if (proposal.status === 'confirmed') {
    throw new ConflictError(
      'this suggestion was confirmed, so what it asserts is now a confirmed statement: reject the statement itself on the Career evidence page (that decision has its own audit row)',
    );
  }
  if (proposal.status === 'rejected') {
    return {
      changed: false,
      potentialMatch: {
        id: proposal.id,
        requirementId: proposal.requirementId,
        claimId: proposal.claimId,
        level: proposal.level,
        status: proposal.status,
        resolvedAt: null,
      },
      claim: null,
      claimVerification: null,
      potentialVerification: null,
      report: await refreshReport(report, stage, store),
    };
  }

  const updated = await store.$transaction(async (tx) => {
    const row = await tx.potentialMatch.update({
      where: { id: proposal.id },
      data: { status: 'rejected', resolvedAt: now },
      select: { id: true, requirementId: true, claimId: true, level: true, status: true, resolvedAt: true },
    });
    const audit = await tx.claimVerification.create({
      data: {
        userId: input.userId,
        actorUserId: input.userId,
        targetType: VerificationTarget.potential_match,
        targetId: proposal.id,
        claimId: proposal.claimId,
        action: VerificationAction.reject,
        before: { status: 'pending' } as Prisma.InputJsonValue,
        after: { status: 'rejected' } as Prisma.InputJsonValue,
        note: input.reason ?? input.note ?? null,
        createdAt: now,
      },
      select: { id: true, action: true, targetType: true, targetId: true },
    });
    return { row, audit };
  });

  return {
    changed: true,
    potentialMatch: {
      id: updated.row.id,
      requirementId: updated.row.requirementId,
      claimId: updated.row.claimId,
      level: updated.row.level,
      status: updated.row.status,
      resolvedAt: updated.row.resolvedAt ? updated.row.resolvedAt.toISOString() : null,
    },
    claim: null,
    claimVerification: null,
    potentialVerification: {
      id: updated.audit.id,
      action: updated.audit.action,
      targetType: updated.audit.targetType,
      targetId: updated.audit.targetId,
    },
    report: await refreshReport(report, stage, store),
  };
}

/**
 * The statuses this module writes on a `PotentialMatch`, as a closed set.
 *
 * Exported so the invariant is assertable from outside: `potential.ts` writes only
 * `pending`, and this module writes only the other two, and only from a decision.
 */
export const DECIDABLE_POTENTIAL_STATUSES: readonly string[] = ['confirmed', 'rejected'];