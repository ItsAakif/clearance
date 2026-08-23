import { useState } from 'react';
import { Plus, Trash2, ChevronLeft, ChevronRight, FileText, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ResumePage } from '@/types/resume';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface PageManagerProps {
  pages: ResumePage[];
  currentPageIndex: number;
  onPageChange: (index: number) => void;
  onAddPage: () => void;
  onDuplicatePage: (index: number) => void;
  onDeletePage: (index: number) => void;
  editable?: boolean;
}

export function PageManager({
  pages,
  currentPageIndex,
  onPageChange,
  onAddPage,
  onDuplicatePage,
  onDeletePage,
  editable = true,
}: PageManagerProps) {
  const canDeletePage = pages.length > 1;
  const canGoBack = currentPageIndex > 0;
  const canGoForward = currentPageIndex < pages.length - 1;

  return (
    <TooltipProvider>
      <div className="flex items-center justify-center gap-2 py-3 px-4 bg-muted/50 border-t border-b">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onPageChange(currentPageIndex - 1)}
              disabled={!canGoBack}
              className="h-8 w-8"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Previous Page</TooltipContent>
        </Tooltip>

        <div className="flex items-center gap-1.5">
          {pages.map((page, index) => (
            <button
              key={page.id}
              onClick={() => onPageChange(index)}
              className={cn(
                'h-8 w-8 rounded-md text-sm font-medium transition-all',
                'flex items-center justify-center',
                index === currentPageIndex
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-background hover:bg-accent text-muted-foreground hover:text-foreground border'
              )}
            >
              {index + 1}
            </button>
          ))}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onPageChange(currentPageIndex + 1)}
              disabled={!canGoForward}
              className="h-8 w-8"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Next Page</TooltipContent>
        </Tooltip>

        <div className="h-6 w-px bg-border mx-2" />

        {editable && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onAddPage}
                  className="h-8 gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Add Page</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add a new blank page</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDuplicatePage(currentPageIndex)}
                  className="h-8 w-8"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Duplicate current page</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDeletePage(currentPageIndex)}
                  disabled={!canDeletePage}
                  className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {canDeletePage ? 'Delete current page' : 'Cannot delete the only page'}
              </TooltipContent>
            </Tooltip>
          </>
        )}

        <div className="h-6 w-px bg-border mx-2" />
        
        <span className="text-sm text-muted-foreground">
          Page {currentPageIndex + 1} of {pages.length}
        </span>
      </div>
    </TooltipProvider>
  );
}

interface PageThumbnailProps {
  pageNumber: number;
  isActive: boolean;
  onClick: () => void;
  onDelete?: () => void;
  canDelete: boolean;
}

export function PageThumbnail({
  pageNumber,
  isActive,
  onClick,
  onDelete,
  canDelete,
}: PageThumbnailProps) {
  const [showDelete, setShowDelete] = useState(false);

  return (
    <div
      className="relative group"
      onMouseEnter={() => setShowDelete(true)}
      onMouseLeave={() => setShowDelete(false)}
    >
      <button
        onClick={onClick}
        className={cn(
          'w-16 h-20 rounded-md border-2 transition-all flex flex-col items-center justify-center gap-1',
          isActive
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-border bg-background hover:border-primary/50 hover:bg-muted/50'
        )}
      >
        <FileText className={cn(
          'h-6 w-6',
          isActive ? 'text-primary' : 'text-muted-foreground'
        )} />
        <span className={cn(
          'text-xs font-medium',
          isActive ? 'text-primary' : 'text-muted-foreground'
        )}>
          {pageNumber}
        </span>
      </button>
      
      {showDelete && canDelete && onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs shadow-sm hover:bg-destructive/90 transition-colors"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function createNewPage(pageNumber: number): ResumePage {
  return {
    id: `page-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    pageNumber,
    sectionIds: [],
    customContent: [],
  };
}

export function duplicatePage(page: ResumePage, newPageNumber: number): ResumePage {
  return {
    ...page,
    id: `page-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    pageNumber: newPageNumber,
    sectionIds: page.sectionIds ? [...page.sectionIds] : [],
    customContent: page.customContent 
      ? page.customContent.map(section => ({
          ...section,
          id: `section-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        }))
      : [],
  };
}
