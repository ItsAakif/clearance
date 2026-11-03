import type { SearchDocument } from '@/services/api/jobs';
import { facetValueLabel } from '@/features/jobs/catalogueParams';
import { skillLabel } from '@/features/jobs/skillLabels';
import { Freshness } from '@/features/jobs/Freshness';
import { SalaryText } from '@/features/jobs/SalaryText';

export interface JobRowProps {
  job: SearchDocument;
  onSelect: (job: SearchDocument) => void;
  /** True while this row's detail sheet is open. */
  selected?: boolean;
  /** Fixed clock for deterministic tests; production leaves it undefined. */
  now?: number;
}

/**
 * One dense catalogue row: a hairline, three text lines and a right-aligned
 * salary/freshness column. No card, no score, no chips, no hover lift.
 */
export function JobRow({ job, onSelect, selected = false, now }: JobRowProps) {
  const meta = [job.company, job.workMode ? facetValueLabel('workMode', job.workMode) : null,
    job.seniority ? facetValueLabel('seniority', job.seniority) : null]
    .filter((value): value is string => Boolean(value))
    .join(', ');

  const detail = [
    job.location,
    job.specialization ? facetValueLabel('specialization', job.specialization) : null,
    ...(job.skills ?? []).slice(0, 3).map((skill) => skillLabel(skill)),
  ]
    .filter((value): value is string => Boolean(value))
    .join(', ');

  return (
    <button
      type="button"
      onClick={() => onSelect(job)}
      className={`group relative mb-2 flex min-h-[72px] w-full items-start gap-4 rounded-control border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 ${
        selected
          ? 'border-accent-hi/40 bg-accent shadow-e1'
          : 'border-transparent bg-card hover:border-border hover:bg-paper-2 hover:shadow-e1'
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs leading-tight text-ink-3">{meta}</span>
        <span className="mt-0.5 block truncate text-[15px] font-medium leading-tight text-ink">{job.title}</span>
        {detail && <span className="mt-0.5 block truncate text-xs2 leading-tight text-ink-3">{detail}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5 text-right">
        <SalaryText salary={job.salary} className="num text-sm text-ink-2" />
        <Freshness value={job.postedAt ?? job.firstSeenAt} now={now} className="text-xs2 text-ink-3 whitespace-nowrap" />
      </span>
    </button>
  );
}
