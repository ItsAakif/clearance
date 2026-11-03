// One interview question, its anchor, its focus, and its model answer (T1090; 06 sec. E.11
// flow 8, and E.4's grounded-prep model).
//
// THE THREE THINGS THIS CARD MAKES VISIBLE, in this order, because this is the order a
// candidate needs them in:
//
//   1. THE QUESTION, and the RISK it was derived from. The question text quotes the anchored
//      rows verbatim, so a reader can match the question against their own resume without
//      guessing.
//   2. THE FOCUS - what an interviewer will actually probe, and what to prepare.
//   3. THE MODEL ANSWER, or WHY THERE ISN'T ONE. `modelAnswer` is `null` or a string, never an
//      empty string, and the three absent cases are DIFFERENT sentences, not one blank:
//        - `no_grounded_evidence`: the question is about something their evidence does not
//          cover. That is the gap case, and the honest answer is the useful part.
//        - `no_ai_provider_configured` / `provider_unavailable`: nothing was written. The
//          question and the focus are still exact, because they are derived from rows.
//        - `ungrounded_entities_after_regeneration`: an answer WAS written, it named something
//          the evidence does not contain, it was asked once more, and it did it again. The
//          refusal is SHOWN, including the entities it named, because the point of the feature
//          is that the user can see what was refused and why.
//
// THE GROUNDED CLAIMS ARE SHOWN UNDER EVERY ANSWER. 06 sec. E.11 flow 8 asks for "a model
// answer that shows its grounded claims inline", and it is the only way a reader can check the
// answer's authority for themselves rather than trusting it.

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CircleCheck, CircleSlash, Quote, TriangleAlert } from "lucide-react";
import { categoryLabel } from "./riskPresentation";
import { answerStageMessage } from "./riskPresentation";
import type { InterviewAnswerStage, InterviewQuestion } from "@/services/api/interview";

interface QuestionCardProps {
  question: InterviewQuestion;
  className?: string;
}

const STATUS_ICON: Record<InterviewAnswerStage["status"], typeof CircleCheck> = {
  answered: CircleCheck,
  skipped: CircleSlash,
  rejected: TriangleAlert,
};

const STATUS_CLASS: Record<InterviewAnswerStage["status"], string> = {
  answered: "text-success",
  skipped: "text-ink-3",
  rejected: "text-destructive",
};

export function QuestionCard({ question, className }: QuestionCardProps) {
  const message = answerStageMessage(question.answerStage);
  const StatusIcon = STATUS_ICON[question.answerStage.status] ?? CircleSlash;
  const hasAnswer = question.modelAnswer !== null;

  return (
    <Card className={className ?? ""}>
      <CardContent className="space-y-3 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{categoryLabel(question.category)}</Badge>
          {/* The anchor, spelled out. E.4: no question exists without one. */}
          {question.requirementId ? (
            <Badge variant="outline" className="gap-1">
              Requirement {question.requirementId}
            </Badge>
          ) : null}
          <span
            className={`flex items-center gap-1 text-xs2 font-medium ${STATUS_CLASS[question.answerStage.status]}`}
          >
            <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
            {message.headline}
          </span>
        </div>

        <p className="text-sm font-medium text-ink">{question.question}</p>

        <p className="text-xs2 text-ink-3">
          <span className="font-medium text-ink">Prepare: </span>
          {question.focus}
        </p>

        {hasAnswer ? (
          <div className="border-l-2 border-rule py-1 pl-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs2 font-medium text-ink-3">
              <Quote className="h-3 w-3" aria-hidden="true" />
              Model answer
            </p>
            <p className="text-sm text-ink">{question.modelAnswer}</p>
          </div>
        ) : (
          <p className="border-l-2 border-rule py-1 pl-3 text-xs2 text-ink-3">
            {message.detail}
          </p>
        )}

        {question.groundedClaimIds.length > 0 ? (
          <p className="text-xs2 text-ink-3">
            <span className="font-medium text-ink">Grounded in: </span>
            {question.groundedClaimIds.join(", ")}
            {question.answerStage.rejectedEntities.length > 0 ? (
              <>
                {" "}
                &middot;{" "}
                <span className="text-destructive">
                  refused for naming {question.answerStage.rejectedEntities.join(", ")}
                </span>
              </>
            ) : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default QuestionCard;