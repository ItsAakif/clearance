import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import type { CatalogueFacets, CataloguePostedWithin } from '@/services/api/jobs';
import { Input } from '@/components/ui/input';
import {
  POSTED_FACET_ORDER,
  REGION_FACET_ORDER,
  SENIORITY_FACET_ORDER,
  activeCatalogueFilterCount,
  facetValueLabel,
  postedWithinLabel,
  toggleCatalogueFacet,
  togglePostedWithin,
  type CatalogueFacetGroup,
  type CatalogueFilterState,
} from '@/features/jobs/catalogueParams';
import { cn } from '@/lib/utils';
import { skillLabel } from '@/features/jobs/skillLabels';

export interface CatalogueFiltersProps {
  facets: CatalogueFacets | undefined;
  filters: CatalogueFilterState;
  onChange: (next: CatalogueFilterState) => void;
  onClearAll: () => void;
  /** Currency shown beside the salary input when the loaded rows carry one. */
  currency?: string | null;
  /** Show the salary control when at least one loaded row has a range. */
  showSalary?: boolean;
}

const EMPTY_FACETS: CatalogueFacets = {
  region: {},
  workMode: {},
  seniority: {},
  specialization: {},
  skills: {},
  source: {},
  postedWithin: {},
};

function orderedEntries(
  record: Record<string, number> | undefined,
  order?: readonly string[],
): Array<[string, number]> {
  const entries = Object.entries(record ?? {}).filter(([, count]) => count > 0);
  if (!order) return entries;
  const rank = new Map(order.map((value, index) => [value, index]));
  return entries.sort((a, b) => (rank.get(a[0]) ?? 999) - (rank.get(b[0]) ?? 999));
}

function FacetSection({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="border-b border-rule pt-5 pb-2 first:pt-4 last:border-b-0"
    >
      <summary className="flex h-7 cursor-pointer list-none items-center justify-between section-label hover:text-ink">
        <span>{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
        />
      </summary>
      <fieldset aria-label={label}>
        {children}
      </fieldset>
    </details>
  );
}

function FacetCheckbox({
  label,
  count,
  checked,
  onChange,
}: {
  label: string;
  count: number;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex h-7 cursor-pointer items-center gap-2 text-sm text-ink-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-3.5 w-3.5 shrink-0 rounded-full border border-rule text-primary accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="num shrink-0 text-xs2 text-ink-3">{count}</span>
    </label>
  );
}

function SalaryControl({
  value,
  currency,
  onCommit,
}: {
  value: number | null;
  currency?: string | null;
  onCommit: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));

  useEffect(() => {
    setDraft(value === null ? '' : String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    const amount = Number(trimmed);
    if (!trimmed || !Number.isFinite(amount) || amount <= 0) {
      onCommit(null);
      return;
    }
    onCommit(Math.floor(amount));
  };

  return (
    <div className="flex h-7 items-center gap-2">
      <span className="text-sm text-ink-3">From</span>
      <div className="relative">
        <Input
          type="number"
          inputMode="numeric"
          min={0}
          step={5000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
          }}
          placeholder="120000"
          aria-label="Minimum annual salary"
          className="num h-7 w-28 pr-9 text-sm"
        />
        {currency && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs2 text-ink-3">
            {currency}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The sticky facet rail. Every group is a disclosure with native checkbox
 * rows and the count on the right. Counts come from `meta.facets` of the same
 * call that returned the rows, so the rail always describes the current query.
 *
 * Region is a count-only group: the catalogue API accepts no region filter
 * (see `.planning/progress/catalogue-search-backend.md`), so a checkbox there
 * would be a control that does nothing. The counts stay visible for context.
 */
export function CatalogueFilters({
  facets,
  filters,
  onChange,
  onClearAll,
  currency,
  showSalary = false,
}: CatalogueFiltersProps) {
  const data = facets ?? EMPTY_FACETS;
  const activeCount = activeCatalogueFilterCount(filters);
  const toggle = (group: CatalogueFacetGroup, value: string) =>
    onChange(toggleCatalogueFacet(filters, group, value));

  const workMode = orderedEntries(data.workMode, ['remote', 'hybrid']);
  const seniority = orderedEntries(data.seniority, SENIORITY_FACET_ORDER);
  const specialization = orderedEntries(data.specialization);
  const skills = orderedEntries(data.skills);
  const sources = orderedEntries(data.source);
  const regions = orderedEntries(data.region, REGION_FACET_ORDER);
  const posted = POSTED_FACET_ORDER.filter((days) => {
    const count = data.postedWithin[String(days)] ?? 0;
    return count > 0 || filters.postedWithin === days;
  });

  return (
    <div className="text-sm">
      <div className="flex items-center justify-between border-b border-rule pb-2">
        <span className="section-label">
          {activeCount > 0 ? `${activeCount} active` : 'No filters'}
        </span>
        <button
          type="button"
          onClick={onClearAll}
          disabled={activeCount === 0}
          className="text-xs text-ink-3 hover:text-ink disabled:opacity-40"
        >
          Clear all
        </button>
      </div>

      {workMode.length > 0 && (
        <FacetSection label="Work mode" defaultOpen>
          {workMode.map(([value, count]) => (
            <FacetCheckbox
              key={value}
              label={facetValueLabel('workMode', value)}
              count={count}
              checked={filters.workMode.includes(value)}
              onChange={() => toggle('workMode', value)}
            />
          ))}
        </FacetSection>
      )}

      {seniority.length > 0 && (
        <FacetSection label="Seniority" defaultOpen>
          {seniority.map(([value, count]) => (
            <FacetCheckbox
              key={value}
              label={facetValueLabel('seniority', value)}
              count={count}
              checked={filters.seniority.includes(value)}
              onChange={() => toggle('seniority', value)}
            />
          ))}
        </FacetSection>
      )}

      {specialization.length > 0 && (
        <FacetSection label="Specialization">
          {specialization.map(([value, count]) => (
            <FacetCheckbox
              key={value}
              label={facetValueLabel('specialization', value)}
              count={count}
              checked={filters.specialization.includes(value)}
              onChange={() => toggle('specialization', value)}
            />
          ))}
        </FacetSection>
      )}

      {skills.length > 0 && (
        <FacetSection label="Skills">
          {skills.map(([value, count]) => (
            <FacetCheckbox
              key={value}
              label={skillLabel(value)}
              count={count}
              checked={filters.skills.includes(value)}
              onChange={() => toggle('skills', value)}
            />
          ))}
        </FacetSection>
      )}

      {(showSalary || filters.salaryMin !== null) && (
        <FacetSection label="Salary" defaultOpen>
          <SalaryControl
            value={filters.salaryMin}
            currency={currency}
            onCommit={(salaryMin) =>
              onChange(
                salaryMin === null
                  ? { ...filters, salaryMin: null, page: 1 }
                  : { ...filters, salaryMin, page: 1 },
              )
            }
          />
        </FacetSection>
      )}

      {posted.length > 0 && (
        <FacetSection label="Posted" defaultOpen>
          {posted.map((days) => {
            const count = data.postedWithin[String(days)] ?? 0;
            return (
              <FacetCheckbox
                key={days}
                label={postedWithinLabel(days)}
                count={count}
                checked={filters.postedWithin === days}
                onChange={() => onChange(togglePostedWithin(filters, days as CataloguePostedWithin))}
              />
            );
          })}
        </FacetSection>
      )}

      {regions.length > 0 && (
        <FacetSection label="Region">
          {regions.map(([value, count]) => (
            <div key={value} className="flex h-7 items-center gap-2 text-sm text-ink-2">
              <span className="min-w-0 flex-1 truncate">{facetValueLabel('region', value)}</span>
              <span className="num shrink-0 text-xs2 text-ink-3">{count}</span>
            </div>
          ))}
        </FacetSection>
      )}

      {sources.length > 0 && (
        <FacetSection label="Source">
          {sources.map(([value, count]) => (
            <FacetCheckbox
              key={value}
              label={facetValueLabel('source', value)}
              count={count}
              checked={filters.source.includes(value)}
              onChange={() => toggle('source', value)}
            />
          ))}
        </FacetSection>
      )}
    </div>
  );
}
