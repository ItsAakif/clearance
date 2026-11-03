import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Plus, Search, Edit, Trash2, Sparkles } from "lucide-react";
import { useQuestionAnswers, useCreateQuestionAnswer, useUpdateQuestionAnswer, useDeleteQuestionAnswer, questionAnswersQueryKey, useApplications } from "@/hooks/useJobs";
import { useQueryClient } from "@tanstack/react-query";
import { PageShell } from "@/components/layout/PageShell";
import { SectionView } from "@/components/layout/SectionView";
import { InterviewSectionTabs } from "@/components/layout/SectionTabs";
import type { QuestionAnswer } from "@/services/api";

const CATEGORIES = ["behavioral", "technical", "situational", "general"] as const;

type QAFormState = {
  question: string;
  answer: string;
  category: string;
  notes: string;
  tags: string;
};

const emptyForm: QAFormState = { question: "", answer: "", category: "", notes: "", tags: "" };

export default function QABankPage() {
  const qc = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<QuestionAnswer | null>(null);
  const [form, setForm] = useState<QAFormState>(emptyForm);
  const [deleteTarget, setDeleteTarget] = useState<QuestionAnswer | null>(null);
  const [formError, setFormError] = useState<string>("");

  const filters = useMemo(() => ({
    q: searchQuery || undefined,
    category: categoryFilter || undefined,
  }), [searchQuery, categoryFilter]);

  const { data: items = [], isLoading, error, refetch } = useQuestionAnswers(filters);
  const { data: apps = [] } = useApplications();
  const createMutation = useCreateQuestionAnswer();
  const updateMutation = useUpdateQuestionAnswer();
  const deleteMutation = useDeleteQuestionAnswer();

  const openCreate = () => {
    setEditingItem(null);
    setForm(emptyForm);
    setFormError("");
    setDialogOpen(true);
  };

  const openEdit = (item: QuestionAnswer) => {
    setEditingItem(item);
    setForm({
      question: item.question,
      answer: item.answer,
      category: item.category ?? "",
      notes: item.notes ?? "",
      tags: (item.tags ?? []).join(", "),
    });
    setFormError("");
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditingItem(null);
    setForm(emptyForm);
    setFormError("");
  };

  const handleSubmit = async () => {
    setFormError("");
    const trimmedQ = form.question.trim();
    const trimmedA = form.answer.trim();
    if (!trimmedQ || !trimmedA) {
      setFormError("Question and answer are required.");
      return;
    }
    const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      if (editingItem) {
        await updateMutation.mutateAsync({
          id: editingItem.id,
          question: trimmedQ,
          answer: trimmedA,
          category: form.category || undefined,
          notes: form.notes.trim() || undefined,
          tags: tags.length ? tags : undefined,
        });
      } else {
        await createMutation.mutateAsync({
          question: trimmedQ,
          answer: trimmedA,
          category: form.category || undefined,
          notes: form.notes.trim() || undefined,
          tags: tags.length ? tags : undefined,
        });
      }
      handleCloseDialog();
    } catch {
      setFormError(editingItem ? "Failed to update. Please try again." : "Failed to add. Please try again.");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
    } catch {
      // error toast handled by hook
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <PageShell
      title="Interview"
      width="data"
      actions={
        <>
          {/* T1110: the "Generate with AI" button and its dialog are GONE.
              `POST /ai/generate-interview-answer` answered a question from free-form text with
              nothing anchoring it to anything the candidate had actually done, and it is now a
              410 (FREEZE A-38). The successor is `/app/interview/prep`, where the questions are
              derived from the risks and gaps in the user's own confirmed evidence - so the button
              points there instead of pretending to write the answer for them. */}
          <Button variant="outline" asChild>
            <Link to="/app/interview/prep">
              <Sparkles className="mr-2 h-4 w-4" />
              Prep from my evidence
            </Link>
          </Button>
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="mr-2 h-4 w-4" />
            Add question
          </Button>
        </>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
            <Input
              placeholder="Search questions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              aria-label="Search Q&A entries"
            />
          </div>
          <Select value={categoryFilter || "all"} onValueChange={(v) => setCategoryFilter(v === "all" ? "" : v)}>
            <SelectTrigger className="w-[180px]" aria-label="Filter by category">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      }
    >
      <InterviewSectionTabs />
      <SectionView
        title="Q&A Bank"
        description="Prepare answers for common interview questions"
      />
          {isLoading ? (
            <div className="flex h-full items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-ink-3" />
            </div>
          ) : error ? (
            <div className="max-w-md">
              <p className="text-xs2 text-ink-3">
                Could not load Q&amp;A entries. {error instanceof Error ? error.message : "An error occurred"}
              </p>
              <button
                type="button"
                onClick={() => refetch()}
                className="mt-2 text-xs2 text-ink-2 underline underline-offset-4 hover:text-ink"
              >
                Try again
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="max-w-md">
              <p className="text-xs2 text-ink-3">
                {searchQuery || categoryFilter
                  ? "No answer matches that search."
                  : "No Q&A entries yet. Add the first answer you want to rehearse."}
              </p>
              {!searchQuery && !categoryFilter && (
                <button
                  type="button"
                  onClick={openCreate}
                  className="mt-2 text-xs2 text-ink-2 underline underline-offset-4 hover:text-ink"
                >
                  Add question
                </button>
              )}
            </div>
          ) : (
            <div className="max-w-3xl space-y-3">
              <div className="flex items-baseline justify-between gap-4">
                <h2 className="section-title">Answers</h2>
                <span className="num text-xs2 text-ink-3">{items.length} entries</span>
              </div>
              {items.map((item) => (
                <article key={item.id} className="surface-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-base font-medium leading-snug text-ink">{item.question}</h3>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className="text-ink-3 hover:text-ink"
                        onClick={() => openEdit(item)}
                        aria-label={`Edit: ${item.question}`}
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="text-ink-3 hover:text-destructive"
                        onClick={() => setDeleteTarget(item)}
                        aria-label={`Delete: ${item.question}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-ink-3 line-clamp-3">{item.answer}</p>
                  {(item.category || item.tags?.length || item.notes) && (
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs2 text-ink-3">
                      {item.category && <span className="capitalize">{item.category}</span>}
                      {item.tags?.map((tag) => (
                        <span key={tag} className="before:mr-2 before:content-['·']">{tag}</span>
                      ))}
                      {item.notes && <span className="italic line-clamp-1">{item.notes}</span>}
                    </p>
                  )}
                </article>
              ))}
            </div>
          )}
          {/* Add / Edit dialog */}
        <Dialog open={dialogOpen} onOpenChange={(open) => open ? null : handleCloseDialog()}>
          <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
            <DialogHeader>
              <DialogTitle>{editingItem ? "Edit Q&A" : "Add Q&A"}</DialogTitle>
              <DialogDescription>
                {editingItem ? "Update your interview answer." : "Add a new question and answer to your bank."}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div>
                <Label htmlFor="qa-question">Question <span className="text-destructive">*</span></Label>
                <Input
                  id="qa-question"
                  value={form.question}
                  onChange={(e) => setForm((f) => ({ ...f, question: e.target.value }))}
                  placeholder="e.g. Tell me about a time you handled a conflict"
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="qa-answer">Answer <span className="text-destructive">*</span></Label>
                <Textarea
                  id="qa-answer"
                  value={form.answer}
                  onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
                  placeholder="Write your answer using the STAR method..."
                  className="mt-1 min-h-[120px]"
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="qa-category">Category</Label>
                  <Select value={form.category || "none"} onValueChange={(v) => setForm((f) => ({ ...f, category: v === "none" ? "" : v }))}>
                    <SelectTrigger id="qa-category" className="mt-1">
                      <SelectValue placeholder="Select category" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="qa-tags">Tags <span className="text-xs2 text-ink-3">(comma-separated)</span></Label>
                  <Input
                    id="qa-tags"
                    value={form.tags}
                    onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
                    placeholder="leadership, react, incident"
                    className="mt-1"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="qa-notes">Notes <span className="text-xs2 text-ink-3">(optional)</span></Label>
                <Textarea
                  id="qa-notes"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Additional context or tips..."
                  className="mt-1 min-h-[60px]"
                />
              </div>
              {formError && (
                <p className="text-sm text-destructive" role="alert">{formError}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleCloseDialog}>Cancel</Button>
              <Button onClick={handleSubmit} disabled={createMutation.isPending || updateMutation.isPending}>
                {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {editingItem ? "Save changes" : "Add entry"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete confirmation */}
        <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete Q&A entry</AlertDialogTitle>
              <AlertDialogDescription>
                This will permanently remove this question and answer from your bank. This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                {deleteMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        </PageShell>
  );
}
