import { SlidersHorizontal } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { CatalogueFilters, type CatalogueFiltersProps } from '@/features/jobs/CatalogueFilters';

export interface CatalogueFiltersSheetProps extends CatalogueFiltersProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCount: number;
}

/**
 * Mobile presentation of the same facet rail. The trigger stays a quiet
 * outline button; the sheet reuses the existing Sheet primitive and renders
 * the identical `CatalogueFilters` tree, so there is one filter implementation.
 */
export function CatalogueFiltersSheet({
  open,
  onOpenChange,
  activeCount,
  ...filterProps
}: CatalogueFiltersSheetProps) {
  return (
    <>
      <div className="lg:hidden">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(true)}
          aria-label="Open filters"
          className="gap-2"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Filters{activeCount > 0 ? ` (${activeCount})` : ''}
        </Button>
      </div>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="left" className="w-[300px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Filters</SheetTitle>
            <SheetDescription>Narrow the catalogue.</SheetDescription>
          </SheetHeader>
          <div className="mt-4">
            <CatalogueFilters {...filterProps} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
