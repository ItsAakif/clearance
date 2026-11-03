// Presentation model for the derived interview risks (T1090; 06 sec. E.4, E.6, E.11 flow 8).
//
// WHY A SEPARATE PURE MODULE. The same two reasons `features/match/matchPresentation.ts`
// gives, and both still hold in a node-environment runner (ADR-031 decision 3 - pure modules
// only, no jsdom):
//   1. EVERY RISK AND EVERY SEVERITY IS ICON + TEXT, NEVER COLOUR ALONE (06 sec. E.11). Here it
//      is load-bearing in a second way: `high` is not "worse styling", it is "an interviewer may
//      catch you out on this", and a colour-blind user has to be able to read that difference.
//      The mapping is data here, so a test asserts every kind has a non-empty label, a
//      description and an icon - the accessibility requirement as an assertion rather than as a
//      promise about markup.
//   2. THE RULES ARE CONSTANTS, NOT STRINGS BUILT AT RENDER TIME. "Risks are derived" and
//      "an answer is stored only when every entity in it is grounded" are the two sentences
//      this screen rests on; they arrive from the server so no client can weaken them, and the
//      fallbacks for a missing payload are pinned here.
//
// AND, LOAD-BEARING: THERE IS NO ARITHMETIC OVER THE COUNTS IN THIS FILE. E.6 says the client
// must not compute a single derived number, so the only derived values are label text and
// booleans. There is no division, no `Math.round`, no percentage, and
// `noVerdict.test.ts` asserts that by walking this file's source.
//
// THE TWO RULES THIS SCREEN EXISTS TO ENFORCE, STATED PLAINLY:
//   - Every risk names the ROWS it was read from, and this module refuses to render a risk
//     whose anchors are empty rather than showing an unattributable warning box.
//   - A question with no model answer says WHY there is no model answer. Silence would read as
//     "nothing to say", which is not what happened.

import type {
  InterviewAnswerStage,
  InterviewAnchor,
  InterviewQuestionCategory,
  InterviewRiskKind,
  InterviewSeverity,
} from "@/services/api/interview";

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * Visual weight of a severity.
 *
 * `high` is the only one with a warm tone, and it is `high` because an interviewer WILL probe
 * it - not because the user did something wrong. `low` is neutral, never green: a thin piece of
 * evidence is not an achievement.
 */
export type SeverityTone = "urgent" | "attention" | "neutral";

export interface SeverityPresentation {
  /** Always non-empty: an empty badge communicates nothing. */
  label: string;
  icon: "triangle-alert" | "circle-alert" | "info";
  tone: SeverityTone;
  /** One sentence saying what this severity MEANS for the interview, not for the resume. */
  description: string;
}

const SEVERITY: Record<InterviewSeverity, SeverityPresentation> = {
  high: {
    label: "High",
    icon: "triangle-alert",
    tone: "urgent",
    description: "An interviewer is likely to probe this, and the honest answer is not ready yet.",
  },
  medium: {
    label: "Medium",
    icon: "circle-alert",
    tone: "attention",
    description: "Worth preparing. Expect a follow-up rather than an opening question.",
  },
  low: {
    label: "Low",
    icon: "info",
    tone: "neutral",
    description: "Worth knowing, unlikely to be asked first.",
  },
};

/** A severity this build has never heard of. Fail-closed: it reads as `high`. */
export const UNKNOWN_SEVERITY: SeverityPresentation = {
  label: "Unknown",
  icon: "triangle-alert",
  tone: "urgent",
  description:
    "This build does not recognise the severity, so it is shown as high rather than quietly downgraded.",
};

export function severityPresentation(severity: string | null | undefined): SeverityPresentation {
  if (typeof severity !== "string") return UNKNOWN_SEVERITY;
  return SEVERITY[severity as InterviewSeverity] ?? UNKNOWN_SEVERITY;
}

/** Worst-first, which is the order the server already sends and the order this screen reads. */
export const SEVERITY_ORDER: readonly InterviewSeverity[] = ["high", "medium", "low"];

// ---------------------------------------------------------------------------
// Risk kinds
// ---------------------------------------------------------------------------

export interface RiskKindPresentation {
  label: string;
  icon:
    | "file-plus"
    | "triangle-alert"
    | "sparkles"
    | "pencil-line"
    | "circle-slash"
    | "trending-up"
    | "file-question";
  /** One sentence saying what this kind MEANS and where it was read from. */
  description: string;
}

const KIND: Record<InterviewRiskKind, RiskKindPresentation> = {
  new_claim: {
    label: "New statement",
    icon: "file-plus",
    description:
      "A statement on your resume was confirmed recently, or has no document behind it. Expect to be asked where it came from.",
  },
  emphasized_tech: {
    label: "Emphasised on the summary",
    icon: "sparkles",
    description:
      "A technology sits on your first screen and carries more than one must-have requirement. Expect to go deeper than the line allows.",
  },
  inferred_claim: {
    label: "Wording you have not confirmed",
    icon: "triangle-alert",
    description:
      "Something on your resume says more than the statements you confirmed. This is a detection of a leak, not an accusation.",
  },
  rewritten_bullet: {
    label: "Reworded bullet",
    icon: "pencil-line",
    description:
      "A line was reworded while keeping every fact. Expect a follow-up on the original achievement behind it.",
  },
  gap: {
    label: "Named gap",
    icon: "circle-slash",
    description:
      "This job asks for something your confirmed evidence does not cover. The honest answer is what you have not done.",
  },
  overclaim: {
    label: "Figure went up",
    icon: "trending-up",
    description:
      "A number on your resume is larger than the number it replaced. Expect to be asked how it was measured.",
  },
  thin_evidence: {
    label: "Thin evidence",
    icon: "file-question",
    description:
      "This statement is confirmed, but nothing behind it corroborates it. Expect to be asked where it comes from.",
  },
};

/**
 * The presentation of a risk kind, tolerating a value the server invented.
 *
 * AN UNKNOWN KIND RENDERS AS THE LEAKAGE KIND, never as something reassuring. The kinds this
 * build cannot explain are exactly the ones a future server might add, and a new kind is far
 * more likely to be a new way of saying "this says something you have not confirmed" than
 * anything benign - so the fail-closed direction is the alarming label.
 */
export const UNKNOWN_RISK_KIND: RiskKindPresentation = KIND.inferred_claim;

export function riskKindPresentation(kind: string | null | undefined): RiskKindPresentation {
  if (typeof kind !== "string") return UNKNOWN_RISK_KIND;
  return KIND[kind as InterviewRiskKind] ?? UNKNOWN_RISK_KIND;
}

/** Every kind the server can emit, in the schema's order. Drives the counter row. */
export const INTERVIEW_RISK_KINDS: readonly InterviewRiskKind[] = [
  "new_claim",
  "emphasized_tech",
  "inferred_claim",
  "rewritten_bullet",
  "gap",
  "overclaim",
  "thin_evidence",
];

/** The four question categories, in the schema's order. */
export const INTERVIEW_QUESTION_CATEGORIES: readonly InterviewQuestionCategory[] = [
  "behavioral",
  "technical",
  "situational",
  "general",
];

const CATEGORY_LABEL: Record<InterviewQuestionCategory, string> = {
  behavioral: "Past behaviour",
  technical: "Technical depth",
  situational: "Hypothetical",
  general: "About you",
};

export function categoryLabel(category: string | null | undefined): string {
  if (typeof category !== "string") return CATEGORY_LABEL.general;
  return CATEGORY_LABEL[category as InterviewQuestionCategory] ?? CATEGORY_LABEL.general;
}

// ---------------------------------------------------------------------------
// The anchors - the audit trail a reader can follow
// ---------------------------------------------------------------------------

const ANCHOR_LABEL: Record<string, string> = {
  resume_claim_usage: "a claim this resume uses",
  career_claim: "a statement you have on file",
  match_gap: "a gap named by the match report",
  resume_change: "a change applied to this resume",
  requirement: "a requirement of the job",
};

const ANCHOR_DETAIL: Record<string, string> = {
  recently_confirmed: "confirmed in the last 30 days",
  user_entered_without_evidence_source: "no document behind it",
  no_evidence_source: "no evidence source",
  no_corroborating_claim: "no corroborating statement",
  first_screen_placement: "on the first screen",
  direct_must_requirement: "direct evidence for a must-have requirement",
  change_fact_delta: "introduces a fact the before-state did not have",
  tailored_on_unconfirmed_claim: "tailored wording over a statement you did not confirm",
  rendered_text_fact_delta: "the wording on the page asserts a fact the statement does not",
  accepted_rewrite: "an accepted rewrite",
  material_rewording: "the wording changed substantially",
  entity_preserving: "every fact was preserved",
  metric_exceeds_before: "a figure larger than the one it replaced",
  unsupported_requirement: "nothing in your evidence covers it",
  requirement_importance: "importance sets the severity",
};

/** The human sentence for one anchor. Both halves are fixed strings, never caller prose. */
export function anchorSentence(anchor: InterviewAnchor): string {
  const source = ANCHOR_LABEL[anchor.source] ?? "a row we cannot name";
  const detail = ANCHOR_DETAIL[anchor.detail] ?? anchor.detail;
  return `From ${source}, which ${detail}.`;
}

/**
 * Is this risk attributable?
 *
 * A risk with no anchor is not rendered. That is the one thing this module refuses: 06 sec. E.4
 * says risks are DERIVED, and a warning box with nothing behind it is the shape an un-derived
 * risk takes when a server or a future bug produces one. Refusing to render it makes the client
 * agree with the server's own `assertRisksAreAnchored`, and it is the second half of acceptance
 * item 1 - the client must not be the layer that lets an unattributable risk through.
 */
export function isAttributable(anchors: readonly InterviewAnchor[] | null | undefined): boolean {
  return Array.isArray(anchors) && anchors.length > 0;
}

/** The risks worth showing, worst first. A pure filter and a sort: no arithmetic, no verdict. */
export function orderedRisks<T extends { severity: string; key: string }>(risks: readonly T[]): T[] {
  const rank = (severity: string): number => {
    const index = SEVERITY_ORDER.indexOf(severity as InterviewSeverity);
    return index === -1 ? 0 : index;
  };
  return [...risks].sort((a, b) => {
    const bySeverity = rank(a.severity) - rank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// The answer stage, in words
// ---------------------------------------------------------------------------

export type StageMessage = { headline: string; detail: string };

/**
 * What the ANSWER stage did, in words.
 *
 * THE FOUR THAT MATTER, and they are deliberately different sentences rather than one template
 * with a reason substituted:
 *   `no_ai_provider_configured` - nothing was asked of a provider. The risks and the questions
 *     are still exact, because they are derived from your rows.
 *   `no_grounded_evidence` - the question is about something your evidence does not cover, so
 *     there is nothing to write an answer from. This is the gap case and it is not a failure.
 *   `ungrounded_entities_after_regeneration` - an answer WAS written, it named something your
 *     evidence does not contain, it was asked once more, and it did it again, so it was
 *     discarded. Nothing about it is stored except the refusal.
 *   `not_evaluated` - this screen did not ask a provider anything, because it is a READ.
 */
export function answerStageMessage(stage: InterviewAnswerStage): StageMessage {
  switch (stage.reason) {
    case "ok":
      return {
        headline: "A model answer was written and checked against your evidence.",
        detail: "Every employer, technology, year and number in it appears in the evidence this question is grounded in.",
      };
    case "no_ai_provider_configured":
      return {
        headline: "No AI provider is configured, so no model answers were written.",
        detail:
          "The risks and the questions below are still exact: they come from your resume, your confirmed statements and the match report. Add a key in Settings to get model answers.",
      };
    case "provider_unavailable":
      return {
        headline: "The AI provider could not be reached, so no model answers were written.",
        detail: "Nothing was guessed in its place. Every question below is still there, with its focus.",
      };
    case "no_grounded_evidence":
      return {
        headline: "No answer was written for this one.",
        detail:
          "This question is about something your confirmed evidence does not cover, so there is nothing to write an answer from. The focus below is the useful part.",
      };
    case "ungrounded_entities_after_regeneration":
      return {
        headline: "A written answer was refused and discarded.",
        detail: `It named something your evidence does not contain${
          stage.rejectedEntities.length > 0 ? ` (${stage.rejectedEntities.join(", ")})` : ""
        }, it was asked once more, and it did it again. Nothing was stored.`,
      };
    case "not_evaluated":
    default:
      return {
        headline: "This view did not ask a provider anything.",
        detail: "It is showing the last run, exactly as it was recorded.",
      };
  }
}

/**
 * The one-line summary under the counter row.
 *
 * A MISSING KEY IS NAMED RATHER THAN IMPLIED, and a refusal is never phrased as an absence of
 * findings: three things went wrong (no key, unreachable provider, refused twice) and a reader
 * who is not told which will assume the fourth thing - that nothing needed saying.
 */
export function answerSummaryMessage(
  summary: { answered: number; skipped: number; rejected: number },
): StageMessage {
  if (summary.rejected > 0) {
    return {
      headline: `${summary.rejected} model answer${summary.rejected === 1 ? " was" : "s were"} refused and discarded.`,
      detail: "An answer that named something your evidence does not contain is never stored. The questions below are all still there.",
    };
  }
  if (summary.answered > 0) {
    return {
      headline: `${summary.answered} model answer${summary.answered === 1 ? "" : "s"} passed the grounding check.`,
      detail: "The rest have no answer, for the reason shown on each question.",
    };
  }
  return {
    headline: "No model answers were written.",
    detail: "The risks and the questions are derived from your evidence and need no provider.",
  };
}

// ---------------------------------------------------------------------------
// The empty state
// ---------------------------------------------------------------------------

/**
 * Is there anything at all to show?
 *
 * NOT the same as "no risks": a revision with no claim usages and no tailoring changes and no
 * match report derives nothing, and "nothing to prepare" would be a claim. The screen says what
 * is missing instead, which is 06 sec. E.11's "empty" row of the state table.
 */
export function emptyPrepMessage(prep: {
  revision: { usageCount: number; changeCount: number } | null;
  match: { matchReportId: string | null; jobId: string | null };
}): string {
  const hasUsage = (prep.revision?.usageCount ?? 0) > 0;
  const hasChange = (prep.revision?.changeCount ?? 0) > 0;
  const hasMatch = prep.match.matchReportId !== null || prep.match.jobId !== null;
  if (hasUsage || hasChange || hasMatch) {
    return "Nothing risky was derived from this resume. That means every statement on it is confirmed, corroborated and no requirement it answers is missing - which is not the same as a guarantee of anything.";
  }
  return "Nothing to derive yet. This resume has no saved revision, so there is nothing to check against your confirmed evidence.";
}