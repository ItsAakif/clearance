// Shared display pieces for the Wave 13 admin observability sections.
//
// Existing shadcn primitives only (Card, Table, Badge, Button) - no chart
// library, no new visual language, no theme change (N8).

import type { ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { timestampText } from './format';

export interface CountItem {
  label: string;
  value: string;
}

/** Key counts row rendered above every section table. */
export function CountsRow({ items }: { items: CountItem[] }) {
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item.label}
          className="rounded-md border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground"
        >
          <span className="font-semibold text-foreground">{item.value}</span>
          {' '}{item.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Timestamp cell showing BOTH the absolute timestamp and the relative age,
 * never only the relative age (clock skew between `generatedAt` and stored
 * times would make a lone "2m ago" unverifiable). Null renders "-".
 */
export function Time({ value }: { value: string | null | undefined }) {
  const text = value === null || value === undefined ? null : timestampText(value);
  if (text === null) return <span className="text-muted-foreground">-</span>;
  return <span className="whitespace-nowrap">{text}</span>;
}

/** Freshness line backed by the endpoint `{ generatedAt, data }` envelope. */
export function Freshness({ generatedAt }: { generatedAt: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Generated <Time value={generatedAt} />
    </p>
  );
}

/** Honest empty state: what is missing and (where known) what to do. */
export function EmptyState({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="border-t border-rule pt-2">
      <p className="text-sm font-medium text-ink">{title}</p>
      {body !== undefined ? (
        <div className="mt-1 text-sm text-ink-3">{body}</div>
      ) : null}
    </div>
  );
}

/** Query error state - honest about the failure, with a retry. */
export function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="border-t border-rule pt-2">
      <p className="text-sm font-medium text-ink">Could not load this section</p>
      <p className="mt-1 text-sm text-ink-3">{message}</p>
      <Button variant="ghost" size="sm" className="mt-2 px-0 text-ink-2" onClick={onRetry}>
        <RefreshCw className="mr-2 h-4 w-4" />
        Retry
      </Button>
    </div>
  );
}

interface SectionShellProps {
  title: string;
  description: string;
  generatedAt?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  children: ReactNode;
}

/** Card shell shared by all six sections: title, freshness, refresh. */
export function SectionShell({
  title,
  description,
  generatedAt,
  onRefresh,
  refreshing,
  children,
}: SectionShellProps) {
  return (
    <Card className="p-6">
      <div className="mb-4 flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
          {generatedAt !== undefined ? (
            <div className="mt-1">
              <Freshness generatedAt={generatedAt} />
            </div>
          ) : null}
        </div>
        {onRefresh !== undefined ? (
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing === true}>
            {refreshing === true ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh
          </Button>
        ) : null}
      </div>
      {children}
    </Card>
  );
}

/** Loading placeholder for a section body. */
export function SectionLoading() {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading...
    </div>
  );
}
