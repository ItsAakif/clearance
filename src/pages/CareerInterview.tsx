// CareerInterview (T1021) - the Career Interview wizard page.
//
// This page REPLACES the fabricating AI wizard (`src/pages/AIBuild.tsx`, FREEZE A-25,
// deleted at the cutover). The difference is the whole point, and it is stated in the shell
// rather than left to be discovered:
//   - it produces CANDIDATE CLAIMS, never a resume;
//   - it cannot confirm anything - every claim it creates is `inferred`, and confirming one
//     is a separate, audited decision on the Career Evidence page (ADR-036);
//   - it needs an AI provider, and refuses honestly without one instead of running a
//     template questionnaire that would look like it worked.
//
// The page is deliberately THIN: it renders `InterviewWizard` and nothing else, because the
// wizard itself is where the state lives and `features/interview/interviewModel.ts` is where
// the rules are (both stated in their own headers - the split exists so the rules are
// testable in this repo's node-environment runner).
//
// NOT FLAG GATED. T1110 removed the `v2ResumeStudio` gate from every V2 route because the
// legacy surfaces those routes replace are deleted; there is no longer a state in which the
// wizard may be absent, and the two retired `/get-started/ai*` URLs now redirect here, so a
// flag-gated wizard would 404 a public entry point.

import { PageShell } from "@/components/layout/PageShell";
import { SectionView } from "@/components/layout/SectionView";
import { InterviewSectionTabs } from "@/components/layout/SectionTabs";
import { InterviewWizard } from "@/features/interview/InterviewWizard";

export default function CareerInterview() {
  return (
    <PageShell title="Interview" width="prose">
      <InterviewSectionTabs />
      <SectionView
        title="Career interview"
        description="Answer in your own words and we turn it into candidate statements you check one by one. Nothing is confirmed until you confirm it."
      />
      <div className="space-y-4">
        <InterviewWizard />
      </div>
    </PageShell>
  );
}