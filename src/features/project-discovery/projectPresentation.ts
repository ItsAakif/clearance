// Presentation for the two-day project engine (T1100, 06 sec. E.5 / E.11).
//
// WHY A MODULE AND NOT JSX. Everything the page renders about a CANDIDATE, a GAP, a REFERENCE
// or a LIFECYCLE STATE is derived here, as a pure function of the wire types, so each rule is
// assertable without a DOM. This repo has no jsdom (`vitest.config.ts` pins `environment:
// 'node'`), so a rule that lives in JSX is a rule nothing can test; a rule that lives here is a
// rule a fixture can pin. The components render what these functions return.
//
// WHAT THE RULES ARE, and what each one is refusing to do:
//
//   1. A CANDIDATE IS A PLAN, NEVER A VERDICT. `planSections` renders the four parts E.5 names
//      and the original design decision the anti-copy guard requires. No candidate is described
//      by how well it fits anything: `difficulty` is three named words and `estimatedHours` is
//      the two-day BUDGET, which is why `budgetNote` compares against 16 rather than producing a
//      figure.
//   2. EVERY REFUSAL IS NAMED. `exclusionReasonLabel` and `researchStageMessage` render a
//      machine-readable reason as a sentence a user can act on, because "nothing here" and "we
//      refused this and here is why" are different answers and only the second one is true.
//   3. THE OPTIONAL STAGES ARE REPORTED, NOT HIDDEN. With no network the research stage says so;
//      with no provider the proposal stage says so. `stageMessage` turns each of the five
//      research reasons and four proposal reasons into one sentence, and never into an error.
//   4. NOTHING AUTO-CONFIRMS, IN THE UI EITHER. `decisionMessage` is the ONLY place that says
//      what a decision did, and after a `complete` it says the profile has not changed - which is
//      what `opportunity.awaitingYourConfirmation` exists to make impossible to miss.
//
// NO ARITHMETIC OVER ANY COUNT. `countsRows` reads `counts[label]` and nothing else, and there
// is no percentage, no ratio and no total figure anywhere in this file. `noVerdict.test.ts`
// pins that with a fixture whose numbers are deliberately not in proportion to anything.

import type {
  ExcludedGap,
  ProjectDecision,
  ProjectDiscoveryCounts,
  ProjectGap,
  ProjectOpportunity,
  ProjectPlan,
  ProjectProposalStage,
  ProjectReference,
  ProjectResearchStage,
  TeachableGap,
} from "@/services/api/projectDiscovery";

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/** Two eight-hour days. The DEFINITION of a two-day project, not a preference. */
export const TWO_DAY_BUDGET_HOURS = 16;

/** Stated under every candidate, so the hours are read as a budget and not as a rating. */
export const NO_VERDICT_NOTE =
  "Hours are the two-day budget, not a rating. Nothing here is scored, and nothing counts as your experience until you confirm it.";

/** What the server says about candidates, rendered verbatim rather than paraphrased. */
export const CANDIDATE_NOTE =
  "A candidate is a plan you can accept, finish and confirm yourself. Nothing here is added to your profile before that.";

// ---------------------------------------------------------------------------
// Lifecycle state
// ---------------------------------------------------------------------------

export type LifecycleTone = "planned" | "active" | "awaiting" | "done" | "closed";

/** Every `ProjectStatus` the schema declares, as a label and a tone. */
const STATUS: Readonly<Record<string, { label: string; tone: LifecycleTone }>> = Object.freeze({
  proposed: { label: "Proposed", tone: "planned" },
  accepted: { label: "Accepted", tone: "active" },
  in_progress: { label: "In progress", tone: "active" },
  completed: { label: "Marked complete", tone: "awaiting" },
  abandoned: { label: "Abandoned", tone: "closed" },
});

/** An unknown status is shown verbatim rather than as a guess. */
export function statusView(status: string): { label: string; tone: LifecycleTone } {
  const known = STATUS[status];
  return known ?? { label: String(status ?? "").replace(/_/g, " "), tone: "planned" };
}

/** The three steps of the loop, and where this candidate is on them. */
export function lifecycleSteps(opportunity: ProjectOpportunity): Array<{
  label: string;
  state: "done" | "current" | "todo";
}> {
  const confirmed = opportunity.verifiedClaimId !== null;
  const completed = opportunity.completedAt !== null;
  const accepted = opportunity.status === "accepted" || opportunity.status === "in_progress";
  const steps: Array<{ label: string; state: "done" | "current" | "todo" }> = [
    { label: "Accept the plan", state: "todo" },
    { label: "Finish the project", state: "todo" },
    { label: "Confirm it yourself", state: "todo" },
  ];
  if (accepted || completed) steps[0] = { ...steps[0], state: "done" };
  if (completed) steps[1] = { ...steps[1], state: "done" };
  if (confirmed) steps[2] = { ...steps[2], state: "done" };
  const current = steps.findIndex((step) => step.state === "todo");
  if (current >= 0) steps[current] = { ...steps[current], state: "current" };
  // Everything done: every step reads as done and none is current.
  return steps;
}

/** The four integer counts, as four labelled rows. A count per named thing, never a verdict. */
export function countsRows(counts: ProjectDiscoveryCounts): Array<{ label: string; value: number }> {
  return [
    { label: "Named gaps considered", value: counts.considered },
    { label: "A two-day project could close", value: counts.selected },
    { label: "No project can close these", value: counts.excluded },
    { label: "Candidates you can accept", value: counts.candidates },
  ];
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlanSection {
  title: string;
  lines: string[];
}

/**
 * E.5's four plan parts, in the order the two days happen.
 *
 * `scope.out` is rendered as its own section and NOT as padding: it is the line that keeps a
 * weekend a weekend, and hiding it behind "in scope" would remove the only part of the plan that
 * says what the candidate deliberately does not build.
 */
export function planSections(plan: ProjectPlan): PlanSection[] {
  return [
    { title: "Day 1", lines: plan.day1 },
    { title: "Day 2", lines: plan.day2 },
    { title: "Milestones", lines: plan.milestones },
    { title: "In scope", lines: plan.scope.in },
    { title: "Deliberately not built", lines: plan.scope.out },
  ].filter((section) => section.lines.length > 0);
}

/** E.5's output requirement, as its own row: the plan must name an ORIGINAL decision. */
export function designDecision(plan: ProjectPlan): string {
  return plan.originalDesignDecision;
}

/** The two-day budget, as a sentence. Never a comparison that produces a figure. */
export function budgetNote(hours: number): string {
  const withinBudget = hours >= 1 && hours <= TWO_DAY_BUDGET_HOURS;
  return withinBudget
    ? `${hours} of the ${TWO_DAY_BUDGET_HOURS} hours the two days hold.`
    : `${hours} hours, which is outside the ${TWO_DAY_BUDGET_HOURS}-hour two-day budget.`;
}

/** The named gap a candidate closes, looked up from the run's selected gaps. */
export function gapFor(candidate: ProjectOpportunity, selected: TeachableGap[]): ProjectGap | null {
  const first = candidate.requirementIds[0];
  if (first === undefined) return null;
  return selected.find((gap) => gap.requirementId === first) ?? null;
}

/** "Kubernetes, Helm" - the candidate's own stack, joined for one line. */
export function stackLine(candidate: ProjectOpportunity): string {
  return candidate.stack.join(", ");
}

// ---------------------------------------------------------------------------
// Refusals, named
// ---------------------------------------------------------------------------

/** Why a gap is not offered as a project, in words a user can argue with. */
const EXCLUSION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  non_teachable_kind: "No project can produce this",
  hard_credential: "It asks for a credential, not a capability",
  location_or_authorisation: "It asks about where you are, not what you can do",
  degree: "It asks for a qualification, not a capability",
  optional_when_something_better_exists:
    "Optional, and something more important from the same job is open",
  no_usable_text: "The requirement has no usable text to target",
});

export function exclusionReasonLabel(reason: string): string {
  return EXCLUSION_LABEL[reason] ?? reason.replace(/_/g, " ");
}

/** One refusal row, as the UI renders it: the name, then the rule, then why. */
export interface ExclusionRow {
  text: string;
  label: string;
  detail: string;
  importance: string;
}

export function exclusionRows(excluded: ExcludedGap[]): ExclusionRow[] {
  return excluded.map((gap) => ({
    text: gap.text,
    label: exclusionReasonLabel(gap.reason),
    detail: gap.detail,
    importance: gap.importance,
  }));
}

// ---------------------------------------------------------------------------
// The two optional stages
// ---------------------------------------------------------------------------

export interface StageMessage {
  headline: string;
  detail: string;
}

/**
 * The research stage, as one sentence pair.
 *
 * EVERY reason is a real answer, so none of them is an error state: `not_requested` means the
 * caller declined, `research_unavailable` means there was no network or the provider refused,
 * `no_references_passed` means the provider answered and every repository failed a criterion
 * (with the refusals attached), and `ok` means at least one reference is recorded with its
 * licence.
 */
export function researchStageMessage(stage: ProjectResearchStage): StageMessage {
  const { reason, acceptedCount, consideredCount } = stage;
  if (reason === "ok") {
    return {
      headline: "Public references consulted",
      detail: `${acceptedCount} repository${acceptedCount === 1 ? "" : " repositories"} of ${consideredCount} consulted passed every check. Each one is recorded with its licence and when it was last touched, as inspiration only.`,
    };
  }
  if (reason === "not_requested") {
    return {
      headline: "No public research was requested",
      detail: "The candidates below were produced without looking anything up, and no repository is listed.",
    };
  }
  if (reason === "no_search_terms") {
    return {
      headline: "There was nothing to look up",
      detail: "The selected gaps named no technology to search for, so no repository was consulted.",
    };
  }
  if (reason === "research_unavailable") {
    return {
      headline: "Public research could not run",
      detail:
        "There was no network, or the provider refused. Nothing was learned about any repository, so none is listed - and the candidates below are unchanged, because they do not depend on it.",
    };
  }
  return {
    headline: "No repository passed the checks",
    detail: `${consideredCount} were consulted and every one was refused - most often for having no licence. The refusals are listed under the run.`,
  };
}

/** The provider stage, as one sentence pair. A missing key is not an error (ADR-041 D5). */
export function proposalStageMessage(stage: ProjectProposalStage): StageMessage {
  const { reason, proposedCount, dropped } = stage;
  if (reason === "ok") {
    return {
      headline: "Extra candidates proposed",
      detail: `${proposedCount} proposed, ${dropped.length} refused by the same checks a hand-written plan has to pass.`,
    };
  }
  if (reason === "not_evaluated") {
    return {
      headline: "Deterministic candidates only",
      detail: "No AI provider was asked. Every candidate below is composed from the gaps you already have.",
    };
  }
  if (reason === "no_ai_provider_configured") {
    return {
      headline: "No AI provider configured",
      detail:
        "Nothing was asked of a model. The candidates below are the deterministic ones, which is the whole feature with no provider at all.",
    };
  }
  return {
    headline: "The provider could not answer",
    detail:
      "No extra candidates were proposed, and nothing was written about you either way. The deterministic candidates below are unchanged.",
  };
}

/** Whether a stage ran at all, so the UI can place the message without a second condition. */
export function stageRan(stage: { status: string }): boolean {
  return stage.status === "applied";
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * One reference's activity facts, as NAMED rows.
 *
 * These are facts about a public repository - its licence, when it was last pushed, how many
 * stars it has - and they are what makes the reference auditable afterwards: a reader who sees a
 * repository named under a candidate can ask "under what licence, and when was it last touched?"
 * and get an answer from here. Nothing here is a judgement of the repository.
 */
export function activityFacts(reference: ProjectReference): Array<{ label: string; value: string }> {
  const activity = reference.activity ?? {};
  const facts: Array<{ label: string; value: string }> = [
    { label: "Licence", value: reference.licence },
  ];
  const pushedAt = typeof activity.pushedAt === "string" ? activity.pushedAt : null;
  if (pushedAt !== null) facts.push({ label: "Last pushed", value: pushedAt.slice(0, 10) });
  if (typeof activity.stars === "number") facts.push({ label: "Stars", value: String(activity.stars) });
  if (activity.hasReleases === true) facts.push({ label: "Releases", value: "yes" });
  return facts;
}

/** The line above the list: what a reference IS, so it is never read as a template. */
export function referenceNote(): string {
  return "Inspiration only. Each repository is recorded with its licence; the project itself has to be yours.";
}

// ---------------------------------------------------------------------------
// What a decision did
// ---------------------------------------------------------------------------

export type DecisionAction = "accept" | "complete" | "confirm";

/**
 * What one decision actually did, in one sentence.
 *
 * AFTER A `complete` THIS IS THE IMPORTANT ONE: it says the profile has not changed, because
 * that is the promise E.5 makes and the one a user has to be able to check. It is driven by the
 * SERVER's own fields rather than by which button was pressed - `changed` says whether anything
 * was written, and `claim` says whether a statement exists.
 */
export function decisionMessage(decision: ProjectDecision, action: DecisionAction): string {
  const title = decision.opportunity.title;
  if (action === "accept") {
    return decision.changed
      ? `"${title}" is accepted. Nothing has been added to your profile: accepting is a decision about the plan.`
      : `"${title}" was already accepted.`;
  }
  if (action === "complete") {
    if (!decision.changed) {
      return decision.opportunity.awaitingYourConfirmation
        ? `"${title}" was already marked complete, and it is still waiting for your confirmation.`
        : `"${title}" was already marked complete.`;
    }
    return decision.opportunity.awaitingYourConfirmation
      ? `You marked "${title}" complete. Your profile has NOT changed: nothing is recorded until you confirm it yourself.`
      : `You marked "${title}" complete.`;
  }
  if (!decision.claim) {
    return decision.changed
      ? `"${title}" is confirmed, but the server returned no statement to show.`
      : `"${title}" was already confirmed.`;
  }
  return decision.changed
    ? `Recorded as your own statement: "${decision.claim.statement}".`
    : `"${title}" was already confirmed as: "${decision.claim.statement}".`;
}

/** Which buttons a candidate offers, and why the others are not there. */
export function availableActions(opportunity: ProjectOpportunity): {
  canAccept: boolean;
  canComplete: boolean;
  canConfirm: boolean;
} {
  const confirmed = opportunity.verifiedClaimId !== null;
  const completed = opportunity.completedAt !== null;
  const accepted = opportunity.status === "accepted" || opportunity.status === "in_progress";
  return {
    canAccept: !accepted && !completed && !confirmed,
    canComplete: accepted && !completed,
    canConfirm: completed && !confirmed,
  };
}

/** Why an action is unavailable, for the disabled button's explanation. */
export function actionHint(action: DecisionAction, opportunity: ProjectOpportunity): string {
  if (action === "accept" && opportunity.status === "proposed") return "";
  if (action === "complete") {
    return opportunity.status === "proposed"
      ? "Accept the plan first: completing a plan you did not accept records nothing either way."
      : "";
  }
  if (action === "confirm") {
    return opportunity.completedAt === null
      ? "Mark the project complete first. Only your confirmation turns a finished project into a statement."
      : "";
  }
  return "";
}