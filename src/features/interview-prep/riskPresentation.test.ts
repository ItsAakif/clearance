// Presentation contract for the interview-prep feature (T1090).
//
// Two things are asserted here that a `.tsx` component cannot be: that EVERY risk kind and
// EVERY severity has a non-empty label, a description and an icon (the accessibility rule as
// an assertion rather than a promise about markup), and that the two RULES the screen rests on
// are constants with pinned wording - "risks are derived" and "an answer is stored only when it
// is grounded".
//
// The third block is the one that earns its keep: `isAttributable` is the client's half of
// acceptance item 1. The server refuses to emit an unanchored risk; this refuses to RENDER one,
// so the two layers agree and an unattributable warning box cannot appear.

import { describe, it, expect } from "vitest";
import {
  INTERVIEW_QUESTION_CATEGORIES,
  INTERVIEW_RISK_KINDS,
  SEVERITY_ORDER,
  UNKNOWN_RISK_KIND,
  UNKNOWN_SEVERITY,
  anchorSentence,
  answerStageMessage,
  answerSummaryMessage,
  categoryLabel,
  emptyPrepMessage,
  isAttributable,
  orderedRisks,
  riskKindPresentation,
  severityPresentation,
} from "./riskPresentation";
import type { InterviewAnchor, InterviewAnswerStage } from "@/services/api/interview";

describe("every severity is icon + text, never colour alone", () => {
  it("labels and describes all three, with distinct icons", () => {
    const icons = new Set<string>();
    for (const severity of SEVERITY_ORDER) {
      const presentation = severityPresentation(severity);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.description.length).toBeGreaterThan(20);
      expect(presentation.icon.length).toBeGreaterThan(0);
      icons.add(presentation.icon);
    }
    // Three icons for three severities: a severity that shared a glyph with another would be
    // indistinguishable without colour.
    expect(icons.size).toBe(SEVERITY_ORDER.length);
  });

  it("an unknown severity fails CLOSED to high, never downgraded to low", () => {
    expect(severityPresentation("catastrophic")).toBe(UNKNOWN_SEVERITY);
    expect(UNKNOWN_SEVERITY.tone).toBe("urgent");
    expect(severityPresentation(null).tone).toBe("urgent");
    expect(severityPresentation(undefined).tone).toBe("urgent");
  });

  it("a value this build does not know reads as high, not as fine", () => {
    // The direction that matters: an unrecognised severity must not look reassuring.
    expect(severityPresentation("HIGH")).toEqual(UNKNOWN_SEVERITY);
  });
});

describe("every risk kind is icon + text, and explains WHERE it was read from", () => {
  it("labels and describes all seven, with distinct icons", () => {
    const icons = new Set<string>();
    for (const kind of INTERVIEW_RISK_KINDS) {
      const presentation = riskKindPresentation(kind);
      expect(presentation.label.length).toBeGreaterThan(0);
      expect(presentation.description.length).toBeGreaterThan(20);
      icons.add(presentation.icon);
    }
    expect(icons.size).toBe(INTERVIEW_RISK_KINDS.length);
  });

  it("is exactly the seven kinds of 06 sec. E.4", () => {
    expect([...INTERVIEW_RISK_KINDS]).toEqual([
      "new_claim",
      "emphasized_tech",
      "inferred_claim",
      "rewritten_bullet",
      "gap",
      "overclaim",
      "thin_evidence",
    ]);
  });

  it("an unknown kind fails CLOSED to the LEAKAGE kind, never to something reassuring", () => {
    expect(riskKindPresentation("brand_new_kind")).toBe(UNKNOWN_RISK_KIND);
    expect(UNKNOWN_RISK_KIND.label).toBe("Wording you have not confirmed");
    expect(riskKindPresentation(null)).toBe(UNKNOWN_RISK_KIND);
  });

  it("every kind's description says what an interviewer will do, not what is wrong with the user", () => {
    for (const kind of INTERVIEW_RISK_KINDS) {
      expect(riskKindPresentation(kind).description).toMatch(/Expect|The honest|This is|Worth/);
    }
  });

  it("the gap kind never implies the user might have the thing", () => {
    expect(riskKindPresentation("gap").description).toContain("does not cover");
    expect(riskKindPresentation("gap").description).toContain("what you have not done");
  });
});

describe("ACCEPTANCE 1, second half: the client refuses to RENDER an unanchored risk", () => {
  const anchor: InterviewAnchor = { source: 'resume_claim_usage', id: 'clm-1', detail: 'first_screen_placement' };

  it("a risk with anchors is attributable", () => {
    expect(isAttributable([anchor])).toBe(true);
  });

  it("a risk with NO anchors is NOT renderable, and that is the fail-closed direction", () => {
    expect(isAttributable([])).toBe(false);
    expect(isAttributable(null)).toBe(false);
    expect(isAttributable(undefined)).toBe(false);
  });

  it("every anchor renders as a SENTENCE naming the row and the reason", () => {
    const sentence = anchorSentence(anchor);
    expect(sentence).toContain("a claim this resume uses");
    expect(sentence).toContain("on the first screen");
    expect(sentence.endsWith(".")).toBe(true);
  });

  it("an anchor whose detail this build does not know still shows the raw detail", () => {
    const sentence = anchorSentence({ source: 'resume_change', id: 'chg-1', detail: 'a_brand_new_reason' });
    expect(sentence).toContain("a_brand_new_reason");
    expect(sentence).toContain("a change applied to this resume");
  });

  it("an anchor whose source this build does not know does not become blank", () => {
    const sentence = anchorSentence({ source: 'vibes' as never, id: 'x', detail: 'felt_risky' });
    expect(sentence).toContain("a row we cannot name");
    expect(sentence).toContain("felt_risky");
  });
});

describe("the answer stage is described in WORDS, and a refusal is never phrased as silence", () => {
  const stage = (over: Partial<InterviewAnswerStage>): InterviewAnswerStage => ({
    status: 'skipped',
    reason: 'not_evaluated',
    provider: null,
    model: null,
    attempts: 0,
    rejectedEntities: [],
    dropped: [],
    ...over,
  });

  it("names the four states a reader has to tell apart", () => {
    const reasons = [
      "ok",
      "no_ai_provider_configured",
      "provider_unavailable",
      "no_grounded_evidence",
      "ungrounded_entities_after_regeneration",
    ];
    const headlines = reasons.map((reason) => answerStageMessage(stage({ reason })).headline);
    // Five distinct sentences. One template with a reason substituted would give one.
    expect(new Set(headlines).size).toBe(reasons.length);
  });

  it("no provider says the RISKS ARE STILL EXACT, because they are derived", () => {
    const message = answerStageMessage(stage({ reason: "no_ai_provider_configured" }));
    expect(message.detail).toContain("still exact");
    expect(message.detail).toContain("your confirmed statements");
  });

  it("a gap question says its absence is the POINT, not a failure", () => {
    const message = answerStageMessage(stage({ reason: "no_grounded_evidence" }));
    expect(message.detail).toContain("does not cover");
    expect(message.detail).toContain("useful part");
  });

  it("a REFUSED answer is named as a refusal and the entities are shown", () => {
    const message = answerStageMessage(
      stage({ status: 'rejected', reason: 'ungrounded_entities_after_regeneration', rejectedEntities: ['employer Initech'] }),
    );
    expect(message.headline).toContain("refused and discarded");
    expect(message.detail).toContain("employer Initech");
    expect(message.detail).toContain("asked once more");
  });

  it("a refusal with no entities named still says it happened", () => {
    const message = answerStageMessage(stage({ status: 'rejected', reason: 'ungrounded_entities_after_regeneration' }));
    expect(message.headline).toContain("refused");
    expect(message.detail).not.toContain("()");
  });

  it("a read says it did not ask anything, rather than blaming the configuration", () => {
    expect(answerStageMessage(stage({ reason: 'not_evaluated' })).headline).toContain(
      "did not ask a provider anything",
    );
  });

  it("an unknown reason falls back to the READ wording rather than to a blank", () => {
    expect(answerStageMessage(stage({ reason: 'from_the_future' })).headline.length).toBeGreaterThan(10);
  });

  it("the summary leads with a refusal when there was one", () => {
    const summary = answerSummaryMessage({ answered: 2, skipped: 1, rejected: 1 });
    expect(summary.headline).toContain("refused and discarded");
    expect(summary.detail).toContain("never stored");
  });

  it("the summary reports answers only when none were refused", () => {
    expect(answerSummaryMessage({ answered: 3, skipped: 0, rejected: 0 }).headline).toContain("3");
    expect(answerSummaryMessage({ answered: 1, skipped: 0, rejected: 0 }).headline).toContain("1 model answer passed");
  });

  it("no answers at all says the questions are derived and need no provider", () => {
    expect(answerSummaryMessage({ answered: 0, skipped: 4, rejected: 0 }).detail).toContain(
      "derived from your evidence",
    );
  });
});

describe("the empty state names what is missing, and never claims a good result", () => {
  it("no rows at all says there is no saved revision", () => {
    const message = emptyPrepMessage({ revision: null, match: { matchReportId: null, jobId: null } });
    expect(message).toContain("no saved revision");
  });

  it("a derived-but-empty revision says so WITHOUT calling it safe", () => {
    // There IS something to derive from (usages were read), and nothing was derived - which is
    // the case a "0 risks, you're ready" message would get wrong.
    const message = emptyPrepMessage({
      revision: { usageCount: 3, changeCount: 0 },
      match: { matchReportId: null, jobId: null },
    });
    expect(message).toContain("Nothing risky was derived");
    expect(message).toContain("not the same as a guarantee");
  });
});

describe("the ordering is a filter and a sort, never a number", () => {
  it("puts the worst first and breaks a tie on the anchor key", () => {
    const ordered = orderedRisks([
      { severity: "low", key: "career_claim:b" },
      { severity: "high", key: "career_claim:z" },
      { severity: "low", key: "career_claim:a" },
    ]);
    expect(ordered.map((row) => row.key)).toEqual(["career_claim:z", "career_claim:a", "career_claim:b"]);
  });

  it("an unknown severity sorts as high, so a future value is not quietly hidden", () => {
    const ordered = orderedRisks([
      { severity: "low", key: "a" },
      { severity: "catastrophic", key: "b" },
    ]);
    expect(ordered[0].key).toBe("b");
  });

  it("does not mutate its input", () => {
    const input = [{ severity: "low", key: "b" }, { severity: "high", key: "a" }];
    orderedRisks(input);
    expect(input.map((row) => row.key)).toEqual(["b", "a"]);
  });
});

describe("the four categories are labelled, and an unknown one falls back rather than blanking", () => {
  it("labels all four", () => {
    expect(new Set(INTERVIEW_QUESTION_CATEGORIES.map(categoryLabel)).size).toBe(4);
  });

  it("falls back for an unknown category", () => {
    expect(categoryLabel("vibes")).toBe(categoryLabel("general"));
    expect(categoryLabel(null)).toBe(categoryLabel("general"));
  });
});