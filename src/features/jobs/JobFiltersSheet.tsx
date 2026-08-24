import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { JobFilters } from "@/features/jobs/JobFilters";
import type { JobSearchFilters } from "@/services/api";

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
}

export function JobFiltersSheet({
  filters, onChange, onSearch, onClear, sources, resultCount, pending, open, onOpenChange, activeFilterCount,
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
            <Badge variant="secondary" className="ml-1 h-5 min-w-5 rounded-full px-1 text-xs">
              {activeFilterCount}
            </Badge>
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
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
