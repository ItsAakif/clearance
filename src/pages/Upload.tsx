import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { FileText, ArrowRight, ArrowLeft, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { AnimatedButton, StepIndicator } from "@/components/animations";
import { resumeApi } from "@/services/api/resume";
import { useToast } from "@/hooks/use-toast";
import type { Resume } from "@/types/resume";

type UploadState = "idle" | "uploading" | "processing" | "success" | "error";

export default function UploadPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [isDragging, setIsDragging] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [uploadedResume, setUploadedResume] = useState<Resume | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const validateFile = (file: File): boolean => {
    const validTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "text/plain",
    ];
    
    if (!validTypes.includes(file.type)) {
      setErrorMessage("Please upload a PDF, DOCX, or TXT file");
      setUploadState("error");
      return false;
    }

    if (file.size > 10 * 1024 * 1024) {
      setErrorMessage("File size must be less than 10MB");
      setUploadState("error");
      return false;
    }

    return true;
  };

  const processFile = useCallback(async (file: File) => {
    setUploadedFile(file);
    setUploadState("uploading");
    setErrorMessage("");

    try {
      // Upload file to backend
      setUploadState("processing");
      const resume = await resumeApi.uploadFile(file);
      
      setUploadedResume(resume);
      setUploadState("success");
      
      toast({
        title: "Resume uploaded successfully",
        description: `Created: ${resume.name}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      setErrorMessage(message);
      setUploadState("error");
      
      toast({
        title: "Upload failed",
        description: message,
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (validateFile(file)) {
        processFile(file);
      }
    }
  }, [processFile]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (validateFile(file)) {
        processFile(file);
      }
    }
  }, [processFile]);

  // T1110: `/app/build` is deleted (FREEZE A-24). The uploaded row opens in the Studio, which
  // is the editor's successor; the Studio's own "no revisions yet" empty state is the honest
  // answer for a row that has never been projected, and it is where upgrade-on-open picks it
  // up. `?from=upload` is dropped: nothing downstream read it.
  const handleContinue = () => {
    if (uploadedResume) {
      navigate(`/app/studio/${uploadedResume.id}`);
    } else {
      navigate("/app/studio");
    }
  };

  const handleReset = () => {
    setUploadedFile(null);
    setUploadState("idle");
    setErrorMessage("");
    setUploadedResume(null);
  };

  return (
    <div className="min-h-screen bg-paper">
      <LandingHeader />

      <DotGridSection className="flex items-center justify-center" minHeight="min-h-screen">
        <div className="mx-auto w-full max-w-xl px-6 py-24 pt-32">
          {/* Step Indicator */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mb-8"
          >
            <StepIndicator currentStep={2} totalSteps={3} />
          </motion.div>

          {/* Back button */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            <button
              onClick={() => navigate("/get-started")}
              className="mb-6 flex items-center gap-2 text-sm text-ink-3 transition-colors hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to options
            </button>
          </motion.div>

          {/* Header: page title, one context line, hairline. */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="border-b border-rule pb-4"
          >
            <h1 className="page-title text-ink">Upload your resume</h1>
            <p className="mt-1 text-sm text-ink-3">
              We extract your content, then you confirm every statement before it can be rendered.
            </p>
          </motion.div>

          <AnimatePresence mode="wait">
            {(uploadState === "idle" || uploadState === "error") && (
              <motion.div
                key="upload"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              >
                <div
                  className={cn(
                    "relative mt-6 rounded-card border border-dashed bg-card p-8 transition-colors duration-150",
                    isDragging
                      ? "border-accent-hi bg-accent"
                      : uploadState === "error"
                      ? "border-destructive/50"
                      : "border-border hover:border-rule-strong"
                  )}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <input
                    type="file"
                    accept=".pdf,.docx,.doc,.txt"
                    onChange={handleFileSelect}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    aria-label="Choose a resume file"
                  />
                  <p className="text-base font-medium text-ink">
                    {isDragging ? "Drop your file here" : "Drop your resume here"}
                  </p>
                  <p className="mt-1 text-sm text-ink-3">or click to browse your files</p>
                  {uploadState === "error" && (
                    <p className="mt-3 text-sm text-destructive">{errorMessage}</p>
                  )}
                  <p className="mt-4 text-xs2 text-ink-3">PDF, DOCX, TXT - max 10 MB</p>
                </div>
              </motion.div>
            )}

            {(uploadState === "uploading" || uploadState === "processing") && (
              <motion.div
                key="processing"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="surface-card mt-6 flex items-start gap-3 p-5"
              >
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-ink-3" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-base font-medium text-ink">
                    {uploadState === "uploading" ? "Uploading..." : "Processing your resume..."}
                  </p>
                  <p className="mt-0.5 text-sm text-ink-3">
                    {uploadState === "uploading"
                      ? "Please wait while we upload your file"
                      : "Extracting content and analysing structure"}
                  </p>
                  {uploadedFile && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs2 text-ink-3">
                      <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                      {uploadedFile.name}
                    </p>
                  )}
                </div>
              </motion.div>
            )}

            {uploadState === "success" && (
              <motion.div
                key="success"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="surface-card mt-6 p-5"
              >
                <h2 className="section-label">Resume uploaded successfully</h2>
                <div className="mt-2 border-t border-rule" />
                <p className="mt-2 text-sm text-ink-3">
                  We've extracted your content and it's ready for editing
                </p>
                {uploadedFile && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs2 text-ink-3">
                    <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                    {uploadedFile.name}
                  </p>
                )}

                {/* T1110 removed the inline ATS Quick Score card; T1101 removed its replacement link too.
                    The /app/ats-scan destination is GONE: that page existed only to draw a
                    0-100 dial and a good/needs-work grade, which 06 sec. E.6 forbids, so it
                    is retired and now redirects to /app/match. The deterministic scanner
                    still runs server-side as an internal signal (FREEZE B-16/B-17/B-18); there is
                    simply no score screen left to point at. What remains is the honest next
                    step, and nothing on this screen computes anything. */}
                <div className="mt-5 flex flex-wrap items-center gap-4">
                  <AnimatedButton variant="hero" onClick={handleContinue} className="gap-2">
                    Continue to the Studio
                    <ArrowRight className="h-4 w-4" />
                  </AnimatedButton>
                  <button
                    type="button"
                    onClick={() => navigate("/app/match")}
                    className="text-xs2 text-ink-3 underline-offset-4 hover:text-ink hover:underline"
                  >
                    Match a job to your evidence
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    className="text-xs2 text-ink-3 underline-offset-4 hover:text-ink hover:underline"
                  >
                    Upload a different file
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <p className="mt-8 text-xs2 text-ink-3">
            Your file is processed securely and never shared with third parties.
          </p>
        </div>
      </DotGridSection>
    </div>
  );
}
