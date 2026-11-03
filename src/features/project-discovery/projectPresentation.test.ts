// Presentation tests for the two-day project engine (T1100, 06 sec. E.5 / E.6).
//
// WHY THESE ARE HERE AND NOT IN THE COMPONENTS. This repo runs its frontend suite in a NODE
// environment (`vitest.config.ts`: `environment: 'node'`, `include: ['src/**/*.test.ts']`), so
// there is no DOM, no React Testing Library and no `.test.tsx` - every rule a component follows
// has to live in a `.ts` module to be testable at all. `projectPresentation.ts` is that module:
// the components render what it returns, and this file pins what it returns.
//
// THE FIXTURE DELIBERATELY HAS NO PROPORTIONS. Four named counts, two gaps of different
// importance, a candidate with three technologies and a candidate whose hours exceed the budget.
// If any presentation rule were silently combining those numbers into a figure, a fixture with
// an awkward ratio would show it.
//
// WHAT IS PINNED, and the rule behind each:
//   1. A candidate is a PLAN: five sections, plus the original design decision E.5 requires.
//   2. The hours are a BUDGET: a sentence, never a figure, and out-of-budget reads as a warning.
//   3. EVERY REFUSAL IS NAMED, in words, including the five gap reasons and the five research
//      reasons and the four proposal reasons - an unmapped reason would render as a raw slug.
//   4. NOTHING AUTO-CONFIRMS: after a `complete` the sentence says the profile has NOT changed,
//      which is the acceptance item's UI half.

import { describe, it, expect } from 'vitest';
import {
  NO_VERDICT_NOTE,
  TWO_DAY_BUDGET_HOURS,
  actionHint,
  activityFacts,
  availableActions,
  budgetNote,
  countsRows,
  decisionMessage,
  designDecision,
  exclusionReasonLabel,
  exclusionRows,
  gapFor,
  lifecycleSteps,
  planSections,
  proposalStageMessage,
  referenceNote,
  researchStageMessage,
  stackLine,
  stageRan,
  statusView,
} from "./projectPresentation";
import type {
  ExcludedGap,
  ProjectDecision,
  ProjectDiscoveryCounts,
  ProjectOpportunity,
  ProjectPlan,
  ProjectReference,
  ProjectResearchStage,
  TeachableGap,
} from "@/services/api/projectDiscovery";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN: ProjectPlan = {
  day1: ["Scaffold it and write down what it has to do.", "Run it once, end to end."],
  day2: ["Cover the failure cases.", "Write the README."],
  milestones: ["It runs from a clean checkout.", "The failures are covered.", "It is documented."],
  scope: { in: ["one service", "a README"], out: ["production", "authentication"] },
  originalDesignDecision: "Everything sits behind one small interface so the rest can be tested without it.",
};

function opportunity(overrides: Partial<ProjectOpportunity> = {}): ProjectOpportunity {
  return {
    id: "opp-1",
    profileId: "prof-1",
    jobId: "job-1",
    title: "A two-day kubernetes project",
    idea: "Build one small thing that uses kubernetes end to end.",
    requirementIds: ["req-k8s"],
    stack: ["kubernetes", "typescript"],
    difficulty: "medium",
    estimatedHours: 10,
    relevance: "Closes the named gap.",
    plan: PLAN,
    references: [],
    status: "proposed",
    createdAt: "2026-10-06T09:00:00.000Z",
    completedAt: null,
    verifiedClaimId: null,
    awaitingYourConfirmation: false,
    producedBy: "deterministic",
    ...overrides,
  };
}

const GAPS: TeachableGap[] = [
  {
    requirementId: "req-k8s",
    normalizedKey: "kubernetes",
    text: "Kubernetes",
    kind: "required_skill",
    importance: "must",
    skillTargets: ["kubernetes", "helm"],
  },
  {
    requirementId: "req-kafka",
    normalizedKey: "kafka",
    text: "Kafka",
    kind: "technology",
    importance: "should",
    skillTargets: ["kafka"],
  },
];

function decision(overrides: Partial<ProjectDecision> = {}): ProjectDecision {
  return {
    opportunity: opportunity(),
    changed: true,
    claim: null,
    claimVerification: null,
    notes: "notes",
    rule: "rule",
    ...overrides,
  };
}

/** A reference as the server stored it: a licence and an activity snapshot, always. */
const REFERENCE: ProjectReference = {
  kind: "github_repo",
  title: "queuewright/queuewright",
  url: "https://github.com/queuewright/queuewright",
  licence: "MIT",
  activity: { stars: 120, pushedAt: "2026-06-01T00:00:00.000Z", hasReleases: true },
  notes: "an excerpt",
};

// ---------------------------------------------------------------------------
// 1. A candidate is a plan
// ---------------------------------------------------------------------------

describe("a candidate is rendered as a PLAN, never as a verdict", () => {
  it("has all four of E.5's parts, plus the original design decision", () => {
    expect(planSections(PLAN).map((section) => section.title)).toEqual([
      "Day 1",
      "Day 2",
      "Milestones",
      "In scope",
      "Deliberately not built",
    ]);
    expect(designDecision(PLAN)).toBe(PLAN.originalDesignDecision);
    // "Deliberately not built" is its own section, not folded into scope: it is the line that
    // keeps a weekend a weekend.
    expect(planSections(PLAN)[4].lines).toEqual(["production", "authentication"]);
  });

  it("an empty part is not rendered as an empty heading", () => {
    const sparse: ProjectPlan = { ...PLAN, day2: [], milestones: [], scope: { in: [], out: [] } };
    expect(planSections(sparse).map((section) => section.title)).toEqual(["Day 1"]);
    // ...and a plan whose only empty part is `out` still shows the four that are there.
    const noScope: ProjectPlan = { ...PLAN, scope: { in: ["one service"], out: [] } };
    expect(planSections(noScope).map((section) => section.title)).toEqual([
      "Day 1",
      "Day 2",
      "Milestones",
      "In scope",
    ]);
  });

  it("the hours are a BUDGET sentence, and an over-budget claim reads as a warning", () => {
    expect(budgetNote(10)).toBe(`10 of the ${TWO_DAY_BUDGET_HOURS} hours the two days hold.`);
    expect(budgetNote(TWO_DAY_BUDGET_HOURS)).toContain("16");
    // Out of budget, and the sentence says so rather than hiding it.
    expect(budgetNote(30)).toContain("outside");
    expect(budgetNote(0)).toContain("outside");
    // No percentage, ever: the whole budget is named, and the hours are a count of hours.
    for (const hours of [1, 8, 10, 16, 30]) expect(budgetNote(hours)).not.toMatch(/%/);
  });

  it("names the gap a candidate closes, from the run's own selected gaps", () => {
    expect(gapFor(opportunity(), GAPS)?.text).toBe("Kubernetes");
    expect(gapFor(opportunity({ requirementIds: ["req-kafka"] }), GAPS)?.text).toBe("Kafka");
    // A candidate whose requirement is not in the selected list is shown its own relevance line
    // rather than a wrong gap.
    expect(gapFor(opportunity({ requirementIds: ["req-unknown"] }), GAPS)).toBeNull();
    expect(gapFor(opportunity({ requirementIds: [] }), GAPS)).toBeNull();
    expect(stackLine(opportunity())).toBe("kubernetes, typescript");
  });

  it("the counts are four labelled integers, and nothing is combined", () => {
    const counts: ProjectDiscoveryCounts = { considered: 7, selected: 3, excluded: 4, candidates: 2 };
    const rows = countsRows(counts);
    expect(rows.map((row) => row.label)).toEqual([
      "Named gaps considered",
      "A two-day project could close",
      "No project can close these",
      "Candidates you can accept",
    ]);
    // The values are the server's, in the server's order, and there is no fifth row.
    expect(rows.map((row) => row.value)).toEqual([7, 3, 4, 2]);
    expect(rows.every((row) => Number.isInteger(row.value))).toBe(true);
    // NO VERDICT NOTE is stated under the run, and it says what the numbers are not.
    expect(NO_VERDICT_NOTE).toMatch(/budget/);
    expect(NO_VERDICT_NOTE).toMatch(/nothing counts as your experience until you confirm it/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Every refusal is named
// ---------------------------------------------------------------------------

describe("every refusal is named, in words a user can argue with", () => {
  it("all five gap-exclusion reasons have a sentence", () => {
    const reasons = [
      "non_teachable_kind",
      "hard_credential",
      "location_or_authorisation",
      "degree",
      "optional_when_something_better_exists",
      "no_usable_text",
    ];
    for (const reason of reasons) {
      const label = exclusionReasonLabel(reason);
      expect([reason, label.length > 10, label.includes("_")]).toEqual([reason, true, false]);
    }
    // An unknown reason degrades to a readable slug rather than to nothing.
    expect(exclusionReasonLabel("some_future_reason")).toBe("some future reason");
  });

  it("an exclusion row carries the name, the rule and the server's own detail", () => {
    const excluded: ExcludedGap[] = [
      {
        ...GAPS[0],
        teachable: false,
        reason: "years_experience_shape",
        detail: "the requirement names something a project cannot produce",
      },
    ];
    expect(exclusionRows(excluded)).toEqual([
      {
        text: "Kubernetes",
        label: "years experience shape",
        detail: "the requirement names something a project cannot produce",
        importance: "must",
      },
    ]);
  });

  it("all five research reasons are reported as answers, none as an error", () => {
    const cases: ProjectResearchStage[] = [
      { status: "applied", reason: "ok", searchCount: 1, consideredCount: 3, acceptedCount: 1, rejectedReferences: [] },
      { status: "skipped", reason: "not_requested", searchCount: 0, consideredCount: 0, acceptedCount: 0, rejectedReferences: [] },
      { status: "skipped", reason: "no_search_terms", searchCount: 0, consideredCount: 0, acceptedCount: 0, rejectedReferences: [] },
      { status: "skipped", reason: "research_unavailable", searchCount: 0, consideredCount: 0, acceptedCount: 0, rejectedReferences: [] },
      { status: "skipped", reason: "no_references_passed", searchCount: 1, consideredCount: 4, acceptedCount: 0, rejectedReferences: [] },
    ];
    for (const stage of cases) {
      const message = researchStageMessage(stage);
      expect([stage.reason, message.headline.length > 5, message.detail.length > 30]).toEqual([
        stage.reason,
        true,
        true,
      ]);
      expect(message.detail).not.toMatch(/%/);
    }
    // The no-network sentence says the candidates are unchanged, because they are.
    expect(researchStageMessage(cases[3]).detail).toMatch(/candidates below are unchanged/);
    // The applied sentence says each reference carries its licence.
    expect(researchStageMessage(cases[0]).detail).toMatch(/licence/);
    expect(stageRan(cases[0])).toBe(true);
    expect(stageRan(cases[1])).toBe(false);
  });

  it("all four proposal reasons are reported, and a missing provider is not an error", () => {
    const base = { provider: null, model: null, proposedCount: 0, dropped: [] };
    for (const reason of ["ok", "not_evaluated", "no_ai_provider_configured", "provider_unavailable"]) {
      const message = proposalStageMessage({ status: "applied", reason, ...base });
      expect([reason, message.headline.length > 5, message.detail.length > 30]).toEqual([
        reason,
        true,
        true,
      ]);
    }
    expect(proposalStageMessage({ status: "skipped", reason: "no_ai_provider_configured", ...base }).detail).toMatch(
      /whole feature with no provider at all/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. References: a licence and an activity snapshot, as named facts
// ---------------------------------------------------------------------------

describe("a reference is a licence and facts, never copied text", () => {
  it("shows the licence first, then the activity facts", () => {
    expect(activityFacts(REFERENCE)).toEqual([
      { label: "Licence", value: "MIT" },
      { label: "Last pushed", value: "2026-06-01" },
      { label: "Stars", value: "120" },
      { label: "Releases", value: "yes" },
    ]);
    // A reference with no activity at all still shows its licence: that is the field the
    // acceptance item is about.
    expect(activityFacts({ ...REFERENCE, activity: {} })).toEqual([{ label: "Licence", value: "MIT" }]);
    expect(referenceNote()).toMatch(/Inspiration only/);
    expect(referenceNote()).toMatch(/the project itself has to be yours/);
  });
});

// ---------------------------------------------------------------------------
// 4. Nothing auto-confirms, in the UI either
// ---------------------------------------------------------------------------

describe("the loop, and the sentence after each decision", () => {
  it("the three steps track the opportunity's own fields", () => {
    expect(lifecycleSteps(opportunity()).map((step) => step.state)).toEqual(["current", "todo", "todo"]);
    expect(
      lifecycleSteps(opportunity({ status: "accepted" })).map((step) => step.state),
    ).toEqual(["done", "current", "todo"]);
    expect(
      lifecycleSteps(opportunity({ status: "completed", completedAt: "2026-10-06T10:00:00.000Z" })).map(
        (step) => step.state,
      ),
    ).toEqual(["done", "done", "current"]);
    // Everything done: all three read as done and none is current.
    const finished = opportunity({
      status: "completed",
      completedAt: "2026-10-06T10:00:00.000Z",
      verifiedClaimId: "clm-1",
    });
    expect(lifecycleSteps(finished).map((step) => step.state)).toEqual(["done", "done", "done"]);
  });

  it("MUTATION TARGET: after a complete the sentence says the profile has NOT changed", () => {
    const completed = opportunity({
      status: "completed",
      completedAt: "2026-10-06T10:00:00.000Z",
      awaitingYourConfirmation: true,
    });
    const message = decisionMessage(decision({ opportunity: completed }), "complete");
    expect(message).toMatch(/has NOT changed/);
    expect(message).toMatch(/until you confirm it yourself/);
    // An idempotent repeat says the same thing rather than claiming to have written something.
    const repeat = decisionMessage(decision({ opportunity: completed, changed: false }), "complete");
    expect(repeat).toMatch(/already marked complete/);
    expect(repeat).toMatch(/waiting for your confirmation/);
  });

  it("an accept says nothing about the profile, and a confirm quotes the statement", () => {
    expect(decisionMessage(decision(), "accept")).toMatch(/accepting is a decision about the plan/);
    expect(decisionMessage(decision({ changed: false }), "accept")).toMatch(/already accepted/);
    const confirmed = decisionMessage(
      decision({
        claim: { id: "clm-1", kind: "project", statement: "Built a linter", status: "user_confirmed" },
      }),
      "confirm",
    );
    expect(confirmed).toContain("Built a linter");
    expect(decisionMessage(decision({ changed: false }), "confirm")).toMatch(/already confirmed/);
  });

  it("the three buttons appear only where the loop allows them", () => {
    expect(availableActions(opportunity())).toEqual({
      canAccept: true,
      canComplete: false,
      canConfirm: false,
    });
    expect(availableActions(opportunity({ status: "accepted" }))).toEqual({
      canAccept: false,
      canComplete: true,
      canConfirm: false,
    });
    const completed = opportunity({
      status: "completed",
      completedAt: "2026-10-06T10:00:00.000Z",
      awaitingYourConfirmation: true,
    });
    expect(availableActions(completed)).toEqual({
      canAccept: false,
      canComplete: false,
      canConfirm: true,
    });
    const confirmed = { ...completed, verifiedClaimId: "clm-1", awaitingYourConfirmation: false };
    expect(availableActions(confirmed)).toEqual({
      canAccept: false,
      canComplete: false,
      canConfirm: false,
    });
  });

  it("a disabled button says WHY it is disabled", () => {
    expect(actionHint("confirm", opportunity())).toMatch(/Mark the project complete first/);
    expect(actionHint("complete", opportunity())).toMatch(/Accept the plan first/);
    const completed = opportunity({ status: "completed", completedAt: "2026-10-06T10:00:00.000Z" });
    expect(actionHint("confirm", completed)).toBe("");
    expect(actionHint("accept", completed)).toBe("");
  });

  it("a status this UI does not know is shown verbatim, not guessed at", () => {
    expect(statusView("proposed")).toEqual({ label: "Proposed", tone: "planned" });
    expect(statusView("completed")).toEqual({ label: "Marked complete", tone: "awaiting" });
    expect(statusView("abandoned")).toEqual({ label: "Abandoned", tone: "closed" });
    expect(statusView("some_future_state")).toEqual({ label: "some future state", tone: "planned" });
  });
});