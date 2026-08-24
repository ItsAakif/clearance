import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import type { QuestionAnswer, InterviewAnswerCategory } from '@/services/api';

export interface QuestionAnswerWriteInput {
  question: string;
  answer: string;
  category?: InterviewAnswerCategory;
  notes?: string;
  tags?: string[];
}

interface Props {
  initial?: QuestionAnswer;
  onSubmit(data: QuestionAnswerWriteInput): Promise<void>;
  onCancel?(): void;
  isSaving: boolean;
}

const CATEGORIES: InterviewAnswerCategory[] = ['behavioral', 'technical', 'situational', 'general'];

export function QuestionAnswerForm({ initial, onSubmit, onCancel, isSaving }: Props) {
  const [question, setQuestion] = useState(initial?.question || '');
  const [answer, setAnswer] = useState(initial?.answer || '');
  const [category, setCategory] = useState<InterviewAnswerCategory | undefined>(initial?.category || undefined);
  const [notes, setNotes] = useState(initial?.notes || '');
  const [tagsText, setTagsText] = useState((initial?.tags || []).join(', '));

  const handleSubmit = async () => {
    const trimmed = tagsText
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const unique = Array.from(new Set(trimmed)).slice(0, 20);
    await onSubmit({
      question: question.trim(),
      answer: answer.trim(),
      category,
      notes: notes.trim() || undefined,
      tags: unique,
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="qa-question">Question</Label>
        <Input id="qa-question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Tell me about a time you handled a conflict" />
      </div>
      <div>
        <Label htmlFor="qa-answer">Answer</Label>
        <Textarea id="qa-answer" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Write your answer" className="min-h-[120px]" />
      </div>
      <div>
        <Label htmlFor="qa-category">Category</Label>
        <Select value={category} onValueChange={(v) => setCategory(v as InterviewAnswerCategory)}>
          <SelectTrigger id="qa-category"><SelectValue placeholder="Select category" /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="qa-notes">Notes</Label>
        <Textarea id="qa-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" className="min-h-[60px]" />
      </div>
      <div>
        <Label htmlFor="qa-tags">Tags</Label>
        <Input id="qa-tags" value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="Comma-separated tags" aria-label="Tags" />
        <p className="mt-1 text-xs text-muted-foreground">Separate with commas. Max 20 tags.</p>
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="outline" onClick={onCancel}>Cancel</Button>}
        <Button onClick={handleSubmit} disabled={isSaving || !question.trim() || !answer.trim()}>
          {isSaving ? 'Saving...' : initial ? 'Update' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
