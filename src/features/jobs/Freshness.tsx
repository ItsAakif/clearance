import { formatFreshness } from '@/features/jobs/freshnessFormat';

export interface FreshnessProps {
  value: string | null | undefined;
  now?: number;
  className?: string;
}

/** Presentational freshness text. Renders nothing when the date is absent. */
export function Freshness({ value, now, className = '' }: FreshnessProps) {
  const text = formatFreshness(value, now);
  if (!text) return null;
  return <span className={className}>{text}</span>;
}
