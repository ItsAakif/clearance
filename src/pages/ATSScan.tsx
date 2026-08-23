import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Upload,
  AlertCircle,
  Sparkles,
  History,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { AppLayout } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { atsApi } from "@/services/api";
import type { ATSReport } from "@/types/ats";
import { LLMEvaluationReport } from "@/features/ats-report";
import { useToast } from "@/hooks/use-toast";

type ScanState = "idle" | "uploading" | "scanning" | "complete";

function getIssueSummary(report: ATSReport) {
  return report.categories.reduce(
    (summary, category) => {
      const issueCount = category.issues.length;
      const normalized = category.category.toLowerCase();

      if (normalized.includes("format")) {
        summary.formatting += issueCount;
      } else if (normalized.includes("keyword") || normalized.includes("content")) {
        summary.content += issueCount;
      } else {
        summary.parsing += issueCount;
      }

      return summary;
    },
    {
      parsing: 0,
      formatting: report.formatting.issues.length,
      content: report.keywords.missing.length,
    }
  );
}

function getFlags(report: ATSReport) {
  const issueFlags = report.categories.flatMap((category) =>
    category.issues.map((issue) => issue.suggestion || issue.description)
  );

  const keywordFlag =
    report.keywords.missing.length > 0
      ? [`Missing keywords: ${report.keywords.missing.slice(0, 5).join(", ")}`]
      : [];

  return [...report.formatting.issues, ...keywordFlag, ...issueFlags].filter(Boolean).slice(0, 6);
}

export default function ATSScanPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [result, setResult] = useState<ATSReport | null>(null);
  const [progress, setProgress] = useState(0);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const processFile = useCallback(
    async (file: File) => {
      setUploadedFile(file);
      setScanState("uploading");
      setProgress(15);

      try {
        setScanState("scanning");
        setProgress(50);
        const scanResult = await atsApi.scanResumePublic(file);
        setProgress(100);
        setResult(scanResult);
        setScanState("complete");
      } catch (error) {
        toast({
          title: "Scan failed",
          description: error instanceof Error ? error.message : "Unable to scan that resume.",
          variant: "destructive",
        });
        setUploadedFile(null);
        setProgress(0);
        setResult(null);
        setScanState("idle");
      }
    },
    [toast]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setIsDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) {
        void processFile(file);
      }
    },
    [processFile]
  );

  const handleFileSelect = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        void processFile(file);
      }
    },
    [processFile]
  );

  const handleReset = useCallback(() => {
    setScanState("idle");
    setUploadedFile(null);
    setResult(null);
    setProgress(0);
  }, []);

  const getStatusColor = (status: ATSReport["status"]) => {
    switch (status) {
      case "excellent":
        return "text-success";
      case "good":
        return "text-primary";
      case "needs-work":
        return "text-warning";
      case "poor":
        return "text-destructive";
    }
  };

  const getStatusLabel = (status: ATSReport["status"]) => {
    switch (status) {
      case "excellent":
        return "Excellent";
      case "good":
        return "Good";
      case "needs-work":
        return "Needs Work";
      case "poor":
        return "Poor";
    }
  };

  const issues = result && result.scoredBy !== "llm" ? getIssueSummary(result) : null;
  const flags = result && result.scoredBy !== "llm" ? getFlags(result) : [];

  return (
    <AppLayout>
      <main className="container mx-auto max-w-4xl px-4 pb-16 pt-8">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 text-center"
        >
          <h1 className="text-3xl font-bold text-foreground md:text-4xl">
            Check Your Resume&apos;s ATS Compatibility
          </h1>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-muted-foreground">
            Upload your resume and get an instant ATS score with actionable feedback.
          </p>
        </motion.div>

        <AnimatePresence mode="wait">
          {scanState === "idle" && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
            >
              <Card
                className={`relative overflow-hidden transition-all duration-300 ${
                  isDragging ? "ring-2 ring-primary shadow-lg" : ""
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="flex flex-col items-center justify-center p-12 text-center">
                  <div className="mb-6 rounded-full bg-primary/10 p-4">
                    <Upload className="h-8 w-8 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold text-foreground">Drop your resume here</h2>
                  <p className="mt-2 text-muted-foreground">or click to browse, PDF or DOCX</p>
                  <input
                    type="file"
                    accept=".pdf,.docx"
                    onChange={handleFileSelect}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  />
                </div>
              </Card>

              {/* Feature badges removed - now an app feature */}
            </motion.div>
          )}

          {(scanState === "uploading" || scanState === "scanning") && (
            <motion.div
              key="scanning"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
            >
              <Card className="p-12">
                <div className="flex flex-col items-center text-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                    className="mb-6 rounded-full bg-primary/10 p-4"
                  >
                    <Sparkles className="h-8 w-8 text-primary" />
                  </motion.div>
                  <h2 className="text-xl font-semibold text-foreground">
                    {scanState === "uploading" ? "Uploading..." : "Scanning your resume..."}
                  </h2>
                  <p className="mt-2 text-muted-foreground">{uploadedFile?.name}</p>
                  <Progress value={progress} className="mt-6 w-64" />
                </div>
              </Card>
            </motion.div>
          )}

          {scanState === "complete" && result && (
            <motion.div
              key="results"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <Card className="p-8">
                <div className="flex flex-col items-center text-center md:flex-row md:items-start md:gap-8 md:text-left">
                  <div className="relative mb-6 md:mb-0">
                    <div className="flex h-32 w-32 items-center justify-center rounded-full border-4 border-muted">
                      <div className="text-center">
                        <span className={`text-4xl font-bold ${getStatusColor(result.status)}`}>
                          {result.overallScore}
                        </span>
                        <span className="block text-sm text-muted-foreground">/100</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex-1">
                    <div className="mb-2 flex items-center justify-center gap-2 md:justify-start">
                      <h2 className="text-xl font-semibold text-foreground">ATS Compatibility Score</h2>
                      <Badge variant={result.status === "needs-work" ? "destructive" : "default"}>
                        {getStatusLabel(result.status)}
                      </Badge>
                      {result.scoredBy === "llm" && (
                        <Badge variant="secondary" className="gap-1">
                          <Sparkles className="h-3 w-3" />
                          AI Evaluated
                        </Badge>
                      )}
                    </div>
                     <p className="text-muted-foreground">
                       {result.scoredBy === "llm"
                         ? "Your resume was evaluated by our ATS rubric across parseability, keyword tailoring, action verbs, contact info, section completeness, and experience signals."
                         : "Your resume has some issues that may affect how well it performs with Applicant Tracking Systems. Review the flagged items below."}
                     </p>
                  </div>
                </div>
              </Card>

              {result.scoredBy === "llm" && result.evaluationJson ? (
                <>
                  <LLMEvaluationReport evaluation={result.evaluationJson} />
                  {(result.keywords.found.length > 0 || result.keywords.missing.length > 0) && (
                    <Card className="p-6">
                      <h3 className="mb-4 font-semibold text-foreground">Keyword Analysis</h3>
                      <div className="grid gap-4 sm:grid-cols-2">
                        {result.keywords.found.length > 0 && (
                          <div>
                            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-success">
                              Matched ({result.keywords.found.length})
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {result.keywords.found.slice(0, 12).map((k) => (
                                <span
                                  key={k}
                                  className="rounded-full bg-success/10 px-2.5 py-1 text-xs text-success"
                                >
                                  {k}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                        {result.keywords.missing.length > 0 && (
                          <div>
                            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-warning">
                              Suggested ({result.keywords.missing.length})
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {result.keywords.missing.slice(0, 12).map((k) => (
                                <span
                                  key={k}
                                  className="rounded-full bg-warning/10 px-2.5 py-1 text-xs text-warning"
                                >
                                  {k}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </Card>
                  )}
                </>
              ) : (
                issues && (
                  <>
                    <Card className="p-6">
                      <h3 className="mb-4 font-semibold text-foreground">Issues Found</h3>
                      <ul className="space-y-3">
                        {flags.map((flag, index) => (
                          <li key={index} className="flex items-start gap-3">
                            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                            <span className="text-muted-foreground">{flag}</span>
                          </li>
                        ))}
                      </ul>
                    </Card>

                    <div className="mt-4 grid grid-cols-3 gap-4">
                      <div className="text-center md:text-left">
                        <div className="text-2xl font-semibold text-foreground">{issues.parsing}</div>
                        <div className="text-xs text-muted-foreground">Parsing Issues</div>
                      </div>
                      <div className="text-center md:text-left">
                        <div className="text-2xl font-semibold text-foreground">{issues.formatting}</div>
                        <div className="text-xs text-muted-foreground">Formatting Issues</div>
                      </div>
                      <div className="text-center md:text-left">
                        <div className="text-2xl font-semibold text-foreground">{issues.content}</div>
                        <div className="text-xs text-muted-foreground">Content Issues</div>
                      </div>
                    </div>
                  </>
                )
              )}

              <div className="flex flex-col justify-center gap-4 sm:flex-row">
                <Button size="lg" onClick={() => navigate("/app/ats-history")}>
                  <History className="mr-2 h-5 w-5" />
                  Past Scans
                </Button>
                <Button size="lg" onClick={handleReset}>
                  Scan Another Resume
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </AppLayout>
  );
}
