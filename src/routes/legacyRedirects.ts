// Where every retired path goes after the sidebar merge.
//
// WHY THIS IS A MODULE AND NOT A COMMENT IN `App.tsx`. The route table has to answer two
// questions that are checked by different means: "does every retired path have a redirect
// declared" (a source-level check on `src/App.tsx`) and "what is the redirect for a resume
// id" (a pure function). Keeping the mapping here means the answer to the second question is
// unit-testable without a DOM - ADR-031 decision 3 keeps this repo in vitest's `node`
// environment, so `AppRouteTable.test.ts` asserts this module directly and the table's
// DECLARATION in `App.tsx` separately.
//
// THE PARAMETRISED ONES ARE THE INTERESTING CASE. `react-router`'s `<Navigate to>` does not
// substitute `:params` in its `to` string: `useNavigate` resolves against the ANCESTOR
// matches of the route it is called from (`getResolveToMatches` slices the leaf off), so
// `<Route path="/app/tailor/:resumeId" element={<Navigate to="/app/match/tailor/:resumeId" />} />`
// would navigate to the literal string with `:resumeId` in it. The `*RedirectFor` functions
// are therefore the real implementation and the two-line components in `App.tsx` read the
// param and hand it over.

export interface LegacyRouteRedirect {
  from: string;
  to: string;
  /** Why this path moved, in one line. Kept next to the mapping so it cannot drift. */
  because: string;
}

/** Every retired path, and the canonical path it resolves to. `:param` paths are below. */
export const LEGACY_ROUTE_REDIRECTS: ReadonlyArray<LegacyRouteRedirect> = [
  {
    from: '/app/build',
    to: '/app/studio',
    because: 'the builder shell is retired; the Studio is the editor now (FREEZE A-24)',
  },
  {
    from: '/app/career',
    to: '/app/profile',
    because: 'the evidence layer is the Career record tab of Profile now',
  },
  {
    from: '/app/career-interview',
    to: '/app/interview',
    because: 'the Career Interview is the Rehearsal tab of Interview now',
  },
  {
    from: '/app/qa-bank',
    to: '/app/interview/questions',
    because: 'the Q&A Bank is the Question bank tab of Interview now',
  },
  {
    from: '/app/qa',
    to: '/app/interview/questions',
    because: 'the old short alias follows the Q&A Bank into Interview',
  },
  {
    from: '/app/interview-prep',
    to: '/app/interview/prep',
    because: 'Interview Prep is the Prep tab of Interview now',
  },
  {
    from: '/app/tailor',
    to: '/app/match/tailor',
    because: 'Tailor is the Tailor tab of Match now',
  },
  {
    from: '/app/project-discovery',
    to: '/app/match/projects',
    because: 'Two-day Projects is the Projects tab of Match now',
  },
  {
    from: '/get-started/ai',
    to: '/app/interview',
    because:
      'the fabricating questionnaire is retired; the Career Interview wizard is its successor, and it ends in the verification list at /app/profile (FREEZE A-25, T1021)',
  },
  {
    from: '/get-started/ai-build',
    to: '/app/interview',
    because: 'the same questionnaire under its second URL (FREEZE A-25, T1021)',
  },
  // T1101 / T1110: the two ATS scan surfaces are RETIRED. Both existed to show one number -
  // `ATSReport.overallScore` out of 100 with a `good`/`needs-work` grade beside it - and 06
  // sec. E.6 forbids that anywhere, ever. `/app/match` is the successor: four counts over the
  // statements you have confirmed, plus the gaps BY NAME, with Confirm/Reject on the two
  // proposal levels. It is also where the deterministic scanner's remaining honest output lives:
  // the keywords it found and the keywords it did not.
  {
    from: '/app/ats-scan',
    to: '/app/match',
    because: 'the ATS score screen is retired; Job Match reports counts and named gaps (06 sec. E.6)',
  },
  {
    from: '/app/ats-history',
    to: '/app/match',
    because: 'the score history is retired; the stored scans stay on disk, unpresented (T1101)',
  },
];

/**
 * `/app/build/:resumeId` -> `/app/studio/:resumeId`, and the bare path to the chooser.
 *
 * The bare case matters: a redirect that produced `/app/studio/:resumeId` for a request with
 * no id would land on a 404, which is the exact dead end this task exists to remove.
 */
export function studioRedirectFor(params: Readonly<Record<string, string | undefined>>): string {
  const resumeId = params.resumeId;
  return resumeId ? `/app/studio/${resumeId}` : '/app/studio';
}

/** `/app/tailor/:resumeId` -> `/app/match/tailor/:resumeId`. */
export function tailorRedirectFor(params: Readonly<Record<string, string | undefined>>): string {
  const resumeId = params.resumeId;
  return resumeId ? `/app/match/tailor/${resumeId}` : '/app/match/tailor';
}

/** `/app/interview-prep/:resumeId` -> `/app/interview/prep/:resumeId`. */
export function prepRedirectFor(params: Readonly<Record<string, string | undefined>>): string {
  const resumeId = params.resumeId;
  return resumeId ? `/app/interview/prep/${resumeId}` : '/app/interview/prep';
}

/** The parametrised retired paths. Each is declared with a redirect component in `App.tsx`. */
export const LEGACY_PARAM_REDIRECTS: ReadonlyArray<{
  from: string;
  to: string;
  because: string;
}> = [
  {
    from: '/app/build/:resumeId',
    to: '/app/studio/:resumeId',
    because: 'the legacy builder editor moved to the Studio, keeping the resume id',
  },
  {
    from: '/app/tailor/:resumeId',
    to: '/app/match/tailor/:resumeId',
    because: 'Tailor is the Tailor tab of Match now, keeping the resume id',
  },
  {
    from: '/app/interview-prep/:resumeId',
    to: '/app/interview/prep/:resumeId',
    because: 'Interview Prep is the Prep tab of Interview now, keeping the resume id',
  },
];

/** Every retired path, including the parametrised ones, for the route-table test's sweep. */
export const ALL_RETIRED_PATHS: readonly string[] = [
  ...LEGACY_ROUTE_REDIRECTS.map((row) => row.from),
  ...LEGACY_PARAM_REDIRECTS.map((row) => row.from),
];
