import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  FileText,
  File,
  FileType2,
  MoreHorizontal,
  Copy,
  Archive,
  Trash2,
  Search,
  Loader2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageBody } from "@/components/layout";
import { SectionView } from "@/components/layout/SectionView";
import { ResumeSectionTabs } from "@/components/layout/SectionTabs";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useResumes, useCreateResume, useDeleteResume } from "@/hooks/useResumeApi";
import { resumeKeys } from "@/hooks/useResumeApi";
import { useUploadedFiles, useUploadUploadedFile } from "@/hooks/useJobs";
import { resumeApi, uploadedFilesApi, type UploadedFileSummary } from "@/services/api/resume";
import { UploadedFilePreview } from "@/features/uploaded-files/UploadedFilePreview";
import type { Resume } from "@/types/resume";

// Format relative time
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  if (hours < 24) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (days < 7) return `${days} day${days > 1 ? "s" : ""} ago`;
  
  return date.toLocaleDateString();
}

// Raw uploaded files are rendered as-is (ADR-007): icon + type badge only,
// never through a builder template.
function uploadedFileIcon(fileType: string) {
  const normalized = (fileType ?? "").trim().toLowerCase();
  if (normalized === "application/pdf") return FileText;
  if (
    normalized ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalized === "application/msword"
  )
    return FileType2;
  return File;
}

function uploadedTypeLabel(fileType: string): string {
  const normalized = (fileType ?? "").trim().toLowerCase();
  if (normalized === "application/pdf") return "PDF";
  if (
    normalized ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    normalized === "application/msword"
  )
    return "Word";
  return "Text";
}

export default function ResumesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [newResumeName, setNewResumeName] = useState("");
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isVariantDialogOpen, setIsVariantDialogOpen] = useState(false);
  const [variantResume, setVariantResume] = useState<Resume | null>(null);
  const [variantName, setVariantName] = useState("");
  const [variantTargetJob, setVariantTargetJob] = useState("");

  // Fetch resumes from API
  const { data: resumes = [], isLoading: resumesLoading, error: resumesError, refetch: refetchResumes } = useResumes();
  const createResumeMutation = useCreateResume();
  const deleteResumeMutation = useDeleteResume();

  // Raw uploaded files (server returns newest-first); each tab owns its query.
  const {
    data: uploadedFiles = [],
    isLoading: filesLoading,
    error: filesError,
    refetch: refetchFiles,
  } = useUploadedFiles();
  const [previewFile, setPreviewFile] = useState<UploadedFileSummary | null>(null);

  // Direct resume upload (header + empty state share one hidden file input).
  // The mutation invalidates the list so the new file appears immediately.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadUploadedFile();

  const handleFileUpload = async (file: File) => {
    try {
      const created = await upload.mutateAsync(file);
      toast({ title: "Resume uploaded", description: `"${created.fileName}" is ready to preview.` });
    } catch {
      // Error toast is handled by the mutation.
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDownloadUploaded = async (file: UploadedFileSummary) => {
    try {
      const blob = await uploadedFilesApi.download(file.id);
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = file.fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const filteredResumes = resumes.filter((r) => {
    const matchesSearch = r.name.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesArchiveState = showArchived ? !!r.isArchived : !r.isArchived;
    return matchesSearch && matchesArchiveState;
  });

  const handleCreate = async () => {
    if (!newResumeName.trim()) return;
    
    try {
      const newResume = await createResumeMutation.mutateAsync({
        name: newResumeName,
      });
      
      setNewResumeName("");
      setIsCreateDialogOpen(false);
      navigate(`/app/studio/${newResume.id}`);
    } catch (error) {
      // Error is handled by the mutation
    }
  };

  const handleDuplicate = async (resume: Resume) => {
    try {
      const duplicate = await resumeApi.create({
        name: `${resume.name} (Copy)`,
        personalInfo: resume.personalInfo,
        summary: resume.summary,
        experience: resume.experience,
        education: resume.education,
        skills: resume.skills,
        sections: resume.sections,
        templateId: resume.templateId,
        templateSettings: resume.templateSettings,
      });
      
      toast({ title: "Resume duplicated" });
      navigate(`/app/studio/${duplicate.id}`);
    } catch (error) {
      toast({ 
        title: "Failed to duplicate resume", 
        variant: "destructive" 
      });
    }
  };

  const handleDelete = (id: string) => {
    deleteResumeMutation.mutate(id);
  };

  const openVariantDialog = (resume: Resume) => {
    setVariantResume(resume);
    setVariantName(`${resume.name} Variant`);
    setVariantTargetJob("");
    setIsVariantDialogOpen(true);
  };

  const handleCreateVariant = async () => {
    if (!variantResume || !variantName.trim()) {
      return;
    }

    try {
      await resumeApi.createVariant(variantResume.id, variantName.trim(), variantTargetJob.trim() || undefined);
      await queryClient.invalidateQueries({ queryKey: resumeKeys.lists() });
      toast({ title: "Variant created" });
      setIsVariantDialogOpen(false);
      setVariantResume(null);
      setVariantName("");
      setVariantTargetJob("");
    } catch (error) {
      toast({
        title: "Failed to create variant",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleDeleteVariant = async (resumeId: string, variantId: string) => {
    try {
      await resumeApi.deleteVariant(resumeId, variantId);
      await queryClient.invalidateQueries({ queryKey: resumeKeys.lists() });
      toast({ title: "Variant deleted" });
    } catch (error) {
      toast({
        title: "Failed to delete variant",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleArchiveToggle = async (resume: Resume) => {
    try {
      if (resume.isArchived) {
        await resumeApi.unarchive(resume.id);
        toast({ title: "Resume restored" });
      } else {
        await resumeApi.archive(resume.id);
        toast({ title: "Resume archived" });
      }
      await queryClient.invalidateQueries({ queryKey: resumeKeys.lists() });
    } catch (error) {
      toast({
        title: "Unable to update archive status",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  // T1101: `getScoreColor` is GONE with the `ATS {n}` badge. Three thresholds (80 / 60) over a
  // stored number, chosen to paint a traffic light on it: that is the whole of E.6's forbidden
  // "grade", and it is now unreachable code. `src/noDerivedScore.test.ts` fails if it comes back.

  return (
    <Tabs defaultValue="resumes" className="flex h-full flex-col overflow-hidden">
        {/* Header: title + one context line + actions on the right. */}
        <header className="flex flex-col gap-3 border-b border-border bg-paper px-8 py-5 sm:flex-row sm:items-center sm:justify-between print:hidden">
          <div>
            <h1 className="page-title text-ink">Resumes</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={upload.isPending}
            >
              {upload.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {upload.isPending ? "Uploading..." : "Upload resume"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFileUpload(file);
              }}
            />
          </div>
        </header>

        <div className="px-8 pt-6 print:hidden">
          <ResumeSectionTabs />
          <SectionView
            title="My resumes"
            description="Every resume and variant, newest activity first."
          />
        </div>

        {/* View + tools row: tabs, search, archive toggle, create. */}
        <div className="flex flex-wrap items-center gap-4 border-b border-border px-8 py-3 print:hidden">
          <TabsList className="h-8 border-b-0">
            <TabsTrigger value="resumes">Resumes</TabsTrigger>
            <TabsTrigger value="uploaded">
              {filesLoading ? "Uploaded" : `Uploaded (${uploadedFiles.length})`}
            </TabsTrigger>
          </TabsList>
          <div className="relative w-full max-w-xs flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search resumes"
              className="pl-8"
            />
          </div>
          <Button
            variant={showArchived ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowArchived(!showArchived)}
          >
            <Archive className="mr-2 h-4 w-4" />
            {showArchived ? "Showing archived" : "View archived"}
          </Button>
          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button className="ml-auto">
                <Plus className="mr-2 h-4 w-4" />
                New resume
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create new resume</DialogTitle>
                <DialogDescription>
                  Give your resume a name to get started
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <Label htmlFor="name">Resume name</Label>
                <Input
                  id="name"
                  value={newResumeName}
                  onChange={(e) => setNewResumeName(e.target.value)}
                  placeholder="e.g., Software Engineer Resume"
                  className="mt-2"
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={!newResumeName.trim()}>
                  Create
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <TabsContent value="resumes" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          {resumesLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-ink-3" />
            </div>
          ) : resumesError ? (
            <PageBody width="full" className="px-8 py-6">
              <p className="text-xs2 text-ink-3">
                Could not load resumes. {resumesError instanceof Error ? resumesError.message : "An error occurred"}
              </p>
              <button
                type="button"
                onClick={() => void refetchResumes()}
                className="mt-2 text-xs2 text-ink-2 underline underline-offset-4 hover:text-ink"
              >
                Try again
              </button>
            </PageBody>
          ) : (
            <PageBody width="full" className="flex-1 overflow-auto px-8 py-6">
          {filteredResumes.length === 0 ? (
            <div className="max-w-md pt-4">
              <p className="text-xs2 text-ink-3">
                {searchQuery
                  ? "No resume matches that search."
                  : showArchived
                  ? "No archived resumes."
                  : "No resumes yet. Create the first one to start editing."}
              </p>
              {!searchQuery && !showArchived && (
                <button
                  type="button"
                  onClick={() => setIsCreateDialogOpen(true)}
                  className="mt-2 text-xs2 text-ink-2 underline underline-offset-4 hover:text-ink"
                >
                  Create resume
                </button>
              )}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {filteredResumes.map((resume) => (
                <div
                  key={resume.id}
                  role="link"
                  tabIndex={0}
                  aria-label={`${resume.name}: open in the Studio`}
                  onClick={() => navigate(`/app/studio/${resume.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/app/studio/${resume.id}`);
                    }
                  }}
                  className="group surface-card surface-hover relative flex cursor-pointer flex-col overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
                >
                  {/* Preview thumbnail: a quiet A4-ish sheet, never a fake score. */}
                  <div className="aspect-[8.5/6] border-b border-border bg-secondary/50 p-4">
                    <div className="h-full w-full rounded-md bg-card p-3 shadow-e1">
                      <div className="space-y-1.5">
                        <div className="h-2 w-24 rounded-full bg-ink/70" />
                        <div className="h-1 w-32 rounded-full bg-ink/20" />
                        <div className="mt-3 space-y-1">
                          <div className="h-1 w-full rounded-full bg-ink/10" />
                          <div className="h-1 w-11/12 rounded-full bg-ink/10" />
                          <div className="h-1 w-4/5 rounded-full bg-ink/10" />
                        </div>
                        <div className="mt-3 h-1 w-16 rounded-full bg-accent-dark/60" />
                        <div className="space-y-1">
                          <div className="h-1 w-full rounded-full bg-ink/10" />
                          <div className="h-1 w-10/12 rounded-full bg-ink/10" />
                          <div className="h-1 w-3/4 rounded-full bg-ink/10" />
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <h3 className="truncate text-sm font-semibold text-ink">{resume.name}</h3>
                        {resume.isArchived && <Badge variant="outline">Archived</Badge>}
                      </div>
                      <p className="mt-1 flex items-center gap-1.5 text-xs2 text-ink-3">
                        <span className="whitespace-nowrap">{formatRelativeTime(resume.updatedAt)}</span>
                        {!!resume.variants?.length && (
                          <>
                            <span>·</span>
                            <span className="num">{resume.variants.length} variants</span>
                          </>
                        )}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-ink-3"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem onClick={() => navigate(`/app/studio/${resume.id}`)}>
                          <FileText className="mr-2 h-4 w-4" />
                          Open
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() =>
                            navigate(`/app/match?resumeId=${encodeURIComponent(resume.id)}`)
                          }
                        >
                          <Search className="mr-2 h-4 w-4" />
                          Find matching jobs
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDuplicate(resume)}>
                          <Copy className="mr-2 h-4 w-4" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openVariantDialog(resume)}>
                          <Copy className="mr-2 h-4 w-4" />
                          Create variant
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void handleArchiveToggle(resume)}>
                          <Archive className="mr-2 h-4 w-4" />
                          {resume.isArchived ? "Restore" : "Archive"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => handleDelete(resume.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  {!!resume.variants?.length && (
                    <div className="border-t border-border px-4 py-2">
                      {resume.variants.map((variant) => (
                        <div
                          key={variant.id}
                          className="flex items-center justify-between gap-3 py-1 text-xs2"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-ink">{variant.name}</span>
                            {variant.targetJob ? (
                              <span className="truncate text-ink-3">{variant.targetJob}</span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            aria-label={`Delete variant ${variant.name}`}
                            className="shrink-0 text-ink-3 hover:text-ink"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteVariant(resume.id, variant.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </PageBody>
          )}
        </TabsContent>

        <TabsContent value="uploaded" className="mt-0 flex-1 overflow-auto">
          <PageBody width="full" className="px-8 py-6">
          {filesLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-ink-3" />
            </div>
          ) : filesError ? (
            <div className="max-w-md pt-4">
              <p className="text-xs2 text-ink-3">
                Could not load uploaded files. {filesError instanceof Error ? filesError.message : "An error occurred"}
              </p>
              <button
                type="button"
                onClick={() => void refetchFiles()}
                className="mt-2 text-xs2 text-ink-2 underline underline-offset-4 hover:text-ink"
              >
                Try again
              </button>
            </div>
          ) : uploadedFiles.length === 0 ? (
            <div className="max-w-md pt-4">
              <p className="text-xs2 text-ink-3">
                No uploaded files yet. Upload a resume, or import one from Job Match.
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={upload.isPending}
                className="mt-2 text-xs2 text-ink-2 underline underline-offset-4 hover:text-ink disabled:opacity-50"
              >
                {upload.isPending ? "Uploading..." : "Upload resume"}
              </button>
            </div>
          ) : (
            <div className="max-w-3xl space-y-2">
              {uploadedFiles.map((file) => {
                const TypeIcon = uploadedFileIcon(file.fileType);
                return (
                  <div key={file.id} className="surface-card flex items-start gap-3 p-4">
                    <TypeIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-base font-medium text-ink" title={file.fileName}>
                        {file.fileName}
                      </h3>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs2 text-ink-3">
                        <span>{uploadedTypeLabel(file.fileType)}</span>
                        <span>·</span>
                        <span className="whitespace-nowrap">{formatRelativeTime(file.createdAt)}</span>
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setPreviewFile(file)}
                          className="text-xs2 text-ink-2 underline-offset-4 hover:text-ink hover:underline"
                        >
                          Preview
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-ink-3"
                              aria-label={`More actions for ${file.fileName}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => void handleDownloadUploaded(file)}>
                              Download
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                void navigate(`/app/match?uploadedFileId=${encodeURIComponent(file.id)}`)
                              }
                            >
                              Find matching jobs
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() =>
                                void navigate(`/app/profile?uploadedFileId=${encodeURIComponent(file.id)}`)
                              }
                            >
                              Autofill profile
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          </PageBody>
        </TabsContent>

      <Dialog open={previewFile !== null} onOpenChange={(open) => { if (!open) setPreviewFile(null); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate">{previewFile?.fileName}</DialogTitle>
            <DialogDescription>
              Raw uploaded file, shown as-is.
            </DialogDescription>
          </DialogHeader>
          <UploadedFilePreview file={previewFile} />
        </DialogContent>
      </Dialog>

      <Dialog open={isVariantDialogOpen} onOpenChange={setIsVariantDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Resume Variant</DialogTitle>
            <DialogDescription>
              Save a role-specific copy of this resume for tailoring and tracking.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="variant-name">Variant name</Label>
              <Input id="variant-name" value={variantName} onChange={(event) => setVariantName(event.target.value)} className="mt-2" />
            </div>
            <div>
              <Label htmlFor="variant-target-job">Target job</Label>
              <Input id="variant-target-job" value={variantTargetJob} onChange={(event) => setVariantTargetJob(event.target.value)} placeholder="Senior Frontend Engineer" className="mt-2" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsVariantDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreateVariant()} disabled={!variantName.trim()}>
              Create Variant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Tabs>
  );
}
