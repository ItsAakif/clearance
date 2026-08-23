import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Plus,
  FileText,
  MoreHorizontal,
  Copy,
  Archive,
  Trash2,
  Edit,
  Clock,
  Search,
  Loader2,
} from "lucide-react";
import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { useResumes, useCreateResume, useDeleteResume } from "@/hooks/useResumeApi";
import { resumeKeys } from "@/hooks/useResumeApi";
import { resumeApi } from "@/services/api/resume";
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
  const { data: resumes = [], isLoading, error } = useResumes();
  const createResumeMutation = useCreateResume();
  const deleteResumeMutation = useDeleteResume();

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
      navigate(`/app/build/${newResume.id}`);
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
      navigate(`/app/build/${duplicate.id}`);
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

  const getScoreColor = (score?: number) => {
    if (!score) return "bg-muted text-muted-foreground";
    if (score >= 80) return "bg-success/10 text-success";
    if (score >= 60) return "bg-warning/10 text-warning";
    return "bg-destructive/10 text-destructive";
  };

  // Loading state
  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  // Error state
  if (error) {
    return (
      <AppLayout>
        <div className="flex h-full flex-col items-center justify-center text-center">
          <FileText className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <h3 className="font-medium text-foreground mb-1">Failed to load resumes</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {error instanceof Error ? error.message : "An error occurred"}
          </p>
          <Button onClick={() => window.location.reload()}>
            Try Again
          </Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="flex h-full flex-col overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-foreground">My Resumes</h1>
            <p className="text-sm text-muted-foreground">
              Manage all your resumes and variants
            </p>
          </div>
          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New Resume
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Resume</DialogTitle>
                <DialogDescription>
                  Give your resume a name to get started
                </DialogDescription>
              </DialogHeader>
              <div className="py-4">
                <Label htmlFor="name">Resume Name</Label>
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
        </header>

        {/* Toolbar */}
        <div className="flex items-center gap-4 border-b border-border bg-background px-6 py-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search resumes..."
              className="pl-9"
            />
          </div>
          <Button
            variant={showArchived ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowArchived(!showArchived)}
          >
            <Archive className="mr-2 h-4 w-4" />
            {showArchived ? "Showing Archived" : "View Archived"}
          </Button>
        </div>

        {/* Resume Grid */}
        <div className="flex-1 overflow-auto p-6">
          {filteredResumes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileText className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="font-medium text-foreground mb-1">No resumes found</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {searchQuery
                  ? "Try a different search term"
                  : showArchived
                  ? "No archived resumes"
                  : "Create your first resume to get started"}
              </p>
              {!searchQuery && !showArchived && (
                <Button onClick={() => setIsCreateDialogOpen(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Resume
                </Button>
              )}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredResumes.map((resume, index) => (
                <motion.div
                  key={resume.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <Card
                    className="group relative overflow-hidden transition-all hover:shadow-lg hover:-translate-y-0.5 cursor-pointer"
                    onClick={() => navigate(`/app/build/${resume.id}`)}
                  >
                    {/* Preview thumbnail */}
                    <div className="aspect-[8.5/6] bg-secondary/30 border-b border-border p-4">
                      <div className="h-full w-full rounded bg-card p-3 shadow-sm">
                        <div className="space-y-2">
                          <div className="h-2 w-20 rounded-sm bg-foreground/70" />
                          <div className="flex gap-2">
                            <div className="h-1.5 w-10 rounded-sm bg-muted-foreground/30" />
                            <div className="h-1.5 w-8 rounded-sm bg-muted-foreground/30" />
                          </div>
                          <div className="h-px w-full bg-border mt-2" />
                          <div className="space-y-1 pt-1">
                            <div className="h-1.5 w-full rounded-sm bg-muted-foreground/20" />
                            <div className="h-1.5 w-3/4 rounded-sm bg-muted-foreground/20" />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Info */}
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <h3 className="font-medium text-foreground truncate">
                            {resume.name}
                          </h3>
                          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            <span>{formatRelativeTime(resume.updatedAt)}</span>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {resume.lastATSScore ? (
                              <Badge className={getScoreColor(resume.lastATSScore)}>
                                ATS {resume.lastATSScore}
                              </Badge>
                            ) : (
                              <Badge variant="secondary">No ATS score yet</Badge>
                            )}
                            {resume.isArchived && <Badge variant="outline">Archived</Badge>}
                            {!!resume.variants?.length && (
                              <Badge variant="outline">{resume.variants.length} variants</Badge>
                            )}
                          </div>
                          {!!resume.variants?.length && (
                            <div className="mt-3 space-y-2">
                              {resume.variants.map((variant) => (
                                <div key={variant.id} className="flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-xs">
                                  <div className="min-w-0">
                                    <p className="truncate font-medium text-foreground">{variant.name}</p>
                                    {variant.targetJob ? (
                                      <p className="truncate text-muted-foreground">{variant.targetJob}</p>
                                    ) : null}
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void handleDeleteVariant(resume.id, variant.id);
                                    }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Actions dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuItem onClick={() => navigate(`/app/build/${resume.id}`)}>
                          <Edit className="mr-2 h-4 w-4" />
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDuplicate(resume)}>
                          <Copy className="mr-2 h-4 w-4" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => openVariantDialog(resume)}>
                          <Copy className="mr-2 h-4 w-4" />
                          Create Variant
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
                  </Card>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>

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
    </AppLayout>
  );
}
