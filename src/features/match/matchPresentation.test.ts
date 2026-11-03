// Unit tests for the match-presentation helpers (T1070).
//
// Runner: vitest in node environment (`npm test`, root vitest.config.ts; ADR-031 decision 3
// - pure modules only, no jsdom / component tests). `describe`/`it` come from vitest;
// assertions use `node:assert/strict`, matching the frontend's existing style.
//
// What this file pins, and why each cannot be checked anywhere else:
//   1. ICON + TEXT, NEVER COLOUR ALONE. All four levels have a NON-EMPTY label, an icon name
//      and a tone, and the four labels are distinct - so no two states can be told apart by
//      colour alone and no state renders as an empty badge.
//   2. AN UNKNOWN LEVEL FAILS CLOSED. A level this build has never heard of renders as a
//      GAP, never as evidence and never as actionable.
//   3. THE ACTION FOLLOWS THE LEVEL. `contextual`/`potential` get Confirm/Reject; `direct`
//      and `unsupported` never do - which is the client half of "an inference never counts
//      as experience".
//   4. THE EMPTY AND SKIPPED STATES SAY WHAT IS MISSING (06 sec. E.11), including the
//      no-provider wording that tells the user the counts are still exact.
//   5. THE RULE TEXT IS A CONSTANT, pinned verbatim from E.11 flow 7.
//
// The no-score guarantees live in `noScore.test.ts` rather than here, because they are a
// property of the SOURCE rather than of any one function's return value.

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  ACTIONABLE_LEVELS,
  GAP_LEVEL,
  INFERENCE_RULE,
  MATCH_LEVELS,
  NO_SCORE_NOTE,
  UNKNOWN_LEVEL,
  actionFor,
  counterHint,
  hasActionable,
  isEmptyReport,
  levelCounters,
  levelPresentation,
  proposalStageMessage,
} from "./matchPresentation";
import type { MatchCounts, MatchRequirement } from "@/services/api/match";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function counts(overrides: Partial<MatchCounts> = {}): MatchCounts {
  return { direct: 0, contextual: 0, potential: 0, unsupported: 0, total: 0, ...overrides };
}

function requirement(overrides: Partial<MatchRequirement> = {}): MatchRequirement {
  return {
    id: "req-1",
    text: "Kubernetes",
    kind: "required_skill",
    importance: "must",
    normalizedKey: "kubernetes",
    level: "unsupported",
    evidence: [],
    potentialMatch: null,
    action: "none",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Icon + text, never colour alone
// ---------------------------------------------------------------------------

describe("every evidence level is icon + text, never colour alone", () => {
  it("all four levels have a non-empty label, an icon and a tone", () => {
    assert.equal(MATCH_LEVELS.length, 4);
    for (const level of MATCH_LEVELS) {
      const presentation = levelPresentation(level);
      assert.ok(presentation.label.length > 0, `${level} has an empty label`);
      assert.ok(presentation.icon.length > 0, `${level} has no icon`);
      assert.ok(["confirmed", "pending", "gap"].includes(presentation.tone), `${level} tone`);
      assert.ok(presentation.description.length > 10, `${level} needs a real description`);
    }
  });

  it("the four labels are distinct, so no two states look alike", () => {
    const labels = MATCH_LEVELS.map((level) => levelPresentation(level).label);
    assert.equal(new Set(labels).size, labels.length);
  });

  it("direct is the only level with the confirmed tone", () => {
    for (const level of MATCH_LEVELS) {
      const tone = levelPresentation(level).tone;
      if (level === "direct") assert.equal(tone, "confirmed");
      else assert.notEqual(tone, "confirmed", `${level} must not read as confirmed`);
    }
  });

  it("unsupported is labelled as a gap, not as a failure", () => {
    // E.11 counts four buckets and the fourth is the named gaps; calling it "Failed" would
    // read as a verdict, which is what this feature exists to avoid.
    assert.equal(levelPresentation("unsupported").label, "Gap");
    assert.equal(GAP_LEVEL, "unsupported");
  });

  it("the wording of a proposal level says plainly that it is not experience", () => {
    for (const level of ACTIONABLE_LEVELS) {
      const description = levelPresentation(level).description.toLowerCase();
      assert.ok(
        description.includes("confirm") || description.includes("nothing"),
        `${level}: ${description}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Unknown levels fail closed
// ---------------------------------------------------------------------------

describe("an unknown level is treated as a gap, never as evidence", () => {
  it("a level this build has never heard of gets the unknown presentation", () => {
    for (const level of ["invented", "DIRECT", "", "direct_v2", null, undefined, 7]) {
      assert.equal(levelPresentation(level as string).label, UNKNOWN_LEVEL.label, String(level));
      assert.equal(levelPresentation(level as string).tone, "gap", String(level));
    }
  });

  it("a case-mismatched level is unknown, not silently treated as direct", () => {
    // The server spells them lowercase; a capitalised value is a payload this build does not
    // understand, and the safe direction is the gap.
    assert.equal(levelPresentation("DIRECT").tone, "gap");
  });

  it("the unknown presentation is visibly a gap, not a neutral blank", () => {
    assert.equal(UNKNOWN_LEVEL.icon, "help-circle");
    assert.ok(UNKNOWN_LEVEL.description.length > 10);
  });
});

// ---------------------------------------------------------------------------
// 3. The action follows the level
// ---------------------------------------------------------------------------

describe("only a proposal offers Confirm/Reject", () => {
  it("contextual and potential are the actionable levels", () => {
    assert.deepEqual([...ACTIONABLE_LEVELS], ["contextual", "potential"]);
    for (const level of ACTIONABLE_LEVELS) {
      assert.equal(
        actionFor(requirement({ level, action: "confirm_or_reject" })),
        "confirm_or_reject",
      );
    }
  });

  it("direct and a gap never offer the action, whatever the payload's `action` says", () => {
    // A client must not render a Confirm button on a requirement that is already evidenced
    // or already a gap; the guard is on the LEVEL, not on the server's copy of it.
    for (const level of ["direct", "unsupported"] as const) {
      assert.equal(actionFor(requirement({ level, action: "confirm_or_reject" })), "none", level);
    }
  });

  it("a missing `action` falls back to the level rather than to a guess", () => {
    const missing = { ...requirement(), action: undefined } as unknown as MatchRequirement;
    assert.equal(actionFor(missing), "none");
    assert.equal(
      actionFor({ ...requirement(), level: "contextual", action: undefined } as unknown as MatchRequirement),
      "confirm_or_reject",
    );
  });

  it("hasActionable is true only when something is waiting for a decision", () => {
    assert.equal(hasActionable(counts({ contextual: 1 })), true);
    assert.equal(hasActionable(counts({ potential: 1 })), true);
    assert.equal(hasActionable(counts({ direct: 9, unsupported: 4 })), false);
  });
});

// ---------------------------------------------------------------------------
// 4. The counters and the empty states
// ---------------------------------------------------------------------------

describe("the four counters read the server's integers", () => {
  it("they appear in report order with the level's own label", () => {
    const counters = levelCounters(
      counts({ direct: 7, contextual: 3, potential: 2, unsupported: 4, total: 16 }),
    );
    assert.deepEqual(
      counters.map((counter) => counter.level),
      ["direct", "contextual", "potential", "unsupported"],
    );
    assert.deepEqual(
      counters.map((counter) => counter.value),
      [7, 3, 2, 4],
    );
    assert.deepEqual(
      counters.map((counter) => counter.label),
      ["Direct", "Contextual", "Potential", "Gap"],
    );
  });

  it("a zero bucket gets a hint that says what is missing, in the DIRECTION of the level", () => {
    const empty = counts();
    // Zero gaps is good news and the wording says so; zero direct is worth saying out loud.
    assert.match(counterHint(empty, "unsupported") ?? "", /no gaps/i);
    assert.match(counterHint(empty, "direct") ?? "", /no confirmed statement/i);
  });

  it("a non-zero bucket has no hint", () => {
    const full = counts({ direct: 1, contextual: 1, potential: 1, unsupported: 1 });
    for (const level of MATCH_LEVELS) {
      assert.equal(counterHint(full, level), null, level);
    }
  });

  it("an empty report is recognised as empty rather than as a perfect match", () => {
    // A job whose analysis produced no requirements is NOT "everything matched".
    assert.equal(isEmptyReport(counts()), true);
    assert.equal(isEmptyReport(counts({ total: 0, direct: 0 })), true);
    assert.equal(isEmptyReport(counts({ total: 1, unsupported: 1 })), false);
  });
});

// ---------------------------------------------------------------------------
// 5. The proposal stage, in words
// ---------------------------------------------------------------------------

describe("the proposal stage is reported in words, never left ambiguous", () => {
  it("no provider configured says the counts are still exact", () => {
    const message = proposalStageMessage("skipped", "no_ai_provider_configured");
    assert.match(message.headline, /no ai provider configured/i);
    // The sentence that matters: a missing key does not make the deterministic half suspect.
    assert.match(message.detail, /not from a model/i);
    assert.match(message.detail, /settings/i);
  });

  it("a provider that failed says nothing was guessed in its place", () => {
    const message = proposalStageMessage("skipped", "provider_unavailable");
    assert.match(message.detail, /nothing was guessed/i);
  });

  it("nothing to propose distinguishes 'none left' from 'nothing confirmed yet'", () => {
    assert.match(
      proposalStageMessage("skipped", "no_requirements_to_propose").detail,
      /already covered/i,
    );
    assert.match(
      proposalStageMessage("skipped", "no_confirmed_claims").detail,
      /career evidence page/i,
    );
  });

  it("a read says it did not re-run, rather than blaming the configuration", () => {
    const message = proposalStageMessage("skipped", "not_evaluated");
    assert.match(message.detail, /not re-run/i);
    assert.doesNotMatch(message.detail, /no ai provider/i);
  });

  it("an applied stage says each suggestion needs a decision", () => {
    assert.match(proposalStageMessage("applied", "ok").detail, /needs your decision/i);
  });

  it("an unknown reason is shown verbatim rather than swallowed", () => {
    const message = proposalStageMessage("skipped", "something_new");
    assert.match(message.detail, /something_new/);
    assert.match(message.headline, /does not recognise/i);
  });
});

// ---------------------------------------------------------------------------
// 6. The rule, as a constant
// ---------------------------------------------------------------------------

describe("the rule is a constant, pinned verbatim from the spec", () => {
  it("states that an inference is never counted as experience", () => {
    assert.equal(INFERENCE_RULE, "We never count an inference as experience.");
  });

  it("the gaps note says gaps are named, not scored", () => {
    assert.equal(NO_SCORE_NOTE, "Gaps are named, not scored.");
  });
});