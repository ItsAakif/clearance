import { useState, useMemo } from "react";
import { AppLayout } from "@/components/layout";
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
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Loader2, Plus, Search, MessageSquare, Edit, Trash2, RefreshCw } from "lucide-react";
import { useQuestionAnswers, useCreateQuestionAnswer, useUpdateQuestionAnswer, useDeleteQuestionAnswer, questionAnswersQueryKey } from "@/hooks/useJobs";
import { useQueryClient } from "@tanstack/react-query";
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

  const getCategoryBadgeVariant = (cat?: string | null) => {
    switch (cat) {
      case "behavioral": return "secondary";
      case "technical": return "outline";
      case "situational": return "outline";
      case "general": return "secondary";
      default: return "outline";
    }
  };

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="flex flex-col gap-3 border-b border-border bg-card px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <h1 className="text-lg font-semibold text-foreground">Q&A Bank</h1>
            <p className="text-sm text-muted-foreground">Prepare answers for common interview questions</p>
          </div>
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="mr-2 h-4 w-4" />
            Add question
          </Button>
        </header>

        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-3 sm:px-6">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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

        <div className="flex-1 overflow-auto p-4 sm:p-6">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <MessageSquare className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="font-medium text-foreground mb-1">Failed to load Q&A entries</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {error instanceof Error ? error.message : "An error occurred"}
              </p>
              <Button variant="outline" onClick={() => refetch()}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <MessageSquare className="h-12 w-12 text-muted-foreground/50 mb-4" />
              <h3 className="font-medium text-foreground mb-1">No Q&A entries yet</h3>
              <p className="text-sm text-muted-foreground mb-4">
                {searchQuery || categoryFilter ? "Try adjusting your filters" : "Add your first interview Q&A to get started"}
              </p>
              {!searchQuery && !categoryFilter && (
                <Button onClick={openCreate}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add question
                </Button>
              )}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((item) => (
                <Card key={item.id} className="flex flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-medium text-foreground leading-snug">{item.question}</h3>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(item)} aria-label={`Edit: ${item.question}`}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleteTarget(item)} aria-label={`Delete: ${item.question}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap line-clamp-4">{item.answer}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {item.category && (
                      <Badge variant={getCategoryBadgeVariant(item.category)} className="capitalize">{item.category}</Badge>
                    )}
                    {item.tags?.map((tag) => (
                      <Badge key={tag} variant="secondary">{tag}</Badge>
                    ))}
                  </div>
                  {item.notes && (
                    <p className="mt-2 text-xs text-muted-foreground italic line-clamp-2">{item.notes}</p>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>

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
                  <Label htmlFor="qa-tags">Tags <span className="text-xs text-muted-foreground">(comma-separated)</span></Label>
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
                <Label htmlFor="qa-notes">Notes <span className="text-xs text-muted-foreground">(optional)</span></Label>
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
      </div>
    </AppLayout>
  );
}
