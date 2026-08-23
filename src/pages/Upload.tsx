import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DotGridSection } from "@/components/backgrounds";
import { LandingHeader } from "@/components/layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileText, CheckCircle2, ArrowRight, ArrowLeft, AlertCircle, Loader2 } from "lucide-react";
import { ATSQuickScore } from "@/components/ats";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { AnimatedButton, StepIndicator } from "@/components/animations";
import { resumeApi } from "@/services/api/resume";
import { useToast } from "@/hooks/use-toast";
import type { Resume } from "@/types/resume";
import type { ResumeData } from "@/types/resume";

function toResumeData(resume: Resume): ResumeData {
  return {
    personalInfo: resume.personalInfo,
    summary: resume.summary,
    experience: resume.experience,
    education: resume.education,
    skills: resume.skills.map((skill) => skill.name),
  };
}

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

  const handleContinue = () => {
    if (uploadedResume) {
      navigate(`/app/build/${uploadedResume.id}?from=upload`);
    } else {
      navigate("/app/build?from=upload");
    }
  };

  const handleReset = () => {
    setUploadedFile(null);
    setUploadState("idle");
    setErrorMessage("");
    setUploadedResume(null);
  };

  return (
    <div className="min-h-screen bg-background">
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
              className="mb-6 flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to options
            </button>
          </motion.div>

          {/* Header */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mb-8 text-center"
          >
            <h1 className="text-2xl font-semibold text-foreground md:text-3xl">
              Upload your resume
            </h1>
            <p className="mt-2 text-muted-foreground">
              We'll extract your content and help you optimise it
            </p>
          </motion.div>

          {/* Upload Card */}
          <AnimatePresence mode="wait">
            {(uploadState === "idle" || uploadState === "error") && (
              <motion.div
                key="upload"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.3 }}
              >
                <Card
                  className={cn(
                    "relative border-2 border-dashed p-12 text-center transition-all duration-200",
                    isDragging
                      ? "border-primary bg-primary/5"
                      : uploadState === "error"
                      ? "border-destructive/50 bg-destructive/5"
                      : "border-border hover:border-muted-foreground/50"
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
                  />
                  
                  <motion.div
                    animate={isDragging ? { scale: 1.1 } : { scale: 1 }}
                    className={cn(
                      "mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full transition-colors",
                      uploadState === "error" ? "bg-destructive/10" : "bg-secondary"
                    )}
                  >
                    {uploadState === "error" ? (
                      <AlertCircle className="h-8 w-8 text-destructive" />
                    ) : (
                      <Upload className={cn("h-8 w-8", isDragging ? "text-primary" : "text-muted-foreground")} />
                    )}
                  </motion.div>

                  <h2 className="mb-2 text-lg font-semibold text-foreground">
                    {isDragging ? "Drop your file here" : "Drop your resume here"}
                  </h2>
                  <p className="mb-4 text-sm text-muted-foreground">
                    or click to browse your files
                  </p>

                  {uploadState === "error" && (
                    <motion.p
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="mb-4 text-sm font-medium text-destructive"
                    >
                      {errorMessage}
                    </motion.p>
                  )}

                  <div className="flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-full bg-secondary px-3 py-1">PDF</span>
                    <span className="rounded-full bg-secondary px-3 py-1">DOCX</span>
                    <span className="rounded-full bg-secondary px-3 py-1">TXT</span>
                    <span className="rounded-full bg-secondary px-3 py-1">Max 10MB</span>
                  </div>
                </Card>
              </motion.div>
            )}

            {(uploadState === "uploading" || uploadState === "processing") && (
              <motion.div
                key="processing"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.3 }}
              >
                <Card className="p-12 text-center">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                    className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10"
                  >
                    <Loader2 className="h-8 w-8 text-primary" />
                  </motion.div>

                  <h2 className="mb-2 text-lg font-semibold text-foreground">
                    {uploadState === "uploading" ? "Uploading..." : "Processing your resume..."}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {uploadState === "uploading"
                      ? "Please wait while we upload your file"
                      : "Extracting content and analysing structure"}
                  </p>

                  {uploadedFile && (
                    <div className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                      <FileText className="h-4 w-4" />
                      {uploadedFile.name}
                    </div>
                  )}
                </Card>
              </motion.div>
            )}

            {uploadState === "success" && (
              <motion.div
                key="success"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.3 }}
              >
                <Card className="p-8 text-center">
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 15 }}
                    className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-success/10"
                  >
                    <CheckCircle2 className="h-8 w-8 text-success" />
                  </motion.div>

                  <h2 className="mb-2 text-lg font-semibold text-foreground">
                    Resume uploaded successfully
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    We've extracted your content and it's ready for editing
                  </p>

                  {uploadedFile && (
                    <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-border bg-secondary/50 px-4 py-2 text-sm">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <span className="text-foreground">{uploadedFile.name}</span>
                    </div>
                  )}

                  {/* ATS Quick Score */}
                  <div className="mt-6">
                    <ATSQuickScore
                      variant="card"
                      resumeData={uploadedResume ? toResumeData(uploadedResume) : undefined}
                    />
                  </div>

                  <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
                    <AnimatedButton
                      variant="hero"
                      onClick={handleContinue}
                      className="gap-2"
                      glowOnHover
                    >
                      Continue to Templates
                      <ArrowRight className="h-4 w-4" />
                    </AnimatedButton>
                    <Button
                      variant="outline"
                      onClick={handleReset}
                    >
                      Upload Different File
                    </Button>
                  </div>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Help text */}
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5 }}
            className="mt-6 text-center text-xs text-muted-foreground"
          >
            Your file is processed securely and never shared with third parties
          </motion.p>
        </div>
      </DotGridSection>
    </div>
  );
}
