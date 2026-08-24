import { useState, useEffect, useMemo } from 'react';
import { AppLayout } from '@/components/layout';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageCircleQuestion, Loader2, Search, Plus, Sparkles } from 'lucide-react';
import { useQuestionAnswers, useCreateQuestionAnswer, useUpdateQuestionAnswer, useDeleteQuestionAnswer, useApplications } from '@/hooks/useJobs';
import { QuestionAnswerForm } from '@/features/question-answers/QuestionAnswerForm';
import { QuestionAnswerCard } from '@/features/question-answers/QuestionAnswerCard';
import { GenerateAnswerDialog } from '@/features/question-answers/GenerateAnswerDialog';
import type { QuestionAnswer, InterviewAnswerCategory } from '@/services/api';

type FilterCategory = 'all' | InterviewAnswerCategory;

export default function QuestionAnswersPage() {
  const [category, setCategory] = useState<FilterCategory>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<QuestionAnswer | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [aiOpen, setAiOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: items = [], isLoading, error, refetch } = useQuestionAnswers({
    category: category === 'all' ? undefined : category,
    q: debouncedSearch || undefined,
  });

  const createMutation = useCreateQuestionAnswer();
  const updateMutation = useUpdateQuestionAnswer();
  const deleteMutation = useDeleteQuestionAnswer();
  const { data: apps = [] } = useApplications();

  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    items.forEach((item) => item.tags?.forEach((t) => tagSet.add(t)));
    return Array.from(tagSet).sort();
  }, [items]);

  const filteredItems = useMemo(() => {
    if (!tagFilter) return items;
    return items.filter((item) => item.tags?.includes(tagFilter));
  }, [items, tagFilter]);

  const handleSubmit = async (data: import('@/services/api').QuestionAnswerWriteInput) => {
    if (editingItem) {
      await updateMutation.mutateAsync({ id: editingItem.id, ...data });
      setEditingItem(null);
    } else {
      await createMutation.mutateAsync(data);
    }
    setFormOpen(false);
  };

  const handleEdit = (item: QuestionAnswer) => {
    setEditingItem(item);
    setFormOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    await deleteMutation.mutateAsync(deleteId);
    setDeleteId(null);
  };

  const handleUseAnswer = (answer: string) => {
    setEditingItem({
      id: '',
      question: '',
      answer,
      category: undefined,
      notes: null,
      tags: [],
      createdAt: '',
      updatedAt: '',
    } as QuestionAnswer);
    setFormOpen(true);
  };

  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="border-b border-border bg-card px-6 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-lg font-semibold text-foreground">Q&A Bank</h1>
              <p className="text-sm text-muted-foreground">Prepare interview answers and organize them by category and tag.</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setAiOpen(true)}>
                <Sparkles className="mr-2 h-4 w-4" /> Generate with AI
              </Button>
              <Button onClick={() => { setEditingItem(null); setFormOpen(true); }}>
                <Plus className="mr-2 h-4 w-4" /> Add question
              </Button>
            </div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search questions..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select value={category} onValueChange={(v) => setCategory(v as FilterCategory)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                <SelectItem value="behavioral">Behavioral</SelectItem>
                <SelectItem value="technical">Technical</SelectItem>
                <SelectItem value="situational">Situational</SelectItem>
                <SelectItem value="general">General</SelectItem>
              </SelectContent>
            </Select>
            {tagFilter && (
              <Button variant="outline" size="sm" onClick={() => setTagFilter(null)}>Clear tag: {tagFilter}</Button>
            )}
          </div>
          {tagFilter && (
            <div className="mb-3 flex flex-wrap gap-2">
              {allTags.map((t) => (
                <Button key={t} variant={t === tagFilter ? 'default' : 'outline'} size="sm" onClick={() => setTagFilter(t === tagFilter ? null : t)} className="capitalize">
                  {t}
                </Button>
              ))}
            </div>
          )}

          {isLoading && (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
            </div>
          )}
          {error && (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <p className="text-sm text-destructive">Failed to load Q&A bank.</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
            </div>
          )}
          {!isLoading && !error && filteredItems.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <MessageCircleQuestion className="h-10 w-10 opacity-40" />
              <p className="text-sm">{debouncedSearch || tagFilter ? 'No matches found.' : 'No questions yet. Add your first question or generate with AI.'}</p>
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredItems.map((item) => (
              <QuestionAnswerCard key={item.id} item={item} onEdit={handleEdit} onDelete={(id) => setDeleteId(id)} onCopy={() => {}} />
            ))}
          </div>
        </div>

        <Dialog open={formOpen} onOpenChange={setFormOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingItem?.id ? 'Edit question' : 'Add question'}</DialogTitle>
            </DialogHeader>
            <QuestionAnswerForm
              initial={editingItem || undefined}
              onSubmit={handleSubmit}
              onCancel={() => { setFormOpen(false); setEditingItem(null); }}
              isSaving={createMutation.isPending || updateMutation.isPending}
            />
          </DialogContent>
        </Dialog>

        <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete question?</AlertDialogTitle>
              <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} disabled={deleteMutation.isPending}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <GenerateAnswerDialog open={aiOpen} onOpenChange={setAiOpen} jobs={apps} onUseAnswer={handleUseAnswer} />
      </div>
    </AppLayout>
  );
}
