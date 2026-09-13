import { Suspense, lazy } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Loader2 } from "lucide-react";

const Index = lazy(() => import("./pages/Index"));
const GetStarted = lazy(() => import("./pages/GetStarted"));
const AIBuild = lazy(() => import("./pages/AIBuild"));
const Build = lazy(() => import("./pages/Build"));
const Upload = lazy(() => import("./pages/Upload"));
const Match = lazy(() => import("./pages/Match"));
const Jobs = lazy(() => import("./pages/Jobs"));
const JobDetail = lazy(() => import("./pages/JobDetail"));
const Applications = lazy(() => import("./pages/Applications"));
const Settings = lazy(() => import("./pages/Settings"));
const Profile = lazy(() => import("./pages/Profile"));
const ATSScan = lazy(() => import("./pages/ATSScan"));
const ATSHistory = lazy(() => import("./pages/ATSHistory"));
const Resumes = lazy(() => import("./pages/Resumes"));
const QABank = lazy(() => import("./pages/QABank"));
const Admin = lazy(() => import("./pages/Admin"));
const QuestionAnswers = lazy(() => import("./pages/QuestionAnswers"));
const Auth = lazy(() => import("./pages/Auth"));
const Terms = lazy(() => import("./pages/Terms"));
const Privacy = lazy(() => import("./pages/Privacy"));
const NotFound = lazy(() => import("./pages/NotFound"));

const queryClient = new QueryClient();

const RouteFallback = () => (
  <div className="flex min-h-screen items-center justify-center bg-background">
    <Loader2 className="h-8 w-8 animate-spin text-primary" />
  </div>
);

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
              <Route path="/get-started/ai" element={<AIBuild />} />
              <Route path="/get-started/ai-build" element={<AIBuild />} />
              <Route path="/auth" element={<Auth />} />
                                                        <Route path="/terms" element={<Terms />} />
              <Route path="/privacy" element={<Privacy />} />
              
              {/* Protected routes - require authentication */}
              <Route path="/app" element={<Navigate to="/app/resumes" replace />} />
              <Route path="/app/resumes" element={
                <ProtectedRoute>
                  <Resumes />
                </ProtectedRoute>
              } />
              <Route path="/app/upload" element={
                <ProtectedRoute>
                  <Upload />
                </ProtectedRoute>
              } />
              <Route path="/app/build" element={
                <ProtectedRoute>
                  <Build />
                </ProtectedRoute>
              } />
              <Route path="/app/build/:resumeId" element={
                <ProtectedRoute>
                  <Build />
                </ProtectedRoute>
              } />
              <Route path="/app/match" element={
                <ProtectedRoute>
                  <Match />
                </ProtectedRoute>
              } />
              <Route path="/app/jobs" element={
                <ProtectedRoute>
                  <Jobs />
                </ProtectedRoute>
              } />
              <Route path="/app/jobs/:id" element={
                <ProtectedRoute>
                  <JobDetail />
                </ProtectedRoute>
              } />
              <Route path="/app/profile" element={
                <ProtectedRoute>
                  <Profile />
                </ProtectedRoute>
              } />
              <Route path="/app/applications" element={
                <ProtectedRoute>
                  <Applications />
                </ProtectedRoute>
              } />
              <Route path="/app/qa-bank" element={
                <ProtectedRoute>
                  <QABank />
                </ProtectedRoute>
              } />
              <Route path="/app/qa" element={
                <ProtectedRoute>
                  <QuestionAnswers />
                </ProtectedRoute>
              } />
              <Route path="/app/settings" element={
                <ProtectedRoute>
                  <Settings />
                </ProtectedRoute>
              } />
              <Route path="/app/ats-scan" element={
                <ProtectedRoute>
                  <ATSScan />
                </ProtectedRoute>
              } />
              <Route path="/app/ats-history" element={
                <ProtectedRoute>
                  <ATSHistory />
                </ProtectedRoute>
              } />
              <Route path="/app/admin" element={
                <ProtectedRoute>
                  <Admin />
                </ProtectedRoute>
              } />
              
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
