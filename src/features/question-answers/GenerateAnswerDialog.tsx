import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { useGenerateInterviewAnswer } from '@/hooks/useJobs';
import { toast } from '@/hooks/use-toast';
import type { Application, InterviewAnswerCategory } from '@/services/api';

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  jobs: Application[];
  onUseAnswer(answer: string): void;
}

export function GenerateAnswerDialog({ open, onOpenChange, jobs, onUseAnswer }: Props) {
  const [question, setQuestion] = useState('');
  const [category, setCategory] = useState<InterviewAnswerCategory | undefined>(undefined);
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [answer, setAnswer] = useState('');
  const generate = useGenerateInterviewAnswer();

  const handleGenerate = async () => {
    if (!question.trim()) return;
    const res = await generate.mutateAsync({
      question: question.trim(),
      category,
      jobListingId: jobId || undefined,
    });
    setAnswer(res.answer);
  };

  const handleUse = () => {
    onUseAnswer(answer);
    onOpenChange(false);
    reset();
  };

  const reset = () => {
    setQuestion('');
    setCategory(undefined);
    setJobId(undefined);
    setAnswer('');
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate answer with AI</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="gen-question">Question</Label>
            <Input id="gen-question" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Interview question" />
          </div>
          <div>
            <Label htmlFor="gen-category">Category</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as InterviewAnswerCategory)}>
              <SelectTrigger id="gen-category"><SelectValue placeholder="Select category" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="behavioral">Behavioral</SelectItem>
                <SelectItem value="technical">Technical</SelectItem>
                <SelectItem value="situational">Situational</SelectItem>
                <SelectItem value="general">General</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="gen-job">Target job (optional)</Label>
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger id="gen-job"><SelectValue placeholder="No specific job" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No specific job</SelectItem>
                {jobs.map((j) => (
                  <SelectItem key={j.id} value={j.id}>{j.jobListing?.title} - {j.jobListing?.company}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleGenerate} disabled={generate.isPending || !question.trim()}>
            {generate.isPending ? 'Generating...' : 'Generate'}
          </Button>
          {generate.isError && (
            <div className="space-y-2">
              <p className="text-xs text-destructive">AI answer generation failed</p>
              <Button variant="outline" size="sm" onClick={() => (window.location.href = '/app/settings')}>Go to Settings</Button>
            </div>
          )}
          {answer && (
            <div className="space-y-2">
              <Label>Generated answer</Label>
              <Textarea value={answer} readOnly className="min-h-[120px]" />
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={async () => {
                  try { await navigator.clipboard.writeText(answer); } catch { toast({ title: 'Clipboard access is unavailable', variant: 'destructive' }); }
                }}>Copy</Button>
                <Button size="sm" onClick={handleUse}>Use this answer</Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
