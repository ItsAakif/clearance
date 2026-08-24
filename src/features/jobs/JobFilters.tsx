import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Search, X } from "lucide-react";
import type { JobSearchFilters, JobWorkMode, JobSort } from "@/services/api";

const SOURCES = ['greenhouse', 'ashby', 'lever', 'workday', 'rss'] as const;

export interface JobFiltersProps {
  filters: JobSearchFilters;
  onChange: (next: JobSearchFilters) => void;
  onSearch: () => void;
  onClear: () => void;
  sources: readonly string[];
  resultCount: number;
  pending?: boolean;
  mobile?: boolean;
}

const DEFAULT_FILTERS: Omit<JobSearchFilters, 'query' | 'location' | 'company' | 'sources' | 'minMatchScore'> & {
  sortBy: JobSort;
  workMode: JobWorkMode;
  postedWithin: JobSearchFilters['postedWithin'];
} = {
  sortBy: 'relevance',
  workMode: 'all',
  postedWithin: 'all',
};

export function JobFilters({ filters, onChange, onSearch, onClear, sources, resultCount, pending, mobile }: JobFiltersProps) {
  const update = <K extends keyof JobSearchFilters>(key: K, value: JobSearchFilters[K]) => {
    onChange({ ...filters, [key]: value });
  };

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.location.trim()) count++;
    if (filters.company.trim()) count++;
    if (filters.minMatchScore !== undefined && filters.minMatchScore > 0) count++;
    if (filters.workMode !== 'all') count++;
    if (filters.sources.length > 0) count++;
    if (filters.postedWithin !== 'all') count++;
    if (filters.sortBy !== 'relevance') count++;
    return count;
  }, [filters]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <div className="col-span-2 sm:col-span-1">
          <Label htmlFor="jf-location" className="mb-1 block text-xs text-muted-foreground">Location</Label>
          <Input
            id="jf-location"
            placeholder="Location"
            value={filters.location}
            onChange={(e) => update('location', e.target.value)}
            aria-label="Location filter"
          />
        </div>
        <div>
          <Label htmlFor="jf-match" className="mb-1 block text-xs text-muted-foreground">Min Match</Label>
          <Select
            value={filters.minMatchScore !== undefined ? String(filters.minMatchScore) : 'all'}
            onValueChange={(v) => update('minMatchScore', v === 'all' ? undefined : Number(v))}
          >
            <SelectTrigger id="jf-match" aria-label="Minimum match score">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="50">50%</SelectItem>
              <SelectItem value="60">60%</SelectItem>
              <SelectItem value="70">70%</SelectItem>
              <SelectItem value="80">80%</SelectItem>
              <SelectItem value="90">90%</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="jf-mode" className="mb-1 block text-xs text-muted-foreground">Work Mode</Label>
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
          <Label htmlFor="jf-posted" className="mb-1 block text-xs text-muted-foreground">Posted</Label>
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
          <Label htmlFor="jf-sort" className="mb-1 block text-xs text-muted-foreground">Sort by</Label>
          <Select
            value={filters.sortBy}
            onValueChange={(v) => update('sortBy', v as JobSort)}
          >
            <SelectTrigger id="jf-sort" aria-label="Sort order">
              <SelectValue placeholder="Relevance" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relevance">Relevance</SelectItem>
              <SelectItem value="matchScore">Match Score</SelectItem>
              <SelectItem value="newest">Newest</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {resultCount} result{resultCount !== 1 ? 's' : ''}
          </span>
          <div className="flex flex-wrap gap-2">
            {SOURCES.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox
                  checked={filters.sources.includes(s)}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...filters.sources, s]
                      : filters.sources.filter((x) => x !== s);
                    update('sources', next);
                  }}
                  aria-label={`Filter source ${s}`}
                />
                <span className="capitalize">{s}</span>
              </label>
            ))}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="gap-1 text-xs">
          <X className="h-3.5 w-3.5" /> Clear filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </Button>
      </div>
    </div>
  );
}
