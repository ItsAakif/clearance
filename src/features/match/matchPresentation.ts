// Presentation model for the evidence-level match report (T1070; 06 sec. E.2, E.6, E.11).
//
// WHY A SEPARATE PURE MODULE. Two reasons, both about what a `.ts` unit test can check in a
// node-environment runner (ADR-031 decision 3 - pure modules only, no jsdom):
//   1. EVERY STATUS IS ICON + TEXT, NEVER COLOUR ALONE (06 sec. E.11 "unconfirmed vs
//      confirmed", and the same rule the career feature applies). The mapping lives here as
//      data, so a test can assert that all four levels have a NON-EMPTY label, a distinct
//      tone and an icon - which is the accessibility requirement stated as an assertion
//      rather than trusted to a component's markup.
//   2. THE RULE IS A CONSTANT, NOT A STRING BUILT AT RENDER TIME. "We never count an
//      inference as experience" is the line the whole screen rests on; it is exported so a
//      test can pin the exact wording and a reviewer can grep for it.
//
// AND, LOAD-BEARING: THERE IS NO ARITHMETIC OVER THE COUNTS ANYWHERE IN THIS FILE. E.6 says
// "the UI must not compute one either (guard: no arithmetic over the counts in the client)",
// so the only derived values here are booleans ("is anything actionable") and label text.
// There is no division, no `Math.round`, no percentage. `noScore.test.ts` asserts that by
// walking this file's source.

import type { MatchAction, MatchEvidenceLevel, MatchCounts, MatchRequirement } from "@/services/api/match";

// ---------------------------------------------------------------------------
// The four levels
// ---------------------------------------------------------------------------

/** Visual weight of a level. `pending` is the fail-closed default (see StatusBadge's note). */
export type LevelTone = "confirmed" | "pending" | "gap";

export interface LevelPresentation {
  /** Always non-empty: an empty badge communicates nothing. */
  label: string;
  /** Icon name, resolved to a component by the badge (never rendered as colour alone). */
  icon: "badge-check" | "sparkles" | "help-circle" | "circle-slash";
  tone: LevelTone;
  /** One sentence the UI can show as help text; says what the level MEANS. */
  description: string;
}

/** A level this build has never heard of. Fail-closed: an unknown level looks like a gap. */
export const UNKNOWN_LEVEL: LevelPresentation = {
  label: "Unknown",
  icon: "help-circle",
  tone: "gap",
  description:
    "This build does not recognise the evidence level, so it is shown as a gap rather than as evidence.",
};

const PRESENTATION: Record<MatchEvidenceLevel, LevelPresentation> = {
  direct: {
    label: "Direct",
    icon: "badge-check",
    tone: "confirmed",
    description:
      "A statement you have confirmed says exactly this. Nothing here was inferred.",
  },
  contextual: {
    label: "Contextual",
    icon: "sparkles",
    tone: "pending",
    description:
      "We think your confirmed work implies this, without naming it. Confirm or reject it - until you do, it is not experience.",
  },
  potential: {
    label: "Potential",
    icon: "sparkles",
    tone: "pending",
    description:
      "This is plausible from your profile but nothing you have confirmed says it. Confirm or reject it.",
  },
  unsupported: {
    label: "Gap",
    icon: "circle-slash",
    tone: "gap",
    description: "Nothing in your confirmed evidence covers this.",
  },
};

/**
 * The presentation of a level, tolerating a value the server invented.
 *
 * UNKNOWN LEVELS RENDER AS A GAP, never as evidence: a level this build cannot explain must
 * not appear next to a Confirm button as though it were understood.
 */
export function levelPresentation(level: string | null | undefined): LevelPresentation {
  if (typeof level !== "string") return UNKNOWN_LEVEL;
  const known = PRESENTATION[level as MatchEvidenceLevel];
  return known ?? UNKNOWN_LEVEL;
}

/** The four buckets in report order. Matches the server's `EVIDENCE_LEVELS`. */
export const MATCH_LEVELS: readonly MatchEvidenceLevel[] = [
  "direct",
  "contextual",
  "potential",
  "unsupported",
];

/** The two levels a person can act on. Neither is a fact until they act. */
export const ACTIONABLE_LEVELS: readonly MatchEvidenceLevel[] = ["contextual", "potential"];

// ---------------------------------------------------------------------------
// The counters
// ---------------------------------------------------------------------------

/** `unsupported` is spelled "gap" in the UI: it is a list of names, not a failure. */
export const GAP_LEVEL: MatchEvidenceLevel = "unsupported";

export interface LevelCounter {
  level: MatchEvidenceLevel;
  label: string;
  /** The integer, exactly as the server counted it. Never rescaled. */
  value: number;
  tone: LevelTone;
}

/**
 * The four counters, in report order.
 *
 * A pure READ of the counts: `counts[level]`, nothing else. No sum, no ratio, no
 * "7 of 16". A counter the client derived would be a second, disagreeable opinion about
 * the same facts, and E.6 forbids exactly that.
 */
export function levelCounters(counts: MatchCounts): LevelCounter[] {
  return MATCH_LEVELS.map((level) => ({
    level,
    label: levelPresentation(level).label,
    value: counts[level] ?? 0,
    tone: levelPresentation(level).tone,
  }));
}

/**
 * The wording for a counter with a value of zero.
 *
 * "0" alone reads as a failure in four places on the screen; the empty state says what is
 * missing instead, which is 06 sec. E.11's "empty" row of the state table.
 */
export function counterHint(counts: MatchCounts, level: MatchEvidenceLevel): string | null {
  const value = counts[level] ?? 0;
  if (value > 0) return null;
  switch (level) {
    case "direct":
      return "No confirmed statement says any of these outright yet.";
    case GAP_LEVEL:
      return "No gaps: every requirement is covered by evidence you have confirmed.";
    default:
      // The two proposal levels carry no per-card hint: the proposal-stage message is
      // rendered once, under the four counters, by the page. Repeating it inside both
      // cards was the duplication this avoids.
      return null;
  }
}

// ---------------------------------------------------------------------------
// The requirement rows
// ---------------------------------------------------------------------------

/**
 * What the UI should offer on a row.
 *
 * THE LEVEL DECIDES, NOT THE SERVER'S `action` MEMBER. The two agree for every response this
 * build produces, but when they disagree the LEVEL wins, in both directions:
 *   - a `direct` or `unsupported` requirement gets NO buttons even if `action` says
 *     `confirm_or_reject`, because offering "Confirm this is my experience" on something you
 *     have already confirmed (or on a gap) is the one mistake this screen must not make;
 *   - a `contextual`/`potential` requirement gets the buttons even if `action` is missing,
 *     because an older payload should not silently hide the only control the page offers.
 *
 * So the rule is: actionable iff the level is one of the two PROPOSAL levels. `action` is not
 * consulted at all, which is also why it cannot drift out of step with what is rendered.
 */
export function actionFor(requirement: MatchRequirement): MatchAction {
  return ACTIONABLE_LEVELS.includes(requirement.level) ? "confirm_or_reject" : "none";
}

/** Is there anything on this screen the user can act on? Drives the empty-state wording. */
export function hasActionable(counts: MatchCounts): boolean {
  return (counts.contextual ?? 0) + (counts.potential ?? 0) > 0;
}

/** Is there anything at all to show? A job with no requirements is not "a perfect match". */
export function isEmptyReport(counts: MatchCounts): boolean {
  return (counts.total ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// The proposal stage
// ---------------------------------------------------------------------------

export type ProposalReasonPresentation = { headline: string; detail: string };

/**
 * What the proposal stage did, in words.
 *
 * ADR-041 D5 says a missing key is not a failure and must not be left ambiguous, so
 * `no_ai_provider_configured` gets its own sentence and a route to fix it. `not_evaluated`
 * is the one a READ reports: the endpoint did not ask a provider anything, so the wording
 * says exactly that rather than blaming the user's configuration.
 */
export function proposalStageMessage(
  status: string,
  reason: string,
): ProposalReasonPresentation {
  switch (reason) {
    case "ok":
      return {
        headline: "Suggestions were proposed.",
        detail: `Each one needs your decision before it counts (${status === "applied" ? "proposed" : status}).`,
      };
    case "no_ai_provider_configured":
      return {
        headline: "No AI provider configured, so no suggestions were proposed.",
        detail:
          "Everything above is still exact: the counts and the named gaps come from your confirmed statements, not from a model. Add a key in Settings to get suggestions.",
      };
    case "provider_unavailable":
      return {
        headline: "The AI provider could not be reached, so no suggestions were proposed.",
        detail:
          "Nothing was guessed in its place. The counts and the named gaps below are unaffected.",
      };
    case "no_requirements_to_propose":
      return {
        headline: "Nothing left to suggest.",
        detail: "Every requirement is already covered by a statement you have confirmed.",
      };
    case "no_confirmed_claims":
      return {
        headline: "No confirmed statements to compare against.",
        detail:
          "Suggestions need something confirmed to point at, so we proposed none. Confirm a statement on the Career evidence page first.",
      };
    case "not_evaluated":
      return {
        headline: "Read from storage.",
        detail:
          "This report was not re-run, so it does not say whether a provider is configured. The levels below are current.",
      };
    default:
      return {
        headline: "The suggestion stage reported something this build does not recognise.",
        detail: `Reason: ${reason}. The levels below are unaffected.`,
      };
  }
}

// ---------------------------------------------------------------------------
// The rule (E.11 flow 7)
// ---------------------------------------------------------------------------

/**
 * The footer, verbatim from 06 sec. E.11 flow 7: "A footer states the rule: 'We never count
 * an inference as experience.'" A constant, so no component can paraphrase it.
 */
export const INFERENCE_RULE = "We never count an inference as experience.";

/** The report's own note (E.6), shown next to the named gaps. A constant for the same reason. */
export const NO_SCORE_NOTE = "Gaps are named, not scored.";

/** Importing a count helper that could divide would be caught by `noScore.test.ts`. */
export type { MatchCounts, MatchEvidenceLevel, MatchRequirement };