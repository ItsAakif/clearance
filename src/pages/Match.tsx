import { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout";
import { JobMatchResults } from "@/features/job-match";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Search, FileText, Loader2, Upload } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useResumes } from "@/hooks/useResumeApi";
import { uploadedFilesApi, type UploadedFileSummary } from "@/services/api/resume";
import { atsApi } from "@/services/api/ats";
import { useToast } from "@/hooks/use-toast";

interface MatchResult {
  id?: string;
  matchScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  suggestions: string[];
  detectedRole?: string | null;
  criticalMissing?: string[];
  preferredMissing?: string[];
  roleSuggestions?: string[];
  tailoringTips?: string[];
}

export default function MatchPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [jobDescription, setJobDescription] = useState("");
  const [selectedResumeId, setSelectedResumeId] = useState("");
  const [selectedUploadedFileId, setSelectedUploadedFileId] = useState("");
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const initializedRef = useRef(false);

  const { data: resumes = [], isLoading: loadingResumes } = useResumes();
  const { toast } = useToast();

  // Initialize selectedResumeId from query param once resumes are loaded
  useEffect(() => {
    if (initializedRef.current) return;
    const qResumeId = searchParams.get("resumeId");
    if (qResumeId && resumes.some((r) => r.id === qResumeId)) {
      setSelectedResumeId(qResumeId);
    }
    initializedRef.current = true;
  }, [searchParams, resumes]);

  // Raw uploaded files (PDF/DOCX/TXT) - stored for Job Match only, never parsed
  // into builder resumes and never shown in "My Resumes".
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileSummary[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    uploadedFilesApi
      .list()
      .then(setUploadedFiles)
      .catch(() => setUploadedFiles([]));
  }, []);

  const handleFileUpload = async (file: File) => {
    setIsUploading(true);
    try {
      const created = await uploadedFilesApi.upload(file);
      const list = await uploadedFilesApi.list();
      setUploadedFiles(list);
      setSelectedResumeId("");
      setSelectedUploadedFileId(created.id);
      toast({ title: "File uploaded", description: `"${created.fileName}" is ready to match.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed";
      toast({ title: "Upload failed", description: message, variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };
  
  const hasSelection = Boolean(selectedResumeId || selectedUploadedFileId);

  const handleAnalyse = async () => {
    if (!jobDescription.trim() || !hasSelection) {
      toast({
        title: "Please fill in all fields",
        description: "Select a resume or upload a file, and paste the job description",
        variant: "destructive",
      });
      return;
    }

    setIsAnalyzing(true);
    try {
      const result = await atsApi.matchJob(
        { resumeId: selectedResumeId || undefined, uploadedFileId: selectedUploadedFileId || undefined },
        jobDescription.trim()
      );
      
      setMatchResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Analysis failed";
      toast({
        title: "Analysis failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Build a tailored resume from the analysed JD + the user's selected resume,
  // then open it directly in the builder.
  const handleBuildTailored = async () => {
    if (!selectedResumeId || !jobDescription.trim()) {
      toast({
        title: "Nothing to build from",
        description: "Run a match first by selecting a resume and pasting a job description.",
        variant: "destructive",
      });
      return;
    }

    setIsBuilding(true);
    try {
      const created = await atsApi.buildFromJd({
        jobDescription: jobDescription.trim(),
        resumeId: selectedResumeId,
      });
      toast({
        title: "Tailored resume created",
        description: "We built a draft based on your resume and the job description.",
      });
      navigate(`/app/build/${created.id}?jobMatchId=${matchResult?.id ?? ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Build failed";
      toast({
        title: "Could not build tailored resume",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsBuilding(false);
    }
  };

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        {/* Page header */}
        <header className="border-b border-border bg-card px-6 py-4">
          <h1 className="text-lg font-semibold text-foreground">Job Match</h1>
          <p className="text-sm text-muted-foreground">
            Compare your resume against a job description
          </p>
          {searchParams.get("resumeId") && resumes.some((r) => r.id === searchParams.get("resumeId")) && (
            <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
              Opened with a pre-selected resume from your library.
            </p>
          )}
        </header>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          <div className="mx-auto max-w-4xl space-y-6 p-6">
            {/* Resume Selection */}
            <Card className="p-6">
              <div className="mb-4 flex items-center gap-2">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <h2 className="font-semibold text-foreground">Select Resume</h2>
              </div>

              {loadingResumes ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading resumes...
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Option 1: builder resume from "My Resumes" */}
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      From My Resumes
                    </p>
                    {resumes.length > 0 ? (
                      <Select
                        value={selectedResumeId}
                        onValueChange={(v) => {
                          setSelectedResumeId(v);
                          setSelectedUploadedFileId("");
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Choose a resume to compare..." />
                        </SelectTrigger>
                        <SelectContent>
                          {resumes.map((resume) => (
                            <SelectItem key={resume.id} value={resume.id}>
                              {resume.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No builder resumes yet.
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">or</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  {/* Option 2: raw uploaded file (PDF/DOCX) - matched as-is */}
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Uploaded file (raw PDF / DOCX)
                    </p>
                    {uploadedFiles.length > 0 && (
                      <Select
                        value={selectedUploadedFileId}
                        onValueChange={(v) => {
                          setSelectedUploadedFileId(v);
                          setSelectedResumeId("");
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Choose an uploaded file..." />
                        </SelectTrigger>
                        <SelectContent>
                          {uploadedFiles.map((file) => (
                            <SelectItem key={file.id} value={file.id}>
                              {file.fileName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}

                    <Button
                      type="button"
                      variant="outline"
                      className="w-full gap-2"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isUploading}
                    >
                      {isUploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      {isUploading ? "Uploading..." : "Upload a PDF / DOCX resume"}
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.txt"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleFileUpload(file);
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Uploaded files are stored as-is and matched against the job
                      description. They are not parsed into builder resumes.
                    </p>
                  </div>
                </div>
              )}
            </Card>

            {/* Job description input */}
            <Card className="p-6">
              <div className="mb-4 flex items-center gap-2">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <h2 className="font-semibold text-foreground">Job Description</h2>
              </div>
              <Textarea
                placeholder="Paste the job description here...

Example:
We are looking for a Senior Software Engineer to join our team. You will be responsible for designing, developing, and maintaining scalable web applications. 

Requirements:
- 5+ years of experience with React and TypeScript
- Experience with cloud platforms (AWS preferred)
- Strong understanding of system design principles
- Excellent communication and leadership skills"
                className="min-h-[200px] resize-none"
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
              />
              <div className="mt-4 flex justify-end">
                <Button 
                  onClick={handleAnalyse} 
                  disabled={!jobDescription.trim() || !hasSelection || isAnalyzing}
                >
                  {isAnalyzing ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Analysing...
                    </>
                  ) : (
                    <>
                      <Search className="mr-2 h-4 w-4" />
                      Analyse Match
                    </>
                  )}
                </Button>
              </div>
            </Card>

            {/* Results */}
            {matchResult && (
              <div className="animate-fade-in">
                <h2 className="mb-4 text-lg font-semibold text-foreground">
                  Match Analysis
                </h2>
                <JobMatchResults
                  {...matchResult}
                  isBuilding={isBuilding}
                  onBuildTailored={selectedResumeId ? handleBuildTailored : undefined}
                />
              </div>
            )}
          </div>
        </div>
      </div>

    </AppLayout>
  );
}
