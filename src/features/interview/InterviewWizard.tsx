// The Career Interview wizard (T1021, 06-design sec. E.11 flow 2).
//
// WHAT THIS COMPONENT IS, AND WHAT IT IS NOT. It replaces the questionnaire whose payload
// went to a fabricating endpoint: its answers become CANDIDATE CLAIMS, all `inferred`, and
// the wizard's last action is a HAND-OFF to the verification list at `/app/career`. It never
// renders a resume, it never marks anything confirmed, and it never says the profile is
// ready - only the user can do those.
//
// THE RULES ARE NOT HERE. Every decision this component makes is a call into
// `interviewModel.ts`: whether a step may advance, how a refused claim reads, what the
// no-provider case says, what the hand-off says. That split is the point - the repo's
// frontend tests run in vitest's `node` environment and cannot render a component
// (`ADR-031` decision 3), so anything that lives only in JSX is untested by construction.
// What stays here is layout, focus, and the two API calls.
//
// A11Y, and the three things that make the wizard completable with a keyboard alone:
//   - every input has a `<Label htmlFor>` bound to a real `id`, and the hint is wired to it
//     with `aria-describedby` so the guidance is announced with the field rather than
//     floating above it;
//   - the stepper is the app's own `StepIndicator` plus a visible text line, because a row of
//     numbered circles conveys nothing to a screen reader;
//   - `Back` / `Next` are real buttons in DOM order, so Tab reaches them without a focus
//     trap and Enter submits. No `onKeyDown` interception, no roving tabindex.
//
// THE NO-PROVIDER PATH IS A FIRST-CLASS SCREEN, NOT AN ERROR TOAST. `start()` is attempted
// on mount; with no provider it renders an alert that says so and links to the manual path.
// There is no "continue without AI" button, because continuing without a provider would mean
// a questionnaire that cannot do what it says it does.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, CircleSlash, Copy, HelpCircle, Loader2, Sparkles } from "lucide-react";
import StepIndicator from "@/components/animations/StepIndicator";
import {
  INTERVIEW_PROVIDER_REQUIRED,
  careerApi,
  type CareerInterviewAnswer,
  type CareerInterviewDrop,
  type CareerInterviewResult,
  type CareerInterviewStart,
  type CareerInterviewStep,
} from "@/services/api/career";
import { ApiClientError } from "@/services/api/client";
import {
  PROVIDER_REQUIRED_COPY,
  answersForStep,
  answersToSubmit,
  canAdvance,
  canSubmit,
  dropPresentation,
  droppedCount,
  handoffSummary,
  hasRefusals,
  refusalHeading,
  stepCompletion,
  stepLabel,
  type DropPresentation,
  type WizardAnswer,
} from "./interviewModel";

/** The lucide component for each presentation icon name. Kept beside the model, not in it. */
const DROP_ICONS = {
  "circle-slash": CircleSlash,
  "alert-triangle": AlertTriangle,
  copy: Copy,
  "help-circle": HelpCircle,
} as const;

/** One refusal row: icon + label + the sentence, and the offending text verbatim. */
function DroppedRow({ drop }: { drop: CareerInterviewDrop }) {
  const presentation: DropPresentation = dropPresentation(drop);
  const Icon = DROP_ICONS[presentation.icon];
  return (
    <li className="border-b border-rule py-2 text-sm">
      <p className="flex items-center gap-2 font-medium text-ink">
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {presentation.label}
      </p>
      <p className="mt-1 text-ink-3">{presentation.explanation}</p>
      {drop.detail ? (
        <p className="mt-1 text-xs2 text-ink-3">{drop.detail}</p>
      ) : null}
    </li>
  );
}

export interface InterviewWizardProps {
  /** Where the finish action goes. The verification list; overridable for a test harness. */
  verificationPath?: string;
}

export function InterviewWizard({ verificationPath = "/app/profile" }: InterviewWizardProps) {
  const [session, setSession] = useState<CareerInterviewStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState<WizardAnswer[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<CareerInterviewResult | null>(null);

  // Focus the heading when the step changes, so a keyboard or screen-reader user is told
  // they moved rather than being left on a button that no longer exists.
  const headingRef = useRef<HTMLHeadingElement>(null);

  const start = useCallback(async () => {
    setStarting(true);
    setProviderError(null);
    setStartError(null);
    try {
      setSession(await careerApi.startInterview());
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.code === INTERVIEW_PROVIDER_REQUIRED) {
        // THE HONEST STATE, not a failure banner with a retry button: retrying will not help
        // until a key is configured, and the answer is a link to the manual path.
        setProviderError(caught.message);
      } else {
        setStartError(
          caught instanceof ApiClientError
            ? caught.message
            : "The interview could not be started.",
        );
      }
    } finally {
      setStarting(false);
    }
  }, []);

  useEffect(() => {
    headingRef.current?.focus();
  }, [stepIndex]);

  const steps = session?.steps ?? [];
  const step: CareerInterviewStep | undefined = steps[stepIndex];
  const lastStep = stepIndex === steps.length - 1;

  const submit = useCallback(async () => {
    if (!session) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload: CareerInterviewAnswer[] = answersToSubmit(answers);
      setResult(await careerApi.submitInterviewAnswers(session.sessionId, payload));
    } catch (caught) {
      const code = caught instanceof ApiClientError ? caught.code : undefined;
      setSubmitError(
        code === INTERVIEW_PROVIDER_REQUIRED
          ? caught instanceof ApiClientError
            ? caught.message
            : PROVIDER_REQUIRED_COPY.body
          : caught instanceof ApiClientError
            ? caught.message
            : "Your answers could not be turned into statements.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [answers, session]);

  const setValue = useCallback((fieldId: string, value: string) => {
    setAnswers((current) => {
      const index = current.findIndex(
        (answer) => answer.stepId === step?.id && answer.fieldId === fieldId,
      );
      if (index === -1) return [...current, { stepId: step?.id ?? "", fieldId, value }];
      const next = [...current];
      next[index] = { ...next[index], value };
      return next;
    });
  }, [step?.id]);

  const completion = useMemo(
    () => (step ? stepCompletion(answers, step) : { complete: false, missing: [] }),
    [answers, step],
  );
  const stepValues = useMemo(
    () => (step ? answersForStep(answers, step) : {}),
    [answers, step],
  );

  // ---------------------------------------------------------------------------
  // 1. No provider. A screen, with the manual path, and nothing else.
  // ---------------------------------------------------------------------------
  if (providerError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {PROVIDER_REQUIRED_COPY.title}
          </CardTitle>
          <CardDescription>{PROVIDER_REQUIRED_COPY.body}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Alert>
            <AlertTitle>What the server said</AlertTitle>
            <AlertDescription>{providerError}</AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to={PROVIDER_REQUIRED_COPY.manualPath}>
                {PROVIDER_REQUIRED_COPY.manualLabel}
              </Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void start()}>
              Try again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---------------------------------------------------------------------------
  // 2. Finished: the hand-off. Never a "you are done".
  // ---------------------------------------------------------------------------
  if (result) {
    return (
      <Card data-testid="interview-result">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Candidate statements ready
          </CardTitle>
          <CardDescription>{handoffSummary(result)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTitle>What they carry</AlertTitle>
            <AlertDescription>
              <p>
                Every statement this interview produced carries status &quot;{result.statusAssigned}&quot;
                , provenance &quot;{result.provenanceAssigned}&quot; and method &quot;{result.inferenceMethod}&quot;.
              </p>
              <p>{result.note}</p>
            </AlertDescription>
          </Alert>

          {hasRefusals(result.dropped) ? (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink">
                {refusalHeading(droppedCount(result.dropped))}
              </h3>
              <p className="text-sm text-ink-3">
                We check every statement against your own answers. These were not stored, and
                none of them was rewritten into something else.
              </p>
              <ul className="space-y-2">
                {result.dropped.map((drop, index) => (
                  <DroppedRow key={`${drop.reason}-${index}`} drop={drop} />
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link to={result.nextPath || verificationPath}>Check each statement</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void start()}>
              Run the interview again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Starting, or starting failed.
  // ---------------------------------------------------------------------------
  if (starting || !session || !step) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Career interview</CardTitle>
          <CardDescription>Checking that an AI provider is configured.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {startError ? (
            <Alert variant="destructive">
              <AlertTitle>The interview could not start</AlertTitle>
              <AlertDescription>{startError}</AlertDescription>
            </Alert>
          ) : starting ? (
            <p className="flex items-center gap-2 text-sm text-ink-3">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Loading the questions
            </p>
          ) : (
            <Button onClick={() => void start()}>
              Start interview
            </Button>
          )}
          {startError ? (
            <Button variant="outline" size="sm" onClick={() => void start()}>
              Try again
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  // ---------------------------------------------------------------------------
  // 4. The wizard.
  // ---------------------------------------------------------------------------
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Career interview
        </CardTitle>
        <CardDescription>
          Answer in your own words. We turn them into candidate statements you check one by
          one - answering does not confirm anything, and nothing enters a resume until you
          confirm it. Read by {session.provider}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <StepIndicator currentStep={stepIndex + 1} totalSteps={steps.length} />
          {/* The stepper's text equivalent. `StepIndicator` is circles and numbers, which
              says nothing to a screen reader. */}
          <p className="text-center text-sm text-ink-3">{stepLabel(steps, stepIndex)}</p>
        </div>

        <div className="space-y-1">
          <h3
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-medium text-ink outline-none"
          >
            {step.title}
          </h3>
          <p className="text-sm text-ink-3">{step.summary}</p>
        </div>

        {step.fields.map((field) => {
          const inputId = `interview-${step.id}-${field.id}`;
          const hintId = `${inputId}-hint`;
          const missing = completion.missing.includes(field.label);
          const value = stepValues[field.id] ?? "";
          const isLong = field.id === "achievements" || field.id === "roles";
          return (
            <div key={field.id} className="space-y-1">
              <Label htmlFor={inputId} className="text-sm">
                {field.label}
                {field.required ? " (required)" : " (optional)"}
              </Label>
              {isLong ? (
                <Textarea
                  id={inputId}
                  aria-describedby={hintId}
                  aria-required={field.required}
                  aria-invalid={missing || undefined}
                  rows={4}
                  value={value}
                  placeholder={field.hint}
                  onChange={(event) => setValue(field.id, event.target.value)}
                />
              ) : (
                <Input
                  id={inputId}
                  aria-describedby={hintId}
                  aria-required={field.required}
                  aria-invalid={missing || undefined}
                  value={value}
                  placeholder={field.hint}
                  onChange={(event) => setValue(field.id, event.target.value)}
                />
              )}
              <p id={hintId} className="text-xs2 text-ink-3">
                {field.hint}
              </p>
            </div>
          );
        })}

        {completion.missing.length > 0 ? (
          <Alert>
            <AlertTitle>Still to answer</AlertTitle>
            <AlertDescription>
              {completion.missing.join(", ")}. You can move on once these are filled in.
            </AlertDescription>
          </Alert>
        ) : null}

        {submitError ? (
          <Alert variant="destructive">
            <AlertTitle>Your answers were not turned into statements</AlertTitle>
            <AlertDescription>
              {submitError}
              {submitError.includes("AI provider") ? (
                <>
                  {" "}
                  <Link className="underline underline-offset-2" to={PROVIDER_REQUIRED_COPY.manualPath}>
                    {PROVIDER_REQUIRED_COPY.manualLabel}
                  </Link>
                  .
                </>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={stepIndex === 0 || submitting}
            onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden="true" />
            Back
          </Button>
          {lastStep ? (
            <Button
              size="sm"
              disabled={!canSubmit(answers, steps) || submitting}
              onClick={() => void submit()}
            >
              {submitting ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {submitting ? "Reading your answers" : "Turn my answers into statements"}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={!canAdvance(answers, step)}
              onClick={() => setStepIndex((current) => Math.min(steps.length - 1, current + 1))}
            >
              Next
              <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
        <p className="text-xs2 text-ink-3">{session.note}</p>
      </CardContent>
    </Card>
  );
}

export default InterviewWizard;