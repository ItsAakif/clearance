import { GripVertical, Plus, Eye, EyeOff, Trash2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface SectionControlsProps {
  onAdd?: () => void;
  onToggleVisibility?: () => void;
  onDelete?: () => void;
  isVisible?: boolean;
  showAdd?: boolean;
  showVisibility?: boolean;
  showDelete?: boolean;
  showDrag?: boolean;
}

export function SectionControls({
  onAdd,
  onToggleVisibility,
  onDelete,
  isVisible = true,
  showAdd = false,
  showVisibility = false,
  showDelete = false,
  showDrag = true,
}: SectionControlsProps) {
  return (
    <div className="inline-section__controls">
      {showDrag && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-section__control-btn cursor-grab"
              aria-label="Drag to reorder"
            >
              <GripVertical className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Drag to reorder</TooltipContent>
        </Tooltip>
      )}

      {showAdd && onAdd && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-section__control-btn"
              onClick={onAdd}
              aria-label="Add item"
            >
              <Plus className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Add item</TooltipContent>
        </Tooltip>
      )}

      {showVisibility && onToggleVisibility && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-section__control-btn"
              onClick={onToggleVisibility}
              aria-label={isVisible ? "Hide section" : "Show section"}
            >
              {isVisible ? (
                <Eye className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {isVisible ? "Hide section" : "Show section"}
          </TooltipContent>
        </Tooltip>
      )}

      {showDelete && onDelete && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-section__control-btn"
              onClick={onDelete}
              aria-label="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left">Delete</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

interface EntryDeleteButtonProps {
  onDelete: () => void;
}

export function EntryDeleteButton({ onDelete }: EntryDeleteButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-entry__delete"
          onClick={onDelete}
          aria-label="Delete entry"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">Delete</TooltipContent>
    </Tooltip>
  );
}
