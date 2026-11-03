import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Search, UserCheck, X } from "lucide-react";
import type { JobSearchFilters, JobWorkMode, JobSort, LocationSuggestion } from "@/services/api";
import { LocationFilter } from "@/features/jobs/LocationFilter";
import { ExperienceLevelFilter } from "@/features/jobs/ExperienceLevelFilter";
import { SourceFilterDropdown } from "@/features/jobs/SourceFilterDropdown";
import { addListItem, removeListItem, validateForm } from "@/features/jobs/searchIntentForm";
import {
  SOURCE_GROUP_MEMBERS,
  selectedSourceGroups,
} from "@/features/jobs/sourceGroups";

export interface JobFiltersProps {
  filters: JobSearchFilters;
  onChange: (next: JobSearchFilters) => void;
  onSearch: () => void;
  onClear: () => void;
  /**
   * The generated-contract source ids the owner passes down (T912: the
   * board list now renders inside `SourceFilterDropdown`, which reads the
   * same contract). Kept on the public props so the `Jobs.tsx` and
   * `JobFiltersSheet` call sites stay unchanged.
   */
  sources: readonly string[];
  resultCount: number;
  pending?: boolean;
  mobile?: boolean;
  locationSuggestions?: LocationSuggestion[];
  locationSuggestionsLoading?: boolean;
  onRequestLocationSuggestions?: (query: string) => void;
  /** Per-run career-profile match (Track A, T403 + manual toggle). Optional so
   *  call sites that have not wired the toggle yet keep compiling; absent
   *  means the action renders disabled. */
  profileMatchAvailable?: boolean;
  onProfileMatch?: () => void;
  profileMatchPending?: boolean;
  /** Explicit manual toggle owned by Jobs.tsx (default off). True renders the
   *  filled primary button + aria-pressed="true"; false renders outline.
   *  Never derived from filters here. */
  profileMatchApplied?: boolean;
}

const DEFAULT_FILTERS: Omit<JobSearchFilters, 'query' | 'location' | 'company' | 'sources' | 'minMatchScore'> & {
  sortBy: JobSort;
  workMode: JobWorkMode;
  postedWithin: JobSearchFilters['postedWithin'];
} = {
  sortBy: 'relevance',
  workMode: 'all',
  postedWithin: 'all',
  // Required by JobSearchFilters (profile-level match gate); this constant is
  // unused (see Jobs.tsx DEFAULT_FILTERS) and gains the key only to compile.
  experienceLevel: [],
  // Wave-10 intent fields (T801); same unused-constant status as above.
  roles: [],
  skills: [],
  exclusions: [],
  companies: [],
  sourceGroups: [],
  mode: 'standard',
};

/**
 * Chip-list input for the intent string-array fields (roles, skills,
 * exclusions, companies). Same visual language as LocationFilter (secondary
 * badges + plain input, comma/Enter commit, Backspace removes last) but
 * without location semantics. Commits are uncapped: over-limit entries stay
 * committable and `validateForm` reports them as inline messages (T801
 * STEP 5) instead of a 400.
 */
function ChipListInput({
  id, label, values, onChange, placeholder,
}: {
  id?: string;
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const list = Array.isArray(values) ? values : [];

  const commitText = (raw: string) => {
    let next = list;
    for (const part of raw.split(",")) {
      const candidate = addListItem(next, part);
      if (candidate !== next) next = candidate;
    }
    if (next !== list) onChange(next);
    setDraft("");
  };

  return (
    <div>
      {list.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {list.map((v) => (
            <span key={v} className="inline-flex items-center gap-1 text-xs text-ink-2">
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                className="text-ink-3 hover:text-ink"
                onClick={() => onChange(removeListItem(list, v))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        id={id}
        value={draft}
        placeholder={placeholder ?? label}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw.includes(",")) commitText(raw);
          else setDraft(raw);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitText(draft);
          } else if (e.key === "Backspace" && draft === "" && list.length > 0) {
            onChange(list.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (draft.trim()) commitText(draft);
          else setDraft("");
        }}
        aria-label={label}
      />
    </div>
  );
}

/** Inline `validateForm` messages for one capped field (T801 STEP 5). */
function FieldMessages({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5" aria-live="polite">
      {messages.map((message, index) => (
        <p key={index} className="text-xs text-destructive">
          {message}
        </p>
      ))}
    </div>
  );
}

export function JobFilters({ filters, onChange, onSearch, onClear, sources, resultCount, pending, mobile, locationSuggestions, locationSuggestionsLoading, onRequestLocationSuggestions, profileMatchAvailable = false, onProfileMatch, profileMatchPending = false, profileMatchApplied = false }: JobFiltersProps) {
  const update = <K extends keyof JobSearchFilters>(key: K, value: JobSearchFilters[K]) => {
    onChange({ ...filters, [key]: value });
  };

  // A source-group toggle edits a SET of source ids (the legacy `sources`
  // filter, which is what the request sends and the client predicates read).
  // `sourceGroups` is re-derived as the fully covered groups, so the two
  // fields can never diverge: one rule, every path (the Sources dropdown
  // writes both its group rows and its per-board rows through this).
  const updateSources = (nextSources: string[]) => {
    onChange({
      ...filters,
      sources: nextSources,
      sourceGroups: selectedSourceGroups(nextSources, SOURCE_GROUP_MEMBERS),
    });
  };

  // Inline validation (T800 `validateForm`, T801 STEP 5): the capped fields
  // the sheet can express. `postedWithin: 'all'` means "no recency filter"
  // and is omitted so the validator never flags the unset state; the legacy
  // `company` string is folded into `companies` exactly as the backend maps
  // it (`searchIntent.ts` legacy table). Only the five capped fields render
  // messages - query/mode/postedWithin/sourceGroups have no new UI here.
  // Messages warn only: nothing here is sent yet (T804 owns the payload), so
  // blocking Search would regress searches that succeed today.
  const formIssues = useMemo(
    () =>
      validateForm({
        query: filters.query,
        roles: filters.roles,
        skills: filters.skills,
        exclusions: filters.exclusions,
        locations: filters.location,
        companies:
          filters.company !== undefined && filters.company.trim()
            ? [filters.company.trim(), ...filters.companies]
            : filters.companies,
        sourceGroups: filters.sourceGroups,
        mode: filters.mode,
        ...(filters.postedWithin !== 'all' ? { postedWithin: filters.postedWithin } : {}),
      }),
    [filters],
  );
  const messagesFor = (field: string): string[] =>
    formIssues
      .filter((issue) => issue.field === field || issue.field.startsWith(`${field}[`))
      .map((issue) => issue.message);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.location.length > 0) count++;
    if (filters.company !== undefined && filters.company.trim()) count++;
    if (filters.minMatchScore !== undefined && filters.minMatchScore > 0) count++;
    if (filters.workMode !== 'all') count++;
    if (filters.sources.length > 0) count++;
    if (filters.postedWithin !== 'all') count++;
    if (filters.sortBy !== 'relevance') count++;
    if (filters.experienceLevel.length > 0) count++;
    // Wave-10 intent fields (T801): each counts once. `sourceGroups` is NOT
    // counted separately - a group toggles a set of source ids, so its
    // selections already count through `sources` above; counting both would
    // bill one user action twice. Standard is the neutral UI default, so mode
    // counts only when the user chooses Deep or Full.
    if (filters.roles.length > 0) count++;
    if (filters.skills.length > 0) count++;
    if (filters.exclusions.length > 0) count++;
    if (filters.companies.length > 0) count++;
    if (filters.mode !== 'standard') count++;
    return count;
  }, [filters]);

  const profileMatchDisabled = !profileMatchAvailable || profileMatchPending;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
          <Input
            className="pl-9"
            placeholder="Search roles, e.g. 'Senior React Engineer'"
            value={filters.query}
            onChange={(e) => update('query', e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            aria-label="Search jobs"
          />
        </div>
        <Button onClick={onSearch} disabled={pending || !filters.query.trim()} className="shrink-0">
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
          Search
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="col-span-2 sm:col-span-1">
          <Label htmlFor="jf-location" className="mb-1 block text-xs text-ink-3">Location</Label>
          <LocationFilter
            id="jf-location"
            value={filters.location}
            onChange={(next) => update('location', next)}
            suggestions={locationSuggestions}
            suggestionsLoading={locationSuggestionsLoading}
            onRequestSuggestions={onRequestLocationSuggestions}
          />
          <FieldMessages messages={messagesFor('locations')} />
        </div>
        <div>
          <Label htmlFor="jf-level" className="mb-1 block text-xs text-ink-3">Experience</Label>
          <ExperienceLevelFilter
            id="jf-level"
            value={filters.experienceLevel}
            onChange={(next) => update('experienceLevel', next)}
            compact={!!mobile}
          />
        </div>
        {/* T1101: the "Min Match" control is GONE.
            It was a percentage scale - 50%, 60%, 70%, 80%, 90% - over `JobEvaluation.overallScore`,
            which is 06 sec. E.6's forbidden case exactly: a single derived number presented as a
            grade, and here as a slider the user is invited to optimise against.

            WHAT IS DELIBERATELY LEFT, and why this is not a half-measure that breaks the filter:
            `minMatchScore` is a PERSISTED column on `SavedSearch` and `JobAlert` (prisma, which this
            task does not touch) and the backend still accepts it, so a saved search created before
            this change keeps filtering exactly as before - it just has no control to change it
            with. `jobSearchUtils` still rescales the 0-5 evaluation for that path and
            `pages/Jobs.tsx` still builds the map. A filter over an internal signal is allowed
            (FREEZE B-16); a SCALE ON A SLIDER is the presentation E.6 forbids. See
            `.planning/progress/T1110-cutover-backend-and-score.md` sec. 9 for the migration this
            defers. */}
        <div>
          <Label htmlFor="jf-mode" className="mb-1 block text-xs text-ink-3">Work Mode</Label>
          <Select
            value={filters.workMode}
            onValueChange={(v) => update('workMode', v as JobWorkMode)}
          >
            <SelectTrigger id="jf-mode" aria-label="Work mode">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="remote">Remote</SelectItem>
              <SelectItem value="hybrid">Hybrid</SelectItem>
              <SelectItem value="onsite">On-site</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="jf-posted" className="mb-1 block text-xs text-ink-3">Posted</Label>
          <Select
            value={filters.postedWithin}
            onValueChange={(v) => update('postedWithin', v as JobSearchFilters['postedWithin'])}
          >
            <SelectTrigger id="jf-posted" aria-label="Posted within">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All time</SelectItem>
              <SelectItem value="day">Past day</SelectItem>
              <SelectItem value="week">Past week</SelectItem>
              <SelectItem value="month">Past month</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="jf-sort" className="mb-1 block text-xs text-ink-3">Sort by</Label>
          <Select
            value={filters.sortBy}
            onValueChange={(v) => update('sortBy', v as JobSort)}
          >
            <SelectTrigger id="jf-sort" aria-label="Sort order">
              <SelectValue placeholder="Relevance" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relevance">Relevance</SelectItem>
              {/* T1101: the "Match Score" sort option is GONE, for the same reason the Min Match
                  slider is: its label announces a score the product will not show you. The VALUE
                  stays supported - `sortBy=matchScore` is still honoured by the backend and still
                  honoured by `jobSearchUtils`, so a saved search ordered by it keeps its order -
                  there is simply no longer an option that offers to put a number in front of you. */}
              <SelectItem value="newest">Newest</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="jf-profile-match" className="mb-1 block text-xs text-ink-3">Career profile</Label>
          <Button
            id="jf-profile-match"
            variant={profileMatchApplied ? "default" : "outline"}
            onClick={() => onProfileMatch?.()}
            disabled={profileMatchDisabled}
            aria-label="Match career profile"
            aria-pressed={profileMatchApplied}
            title={profileMatchAvailable ? (profileMatchApplied ? "Career profile filters are applied to this search" : "Apply your career profile to this search") : "Your career profile offers nothing to apply"}
            className="w-full"
          >
            {profileMatchPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserCheck className="mr-2 h-4 w-4" />}
            Match profile
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <Label htmlFor="jf-roles" className="mb-1 block text-xs text-ink-3">Roles</Label>
          <ChipListInput
            id="jf-roles"
            label="Roles filter"
            values={filters.roles}
            onChange={(next) => update('roles', next)}
            placeholder="Roles"
          />
          <FieldMessages messages={messagesFor('roles')} />
        </div>
        <div>
          <Label htmlFor="jf-skills" className="mb-1 block text-xs text-ink-3">Skills</Label>
          <ChipListInput
            id="jf-skills"
            label="Skills filter"
            values={filters.skills}
            onChange={(next) => update('skills', next)}
            placeholder="Skills"
          />
          <FieldMessages messages={messagesFor('skills')} />
        </div>
        <div>
          <Label htmlFor="jf-exclusions" className="mb-1 block text-xs text-ink-3">Exclusions</Label>
          <ChipListInput
            id="jf-exclusions"
            label="Exclusions filter"
            values={filters.exclusions}
            onChange={(next) => update('exclusions', next)}
            placeholder="Exclude"
          />
          <FieldMessages messages={messagesFor('exclusions')} />
        </div>
        <div>
          <Label htmlFor="jf-companies" className="mb-1 block text-xs text-ink-3">Companies</Label>
          <ChipListInput
            id="jf-companies"
            label="Companies filter"
            values={filters.companies}
            onChange={(next) => update('companies', next)}
            placeholder="Companies"
          />
          <p className="mt-1 text-xs text-ink-3">Optional - leave empty if you have no company preference.</p>
          <FieldMessages messages={messagesFor('companies')} />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <SourceFilterDropdown
            sources={filters.sources}
            onSourcesChange={updateSources}
          />
          <span className="text-xs text-ink-3">
            {resultCount} result{resultCount !== 1 ? 's' : ''}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="gap-1 text-xs">
          <X className="h-3.5 w-3.5" /> Clear filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </Button>
      </div>
    </div>
  );
}
