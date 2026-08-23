import { ReactNode } from "react";
import { Plus } from "lucide-react";
import { SectionControls } from "./SectionControls";

interface InlineSectionProps {
  title?: string;
  children: ReactNode;
  showTitle?: boolean;
  showControls?: boolean;
  showAddButton?: boolean;
  addButtonLabel?: string;
  onAdd?: () => void;
  isRepeatable?: boolean;
}

export function InlineSection({
  title,
  children,
  showTitle = true,
  showControls = true,
  showAddButton = false,
  addButtonLabel = "Add item",
  onAdd,
  isRepeatable = false,
}: InlineSectionProps) {
  return (
    <div className="inline-section group">
      {showControls && (
        <SectionControls
          showDrag={true}
          showAdd={isRepeatable}
          onAdd={onAdd}
        />
      )}

      {showTitle && title && (
        <h2 className="inline-section__header">{title}</h2>
      )}

      <div className="inline-section__content">{children}</div>

      {showAddButton && onAdd && (
        <button
          type="button"
          className="inline-add-btn"
          onClick={onAdd}
        >
          <Plus className="h-3 w-3" />
          {addButtonLabel}
        </button>
      )}
    </div>
  );
}
