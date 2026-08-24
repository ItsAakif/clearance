import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pencil, Copy, Trash2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { format } from 'date-fns';
import type { QuestionAnswer } from '@/services/api';

interface Props {
  item: QuestionAnswer;
  onEdit(item: QuestionAnswer): void;
  onDelete(id: string): void;
  onCopy(item: QuestionAnswer): void;
}

export function QuestionAnswerCard({ item, onEdit, onDelete, onCopy }: Props) {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`Question: ${item.question}\n\nAnswer: ${item.answer}`);
      onCopy(item);
      toast({ title: 'Copied to clipboard' });
    } catch {
      toast({ title: 'Clipboard access is unavailable', variant: 'destructive' });
    }
  };

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{item.question}</p>
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{item.answer}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.category && <Badge variant="secondary" className="capitalize">{item.category}</Badge>}
        {!item.category && <Badge variant="outline">Uncategorized</Badge>}
        {item.tags?.map((tag) => (
          <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
        ))}
      </div>
      {item.notes && <p className="mt-2 text-xs text-muted-foreground">{item.notes}</p>}
      <p className="mt-2 text-xs text-muted-foreground">Updated {format(new Date(item.updatedAt), 'PP')}</p>
      <div className="mt-2 flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(item)} aria-label="Edit">
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCopy} aria-label="Copy">
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => onDelete(item.id)} aria-label="Delete">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </Card>
  );
}
