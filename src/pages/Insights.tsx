import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { insightsApi } from '@/services/api/insights';
import { formatDistanceToNow } from 'date-fns';
import { skillLabel } from '@/features/jobs/skillLabels';
import { PageBody } from '@/components/layout';
import { cn } from '@/lib/utils';

const SENIORITY_LABELS: Record<string, string> = {
  junior: 'Fresher / Entry',
  mid: 'Mid',
  senior: 'Senior',
  staff: 'Staff',
  principal: 'Principal',
  lead: 'Lead / Manager',
};

/**
 * One card: a 15px section heading, an optional stated-for note, a hairline and
 * the rows. Cards are the grouping on this data page.
 */
function Section({
  label,
  note,
  className,
  children,
}: {
  label: string;
  note?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('surface-card flex h-auto min-h-0 flex-col p-5', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="section-title">{label}</h2>
        {note ? <p className="text-right text-xs2 text-ink-3 whitespace-normal">{note}</p> : null}
      </div>
      <div className="mt-2 border-t border-border" />
      <div className="flex-1">{children}</div>
    </section>
  );
}

/**
 * A measure row: the name holds a fixed column so every orange mark starts on the
 * same x. The mark is 96px, sits 12px after the name, and the count is pushed
 * to the right edge by a spacer - the mark belongs to its row, not an axis.
 */
function MeasureRow({
  label,
  count,
  max,
}: {
  label: string;
  count: number;
  max: number;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-rule py-2">
      <span className="w-48 shrink-0 truncate text-sm text-ink">{label}</span>
      <span className="h-0.5 w-24 shrink-0 bg-muted" aria-hidden="true">
        <span className="block h-0.5 bg-primary" style={{ width: `${Math.round((count / max) * 100)}%` }} />
      </span>
      <span className="flex-1" />
      <span className="num shrink-0 text-right text-sm text-ink-3">{count}</span>
    </div>
  );
}

function CountRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-3 border-b border-rule py-2 text-sm">
      <span className="min-w-0 truncate text-ink">{label}</span>
      <span className="flex-1" />
      <span className="num shrink-0 text-right text-ink-3">{count}</span>
    </div>
  );
}

const EMPTY = 'Not enough data yet.';

export default function Insights() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['insights', 'catalogue'],
    queryFn: () => insightsApi.catalogue(),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <PageBody width="data" className="px-6 py-6 text-sm text-ink-3 lg:px-8">
        Loading insights...
      </PageBody>
    );
  }

  if (isError || !data) {
    return (
      <PageBody width="data" className="px-6 py-6 text-sm text-ink-2 lg:px-8">
        Could not load insights.
      </PageBody>
    );
  }

  if (data.totalOpen === 0) {
    return (
      <PageBody width="data" className="px-6 py-6 lg:px-8">
        <h1 className="page-title text-ink">Catalogue insights</h1>
        <p className="mt-4 text-sm text-ink-2">{EMPTY}</p>
        <a href="/app/jobs" className="mt-2 inline-block text-sm text-ink-2 underline">
          Browse jobs
        </a>
      </PageBody>
    );
  }

  const maxSkill = Math.max(1, ...data.topSkills.map((s) => s.count));
  const maxCompany = Math.max(1, ...data.topCompanies.map((c) => c.count));
  const stated = (count: number) =>
    `Stated for ${count.toLocaleString()} of ${data.totalOpen.toLocaleString()} postings.`;

  return (
    <PageBody width="data" className="px-6 py-6 lg:px-8">
      <header className="border-b border-rule pb-4">
        <h1 className="page-title text-ink">Catalogue insights</h1>
        <p className="mt-1 text-sm text-ink-3">
          Every open posting across the connected boards. Updated{' '}
          {formatDistanceToNow(new Date(data.updatedAt), { addSuffix: true })}.
        </p>
      </header>

      {/* The one display anchor: the total, then the sections. */}
      <div className="mt-6 flex items-baseline gap-5">
        <span className="display-number num text-ink">{data.totalOpen.toLocaleString()}</span>
        <div className="pb-1">
          <p className="text-sm text-ink-3">open postings</p>
          <p className="num text-sm text-ink-3">{data.postedLast30} posted in the last 30 days</p>
        </div>
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Section label="Top skills" className="md:col-span-2">
          {data.topSkills.length === 0 ? (
            <p className="py-2 text-sm text-ink-3">{EMPTY}</p>
          ) : (
            data.topSkills.map((s) => (
              <MeasureRow key={s.skill} label={skillLabel(s.skill)} count={s.count} max={maxSkill} />
            ))
          )}
        </Section>

        <Section label="Work mode" note={stated(data.workModeStated)}>
          {data.workMode.length === 0 ? (
            <p className="py-2 text-sm text-ink-3">{EMPTY}</p>
          ) : (
            data.workMode.map((w) => (
              <CountRow
                key={w.mode}
                label={w.mode === 'remote' ? 'Remote' : 'Hybrid'}
                count={w.count}
              />
            ))
          )}
        </Section>

        <Section label="Seniority" note={stated(data.seniorityStated)}>
          {data.seniority.length === 0 ? (
            <p className="py-2 text-sm text-ink-3">{EMPTY}</p>
          ) : (
            data.seniority.map((s) => (
              <CountRow
                key={s.level}
                label={SENIORITY_LABELS[s.level] ?? s.level}
                count={s.count}
              />
            ))
          )}
        </Section>

        <Section label="Pay by region" note="At least five stated annual salaries per region">
          {data.salaryByRegion.length === 0 ? (
            <p className="py-2 text-sm text-ink-3">{EMPTY}</p>
          ) : (
            data.salaryByRegion.map((s) => (
              <div
                key={`${s.region}-${s.currency}`}
                className="flex items-center gap-3 border-b border-border py-2 text-sm"
              >
                <span className="num shrink-0 text-ink">{s.region.toUpperCase()}</span>
                <span className="flex-1" />
                <span className="num shrink-0 text-right text-ink-3">
                  {s.currency} {Math.round(s.median).toLocaleString()} median, {s.count} postings
                </span>
              </div>
            ))
          )}
        </Section>

        <Section label="Companies hiring" className="md:col-span-2">
          {data.topCompanies.length === 0 ? (
            <p className="py-2 text-sm text-ink-3">{EMPTY}</p>
          ) : (
            data.topCompanies.map((c) => (
              <MeasureRow key={c.company} label={c.company} count={c.count} max={maxCompany} />
            ))
          )}
        </Section>
      </div>
    </PageBody>
  );
}
