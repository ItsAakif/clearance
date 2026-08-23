import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { AppLayout } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, FileText, ArrowLeft } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useResumes } from "@/hooks/useResumeApi";
import { useEvaluateJob, useCreateApplication } from "@/hooks/useJobs";
import { jobsApi } from "@/services/api";
import { JobEvaluationReport } from "@/features/jobs/JobEvaluationReport";
import { TailorPanel } from "@/features/jobs/TailorPanel";
import { useToast } from "@/hooks/use-toast";

export default function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [resumeId, setResumeId] = useState("");
  const [job, setJob] = useState<{ title: string; company: string; description: string; applyUrl?: string } | null>(null);
  const [evaluation, setEvaluation] = useState<any>(null);
  const { data: resumes = [], isLoading: loadingResumes } = useResumes();
  const evaluate = useEvaluateJob();
  const createApp = useCreateApplication();
  const { toast } = useToast();

  const loadJob = async () => {
    if (!id) return;
    const data = await jobsApi.get(id);
    setJob(data);
  };

  // Load job description on mount
  useEffect(() => {
    if (id) {
      loadJob();
    }
  }, [id]);

  const handleEvaluate = async () => {
    if (!id || !resumeId) {
      toast({ title: "Select a resume first", variant: "destructive" });
      return;
    }
    const result = await evaluate.mutateAsync({ jobId: id, resumeId, jobDescription: job?.description });
    setEvaluation(result);
  };

  const handleSave = async () => {
    if (!id) return;
    await createApp.mutateAsync({ jobListingId: id, status: "saved" });
  };

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-card px-6 py-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => window.history.back()}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
            <div>
              <h1 className="text-lg font-semibold text-foreground">{job?.title || "Job"}</h1>
              <p className="text-sm text-muted-foreground">{job?.company}</p>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-auto">
          <div className="mx-auto grid max-w-5xl gap-6 p-6 lg:grid-cols-2">
            {/* Left: JD + evaluate */}
            <div className="space-y-6">
              <Card className="p-6">
                <div className="mb-4 flex items-center gap-2">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">Job Description</h2>
                </div>
                {loadingResumes ? (
                  <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
                ) : resumes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Create a resume first.</p>
                ) : (
                  <Select value={resumeId} onValueChange={setResumeId}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="Select your resume" /></SelectTrigger>
                    <SelectContent>
                      {resumes.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                <div className="mt-4">
                  <Button onClick={handleEvaluate} disabled={!resumeId || evaluate.isPending}>
                    {evaluate.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Evaluate Fit
                  </Button>
                  <Button variant="outline" className="ml-2" onClick={handleSave}>Save to Pipeline</Button>
                </div>
              </Card>

              {job && (
                <Card className="max-h-96 overflow-auto p-6">
                  <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm text-muted-foreground">
                    {job.description?.slice(0, 4000)}
                  </div>
                </Card>
              )}
            </div>

            {/* Right: evaluation + tailor */}
            <div className="space-y-6">
              {evaluate.isError && (
                <Card className="border-destructive/40 p-4 text-sm text-destructive">
                  Evaluation failed. You may need to add your own LLM key in Settings (BYOK).
                </Card>
              )}
              {evaluation && (
                <>
                  <Card className="p-6">
                    <JobEvaluationReport evaluation={evaluation} />
                  </Card>
                  {resumeId && (
                    <TailorPanel
                      jobId={id!}
                      resumeId={resumeId}
                      evaluationId={evaluation.id}
                      jobDescription={job?.description}
                    />
                  )}
                </>
              )}
              {!evaluation && (
                <Card className="flex flex-col items-center justify-center p-10 text-center text-muted-foreground">
                  <FileText className="mb-2 h-8 w-8 opacity-40" />
                  <p className="text-sm">Evaluate this job to see the fit report and tailor your resume.</p>
                </Card>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
