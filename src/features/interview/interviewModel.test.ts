// Unit tests for the pure Career Interview presentation rules (T1021).
//
// Runner: vitest in node environment, pure modules only (`ADR-031` decision 3), matching
// `features/career/claimPresentation.test.ts`. These are the rules a component could not
// hand back to a test runner, which is exactly the set that decides whether the wizard
// behaves honestly:
//
//   1. THE NO-PROVIDER COPY always names the MANUAL PATH. A refusal that does not say what
//      to do instead is an apology, and this stage refuses on a configuration the user can
//      change in Settings - so the copy has to tell them.
//   2. EVERY SERVER REFUSAL RENDERS AS ICON + LABEL + A SENTENCE, and an unrecognised reason
//      renders as `UNKNOWN_DROP` rather than as a blank or an optimistic row. Same
//      fail-closed rule `claimPresentation.ts` applies to an unknown status.
//   3. `invented_entity` NAMES THE ENTITIES. That refusal is a diagnosis, not a wording
//      complaint: "employer Initech" tells the user the model mentioned a company they
//      never did.
//   4. THE WIZARD IS KEYBOARD-COMPLETABLE: `canAdvance` / `canSubmit` are pure, so
//      "a user can finish with the keyboard alone" is a testable claim.
//   5. THE HAND-OFF NEVER CLAIMS THE PROFILE IS READY. Only the user can decide that.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PROVIDER_REQUIRED_COPY,
  UNKNOWN_DROP,
  answerValue,
  answersForStep,
  answersToSubmit,
  canAdvance,
  canSubmit,
  dropPresentation,
  droppedCount,
  handoffSummary,
  hasRefusals,
  inventedEntityDrops,
  isFieldSatisfied,
  refusalHeading,
  stepCompletion,
  stepLabel,
  type WizardAnswer,
} from "./interviewModel";
import type {
  CareerInterviewDrop,
  CareerInterviewResult,
  CareerInterviewStep,
} from "@/services/api/career";

// ---------------------------------------------------------------------------
// Fixtures - the questionnaire shape the server sends
// ---------------------------------------------------------------------------

const STEP: CareerInterviewStep = {
  id: "work",
  title: "What you actually did",
  summary: "The work itself.",
  fields: [
    { id: "achievements", label: "Things you did", hint: "One per line", required: true },
    { id: "responsibilities", label: "Responsibilities", hint: "Optional", required: false },
  ],
};

const STEPS: CareerInterviewStep[] = [
  { id: "roles", title: "Your roles", summary: "s", fields: [{ id: "roles", label: "Roles", hint: "h", required: true }] },
  STEP,
];

function answer(fieldId: string, value: string, stepId = "work"): WizardAnswer {
  return { stepId, fieldId, value };
}

// ---------------------------------------------------------------------------
// 1. The no-provider copy
// ---------------------------------------------------------------------------

describe("the no-provider refusal names the manual path", () => {
  it("has a title and a body, and both are non-empty", () => {
    assert.ok(PROVIDER_REQUIRED_COPY.title.length > 0);
    assert.ok(PROVIDER_REQUIRED_COPY.body.length > 0);
    assert.ok(PROVIDER_REQUIRED_COPY.manualLabel.length > 0);
  });

  it("points at a LIVE route, so the pointer cannot become a dead end", () => {
    // The pointer is the whole usefulness of the refusal, so a route that stops existing
    // must fail here rather than in production. `/app/profile` is the verification list and
    // the hand-entered-claims surface, registered unconditionally in `src/App.tsx`.
    assert.equal(PROVIDER_REQUIRED_COPY.manualPath, "/app/profile");
    const app = readAppSource();
    assert.match(app, /path="\/app\/profile"/);
  });

  it("says we will NOT invent content, which is the promise this feature makes", () => {
    assert.match(PROVIDER_REQUIRED_COPY.body, /will not invent/i);
    // ...and says the manual statements are the same experience, so the pointer is an
    // offer rather than a consolation prize.
    assert.match(PROVIDER_REQUIRED_COPY.body, /unconfirmed/);
  });
});

function readAppSource(): string {
  // `import.meta.dirname` rather than `__dirname`: this module runs under vitest, not under
  // a CJS build, and the repo has been bitten by that difference before.
  const url = new URL("../../App.tsx", import.meta.url);
  return readFileSync(url, "utf8");
}

// ---------------------------------------------------------------------------
// 2. Every refusal renders as icon + label + sentence
// ---------------------------------------------------------------------------

describe("a refused claim is shown, not swallowed", () => {
  const REASONS: CareerInterviewDrop["reason"][] = [
    "unknown_kind",
    "no_statement",
    "statement_too_short",
    "statement_too_long",
    "invalid_confidence",
    "invented_entity",
    "duplicate",
    "too_many_claims",
  ];

  it("every reason the server can report has a label and an icon", () => {
    const labels = new Set<string>();
    for (const reason of REASONS) {
      const presentation = dropPresentation({ reason, detail: "claim[0]: x", invented: [] });
      assert.ok(presentation.label.length > 0, reason);
      assert.ok(presentation.explanation.length > 0, reason);
      assert.ok(presentation.icon.length > 0, reason);
      assert.notEqual(presentation.label, reason, `${reason}: the label is just the raw code`);
      labels.add(presentation.label);
    }
    // Distinct labels: a list where every row says "refused" tells the user nothing about
    // which of their sentences was lost.
    assert.equal(labels.size, REASONS.length);
  });

  it("an UNRECOGNISED reason fails closed rather than rendering as fine", () => {
    // The mirror of `UNKNOWN_STATUS` in the career module. A refusal this build has never
    // heard of must not read as "nothing to see here".
    for (const reason of ["brand_new_reason", "", null, undefined] as unknown as CareerInterviewDrop["reason"][]) {
      const presentation = dropPresentation({ reason, detail: "x", invented: [] } as CareerInterviewDrop);
      assert.equal(presentation.label, UNKNOWN_DROP.label);
      assert.equal(presentation.tone, "refused");
    }
    assert.equal(dropPresentation(null).label, UNKNOWN_DROP.label);
    assert.equal(dropPresentation(undefined).label, UNKNOWN_DROP.label);
  });

  it("a refusal is REFUSED or WARNED, and never anything a kept claim could be", () => {
    // There is no "confirmed"/"fine" tone in this vocabulary at all, which is the strongest
    // form of the rule: a refusal row cannot be mistaken for a claim that was kept.
    for (const reason of REASONS) {
      const presentation = dropPresentation({ reason, detail: "x", invented: [] });
      assert.ok(["refused", "warned"].includes(presentation.tone), reason);
      assert.notEqual(presentation.tone, "confirmed", reason);
    }
  });

  it("invented_entity NAMES the entities, because that refusal is a diagnosis", () => {
    const presentation = dropPresentation({
      reason: "invented_entity",
      detail: "claim[1]: Led the payments migration at Initech",
      invented: ["employer:Initech"],
    });
    assert.match(presentation.explanation, /Initech/);
    // ...and says what to do about it, rather than only what went wrong.
    assert.match(presentation.explanation, /add it to your answer/i);
  });

  it("invented_entity with no named entity still says one was missing", () => {
    const presentation = dropPresentation({
      reason: "invented_entity",
      detail: "claim[0]: x",
      invented: [],
    });
    assert.match(presentation.explanation, /do not mention/i);
  });

  it("the non-invented refusals say the server did not change the sentence either", () => {
    // The reassurance that matters: a refused claim was not quietly rewritten into something
    // weaker, which would be a different fabrication.
    for (const reason of ["unknown_kind", "no_statement", "statement_too_long"] as const) {
      const presentation = dropPresentation({ reason, detail: "x", invented: [] });
      assert.match(presentation.explanation, /did not change it into something else/i);
    }
  });

  it("counts the refusals and isolates the interesting ones", () => {
    const dropped: CareerInterviewDrop[] = [
      { reason: "invented_entity", detail: "a", invented: ["employer:Initech"] },
      { reason: "duplicate", detail: "b", invented: [] },
      { reason: "invented_entity", detail: "c", invented: ["date:2015"] },
    ];
    assert.equal(droppedCount(dropped), 3);
    assert.equal(droppedCount([]), 0);
    assert.equal(droppedCount(null), 0);
    assert.equal(droppedCount(undefined), 0);
    assert.equal(inventedEntityDrops(dropped).length, 2);
    assert.equal(inventedEntityDrops([]).length, 0);
    assert.equal(inventedEntityDrops(null).length, 0);
  });

  it("the panel appears only when there is something in it", () => {
    assert.equal(hasRefusals([{ reason: "duplicate", detail: "b", invented: [] }]), true);
    assert.equal(hasRefusals([]), false);
    assert.equal(hasRefusals(null), false);
    assert.equal(refusalHeading(1), "1 statement was refused");
    assert.equal(refusalHeading(3), "3 statements were refused");
  });
});

// ---------------------------------------------------------------------------
// 3 & 4. The wizard is keyboard-completable
// ---------------------------------------------------------------------------

describe("the wizard's gates are pure functions of the answers", () => {
  it("blocks a step whose REQUIRED field is blank, and names the field", () => {
    const completion = stepCompletion([answer("achievements", "  ")], STEP);
    assert.equal(completion.complete, false);
    // Named in the user's words ("Things you did"), not by field id: a gate that blocks
    // invisibly is a wizard a keyboard user cannot get past.
    assert.deepEqual(completion.missing, ["Things you did"]);
  });

  it("an OPTIONAL blank field never blocks a step", () => {
    const complete = [answer("achievements", "Cut the CI build time by 40%")];
    assert.equal(canAdvance(complete, STEP), true);
    assert.deepEqual(stepCompletion(complete, STEP).missing, []);
    assert.equal(isFieldSatisfied({ required: false }, ""), true);
    assert.equal(isFieldSatisfied({ required: true }, "x"), true);
    assert.equal(isFieldSatisfied({ required: true }, "   "), false);
  });

  it("whitespace is not an answer", () => {
    assert.equal(canAdvance([answer("achievements", "\n\t  ")], STEP), false);
  });

  it("canSubmit needs EVERY step, not just the current one", () => {
    const partial = [answer("roles", "Senior Engineer at Acme", "roles")];
    assert.equal(canSubmit(partial, STEPS), false);
    const full = [
      ...partial,
      answer("achievements", "Cut the CI build time by 40%"),
    ];
    assert.equal(canSubmit(full, STEPS), true);
    // ...and an empty questionnaire is trivially submittable rather than throwing.
    assert.equal(canSubmit([], []), true);
  });

  it("reads an answer by step AND field, so two steps can reuse a field id", () => {
    // The bug this prevents: keying by `fieldId` alone would let step 2's answer overwrite
    // step 1's when they share an id.
    const answers: WizardAnswer[] = [
      answer("roles", "Senior Engineer at Acme", "roles"),
      answer("achievements", "Cut the CI build time by 40%", "work"),
    ];
    assert.equal(answerValue(answers, "roles", "roles"), "Senior Engineer at Acme");
    assert.equal(answerValue(answers, "work", "achievements"), "Cut the CI build time by 40%");
    assert.equal(answerValue(answers, "work", "roles"), "");
    assert.equal(answerValue([], "work", "roles"), "");
  });

  it("maps a step's fields to their values, one key per declared field", () => {
    const values = answersForStep([answer("achievements", "x")], STEP);
    assert.deepEqual(values, { achievements: "x", responsibilities: "" });
    // An untouched step yields a value for EVERY field, so a screen never has to guard.
    assert.deepEqual(Object.keys(answersForStep([], STEP)).sort(), ["achievements", "responsibilities"]);
  });

  it("drops blank answers before POSTing, so an untouched optional field is not an error", () => {
    const submitted = answersToSubmit([
      answer("achievements", "  Cut the CI build time by 40%  "),
      answer("responsibilities", "   "),
    ]);
    assert.deepEqual(submitted, [
      { stepId: "work", fieldId: "achievements", value: "Cut the CI build time by 40%" },
    ]);
    assert.deepEqual(answersToSubmit([]), []);
  });

  it("labels the stepper with the step's TITLE, so the numbers mean something", () => {
    assert.equal(stepLabel(STEPS, 0), "Step 1 of 2: Your roles");
    assert.equal(stepLabel(STEPS, 1), "Step 2 of 2: What you actually did");
    // Out-of-range indexes CLAMP rather than rendering "Step 9 of 2", which is what a
    // stale index during a transition would otherwise produce.
    assert.equal(stepLabel(STEPS, 9), "Step 2 of 2: What you actually did");
    assert.equal(stepLabel(STEPS, -1), "Step 1 of 2: Your roles");
    assert.equal(stepLabel([], 0), "Step 1 of 1");
  });
});

// ---------------------------------------------------------------------------
// 5. The hand-off
// ---------------------------------------------------------------------------

function interviewResult(overrides: Partial<CareerInterviewResult> = {}): CareerInterviewResult {
  return {
    sessionId: "iv1.00000000000000000000000000000000",
    profileId: "profile-1",
    provider: "groq",
    model: "test-model",
    claims: { extracted: 2, accepted: 2, created: 2, deduped: 0, total: 2 },
    counts: { total: 2, unconfirmed: 2, inferred: 2, contextual: 0, user_confirmed: 0, rejected: 0, superseded: 0 },
    unconfirmed: 2,
    statusAssigned: "inferred",
    provenanceAssigned: "llm_inferred",
    inferenceMethod: "career_interview",
    dropped: [],
    nextPath: "/app/profile",
    note: "",
    ...overrides,
  };
}

describe("the finish action hands over, and never claims the profile is ready", () => {
  it("states the created count and the unconfirmed total, and says they are unconfirmed", () => {
    const summary = handoffSummary(interviewResult());
    assert.match(summary, /2 candidate statements added/);
    assert.match(summary, /2 still unconfirmed/);
    assert.match(summary, /Confirm or reject each one/);
    // The line it must NEVER say. Only the user can make a claim usable, and the wizard has
    // no standing to say otherwise.
    assert.doesNotMatch(summary, /ready/i);
    assert.doesNotMatch(summary, /done/i);
  });

  it("singular for one claim", () => {
    const summary = handoffSummary(
      interviewResult({
        claims: { extracted: 1, accepted: 1, created: 1, deduped: 0, total: 1 },
        counts: { total: 1, unconfirmed: 1, inferred: 1, contextual: 0, user_confirmed: 0, rejected: 0, superseded: 0 },
        unconfirmed: 1,
      }),
    );
    assert.match(summary, /1 candidate statement added/);
  });

  it('ZERO new claims is reported as "nothing new", not as a success', () => {
    const summary = handoffSummary(
      interviewResult({
        claims: { extracted: 2, accepted: 2, created: 0, deduped: 2, total: 6 },
        unconfirmed: 5,
      }),
    );
    assert.match(summary, /Nothing new was added/);
    // Still points at the verification list, because there IS something to check there.
    assert.match(summary, /verification list/);
  });

  it("survives a missing result rather than throwing in a render", () => {
    assert.ok(handoffSummary(null).length > 0);
    assert.ok(handoffSummary(undefined).length > 0);
  });
});

// ---------------------------------------------------------------------------
// 6. The route table: the wizard is registered and both retired URLs point at it
// ---------------------------------------------------------------------------

describe("the wizard is the successor of the retired questionnaire URLs", () => {
  const app = readAppSource();

  it("/app/interview is registered UNCONDITIONALLY", () => {
    // Unconditional, because there is no flag state left in which the V2 surfaces may be
    // absent (T1110). A wizard behind a flag would leave the retired URLs pointing at a 404.
    assert.match(app, /path="\/app\/interview" element=\{<CareerInterview \/>\}/);
    assert.equal(app.includes("{flags.v2ResumeStudio ? ("), false);
  });

  it("BOTH /get-started/ai* URLs redirect to the wizard's Rehearsal tab, as REPLACED", () => {
    // The wizard is the Rehearsal tab of Interview after the IA merge, so the canonical
    // target is `/app/interview`; `/app/career` redirects to the Career record tab.
    for (const from of ["/get-started/ai", "/get-started/ai-build"]) {
      const declaration = app.match(
        new RegExp(`path="${from.replace(/\//g, "\\/")}"\\s+element=\\{<Navigate to="([^"]+)" replace \\/>\\}`),
      );
      assert.ok(declaration, `${from} must be declared as a replace-redirect`);
      assert.equal(declaration![1], "/app/interview");
    }
    // `replace`, still: with a push the back button returns to the retired path, which
    // redirects again, and the user cannot leave. Three routes target `/app/interview`: the two
    // retired questionnaire URLs and the old `/app/career-interview` tab URL.
    assert.equal(app.match(/<Navigate to="\/app\/interview" replace \/>/g)?.length, 3);
  });

  it("the redirect target is a live route and the verification list still is too", () => {
    assert.match(app, /path="\/app\/interview" element=\{<CareerInterview \/>\}/);
    assert.match(app, /path="\/app\/profile" element=\{<CareerProfile \/>\}/);
  });
});

