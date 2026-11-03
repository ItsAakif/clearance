// Two-day project discovery API - the V2 project engine client (T1100, 06 sec. E.5).
//
// House pattern (`services/api/*`): a thin typed wrapper over `apiClient`, transforming wire
// shapes into the frontend's own vocabulary and nothing else. No React, no flags, no
// components - this module is imported by the feature and is testable in isolation.
//
// THE FOUR CALLS, and what each one is allowed to mean:
//   1. `discover(matchReportId | jobId)` -> the gaps it considered, the ones it selected, every
//      refusal, and the candidates it stored. It CREATES rows, so the response carries ids.
//   2. `accept(id)` -> a PLAN decision. It asserts nothing about the user and writes no claim.
//   3. `complete(id)` -> "I finished this". It writes nothing about the user either: the
//      response says so in a field of its own (`awaitingYourConfirmation`).
//   4. `confirm(id)` -> the ONLY call that can put a statement on the profile, and it goes
//      through the server's verification service, which writes the status and its audit row in
//      one transaction (ADR-036 item 3). `statement` is optional and is the user's own wording.
//
// NOTHING HERE SENDS A STATE. There is no member on any of these calls through which a client
// could name a claim status, a provenance, a claim kind or a `verifiedClaimId`: that is why
// this module cannot become a second confirmation path even by accident.
//
// NO SCORE, NO PERCENTAGE, ANYWHERE IN THIS FILE. The only numbers are integer counts over
// named things and the hours a candidate claims, which is a two-day BUDGET rather than a rating
// of the person. `features/project-discovery/noVerdict.test.ts` greps this module and fails if a
// verdict-shaped member is ever added - the ban is a test, not a convention.

import { apiClient } from "./client";

// ---------------------------------------------------------------------------
// Vocabulary (the wire spelling, mirrored not generated - the frontend has no Prisma)
// ---------------------------------------------------------------------------

/** `ProjectStatus` on the wire. */
export type ProjectStatus = "proposed" | "accepted" | "in_progress" | "completed" | "abandoned";

/** `ReferenceKind` on the wire. */
export type ProjectReferenceKind = "github_repo" | "article" | "docs" | "package" | "example_project" | string;

/** One public repository a candidate drew on: kind, licence and an activity snapshot. */
export interface ProjectReference {
  kind: ProjectReferenceKind;
  title: string;
  url: string;
  /** ALWAYS present on a row this server wrote: a no-licence repository is never recorded. */
  licence: string;
  /** `{ stars, forks, openIssues, pushedAt, archived, license, hasReleases, readmeChars, sizeKb }`. */
  activity: Record<string, unknown>;
  /** The stored excerpt, shown as inspiration and never as a template to copy. */
  notes: string | null;
}

/** E.5's plan, with the original design decision the anti-copy guard requires. */
export interface ProjectPlan {
  day1: string[];
  day2: string[];
  milestones: string[];
  scope: { in: string[]; out: string[] };
  originalDesignDecision: string;
}

/** One stored candidate, as the page renders it. */
export interface ProjectOpportunity {
  id: string;
  profileId: string;
  jobId: string | null;
  title: string;
  idea: string;
  /** `JobRequirement.id`s this closes. Never empty. */
  requirementIds: string[];
  stack: string[];
  /** `low` | `medium` | `high`: three named words, never a number. */
  difficulty: "low" | "medium" | "high" | string;
  /** The two-day BUDGET the candidate claims. Always between 1 and 16. */
  estimatedHours: number;
  relevance: string;
  plan: ProjectPlan;
  references: ProjectReference[];
  status: ProjectStatus | string;
  createdAt: string;
  completedAt: string | null;
  /** `null` until the user confirms. Nothing else in the system writes it. */
  verifiedClaimId: string | null;
  /** True while a completion is waiting for the user's confirmation. */
  awaitingYourConfirmation: boolean;
  producedBy: "deterministic" | "provider" | string;
}

/** A named gap the matcher reported, before any selection. */
export interface ProjectGap {
  requirementId: string;
  normalizedKey: string;
  text: string;
  kind: string;
  importance: string;
}

/** A gap this run WILL build a candidate for. */
export interface TeachableGap extends ProjectGap {
  /** The technologies the gap names, capped. Never empty. */
  skillTargets: string[];
}

/** A gap this run will NOT, with the rule that refused it. */
export interface ExcludedGap extends ProjectGap {
  teachable: boolean;
  /** `non_teachable_kind` | `hard_credential` | `location_or_authorisation` | `degree` | ... */
  reason: string;
  detail: string;
}

/** What the OPTIONAL public-research stage did. Reported either way (ADR-041 D5). */
export interface ProjectResearchStage {
  status: "applied" | "skipped";
  /** `ok` | `not_requested` | `no_search_terms` | `research_unavailable` | `no_references_passed` */
  reason: string;
  searchCount: number;
  consideredCount: number;
  acceptedCount: number;
  /** Every refusal, with the criterion that fired. Never silently discarded. */
  rejectedReferences: Array<{ url: string; reason: string; detail: string }>;
}

/** What the OPTIONAL provider stage did. Reported either way. */
export interface ProjectProposalStage {
  status: "applied" | "skipped";
  /** `ok` | `not_evaluated` | `no_ai_provider_configured` | `provider_unavailable` */
  reason: string;
  provider: string | null;
  model: string | null;
  proposedCount: number;
  dropped: Array<{ reason: string; detail: string }>;
}

/**
 * The run's own report.
 *
 * FOUR INTEGERS over named things, and no derived field. There is no `score`, no `percentage`
 * and no `ratio`, and nothing here may be combined into one - `features/project-discovery/
 * noVerdict.test.ts` fails if a member that reads as a verdict is added.
 */
export interface ProjectDiscoveryCounts {
  considered: number;
  selected: number;
  excluded: number;
  candidates: number;
}

/** `POST /project-discovery`. */
export interface ProjectDiscovery {
  jobId: string | null;
  matchReportId: string | null;
  profileId: string;
  considered: ProjectGap[];
  selectedGaps: TeachableGap[];
  excludedGaps: ExcludedGap[];
  counts: ProjectDiscoveryCounts;
  candidates: ProjectOpportunity[];
  rejectedCandidates: Array<{ reason: string; detail: string }>;
  researchStage: ProjectResearchStage;
  proposalStage: ProjectProposalStage;
  /** The rule the server states, rendered verbatim under the run. */
  notes: string;
  /** The confirmation rule, rendered verbatim under the lifecycle. */
  rule: string;
}

/** The audit row both decisions return. `before`/`after` are server-side only. */
export interface ProjectClaimVerification {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
}

/** What accept, complete and confirm return. */
export interface ProjectDecision {
  opportunity: ProjectOpportunity;
  /** `false` for an idempotent repeat, which then wrote nothing. */
  changed: boolean;
  /** The claim `confirm` created. `null` on accept and complete, and on a repeat confirm. */
  claim: { id: string; kind: string; statement: string; status: string } | null;
  /** The `career_claim` audit row the verification service wrote (confirm only). */
  claimVerification: ProjectClaimVerification | null;
  notes: string;
  rule: string;
}

/** `POST /project-discovery`, narrowed to what this page sends. */
export interface ProjectDiscoveryInput {
  matchReportId?: string;
  jobId?: string;
  /** `false` skips the OPTIONAL public research; the response then says `not_requested`. */
  research?: boolean;
  /** `false` runs the deterministic-only path; the response then says `not_evaluated`. */
  runProvider?: boolean;
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

export const projectDiscoveryApi = {
  /**
   * Turn a job's NAMED GAPS into two-day project candidates.
   *
   * Both optional stages are ON by default, and both report their own outcome in the response:
   * with no network the research stage says `research_unavailable` and the candidates are still
   * there, because the engine's core is deterministic. Passing `research: false` or
   * `runProvider: false` is how a caller asks for the deterministic-only path explicitly.
   *
   * Exactly one of `matchReportId` and `jobId` is required; naming neither is a 400.
   */
  async discover(input: ProjectDiscoveryInput): Promise<ProjectDiscovery> {
    return apiClient.post<ProjectDiscovery>("/project-discovery", input);
  },

  /**
   * Accept a PLAN. This asserts nothing about the user and writes no claim: it records that
   * they chose to build this one.
   */
  async accept(opportunityId: string): Promise<ProjectDecision> {
    return apiClient.post<ProjectDecision>(
      `/project-discovery/${encodeURIComponent(opportunityId)}/accept`,
      {},
    );
  },

  /**
   * Mark the work as finished.
   *
   * It writes NOTHING to the profile - not even with this call's permission, because the body is
   * empty. Read `decision.opportunity.awaitingYourConfirmation` to show the next step rather than
   * inferring it from a missing claim.
   */
  async complete(opportunityId: string): Promise<ProjectDecision> {
    return apiClient.post<ProjectDecision>(
      `/project-discovery/${encodeURIComponent(opportunityId)}/complete`,
      {},
    );
  },

  /**
   * Confirm the finished project, which is the only thing that puts a statement on the profile.
   *
   * `statement` is optional and overrides the derived wording, so the claim can be asserted in
   * the user's own words. The server creates it unconfirmed and then runs its verification
   * service, writing the status change and its audit row in one request.
   */
  async confirm(
    opportunityId: string,
    input: { statement?: string; note?: string } = {},
  ): Promise<ProjectDecision> {
    return apiClient.post<ProjectDecision>(
      `/project-discovery/${encodeURIComponent(opportunityId)}/confirm`,
      input,
    );
  },
};