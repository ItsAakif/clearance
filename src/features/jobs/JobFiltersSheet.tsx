import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SlidersHorizontal } from "lucide-react";
import { JobFilters } from "@/features/jobs/JobFilters";
import type { JobSearchFilters, LocationSuggestion } from "@/services/api";

export interface JobFiltersSheetProps {
  filters: JobSearchFilters;
  onChange: (next: JobSearchFilters) => void;
  onSearch: () => void;
  onClear: () => void;
  sources: readonly string[];
  resultCount: number;
  pending?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeFilterCount: number;
  // Suggestion props from the merged hook in Jobs.tsx (T228), forwarded to
  // both JobFilters instances so desktop and mobile stay identical.
  locationSuggestions?: LocationSuggestion[];
  locationSuggestionsLoading?: boolean;
  onRequestLocationSuggestions?: (query: string) => void;
  /** Forwarded verbatim to both JobFilters instances (desktop row + sheet). */
  profileMatchAvailable?: boolean;
  onProfileMatch?: () => void;
  profileMatchPending?: boolean;
  /** Applied state forwarded verbatim to both JobFilters instances. */
  profileMatchApplied?: boolean;
}

export function JobFiltersSheet({
  filters, onChange, onSearch, onClear, sources, resultCount, pending, open, onOpenChange, activeFilterCount,
  locationSuggestions, locationSuggestionsLoading, onRequestLocationSuggestions,
  profileMatchAvailable, onProfileMatch, profileMatchPending, profileMatchApplied,
}: JobFiltersSheetProps) {
  return (
    <>
      <div className="md:hidden">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(true)}
          aria-label="Open job filters"
          className="gap-2"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-1 text-xs text-ink-3 num">({activeFilterCount})</span>
          )}
        </Button>
      </div>

      <div className="hidden md:block">
        <JobFilters
          filters={filters}
          onChange={onChange}
          onSearch={onSearch}
          onClear={onClear}
          sources={sources}
          resultCount={resultCount}
          pending={pending}
          locationSuggestions={locationSuggestions}
          locationSuggestionsLoading={locationSuggestionsLoading}
          onRequestLocationSuggestions={onRequestLocationSuggestions}
          profileMatchAvailable={profileMatchAvailable}
          onProfileMatch={onProfileMatch}
          profileMatchPending={profileMatchPending}
          profileMatchApplied={profileMatchApplied}
        />
      </div>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-[320px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Job Filters</SheetTitle>
            <SheetDescription>
              Filter results by location, work mode, source, and more.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6">
            <JobFilters
              filters={filters}
              onChange={(next) => {
                onChange(next);
              }}
              onSearch={() => {
                onSearch();
                onOpenChange(false);
              }}
              onClear={onClear}
              sources={sources}
              resultCount={resultCount}
              pending={pending}
              mobile
              locationSuggestions={locationSuggestions}
              locationSuggestionsLoading={locationSuggestionsLoading}
              onRequestLocationSuggestions={onRequestLocationSuggestions}
              profileMatchAvailable={profileMatchAvailable}
              onProfileMatch={onProfileMatch}
              profileMatchPending={profileMatchPending}
              profileMatchApplied={profileMatchApplied}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
