import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppLayout } from "@/components/layout";
import { studioRedirectFor, tailorRedirectFor, prepRedirectFor } from "./routes/legacyRedirects";
import { Loader2 } from "lucide-react";

const Index = lazy(() => import("./pages/Index"));
const GetStarted = lazy(() => import("./pages/GetStarted"));
const Upload = lazy(() => import("./pages/Upload"));
// T1070 + T1101: the evidence-level match report is THE `/app/match` page, unconditionally.
//
// T1110 kept a flag-aware element here (`flags.v2ResumeStudio ? <Match /> : <MatchLegacy />`)
// for exactly one reason: `MatchLegacy` and `features/job-match` were explicitly retained, and
// pinning the element would have left both unreachable with no live caller. T1101 retired that
// reason. `MatchLegacy`'s whole output was `JobMatch.matchScore` rendered as a percentage, which
// is the surface 06 sec. E.6 orders replaced, and `atsApi.matchJob` no longer even returns the
// number. So both files are DELETED and `/app/match` is the V2 report in every build.
//
// THAT IS ALSO THE LAST READ OF `flags.v2ResumeStudio` IN THIS FILE. The env KEY stays in
// `src/lib/flags.ts` and in `backend/src/config/flags.ts` because `src/lib/flags.test.ts` asserts
// the two runtimes name the same three keys; nothing reads its value in the UI any more, and
// `V2_TYPST_RENDER` is the only flag that still governs anything.
const Match = lazy(() => import("./pages/Match"));
const Jobs = lazy(() => import("./pages/Jobs"));
const Applications = lazy(() => import("./pages/Applications"));
const Insights = lazy(() => import("./pages/Insights"));
const ApplicationWorkspace = lazy(() => import("./pages/ApplicationWorkspace"));
const Settings = lazy(() => import("./pages/Settings"));
const Profile = lazy(() => import("./pages/Profile"));
// T1110 (cutover): the V2 surfaces are FIRST CLASS. `v2ResumeStudio` used to gate the
// registration of `/app/career`, `/app/studio`, `/app/tailor` and `/app/interview-prep` - with
// the flag off those paths were not in the table at all and fell through to the catch-all
// NotFound. The legacy builder they replace is DELETED, so there is no longer a state in
// which they may be absent: the gate is gone and all four register unconditionally. The
// `v2ResumeStudio` flag itself is untouched in `src/lib/flags.ts` and in the backend reader,
// because `src/lib/flags.test.ts` asserts that the two runtimes name the same three keys.
//
// `/app/career` is the successor BOTH retired questionnaire paths redirect to. The dedicated
// Career Interview wizard 06-design describes is NOT built yet, so `/app/career` (the evidence
// layer the wizard would feed) is what a user lands on - see `routes/legacyRedirects.ts`.
const CareerProfile = lazy(() => import("./pages/CareerProfile"));
// T1021: THE CAREER INTERVIEW, the successor of the retired fabricating questionnaire
// (FREEZE A-25). `/app/career` - the evidence layer the wizard feeds - is now also where the
// wizard's finish action lands, because a wizard that produced claims and then stopped would
// leave the user holding an unconfirmed list and no way to act on it.
//
// UNGATED for the same reason as every other V2 route (see the note above): the legacy
// builder is deleted, so there is no flag-off state in which this may be absent - and the
// two retired `/get-started/ai*` URLs now redirect HERE, so a flag-gated wizard would turn a
// public entry point into a 404.
const CareerInterview = lazy(() => import("./pages/CareerInterview"));
// T1050: the structured Resume Studio - the editor. It is the successor of the retired
// `/app/build` builder (FREEZE A-24), so both the bare chooser and the parametrised editor
// are registered, and `/app/build*` redirects here rather than 404-ing.
const Studio = lazy(() => import("./pages/Studio"));
// T1080: the tailoring surface - OPERATIONS with a fact-delta guard, never a rewritten
// document. Both the chooser and the parametrised surface are registered, ungated.
const Tailor = lazy(() => import("./pages/Tailor"));
// T1090: the interview-prep surface - DERIVED risks with the rows they came from, and
// questions anchored to those risks. Both forms registered, ungated.
const InterviewPrep = lazy(() => import("./pages/InterviewPrep"));
// T1100: the TWO-DAY PROJECT ENGINE. Its input is the match report's NAMED GAPS, so it sits
// directly after `/app/match` in the table - the user reaches it from a gap they just read.
//
// The element is lazy-imported from `features/project-discovery/` rather than from `pages/`, and
// that is a deliberate exception to the convention above: the route, the run, the gap selection
// and the three decisions are ONE feature, and a `pages/` wrapper would have been a two-line
// file between a directory and its own components. The code-splitting boundary is identical, and
// `src/AppRouteTable.test.ts` resolves the href against this declaration either way.
const ProjectDiscovery = lazy(
  () => import("./features/project-discovery/ProjectDiscoveryPage"),
);
const Resumes = lazy(() => import("./pages/Resumes"));
const QABank = lazy(() => import("./pages/QABank"));
const Admin = lazy(() => import("./pages/Admin"));
const Auth = lazy(() => import("./pages/Auth"));
const Terms = lazy(() => import("./pages/Terms"));
const Privacy = lazy(() => import("./pages/Privacy"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        const status =
          err && typeof err === "object" && "status" in err
            ? (err as { status?: unknown }).status
            : undefined;
        const is4xx =
          typeof status === "number" && status >= 400 && status < 500;
        return count < 1 && !is4xx;
      },
    },
    mutations: { retry: 0 },
  },
});

const RouteFallback = () => (
  <div className="flex min-h-screen items-center justify-center bg-background">
    <Loader2 className="h-8 w-8 animate-spin text-primary" />
  </div>
);

/**
 * `/app/build/:resumeId` -> `/app/studio/:resumeId` (T1110).
 *
 * A component rather than a bare `<Navigate to="/app/studio/:resumeId">` because
 * `react-router` does NOT substitute route params in a `<Navigate>`'s `to`: `useNavigate`
 * resolves relative to the route's ANCESTOR matches, and the leaf - the only match carrying
 * `resumeId` - is sliced off. A literal template would therefore navigate to the literal
 * string `/app/studio/:resumeId`. `studioRedirectFor` reads the param and builds the target;
 * `replace` so the back button skips the retired path rather than bouncing through it.
 *
 * `AppRouteTable.test.ts` asserts both halves: that this component is what the route is
 * declared with, and that `studioRedirectFor` produces the right target for a param and for
 * no param at all.
 */
function LegacyBuilderRedirect() {
  const params = useParams<{ resumeId: string }>();
  return <Navigate to={studioRedirectFor(params)} replace />;
}

/**
 * `/app/tailor/:resumeId` -> `/app/match/tailor/:resumeId` (IA merge).
 * Same reason as `LegacyBuilderRedirect`: `<Navigate>` does not substitute route params.
 */
function LegacyTailorRedirect() {
  const params = useParams<{ resumeId: string }>();
  return <Navigate to={tailorRedirectFor(params)} replace />;
}

/**
 * `/app/interview-prep/:resumeId` -> `/app/interview/prep/:resumeId` (IA merge).
 */
function LegacyPrepRedirect() {
  const params = useParams<{ resumeId: string }>();
  return <Navigate to={prepRedirectFor(params)} replace />;
}

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              {/* Public routes */}
              <Route path="/" element={<Index />} />
              <Route path="/get-started" element={<GetStarted />} />
              {/* T1021: both questionnaire URLs are retired (FREEZE A-25) and now redirect to the
                  Career Interview wizard that REPLACED them. The cutover pointed them at
                  `/app/career`, the evidence layer, because the wizard did not exist yet; it
                  does now, and the contract wants the successor URL to land on the successor
                  page. Kept as PUBLIC routes that redirect, not moved inside the protected
                  layout: a logged-out visitor deep-linking `/get-started/ai` is sent to
                  `/app/career-interview`, where `ProtectedRoute` sends them to sign in - one
                  predictable hop, rather than a redirect that bounces a signed-out visitor
                  back here in a loop. */}
              <Route path="/get-started/ai" element={<Navigate to="/app/interview" replace />} />
              <Route path="/get-started/ai-build" element={<Navigate to="/app/interview" replace />} />
              <Route path="/auth" element={<Auth />} />
                                                        <Route path="/terms" element={<Terms />} />
              <Route path="/privacy" element={<Privacy />} />
              
              {/* Protected routes - require authentication */}
              <Route path="/app" element={<Navigate to="/app/resumes" replace />} />
              <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
                <Route path="/app/resumes" element={<Resumes />} />
                <Route path="/app/upload" element={<Upload />} />
                {/* T1110: the legacy builder is DELETED. These two are the cutover's real
                    contract - a bookmark, an old email link or a V1 row id typed by hand lands
                    on the Studio with the same resume id, and the back button skips the
                    retired path because both are `replace`. */}
                <Route path="/app/build" element={<Navigate to="/app/studio" replace />} />
                <Route path="/app/build/:resumeId" element={<LegacyBuilderRedirect />} />
                {/* T1101: `/app/match` is the V2 evidence-level report in EVERY build. The V1
                    page behind the flag-off element is deleted - see the note on the `Match`
                    lazy import. */}
                <Route path="/app/match" element={<Match />} />
                {/* T1100's project engine is the Projects tab of Match now. The old URL
                    redirects here so a bookmark still lands on the engine. */}
                <Route path="/app/match/projects" element={<ProjectDiscovery />} />
                <Route path="/app/project-discovery" element={<Navigate to="/app/match/projects" replace />} />
                {/* Both jobs routes render the same page so the search results
                    list stays mounted when a row is selected or browser
                    back/forward is used. Selection is driven by the :id param. */}
                <Route path="/app/jobs" element={<Jobs />} />
                <Route path="/app/jobs/:id" element={<Jobs />} />
                {/* IA merge: Profile is two tabs. Career record is the evidence layer; Job
                    preferences is the V1 job-search form. `/app/career` redirects to the
                    Career record tab. */}
                <Route path="/app/profile" element={<CareerProfile />} />
                <Route path="/app/profile/preferences" element={<Profile />} />
                <Route path="/app/career" element={<Navigate to="/app/profile" replace />} />
                {/* Interview is three tabs. `/app/career-interview` is the Rehearsal tab. */}
                <Route path="/app/interview" element={<CareerInterview />} />
                <Route path="/app/career-interview" element={<Navigate to="/app/interview" replace />} />
                <Route path="/app/studio" element={<Studio />} />
                <Route path="/app/studio/:resumeId" element={<Studio />} />
                {/* Tailor is the Tailor tab of Match; both old URLs redirect. */}
                <Route path="/app/match/tailor" element={<Tailor />} />
                <Route path="/app/match/tailor/:resumeId" element={<Tailor />} />
                <Route path="/app/tailor" element={<Navigate to="/app/match/tailor" replace />} />
                <Route path="/app/tailor/:resumeId" element={<LegacyTailorRedirect />} />
                {/* Interview Prep is the Prep tab of Interview; both old URLs redirect. */}
                <Route path="/app/interview/prep" element={<InterviewPrep />} />
                <Route path="/app/interview/prep/:resumeId" element={<InterviewPrep />} />
                <Route path="/app/interview-prep" element={<Navigate to="/app/interview/prep" replace />} />
                <Route path="/app/interview-prep/:resumeId" element={<LegacyPrepRedirect />} />
                <Route path="/app/applications" element={<Applications />} />
                <Route path="/app/insights" element={<Insights />} />
                <Route path="/app/applications/:id" element={<ApplicationWorkspace />} />
                {/* The Q&A Bank is the Question bank tab of Interview. */}
                <Route path="/app/interview/questions" element={<QABank />} />
                <Route path="/app/qa-bank" element={<Navigate to="/app/interview/questions" replace />} />
                <Route path="/app/qa" element={<Navigate to="/app/interview/questions" replace />} />
                <Route path="/app/settings" element={<Settings />} />
                {/* T1101: the ATS scan surfaces are RETIRED. Both were score screens - a
                    0-100 dial and a score history - and 06 sec. E.6 forbids that anywhere. Both
                    `replace` (see `routes/legacyRedirects.ts`) and both land on `/app/match`,
                    which reports counts and named gaps instead. The deterministic scanner still
                    RUNS on the backend as an internal signal; nothing presents it. */}
                <Route path="/app/ats-scan" element={<Navigate to="/app/match" replace />} />
                <Route path="/app/ats-history" element={<Navigate to="/app/match" replace />} />
                <Route path="/app/admin" element={<Admin />} />
              </Route>
              
              {/* Catch-all */}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;
