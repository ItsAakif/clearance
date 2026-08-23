import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { AppLayout } from "@/components/layout";
import { TemplateRenderer, TemplateCustomizer, getAllTemplates, hasTemplate, defaultCustomization } from "@/features/resume-builder/templates";
import { TemplateThumbnail } from "@/features/resume-builder/templates/TemplateThumbnail";
import type { TemplateCustomization } from "@/features/resume-builder/templates";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Download, FileText, ChevronDown, Loader2, FileDown, File, Settings2, X, Target, Sparkles } from "lucide-react";
import { ATSQuickScore } from "@/components/ats";
import { useResumeData } from "@/hooks/useResumeData";
import { useResume } from "@/hooks/useResumeApi";
import { resumeApi } from "@/services/api/resume";
import { atsApi } from "@/services/api/ats";
import { ResumeData, Resume, defaultResumeData } from "@/types/resume";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { mapBackendTemplateToRendererId, mapRendererTemplateToBackendId } from "@/lib/templateMapping";
import { buildExportDocument } from "@/lib/exportHtml";
import { exportResumePdf } from "@/features/resume-builder/export/ResumePdf";

const htmlTemplates = getAllTemplates();

function resumeToEditorData(resume: Resume): ResumeData {
  return {
    personalInfo: resume.personalInfo,
    summary: resume.summary,
    experience: resume.experience,
    education: resume.education,
    skills: resume.skills.map((skill) => skill.name),
  };
}

interface JobMatchContext {
  jobTitle?: string;
  criticalMissing: string[];
  preferredMissing: string[];
  roleSuggestions: string[];
}

export default function BuildPage() {
  const { resumeId } = useParams<{ resumeId?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { resumeData, setResumeData } = useResumeData(defaultResumeData);
  const { toast } = useToast();
  const { data: loadedResume, isLoading, error } = useResume(resumeId);
  const saveTimeoutRef = useRef<number | null>(null);
  const exportRootRef = useRef<HTMLDivElement | null>(null);
  const hasHydratedRef = useRef(false);
  const lastSavedSnapshotRef = useRef<string>("");
  const [isSaving, setIsSaving] = useState(false);
  const [resumeName, setResumeName] = useState("Untitled Resume");
  const [isEditingName, setIsEditingName] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    htmlTemplates[0]?.id || 'professional-standard'
  );
  const [isExporting, setIsExporting] = useState(false);
  const [customization, setCustomization] = useState<TemplateCustomization>(defaultCustomization);
  const [showCustomizer, setShowCustomizer] = useState(false);

  const [jobMatchContext, setJobMatchContext] = useState<JobMatchContext | null>(null);
  const [showJobPanel, setShowJobPanel] = useState(false);
  const jobMatchId = searchParams.get("jobMatchId");

  // "Tailor to JD" modal state (in-builder tailored resume creation)
  const [showTailorModal, setShowTailorModal] = useState(false);
  const [tailorJd, setTailorJd] = useState("");
  const [tailorName, setTailorName] = useState("");
  const [isTailoring, setIsTailoring] = useState(false);

  const selectedTemplate = htmlTemplates.find(t => t.id === selectedTemplateId);
  const editorSnapshot = useMemo(() => JSON.stringify({
    personalInfo: resumeData.personalInfo,
    summary: resumeData.summary,
    experience: resumeData.experience,
    education: resumeData.education,
    skills: resumeData.skills,
    templateId: selectedTemplateId,
  }), [resumeData, selectedTemplateId]);

  useEffect(() => {
    if (!loadedResume) {
      if (!resumeId) {
        const storedTemplateId = localStorage.getItem("selectedTemplate");
        if (storedTemplateId) {
          setSelectedTemplateId(mapBackendTemplateToRendererId(storedTemplateId));
        }
      }
      return;
    }

    const nextData = resumeToEditorData(loadedResume);
    const rendererTemplateId = mapBackendTemplateToRendererId(loadedResume.templateId);

    setResumeData(nextData);
    setResumeName(loadedResume.name);
    setSelectedTemplateId(rendererTemplateId);

    const snapshot = JSON.stringify({
      personalInfo: nextData.personalInfo,
      summary: nextData.summary,
      experience: nextData.experience,
      education: nextData.education,
      skills: nextData.skills,
      templateId: rendererTemplateId,
    });

    lastSavedSnapshotRef.current = snapshot;
    hasHydratedRef.current = true;
  }, [loadedResume, resumeId, setResumeData]);

  useEffect(() => {
    if (!resumeId || !hasHydratedRef.current) {
      return;
    }

    if (editorSnapshot === lastSavedSnapshotRef.current) {
      return;
    }

    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(async () => {
      try {
        setIsSaving(true);
        await resumeApi.patch(resumeId, {
          name: resumeName,
          personalInfo: resumeData.personalInfo,
          summary: resumeData.summary,
          experience: resumeData.experience,
          education: resumeData.education,
          skills: resumeData.skills,
          templateId: mapRendererTemplateToBackendId(selectedTemplateId),
        });
        lastSavedSnapshotRef.current = editorSnapshot;
      } catch (saveError) {
        toast({
          title: "Autosave failed",
          description: saveError instanceof Error ? saveError.message : "Unable to save resume changes.",
          variant: "destructive",
        });
      } finally {
        setIsSaving(false);
      }
    }, 800);

    return () => {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [editorSnapshot, resumeData, resumeId, resumeName, selectedTemplateId, toast]);

  const handleTemplateSelect = useCallback((templateId: string) => {
    setSelectedTemplateId(templateId);
  }, []);

  // Load Job Match context (if opened from a match result) to surface target skills.
  useEffect(() => {
    if (!jobMatchId) {
      setJobMatchContext(null);
      return;
    }
    let cancelled = false;
    atsApi
      .getJobMatch(jobMatchId)
      .then((match) => {
        if (cancelled) return;
        const ctx: JobMatchContext = {
          jobTitle: (match as any).jobTitle,
          criticalMissing: (match as any).criticalMissing || [],
          preferredMissing: (match as any).preferredMissing || [],
          roleSuggestions: (match as any).roleSuggestions || [],
        };
        setJobMatchContext(ctx);
      })
      .catch(() => {
        if (!cancelled) setJobMatchContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [jobMatchId]);

  const handleDataChange = useCallback((newData: ResumeData) => {
    setResumeData(newData);
  }, [setResumeData]);

  // Build a tailored copy of the CURRENT builder resume from a pasted JD.
  // Creates a brand-new resume named by the user (company/role), original stays intact.
  const handleTailorToJd = useCallback(async () => {
    const jd = tailorJd.trim();
    if (jd.length < 50) {
      toast({
        title: "Job description too short",
        description: "Paste a job description of at least 50 characters.",
        variant: "destructive",
      });
      return;
    }
    if (!resumeId) {
      toast({
        title: "Save this resume first",
        description: "Save your resume to My Resumes before tailoring it to a job.",
        variant: "destructive",
      });
      return;
    }

    setIsTailoring(true);
    try {
      const created = await atsApi.buildFromJd({
        jobDescription: jd,
        resumeId,
        name: tailorName.trim() || undefined,
      });
      toast({
        title: "Tailored resume created",
        description: "We built a copy tailored to the job description. Original is untouched.",
      });
      setShowTailorModal(false);
      setTailorJd("");
      setTailorName("");
      navigate(`/app/build/${created.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tailoring failed";
      toast({
        title: "Could not tailor resume",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsTailoring(false);
    }
  }, [tailorJd, tailorName, resumeId, atsApi, toast, navigate]);

  const handleCustomizationChange = useCallback((updates: Partial<TemplateCustomization>) => {
    setCustomization(prev => {
      const newCustomization = { ...prev };
      
      if (updates.layout) {
        newCustomization.layout = {
          ...prev.layout,
          ...updates.layout,
          spacing: updates.layout.spacing 
            ? { ...prev.layout?.spacing, ...updates.layout.spacing }
            : prev.layout?.spacing,
        };
      }
      
      return { ...newCustomization, ...updates, layout: newCustomization.layout };
    });
  }, []);

  const handleExportPdf = async () => {
    setIsExporting(true);
    try {
      if (!exportRootRef.current) {
        throw new Error("Resume preview is not ready for export.");
      }

      const html = buildExportDocument(exportRootRef.current);
      const blob = await resumeApi.exportRenderedPdf(selectedTemplate?.name || resumeName, html);

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedTemplate?.name || 'resume'}-resume.pdf`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Export successful",
        description: "Your resume has been downloaded as PDF.",
      });
    } catch (error) {
      console.error("PDF Export failed:", error);
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Failed to export resume as PDF",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportClientPdf = async () => {
    setIsExporting(true);
    try {
      await exportResumePdf(resumeData, selectedTemplate?.name || 'resume');
      toast({
        title: "Export successful",
        description: "Your resume has been downloaded as PDF (generated in-browser).",
      });
    } catch (error) {
      console.error("Client PDF export failed:", error);
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Failed to export resume as PDF",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportDocx = async () => {
    setIsExporting(true);
    try {
      if (!exportRootRef.current) {
        throw new Error("Resume preview is not ready for export.");
      }

      const html = buildExportDocument(exportRootRef.current);
      const blob = await resumeApi.exportRenderedDocx(selectedTemplate?.name || resumeName, html);

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedTemplate?.name || 'resume'}-resume.docx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast({
        title: "Export successful",
        description: "Your resume has been downloaded as DOCX.",
      });
    } catch (error) {
      console.error("DOCX Export failed:", error);
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Failed to export resume as DOCX",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleSaveToMyResumes = useCallback(async () => {
    setIsSaving(true);
    try {
      const payload = {
        name: resumeName,
        personalInfo: resumeData.personalInfo,
        summary: resumeData.summary,
        experience: resumeData.experience,
        education: resumeData.education,
        skills: resumeData.skills,
        templateId: mapRendererTemplateToBackendId(selectedTemplateId),
      };

      if (resumeId) {
        await resumeApi.patch(resumeId, payload);
        lastSavedSnapshotRef.current = editorSnapshot;
        toast({
          title: "Saved to My Resumes",
          description: "Your resume has been updated.",
        });
      } else {
        const created = await resumeApi.create(payload);
        toast({
          title: "Saved to My Resumes",
          description: "Your resume is saved. You can return to it anytime.",
        });
        navigate(`/app/build/${created.id}`, { replace: true });
      }
    } catch (saveError) {
      toast({
        title: "Could not save resume",
        description: saveError instanceof Error ? saveError.message : "Unable to save your resume.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  }, [resumeId, resumeName, resumeData, selectedTemplateId, editorSnapshot, navigate, toast]);

  const commitResumeName = useCallback(() => {
    const trimmed = resumeName.trim();
    if (!trimmed) {
      setResumeName("Untitled Resume");
    } else {
      setResumeName(trimmed);
    }
    setIsEditingName(false);
  }, [resumeName]);

  useEffect(() => {
    if (isEditingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [isEditingName]);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  if (error) {
    return (
      <AppLayout>
        <div className="flex h-full items-center justify-center px-6">
          <div className="text-center">
            <p className="text-lg font-medium text-foreground">Unable to load resume</p>
            <p className="text-sm text-muted-foreground">
              {error instanceof Error ? error.message : "An unexpected error occurred."}
            </p>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex h-full flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
          <div className="flex items-center gap-4">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <div>
              {isEditingName ? (
                <input
                  ref={nameInputRef}
                  value={resumeName}
                  onChange={(e) => setResumeName(e.target.value)}
                  onBlur={commitResumeName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitResumeName();
                    if (e.key === "Escape") setIsEditingName(false);
                  }}
                  className="w-64 rounded-md border border-input bg-background px-2 py-1 text-lg font-semibold text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              ) : (
                <h1
                  className="cursor-text text-lg font-semibold text-foreground hover:underline"
                  onClick={() => setIsEditingName(true)}
                  title="Click to rename"
                >
                  {resumeName}
                </h1>
              )}
              <p className="text-sm text-muted-foreground">
                {isSaving ? "Saving changes..." : "Click to edit text. Hover over colored areas to change colors."}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Button
              variant={showCustomizer ? "secondary" : "outline"}
              size="sm"
              onClick={() => setShowCustomizer(!showCustomizer)}
              className="gap-2"
            >
              <Settings2 className="h-4 w-4" />
              Customize
            </Button>

            {jobMatchContext && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowJobPanel((v) => !v)}
                className="gap-2"
              >
                <Target className="h-4 w-4" />
                Target Job
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowTailorModal(true)}
              className="gap-2"
              disabled={!resumeId}
              title={resumeId ? "Create a JD-tailored copy of this resume" : "Save this resume first"}
            >
              <Sparkles className="h-4 w-4" />
              Tailor to JD
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  {selectedTemplate?.name || "Select Template"}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-[400px] overflow-y-auto">
                {htmlTemplates.map((template) => (
                  <DropdownMenuItem
                    key={template.id}
                    onClick={() => handleTemplateSelect(template.id)}
                    className={cn(
                      "gap-3",
                      selectedTemplateId === template.id ? "bg-secondary" : ""
                    )}
                  >
                    <div className="h-14 w-11 shrink-0 overflow-hidden rounded border border-border bg-white">
                      <TemplateThumbnail category={template.category} />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium">{template.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {template.description}
                      </div>
                    </div>
                  </DropdownMenuItem>
                ))}
                {htmlTemplates.length === 0 && (
                  <DropdownMenuItem disabled>
                    No templates available
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            <ATSQuickScore variant="inline" resumeData={resumeData} />
            <div className="h-6 w-px bg-border" />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  disabled={isExporting || isSaving}
                >
                  {isExporting || isSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {isSaving ? "Saving..." : "Exporting..."}
                    </>
                  ) : (
                    <>
                      <Download className="mr-2 h-4 w-4" />
                      Export / Save
                      <ChevronDown className="ml-1 h-3 w-3" />
                    </>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleSaveToMyResumes} disabled={isSaving || isExporting}>
                  <FileText className="mr-2 h-4 w-4" />
                  <div>
                    <div className="font-medium">Save to My Resumes</div>
                    <div className="text-xs text-muted-foreground">Keep your work for later</div>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleExportPdf} disabled={isExporting || isSaving}>
                  <File className="mr-2 h-4 w-4" />
                  <div>
                    <div className="font-medium">Download PDF</div>
                    <div className="text-xs text-muted-foreground">Best for sharing</div>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportClientPdf} disabled={isExporting || isSaving}>
                  <File className="mr-2 h-4 w-4" />
                  <div>
                    <div className="font-medium">Download PDF (client)</div>
                    <div className="text-xs text-muted-foreground">Generated in-browser</div>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleExportDocx} disabled={isExporting || isSaving}>
                  <FileDown className="mr-2 h-4 w-4" />
                  <div>
                    <div className="font-medium">Download DOCX</div>
                    <div className="text-xs text-muted-foreground">Editable format</div>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-900 py-8">
            <div className="max-w-[9in] mx-auto px-4">
              <div ref={exportRootRef}>
                  {hasTemplate(selectedTemplateId) ? (
                    <TemplateRenderer
                      templateId={selectedTemplateId}
                      data={resumeData}
                      customization={customization}
                      editable={true}
                      scale={1}
                      onDataChange={handleDataChange}
                      onCustomizationChange={handleCustomizationChange}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-96 bg-white rounded-lg shadow-lg">
                      <div className="text-center text-muted-foreground">
                        <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                        <p className="text-lg font-medium">Select a template to get started</p>
                        <p className="text-sm">Choose a template from the dropdown above</p>
                      </div>
                    </div>
                  )}
                </div>
            </div>
          </div>

          <div
            className={cn(
              "border-l border-border bg-card overflow-y-auto transition-all duration-300 ease-in-out",
              showCustomizer ? "w-72" : "w-0"
            )}
          >
            {showCustomizer && (
              <div className="p-4">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold">Customize Template</h3>
                  <button
                    onClick={() => setShowCustomizer(false)}
                    className="p-1 rounded hover:bg-secondary transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <TemplateCustomizer
                  customization={customization}
                  onChange={handleCustomizationChange}
                />
              </div>
            )}
          </div>

          <div
            className={cn(
              "border-l border-border bg-card overflow-y-auto transition-all duration-300 ease-in-out",
              showJobPanel && jobMatchContext ? "w-80" : "w-0"
            )}
          >
            {showJobPanel && jobMatchContext && (
              <JobPanel
                context={jobMatchContext}
                onClose={() => setShowJobPanel(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Tailor to JD modal - creates a separate tailored copy of this resume */}
      <Dialog open={showTailorModal} onOpenChange={setShowTailorModal}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Tailor this resume to a job</DialogTitle>
            <DialogDescription>
              We'll create a new resume tailored to the job description, leaving this one untouched.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                New resume name (company / role)
              </label>
              <input
                value={tailorName}
                onChange={(e) => setTailorName(e.target.value)}
                placeholder="e.g. Acme Corp - Backend Engineer"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Job description
              </label>
              <Textarea
                value={tailorJd}
                onChange={(e) => setTailorJd(e.target.value)}
                placeholder="Paste the job description here..."
                className="min-h-[160px] resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Minimum 50 characters. Your real experience is reshaped toward this role.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTailorModal(false)} disabled={isTailoring}>
              Cancel
            </Button>
            <Button onClick={handleTailorToJd} disabled={isTailoring}>
              {isTailoring ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Tailoring...
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Create tailored copy
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

function JobPanel({
  context,
  onClose,
}: {
  context: JobMatchContext;
  onClose: () => void;
}) {
  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Target Job</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-secondary transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {context.jobTitle && (
        <p className="mb-4 text-sm text-muted-foreground">
          Matched against: <span className="font-medium text-foreground">{context.jobTitle}</span>
        </p>
      )}

      <div className="space-y-4">
        {context.criticalMissing.length > 0 && (
          <SkillGroup
            title="Critical Skills"
            hint="Hard requirements to work into your resume."
            items={context.criticalMissing}
            tone="destructive"
          />
        )}
        {context.preferredMissing.length > 0 && (
          <SkillGroup
            title="Preferred Skills"
            hint="Nice-to-haves that strengthen your application."
            items={context.preferredMissing}
            tone="warning"
          />
        )}
        {context.roleSuggestions.length > 0 && (
          <SkillGroup
            title="Your Strengths"
            hint="Skills you have that fit this role."
            items={context.roleSuggestions}
            tone="success"
          />
        )}
      </div>
    </div>
  );
}

function SkillGroup({
  title,
  hint,
  items,
  tone,
}: {
  title: string;
  hint: string;
  items: string[];
  tone: "destructive" | "warning" | "success";
}) {
  const toneClass = {
    destructive: "bg-destructive/10 text-destructive",
    warning: "bg-warning/10 text-warning",
    success: "bg-success/10 text-success",
  }[tone];

  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className={cn("rounded-full px-2.5 py-1 text-xs font-medium", toneClass)}
          >
            {item}
          </span>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
