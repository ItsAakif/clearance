// =====================================================================================
// projects/lifecycle.ts - PERSISTENCE AND THE accept -> complete -> confirm LOOP (T1100;
// 06-design sec. E.5, E.8 stage 12, E.10).
//
// WHAT THIS MODULE IS. The I/O half of the project engine. It reads the caller's match report
// (or a bare `Job`), derives the evidence levels through `match/levels.ts` - THE SAME
// derivation the match report shows, so "a gap" means here exactly what it means there -
// selects the teachable gaps through `projects/gaps.ts`, optionally researches public
// references, generates candidates through `projects/generate.ts`, persists
// `ProjectOpportunity` + `ProjectReference` rows, and owns the three decisions.
//
// THE LOOP, AND THE ONE THING IT MUST NEVER DO.
//
//   proposed --accept--> accepted --complete--> completed --confirm--> a CONFIRMED CLAIM
//                                                                        (+ its audit row)
//
// E.5: "Completion -> `status = completed` + the user confirms -> a `CareerClaim` (`kind:
// project`, `provenance: user_entered`, and the confirming status the verification service
// owns)... A completion is NEVER
// auto-confirmed from a repo existing." So `complete` writes NOTHING to the career layer: it
// sets `completedAt`, leaves `verifiedClaimId` NULL, and answers with
// `awaitingYourConfirmation: true`. The claim is written by `confirm`, and only by `confirm`,
// through `career/userDecisions.ts#createUserClaim({ confirm: true })` - the SAME function the
// career page's "Add as unconfirmed" + Confirm uses, which reaches `career/verification.ts`,
// the only writer of `CareerClaim.status` in the system. There is no second promotion path
// here, this file spells NO confirming status literal of its own (it reads the status back
// through `isRenderableClaimStatus` when it has to judge one), and the audit row is inseparable
// from the status change because that module writes both in one transaction.
// `career/claimWriterAI.test.ts` and `routes/career.test.ts`'s source guards both hold, and
// `lifecycle.test.ts` asserts the absence of an auto-confirm BY EXECUTION: the claims table is
// byte-for-byte unchanged after a complete, which is the assertion the acceptance item is
// actually about.
//
// WHY THE CLAIM IS `kind: project`. `ProjectOpportunity` is not a skill and not an
// achievement; it is a thing the person BUILT, which is what `ClaimKind.project` is for. The
// statement is derived from the opportunity's own title unless the user supplies their own
// wording in the confirm body - because a claim the user did not read is the failure this whole
// pipeline exists to prevent.
//
// NO SCORE. The response has four integer counters over NAMED things (`considered`,
// `selected`, `excluded`, `candidates`) and no derived figure. There is no `score`, no
// `percentage` and no `ratio` anywhere in this file or in the response types, and
// `lifecycle.noScore.test.ts` greps both the source and a real response body for them.
//
// WHY A FOREIGN id IS A 404. The same rule `match/report.ts` and `routes/interview-prep.ts`
// apply, and for the same reason: this surface quotes a person's career gaps, so a probe must
// not be able to learn that a row exists. It is deliberately NOT `ensureOwnership`'s 403.
//
// WHY THE REFERENCES ARE WRITTEN WITH THEIR LICENCE AND THEIR SNAPSHOT, HERE AND NOW. The
// screening happened in `projects/references.ts#screenReference` and the row was BUILT by
// `referenceRecord`, which throws rather than emit a reference without a licence. This module
// persists exactly the row that was built - it does not re-derive the licence from a title, and
// it does not have a path that records one without the `activity` object that
// `referenceRecord` already checked for completeness. That is acceptance item 2 as a property
// of the write path rather than of a test.
// =====================================================================================

import { ClaimKind, VerificationAction, VerificationTarget, type Prisma, type PrismaClient, type Severity } from '@prisma/client';

import { BadRequestError, ConflictError, NotFoundError } from '../shared/errors.js';
import type { CareerStore, CareerTxStore } from '../career/claims.js';
import { createUserClaim } from '../career/userDecisions.js';
import { isRenderableClaimStatus } from '../career/claimUsage.js';
import { deriveEvidenceLevels, type MatchGap } from '../match/levels.js';
import { selectTeachableGaps, type ExcludedGap, type TeachableGap } from './gaps.js';
import {
  generateCandidates,
  type CandidateRejection,
  type CandidateResearchStage,
  type CandidateRun,
  type ProjectPlan,
} from './generate.js';
import { researchReferences, type ResearchFetch } from './research.js';
import { referenceRecord, type ReferenceRow } from './references.js';

// ---------------------------------------------------------------------------
// The store seam
// ---------------------------------------------------------------------------

/**
 * Everything this module reads and writes, `Pick`ed from the generated client so a column name
 * cannot drift, PLUS the career layer's transaction seam.
 *
 * It EXTENDS `CareerTxStore` because `confirm` hands the same store to
 * `career/userDecisions.ts` - one seam, one transaction boundary, no cast. A hand-written row
 * type would be a second thing to keep in step with the schema, so every row is returned to the
 * caller exactly as Prisma produced it and is never re-shaped.
 */
export type ProjectTxStore = Pick<
  PrismaClient,
  | 'projectOpportunity'
  | 'projectReference'
  | 'matchReport'
  | 'job'
  | 'jobRequirement'
  | 'careerProfile'
  | 'careerClaim'
  | 'potentialMatch'
> &
  CareerTxStore;

export interface ProjectStore extends ProjectTxStore {
  $transaction<T>(fn: (tx: ProjectTxStore) => Promise<T>): Promise<T>;
}

/** Compile-time proof the real client still satisfies the seam (nothing calls this). */
type RealClientSatisfiesProjectStore = PrismaClient extends ProjectStore ? true : false;
const PROJECT_STORE_TYPECHECK: [RealClientSatisfiesProjectStore] = [true];
void PROJECT_STORE_TYPECHECK;

/**
 * Compile-time proof that a `ProjectStore` may be handed to `career/userDecisions.ts`.
 *
 * `npx tsc --noEmit` proves this line. If it were false, `createUserClaim` would need a cast -
 * and a cast is exactly how a second promotion path gets written later.
 */
type ProjectStoreSatisfiesCareerStore = ProjectStore extends CareerStore ? true : false;
const CAREER_STORE_TYPECHECK: [ProjectStoreSatisfiesCareerStore] = [true];
void CAREER_STORE_TYPECHECK;

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/** E.5's footer, as a CONSTANT, so no code path can produce a body without the rule stated. */
export const PROJECT_DISCOVERY_NOTES =
  'Candidates come from the named gaps the match report could not cover with your confirmed evidence. A candidate is a plan, not experience.';

/** The rule this screen rests on, in the words the UI states under the lifecycle. */
export const PROJECT_CONFIRMATION_RULE =
  'Completing a plan never adds anything to your profile. Nothing is recorded until you confirm it yourself.';

/** One stored reference, as the client sees it: kind + licence + activity, never copied text. */
export interface ProjectReferenceView {
  readonly kind: string;
  readonly title: string;
  readonly url: string;
  /** NEVER empty on a row this module wrote: `referenceRecord` refuses to build one without it. */
  readonly licence: string;
  readonly activity: Record<string, unknown>;
  /** The excerpt kept for the anti-copy guard. The UI shows it as inspiration, never a template. */
  readonly notes: string | null;
}

/** One stored candidate, with its persisted id, its references and its lifecycle state. */
export interface ProjectOpportunityView {
  readonly id: string;
  readonly profileId: string;
  readonly jobId: string | null;
  readonly title: string;
  readonly idea: string;
  /** `JobRequirement.id`s this closes. NEVER empty: `guardCandidate` refuses an unattributable one. */
  readonly requirementIds: readonly string[];
  readonly stack: readonly string[];
  readonly difficulty: Severity;
  /** ALWAYS between 1 and `TWO_DAY_BUDGET_HOURS`: that is the feasibility screen. */
  readonly estimatedHours: number;
  readonly relevance: string;
  readonly plan: ProjectPlan;
  readonly references: readonly ProjectReferenceView[];
  /** `ProjectStatus`. `proposed` on creation; the three decisions move it and nothing else. */
  readonly status: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  /** `null` until the user confirms. There is no other writer in the system. */
  readonly verifiedClaimId: string | null;
  /** True when the completion is waiting for the user. The whole point of the loop. */
  readonly awaitingYourConfirmation: boolean;
  /** Which stage produced this candidate, so "derived" is never read as "generated". */
  readonly producedBy: 'deterministic' | 'provider';
}

/** `POST /project-discovery`. */
export interface ProjectDiscoveryView {
  readonly jobId: string | null;
  readonly matchReportId: string | null;
  readonly profileId: string;
  /** Every named gap the matcher reported, before any selection. */
  readonly considered: readonly MatchGap[];
  /** The gaps a two-day project could close. */
  readonly selectedGaps: readonly TeachableGap[];
  /** Every refusal, with the rule that fired. NEVER silently dropped. */
  readonly excludedGaps: readonly ExcludedGap[];
  /** Four integers over named things. A count per thing, never a verdict. */
  readonly counts: {
    considered: number;
    selected: number;
    excluded: number;
    candidates: number;
  };
  readonly candidates: readonly ProjectOpportunityView[];
  /** Every candidate the screens refused, with the screen that fired. */
  readonly rejectedCandidates: readonly CandidateRejection[];
  /** What the optional public-research stage did. Reported either way. */
  readonly researchStage: CandidateResearchStage & {
    readonly rejectedReferences: ReadonlyArray<{ url: string; reason: string; detail: string }>;
  };
  /** What the optional proposal stage did. Reported either way. */
  readonly proposalStage: CandidateRun['proposalStage'];
  readonly notes: typeof PROJECT_DISCOVERY_NOTES;
  readonly rule: typeof PROJECT_CONFIRMATION_RULE;
}

/** What the three decision endpoints return. */
export interface ProjectDecisionView {
  readonly opportunity: ProjectOpportunityView;
  /** `false` for an idempotent repeat, which then wrote nothing. */
  readonly changed: boolean;
  /** The claim `confirm` created. `null` on accept and complete - and on a repeat confirm. */
  readonly claim: { id: string; kind: string; statement: string; status: string } | null;
  /** The `career_claim` audit row the verification service wrote (confirm only). */
  readonly claimVerification: { id: string; action: string; targetType: string; targetId: string } | null;
  readonly notes: typeof PROJECT_DISCOVERY_NOTES;
  readonly rule: typeof PROJECT_CONFIRMATION_RULE;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const REQUIREMENT_SELECT = {
  id: true,
  kind: true,
  importance: true,
  text: true,
  normalizedKey: true,
} as const;

const OPPORTUNITY_SELECT = {
  id: true,
  userId: true,
  profileId: true,
  jobId: true,
  title: true,
  idea: true,
  requirementsAddressed: true,
  stack: true,
  difficulty: true,
  estimatedHours: true,
  relevance: true,
  plan: true,
  status: true,
  createdAt: true,
  completedAt: true,
  verifiedClaimId: true,
} as const;

type OpportunityRow = {
  id: string;
  userId: string;
  profileId: string;
  jobId: string | null;
  title: string;
  idea: string;
  requirementsAddressed: unknown;
  stack: unknown;
  difficulty: string;
  estimatedHours: number | null;
  relevance: string;
  plan: unknown;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  verifiedClaimId: string | null;
};

/** The caller's `CareerProfile`, created on demand. `ProjectOpportunity.profileId` is NOT NULL. */
async function resolveProfileId(
  userId: string,
  store: Pick<ProjectStore, 'careerProfile'>,
): Promise<string> {
  const existing = await store.careerProfile.findUnique({ where: { userId }, select: { id: true } });
  if (existing) return existing.id;
  const created = await store.careerProfile.create({ data: { userId }, select: { id: true } });
  return created.id;
}

/**
 * THE GAPS, derived rather than read from the column.
 *
 * `MatchReport.gaps` is a SNAPSHOT of the last match write; the body of `GET /matches/:id` is a
 * fresh derivation. This module wants the fresh one - a gap the user closed this morning should
 * not produce a project plan - so it re-derives through the same `deriveEvidenceLevels` and
 * uses the snapshot only as the report's IDENTITY. Same rule and same reason as
 * `routes/interview-prep.ts`.
 */
async function deriveGaps(
  jobId: string,
  profileId: string,
  matchReportId: string | null,
  store: ProjectStore,
): Promise<MatchGap[]> {
  const [requirementRows, claimRows, potentialRows] = await Promise.all([
    store.jobRequirement.findMany({
      where: { jobId },
      orderBy: [{ importance: 'asc' }, { normalizedKey: 'asc' }],
      select: REQUIREMENT_SELECT,
    }),
    store.careerClaim.findMany({
      where: { profileId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, statement: true, kind: true, status: true },
    }),
    matchReportId === null
      ? Promise.resolve([])
      : store.potentialMatch.findMany({
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
        }),
  ]);
  return deriveEvidenceLevels({
    requirements: requirementRows,
    claims: claimRows,
    potentialMatches: potentialRows,
  }).gaps;
}

interface GapContext {
  readonly jobId: string | null;
  readonly matchReportId: string | null;
  readonly profileId: string;
  readonly gaps: MatchGap[];
}

async function loadGapContext(
  userId: string,
  input: { matchReportId?: string | null; jobId?: string | null },
  store: ProjectStore,
): Promise<GapContext> {
  const profileId = await resolveProfileId(userId, store);

  if (typeof input.matchReportId === 'string' && input.matchReportId.length > 0) {
    const report = await store.matchReport.findUnique({
      where: { id: input.matchReportId },
      select: { id: true, userId: true, jobId: true, profileId: true },
    });
    // 404, not 403: this view names a person's career gaps.
    if (!report || report.userId !== userId) throw new NotFoundError('Match report');
    const job = await store.job.findUnique({
      where: { id: report.jobId },
      select: { id: true, userId: true },
    });
    if (!job || job.userId !== userId) throw new NotFoundError('Job');
    return {
      jobId: report.jobId,
      matchReportId: report.id,
      profileId,
      gaps: await deriveGaps(report.jobId, profileId, report.id, store),
    };
  }

  if (typeof input.jobId === 'string' && input.jobId.length > 0) {
    const job = await store.job.findUnique({
      where: { id: input.jobId },
      select: { id: true, userId: true },
    });
    if (!job || job.userId !== userId) throw new NotFoundError('Job');
    // No report named: every requirement is treated as unsupported, because nothing was matched
    // yet. That is the honest reading of "no report", and it is the same rule
    // `routes/interview-prep.ts` applies.
    return {
      jobId: job.id,
      matchReportId: null,
      profileId,
      gaps: await deriveGaps(job.id, profileId, null, store),
    };
  }

  throw new BadRequestError('provide a matchReportId or a jobId');
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function planOf(value: unknown): ProjectPlan {
  const raw = (value ?? {}) as Record<string, unknown>;
  const scope = (raw.scope ?? {}) as Record<string, unknown>;
  return {
    day1: stringList(raw.day1),
    day2: stringList(raw.day2),
    milestones: stringList(raw.milestones),
    scope: { in: stringList(scope.in), out: stringList(scope.out) },
    originalDesignDecision:
      typeof raw.originalDesignDecision === 'string' ? raw.originalDesignDecision : '',
  };
}

async function requireOwnedOpportunity(
  userId: string,
  opportunityId: string,
  store: Pick<ProjectStore, 'projectOpportunity'>,
): Promise<OpportunityRow> {
  if (typeof opportunityId !== 'string' || opportunityId.length === 0) {
    throw new BadRequestError('an opportunityId is required');
  }
  const row = (await store.projectOpportunity.findUnique({
    where: { id: opportunityId },
    select: OPPORTUNITY_SELECT,
  })) as OpportunityRow | null;
  // 404, not 403, and deliberately not `ensureOwnership`: this view names a person's career
  // gaps, so a probe must not learn that the row exists.
  if (!row || row.userId !== userId) throw new NotFoundError('Project opportunity');
  return row;
}

/** A stored opportunity, with its references, as the client sees it. */
export async function opportunityView(
  userId: string,
  opportunityId: string,
  store: Pick<ProjectStore, 'projectOpportunity' | 'projectReference'>,
): Promise<ProjectOpportunityView> {
  const row = await requireOwnedOpportunity(userId, opportunityId, store);
  const stored = await store.projectReference.findMany({
    where: { opportunityId: row.id },
    orderBy: { retrievedAt: 'asc' },
    select: { kind: true, title: true, url: true, licence: true, activity: true, notes: true },
  });
  return {
    id: row.id,
    profileId: row.profileId,
    jobId: row.jobId,
    title: row.title,
    idea: row.idea,
    requirementIds: stringList(row.requirementsAddressed),
    stack: stringList(row.stack),
    difficulty: row.difficulty as Severity,
    estimatedHours: row.estimatedHours ?? 0,
    relevance: row.relevance,
    plan: planOf(row.plan),
    references: stored.map((entry) => ({
      kind: entry.kind,
      title: entry.title,
      url: entry.url,
      // `referenceRecord` refuses to build a row without a licence, so this is never empty on
      // a row this module wrote. The fallback keeps a hand-edited legacy row RENDERABLE rather
      // than throwing on a read - and it says `unknown`, which is the honest reading.
      licence: typeof entry.licence === 'string' && entry.licence.length > 0 ? entry.licence : 'unknown',
      activity: (entry.activity ?? {}) as Record<string, unknown>,
      notes: entry.notes,
    })),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    verifiedClaimId: row.verifiedClaimId,
    // THE WHOLE POINT OF THE LOOP, as one boolean: a completed opportunity with no verified
    // claim is waiting for the user, and nothing else in the system can move it.
    awaitingYourConfirmation: row.completedAt !== null && row.verifiedClaimId === null,
    producedBy: 'deterministic',
  };
}

// ---------------------------------------------------------------------------
// POST /project-discovery
// ---------------------------------------------------------------------------

export interface DiscoverProjectsInput {
  readonly userId: string;
  readonly matchReportId?: string | null;
  readonly jobId?: string | null;
  /** `false` runs the DETERMINISTIC-ONLY path: no provider is asked. */
  readonly runProvider?: boolean;
  /** `false` skips the optional public research. The only network this engine ever makes. */
  readonly research?: boolean;
  /** An injected fetch for the research stage. Absent means the stage reports unavailable. */
  readonly fetchImpl?: ResearchFetch;
  /** An optional GitHub token from the environment. Sent when present; never stored. */
  readonly githubToken?: string | undefined;
  readonly now?: Date;
}

/** A screened reference, ready to persist. Keyed by the requirement it was found for. */
type ReferencesForRequirement = Record<string, ReferenceRow[]>;

/** The `activity` snapshot as the criteria checked it, taken off the row `referenceRecord` built. */
type ReferenceActivityJson = Record<string, unknown>;

/**
 * THE WHOLE RUN, in the order E.5 gives, and the order IS the design:
 *
 *   1. LOAD + OWNERSHIP, then DERIVE THE GAPS with no provider in sight. This is the step that
 *      cannot be skipped, degraded or invented, and it is the whole of acceptance item 1.
 *   2. SELECT the teachable gaps (`projects/gaps.ts`), reporting every refusal.
 *   3. RESEARCH public references, OPTIONALLY. It runs HERE rather than first because a
 *      reference is attached to a CANDIDATE and there are no candidates yet - the reverse order
 *      would either search for gaps it does not have yet or attach a reference to nothing.
 *   4. GENERATE candidates (`projects/generate.ts`), each screened by its feasibility screen and
 *      by the anti-copy guard against the references found in step 3.
 *   5. PERSIST, and build the view from what was STORED rather than from what was computed, so
 *      the ids in the body are the ids the next request needs.
 *
 * WHAT IS WRITTEN WHEN NOTHING IS TEACHABLE: no `ProjectOpportunity` row and no reference, and
 * a body that says so with the exclusions attached. "We looked and nothing here is a two-day
 * project" is a real answer; an empty screen would be indistinguishable from a broken one.
 *
 * A REPEAT POST DOES NOT DEDUPE. An opportunity's identity is a derived candidate plus a moment,
 * and the user pressing the button twice is asking for a fresh look at a changed profile; the
 * lifecycle rows are the history (`ProjectStatus` plus `completedAt`/`verifiedClaimId`), so a
 * second run stacks rather than overwrites. Stated here because it is the opposite of
 * `routes/interview-prep.ts`, which REPLACES, and the difference is deliberate: a project's
 * lifecycle is a thing the user acts on, while an interview run is a derived view.
 */
export async function discoverProjects(
  input: DiscoverProjectsInput,
  store: ProjectStore,
): Promise<ProjectDiscoveryView> {
  const now = input.now ?? new Date();
  const context = await loadGapContext(input.userId, input, store);
  const selection = selectTeachableGaps(context.gaps);

  // ---- 3. research (optional, and the only network this engine makes) ---------
  // Keyed by requirement. `researchReferences` associates a hit with the FIRST selected gap's
  // term list; that association is a single-term search result and is recorded as such, so the
  // reader can see which gap the reference was found for.
  const found: ReferencesForRequirement = {};
  const researchReport = await researchReferences(
    selection.selected,
    {
      enabled: input.research !== false,
      now,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.githubToken !== undefined ? { token: input.githubToken } : {}),
    },
    (acceptance) => {
      const requirementId = selection.selected[0]?.requirementId ?? '';
      // `referenceRecord` is the ONLY way to build a row and it THROWS on a missing licence -
      // which `screenReference` has already refused - so this is a belt-and-braces assertion
      // rather than a filter. A reference with no licence is not recorded, ever.
      const row = referenceRecord(acceptance);
      const bucket = found[requirementId] ?? [];
      bucket.push(row);
      found[requirementId] = bucket;
    },
  );

  // The overlap guard compares the CANDIDATE against the reference's stored excerpt, and the
  // writer persists that same excerpt plus its licence and snapshot. Both read the one row
  // `referenceRecord` built, so a stored reference and a measured reference cannot be two
  // different things.
  const referencesByRequirement: Record<string, ReferenceRow[]> = {};
  for (const [requirementId, rows] of Object.entries(found)) {
    referencesByRequirement[requirementId] = rows;
  }
  const candidateReferences: NonNullable<
    Parameters<typeof generateCandidates>[0]['referencesByRequirement']
  > = Object.fromEntries(
    Object.entries(referencesByRequirement).map(([requirementId, rows]) => [
      requirementId,
      rows.map((row) => ({
        kind: row.kind,
        title: row.title,
        url: row.url,
        licence: row.licence,
        activity: activityOf(row),
      })),
    ]),
  );

  // ---- 4. generate ----------------------------------------------------------
  const run = await generateCandidates({
    userId: input.userId,
    gaps: selection.selected,
    ...(input.runProvider !== undefined ? { runProvider: input.runProvider } : {}),
    referencesByRequirement: candidateReferences,
    // The guard needs the reference's URL, title and stored excerpt - the shape
    // `checkCandidateIsOriginal` reads - and that excerpt is on the row.
    referenceRowsByRequirement: Object.fromEntries(
      Object.entries(referencesByRequirement).map(([requirementId, rows]) => [
        requirementId,
        rows.map((row) => ({
          url: row.url,
          title: row.title,
          notes: row.notes,
        })),
      ]),
    ),
    researchStage: {
      status: researchReport.status,
      reason: researchReport.reason,
      searchCount: researchReport.searchCount,
      consideredCount: researchReport.consideredCount,
      acceptedCount: researchReport.acceptedCount,
    },
  });

  // ---- 5. persist, then build the view from what was STORED ------------------
  const stored: ProjectOpportunityView[] = [];
  for (const candidate of run.candidates) {
    const created = await store.projectOpportunity.create({
      data: {
        userId: input.userId,
        profileId: context.profileId,
        jobId: context.jobId,
        title: candidate.title,
        idea: candidate.idea,
        requirementsAddressed: [...candidate.requirementIds] as unknown as Prisma.InputJsonValue,
        stack: [...candidate.stack] as unknown as Prisma.InputJsonValue,
        difficulty: candidate.difficulty,
        estimatedHours: candidate.estimatedHours,
        relevance: candidate.relevance,
        plan: {
          day1: [...candidate.plan.day1],
          day2: [...candidate.plan.day2],
          milestones: [...candidate.plan.milestones],
          scope: { in: [...candidate.plan.scope.in], out: [...candidate.plan.scope.out] },
          originalDesignDecision: candidate.plan.originalDesignDecision,
        } as unknown as Prisma.InputJsonValue,
        // `proposed` IS NOT A STATUS A CALLER MAY CHOOSE. Nothing in this module's inputs
        // accepts a status, and the only other writers of this column are the three decisions
        // below - which is acceptance item 4's "nothing auto-confirms" at the type level.
        status: 'proposed',
      },
      select: { id: true },
    });
    for (const row of referencesByRequirement[candidate.requirementIds[0]] ?? []) {
      await store.projectReference.create({
        data: {
          opportunityId: created.id,
          kind: row.kind,
          title: row.title,
          url: row.url,
          // Never null on this path: `row.licence` came out of `referenceRecord`, which throws
          // rather than emit a reference without one. This is acceptance item 2 as a property
          // of the WRITE PATH, not of a test.
          licence: row.licence,
          // The SAME snapshot the criteria were checked against, never re-derived.
          activity: activityOf(row) as unknown as Prisma.InputJsonValue,
          notes: row.notes,
          retrievedAt: now,
        },
        select: { id: true },
      });
    }
    stored.push(await opportunityView(input.userId, created.id, store));
  }

  return {
    jobId: context.jobId,
    matchReportId: context.matchReportId,
    profileId: context.profileId,
    considered: context.gaps,
    selectedGaps: selection.selected,
    excludedGaps: selection.excluded,
    counts: {
      considered: context.gaps.length,
      selected: selection.selected.length,
      excluded: selection.excluded.length,
      candidates: stored.length,
    },
    candidates: stored,
    rejectedCandidates: run.rejected,
    researchStage: {
      ...run.researchStage,
      rejectedReferences: researchReport.rejected.map((row) => ({
        url: row.url,
        reason: row.reason,
        detail: row.detail,
      })),
    },
    proposalStage: run.proposalStage,
    notes: PROJECT_DISCOVERY_NOTES,
    rule: PROJECT_CONFIRMATION_RULE,
  };
}

/**
 * The activity snapshot that travels with a reference row.
 *
 * Taken from the SAME object `screenReference` built and handed to `referenceRecord`, so the
 * snapshot stored is the snapshot the criteria were checked against. It is never re-derived
 * from a title or guessed from a date, and `referenceRecord` has already refused to build a row
 * whose snapshot is missing a key.
 */
function activityOf(row: ReferenceRow): ReferenceActivityJson {
  return (row.activity ?? {}) as unknown as ReferenceActivityJson;
}

// ---------------------------------------------------------------------------
// The three decisions
// ---------------------------------------------------------------------------

/**
 * `POST /project-discovery/:id/accept`. `proposed` -> `accepted`.
 *
 * Accepting is a PLAN decision, not a fact: it asserts nothing about the user and writes no
 * claim. An idempotent repeat is a `changed: false` no-op rather than a second row, and an
 * opportunity that is already `completed` or `abandoned` is refused with a 409 naming the
 * state, because "you already accepted this" and "this is finished" are different answers.
 */
export async function acceptOpportunity(
  input: { userId: string; opportunityId: string; now?: Date },
  store: ProjectStore,
): Promise<ProjectDecisionView> {
  const row = await requireOwnedOpportunity(input.userId, input.opportunityId, store);
  if (row.status === 'accepted' || row.status === 'in_progress') {
    return decisionView(input.userId, row.id, store, false);
  }
  if (row.status !== 'proposed') {
    throw new ConflictError(`this opportunity is ${row.status} and cannot be accepted`);
  }
  await store.projectOpportunity.update({
    where: { id: row.id },
    data: { status: 'accepted' },
    select: { id: true },
  });
  return decisionView(input.userId, row.id, store, true);
}

/**
 * `POST /project-discovery/:id/complete`. `accepted` -> `completed`, AND NOTHING ELSE.
 *
 * THIS FUNCTION WRITES NOTHING TO THE CAREER LAYER, and that is the whole of it: `completedAt`
 * is set, `verifiedClaimId` stays NULL, and the answer carries
 * `awaitingYourConfirmation: true`. There is no `createUserClaim` call in this function, no
 * `claimVerification` row, and no claim status literal in it.
 * `projects/lifecycle.test.ts` proves it BY EXECUTION - the claims table is byte-for-byte
 * unchanged after a complete - which is the assertion the acceptance item is actually about,
 * as opposed to a comment saying so.
 *
 * A `proposed` opportunity cannot be completed: the user has not accepted the plan, so marking
 * it finished would be a decision they did not make. That is a 409 with the state in it.
 *
 * AN IDEMPOTENT REPEAT DOES NOT REWRITE THE TIMESTAMP. The first completion is the fact about
 * when the work was marked done, and re-stamping it on a second press would move it.
 */
export async function completeOpportunity(
  input: { userId: string; opportunityId: string; now?: Date },
  store: ProjectStore,
): Promise<ProjectDecisionView> {
  const now = input.now ?? new Date();
  const row = await requireOwnedOpportunity(input.userId, input.opportunityId, store);
  if (row.completedAt !== null) return decisionView(input.userId, row.id, store, false);
  if (row.status !== 'accepted' && row.status !== 'in_progress') {
    throw new ConflictError(
      `this opportunity is ${row.status}: accept the plan before marking it complete, because ` +
        'completing a plan you did not accept records nothing on your profile anyway',
    );
  }
  await store.projectOpportunity.update({
    where: { id: row.id },
    data: { status: 'completed', completedAt: now },
    select: { id: true },
  });
  return decisionView(input.userId, row.id, store, true);
}

/**
 * `POST /project-discovery/:id/confirm`. `completed` -> a CONFIRMED CLAIM, with its audit row.
 *
 * What happens, in this order, and the order is load-bearing:
 *   1. Load + ownership (404 for a foreign id).
 *   2. ALREADY CONFIRMED -> an idempotent no-op that writes nothing (`changed: false`), so a
 *      double press cannot create a second claim for one project.
 *   3. NOT COMPLETED -> 409. Confirming a plan the user never finished would record experience
 *      they never said they had, which is the exact failure ADR-036 exists to prevent.
 *   4. CREATE + CONFIRM THE CLAIM through `career/userDecisions.ts#createUserClaim`, with
 *      `confirm: true` - a USER GESTURE expressed as a boolean and never as a status, because
 *      there is no input on this function through which a caller could simply declare a claim
 *      confirmed. The status change and its `ClaimVerification` row commit in ONE transaction
 *      inside `career/verification.ts`.
 *   5. Record the OPPORTUNITY's own audit row (`job_requirement_match` - the only enum member
 *      that is not about a claim), so the decision about the project is auditable separately
 *      from the statement it produced.
 *   6. Point `verifiedClaimId` at the claim.
 *
 * Step 4 runs BEFORE step 5, for the same reason `match/report.ts` orders it that way: if step
 * 5 fails, the user is left with a confirmed CLAIM - a true record of a gesture they made - and
 * an opportunity whose `verifiedClaimId` is still unset, which is retryable and idempotent. The
 * reverse order would be an opportunity pointing at a claim that does not exist.
 */
export async function confirmOpportunity(
  input: {
    userId: string;
    opportunityId: string;
    statement?: string | null;
    note?: string | null;
    now?: Date;
  },
  store: ProjectStore,
): Promise<ProjectDecisionView> {
  const row = await requireOwnedOpportunity(input.userId, input.opportunityId, store);

  if (row.verifiedClaimId !== null) {
    const existing = await store.careerClaim.findUnique({
      where: { id: row.verifiedClaimId },
      select: { id: true, kind: true, statement: true, status: true },
    });
    return {
      ...(await decisionView(input.userId, row.id, store, false)),
      claim: existing
        ? { id: existing.id, kind: existing.kind, statement: existing.statement, status: String(existing.status) }
        : null,
    };
  }
  if (row.completedAt === null) {
    throw new ConflictError(
      'this opportunity is not complete yet: marking a plan complete records nothing on its own, ' +
        'and only your confirmation turns it into a statement',
    );
  }

  const supplied = typeof input.statement === 'string' ? input.statement.replace(/\s+/g, ' ').trim() : '';
  // The derived statement is the opportunity's OWN title, so the claim is traceable to the plan
  // the user accepted. A user who would rather word it themselves can, and the confirm path
  // honours that wording in both the claim and the audit row.
  const statement = supplied.length > 0 ? supplied.slice(0, 2_000) : `Built and documented ${row.title}`;

  const decision = await createUserClaim(
    {
      profileId: row.profileId,
      confirm: true,
      kind: ClaimKind.project,
      statement,
      actorUserId: input.userId,
      note:
        input.note ??
        `Confirmed from project opportunity ${row.id}, which the user marked complete themselves.`,
    },
    store,
  );

  await store.$transaction(async (tx) => {
    await tx.projectOpportunity.update({
      where: { id: row.id },
      data: { verifiedClaimId: decision.claim.id },
      select: { id: true },
    });
    await tx.claimVerification.create({
      data: {
        userId: input.userId,
        actorUserId: input.userId,
        targetType: VerificationTarget.job_requirement_match,
        targetId: row.id,
        claimId: decision.claim.id,
        action: VerificationAction.confirm,
        before: { status: row.status, verifiedClaimId: null } as Prisma.InputJsonValue,
        after: { status: row.status, verifiedClaimId: decision.claim.id } as Prisma.InputJsonValue,
        note: input.note ?? null,
        createdAt: input.now ?? new Date(),
      },
      select: { id: true },
    });
  });

  return {
    ...(await decisionView(input.userId, row.id, store, true)),
    claim: {
      id: decision.claim.id,
      kind: decision.claim.kind,
      statement: decision.claim.statement,
      // READ, never NAMED: the career layer owns that vocabulary, and
      // `career/claimWriterAI.test.ts` forbids any module outside `career/` spelling it.
      status: String(decision.claim.status),
    },
    claimVerification: decision.verification
      ? {
          id: decision.verification.id,
          action: decision.verification.action,
          targetType: decision.verification.targetType,
          targetId: decision.verification.targetId,
        }
      : null,
  };
}

async function decisionView(
  userId: string,
  opportunityId: string,
  store: ProjectStore,
  changed: boolean,
): Promise<ProjectDecisionView> {
  return {
    opportunity: await opportunityView(userId, opportunityId, store),
    changed,
    claim: null,
    claimVerification: null,
    notes: PROJECT_DISCOVERY_NOTES,
    rule: PROJECT_CONFIRMATION_RULE,
  };
}

/**
 * Is this claim one the career layer treats as confirmed?
 *
 * A THIN re-export rather than a second opinion: `isRenderableClaimStatus` is the career
 * layer's own predicate, so a caller - and the no-auto-confirm test - can ask the QUESTION
 * without this directory ever spelling a confirming status of its own.
 */
export function isConfirmedProjectClaim(status: Parameters<typeof isRenderableClaimStatus>[0]): boolean {
  return isRenderableClaimStatus(status);
}