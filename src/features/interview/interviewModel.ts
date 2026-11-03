// Pure presentation rules for the Career Interview wizard (T1021).
//
// Runner-compatible by construction, and for the same reason as
// `features/career/claimPresentation.ts`: ADR-031 decision 3 keeps this repo's frontend
// tests in vitest's `node` environment, so a `.test.ts` can import a pure module and assert
// it but cannot render a component. Everything a wizard has to get RIGHT - which refusal
// says what, how a dropped claim is worded, whether the wizard may submit, what the stepper
// says - therefore lives here, and `InterviewWizard.tsx` is a thin reader of it. What is
// left in the component is layout, focus and the two API calls.
//
// FOUR THINGS THIS MODULE EXISTS TO MAKE TRUE:
//
//   1. THE NO-PROVIDER CASE IS A REAL STATE, NOT AN ERROR STRING. The interview needs an AI
//      provider, and without one it refuses (ADR-041 D5 read the other way from the
//      deterministic import). `providerRequiredCopy` is what the user is shown, and it always
//      carries the MANUAL PATH - because the honest answer to "your AI interview cannot
//      run" is "here is how you add your statements without one", not an apology.
//
//   2. A DROPPED CLAIM IS SHOWN, NOT SWALLOWED. `dropPresentation` turns each server refusal
//      into an icon + a label + a sentence, the same way `statusPresentation` does for a
//      status. A user who typed five screens and lost one claim to a guard has to be able to
//      see WHICH and WHY, or the guard reads as the tool losing their work.
//
//   3. THE WIZARD IS KEYBOARD-COMPLETABLE, AND THAT IS A RULE NOT A STYLE. `canAdvance` and
//      `canSubmit` are the two gates, and both are pure functions of the answers, so "a user
//      can finish this with the keyboard alone" is a testable statement rather than a hope.
//
//   4. THE FINISH ACTION IS A HAND-OFF, NOT A CONCLUSION. `handoffSummary` states the number
//      of claims created and the number still unconfirmed, and the wizard routes to the
//      verification list. The wizard never says the profile is ready, because it cannot know
//      that - only the user can, by confirming.

import type { CareerInterviewAnswer, CareerInterviewDrop, CareerInterviewResult, CareerInterviewStep } from "@/services/api/career";

/** What the user is told when no AI provider is configured. Never an empty apology. */
export interface ProviderRequiredCopy {
  /** Short form for an alert title. */
  title: string;
  /** The body, which ALWAYS carries the manual path. */
  body: string;
  /** Where to send them instead. The server sends this too; this is the fallback. */
  manualPath: string;
  /** Label for the link/button to that path. */
  manualLabel: string;
}

/**
 * The no-provider copy.
 *
 * `manualPath` is `/career/claims` - the hand-entered claim endpoint behind the Career
 * Evidence page. It is a POST target the UI never calls directly (the page's own "add a
 * statement" form does), so what is offered is a link to the page, not a fake button.
 */
export const PROVIDER_REQUIRED_COPY: ProviderRequiredCopy = {
  title: "This interview needs an AI provider",
  body:
    "Adding a key turns your answers into candidate statements you can check. Without one, " +
    "there is nothing to ask - and we will not invent your career for you. You can add the " +
    "statements yourself on the Career Evidence page instead; they work exactly the same way " +
    "and still start unconfirmed.",
  manualPath: "/app/profile",
  manualLabel: "Add your statements by hand",
};

/**
 * A dropped claim, as icon + label + sentence.
 *
 * ICON + TEXT, NEVER COLOUR ALONE - the same a11y rule `claimPresentation.ts` follows for a
 * status, for the same reason: the two states a user acts on here are "this one is fine" and
 * "this one was refused", and a user who cannot perceive the difference must still be able
 * to act on it.
 */
export interface DropPresentation {
  icon: "circle-slash" | "alert-triangle" | "copy" | "help-circle";
  /** NEVER empty, and never the raw reason code. */
  label: string;
  /** One sentence, in words a person can act on. */
  explanation: string;
  tone: "refused" | "warned";
}

/**
 * Wording for every refusal the server can report.
 *
 * Keyed on the wire reason rather than on an index, so a NEW reason from the server renders
 * as `UNKNOWN_DROP` instead of as a blank row - the same fail-closed rule
 * `claimPresentation.ts` applies to an unknown status. `UNCONFIRMED_STATUSES` is not
 * imported from the career module on purpose: this file is the interview's own vocabulary
 * and the two do not have to be edited together.
 */
const DROP_PRESENTATION: Record<string, Omit<DropPresentation, "explanation">> = {
  invented_entity: {
    icon: "alert-triangle",
    label: "Named something you did not",
    tone: "refused",
  },
  unknown_kind: { icon: "circle-slash", label: "Not a kind of statement we store", tone: "refused" },
  no_statement: { icon: "circle-slash", label: "No statement text", tone: "refused" },
  statement_too_short: { icon: "circle-slash", label: "Too short to be a fact", tone: "refused" },
  statement_too_long: { icon: "circle-slash", label: "Too long to be one fact", tone: "refused" },
  invalid_confidence: { icon: "circle-slash", label: "Unreadable confidence", tone: "refused" },
  duplicate: { icon: "copy", label: "Said twice", tone: "warned" },
  too_many_claims: { icon: "alert-triangle", label: "More claims than we will read", tone: "warned" },
};

export const UNKNOWN_DROP: DropPresentation = {
  icon: "help-circle",
  label: "Refused for a reason this version does not know",
  explanation:
    "A statement was refused for a reason this version of Clearance does not recognise. " +
    "Nothing was invented and nothing was lost - check the Career Evidence page.",
  tone: "refused",
};

/**
 * How many claims were refused for a reason that MIGHT be worth fixing.
 *
 * `duplicate` is a warning rather than a refusal: the fact was captured, twice. The rest
 * mean a sentence did not survive, which is worth the user's attention.
 */
export function droppedCount(dropped: readonly CareerInterviewDrop[] | null | undefined): number {
  return Array.isArray(dropped) ? dropped.length : 0;
}

/** The one refusal that most deserves a sentence of its own, because it is the interesting one. */
export function inventedEntityDrops(
  dropped: readonly CareerInterviewDrop[] | null | undefined,
): CareerInterviewDrop[] {
  return (dropped ?? []).filter((row) => row?.reason === "invented_entity");
}

/**
 * One refusal, as something the UI can render.
 *
 * `invented_entity` names the entities the server could not find in the answers, because
 * that is the whole diagnosis: "employer Initech" is not a wording complaint, it is a
 * report that the model mentioned a company the user never did. The others say only what
 * the refusal was - inventing an explanation for them would be the UI guessing at a
 * decision the server made.
 */
export function dropPresentation(drop: CareerInterviewDrop | null | undefined): DropPresentation {
  if (!drop || typeof drop.reason !== "string") return UNKNOWN_DROP;
  const base = DROP_PRESENTATION[drop.reason];
  if (!base) return UNKNOWN_DROP;
  if (drop.reason !== "invented_entity") {
    return {
      ...base,
      explanation: `${base.label}. We did not store it, and we did not change it into something else.`,
    };
  }
  const named = Array.isArray(drop.invented) ? drop.invented : [];
  const list =
    named.length > 0
      ? named.join(", ")
      : "something the rest of your answers do not mention";
  return {
    ...base,
    explanation: `This one names ${list} - which your answers do not. We dropped it rather than store something you did not say. Add it to your answer and run the interview again, or write it in yourself.`,
  };
}

// ---------------------------------------------------------------------------
// The wizard's own state, as pure functions
// ---------------------------------------------------------------------------

/** One wizard field, addressed the way the server addresses it. */
export interface WizardAnswer {
  stepId: string;
  fieldId: string;
  value: string;
}

/** Every answer of a step, keyed `fieldId`, so a screen renders without searching the list. */
export function answersForStep(
  answers: readonly WizardAnswer[],
  step: CareerInterviewStep,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of step.fields) out[field.id] = answers.find((a) => a.fieldId === field.id)?.value ?? "";
  return out;
}

/** A field's value, trimmed. `""` for an untouched one. */
export function answerValue(
  answers: readonly WizardAnswer[],
  stepId: string,
  fieldId: string,
): string {
  const found = answers.find((a) => a.stepId === stepId && a.fieldId === fieldId);
  return typeof found?.value === "string" ? found.value : "";
}

/** Whether one field is satisfied. Only `required` fields can be unsatisfied. */
export function isFieldSatisfied(field: { required: boolean }, value: string): boolean {
  if (!field.required) return true;
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Whether a step is finished, and WHICH fields are holding it back.
 *
 * Both halves are returned because the UI needs them for different things: the "Next" button
 * for the boolean, and a per-field message for the list. A user blocked by an invisible
 * requirement cannot finish a wizard with the keyboard.
 */
export function stepCompletion(
  answers: readonly WizardAnswer[],
  step: CareerInterviewStep,
): { complete: boolean; missing: string[] } {
  const missing = step.fields
    .filter((field) => !isFieldSatisfied(field, answerValue(answers, step.id, field.id)))
    .map((field) => field.label);
  return { complete: missing.length === 0, missing };
}

/**
 * Whether the wizard may leave this step.
 *
 * DELIBERATELY NOT `disabled` ON THE BUTTON ALONE: the rule lives here so it is one
 * assertion, and `InterviewWizard.tsx` renders a `disabled` attribute from this boolean
 * rather than recomputing it. The last step uses `canSubmit` instead, because the last step
 * has nothing to advance to.
 */
export function canAdvance(answers: readonly WizardAnswer[], step: CareerInterviewStep): boolean {
  return stepCompletion(answers, step).complete;
}

/** Whether every step is finished - the wizard's submit gate. */
export function canSubmit(answers: readonly WizardAnswer[], steps: readonly CareerInterviewStep[]): boolean {
  return steps.every((step) => canAdvance(answers, step));
}

/**
 * The answers to POST, in the server's shape.
 *
 * Blank optional fields are DROPPED rather than sent as `""`, because the server treats a
 * blank value as "not answered" and refusing the whole submission over an untouched optional
 * field would be a worse experience than sending nothing for it. This is the client half of
 * the same rule `normalizeInterviewAnswers` enforces.
 */
export function answersToSubmit(answers: readonly WizardAnswer[]): WizardAnswer[] {
  return answers
    .filter((answer) => typeof answer?.value === "string" && answer.value.trim().length > 0)
    .map((answer) => ({ stepId: answer.stepId, fieldId: answer.fieldId, value: answer.value.trim() }));
}

/**
 * The stepper's progress line, e.g. "Step 2 of 5: What you work with".
 *
 * The stepper itself is the app's own `StepIndicator`; this is the sentence a screen reader
 * and a tooltip both read, because a row of circles with numbers in them conveys nothing
 * without it.
 */
export function stepLabel(
  steps: readonly CareerInterviewStep[],
  index: number,
): string {
  if (steps.length === 0) return "Step 1 of 1";
  // The CLAMPED index is used for BOTH the number and the title. A stale index during a
  // transition would otherwise render "Step 9 of 2", which is the one output that makes the
  // stepper look broken rather than merely wrong.
  const position = Math.min(Math.max(Math.trunc(index) || 0, 0), steps.length - 1);
  return `Step ${position + 1} of ${steps.length}: ${steps[position].title}`;
}

// ---------------------------------------------------------------------------
// The hand-off
// ---------------------------------------------------------------------------

/**
 * What the wizard says after the claims come back.
 *
 * Three numbers and one sentence, and the sentence is the honest one: the claims exist and
 * none of them is confirmed. "Your profile is ready" would be a claim the wizard has no
 * standing to make - the profile becomes usable when the user confirms things, and only then.
 */
export function handoffSummary(result: CareerInterviewResult | null | undefined): string {
  const created = result?.claims?.created ?? 0;
  const unconfirmed = result?.unconfirmed ?? 0;
  if (created === 0) {
    return (
      "Nothing new was added. The statements we could use were already on file - open the " +
      "verification list to see what is still unconfirmed."
    );
  }
  return (
    `${created} candidate statement${created === 1 ? "" : "s"} added, ${unconfirmed} still ` +
    `unconfirmed in total. Confirm or reject each one - nothing enters a resume until you do.`
  );
}

/**
 * Whether the wizard should show the user the refusals at all.
 *
 * Only when there ARE some: an empty "nothing was dropped" panel next to a success message
 * is noise, and the success message already says what was written. The interesting case -
 * `invented_entity` - is the one worth a heading of its own, so
 * `inventedEntityDrops` exists for it.
 */
export function hasRefusals(dropped: readonly CareerInterviewDrop[] | null | undefined): boolean {
  return droppedCount(dropped) > 0;
}

/**
 * The refusal panel's heading.
 *
 * "We checked" rather than "we dropped N", because the number is often zero while the
 * refusal list is not (a duplicate), and because the panel's job is to establish that
 * something was verified rather than to apologise.
 */
export function refusalHeading(count: number): string {
  return count === 1 ? "1 statement was refused" : `${count} statements were refused`;
}