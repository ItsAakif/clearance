import { useRef, KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EditableBulletListProps {
  bullets: string[];
  onChange: (bullets: string[]) => void;
  className?: string;
  bulletChar?: string;
}

export function EditableBulletList({ bullets, onChange, className, bulletChar = "•" }: EditableBulletListProps) {
  const listRef = useRef<HTMLUListElement>(null);

  const handleBulletChange = (index: number, value: string) => {
    const newBullets = [...bullets];
    newBullets[index] = value;
    onChange(newBullets);
  };

  const handleKeyDown = (e: KeyboardEvent, index: number) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Add new bullet after current
      const newBullets = [...bullets];
      newBullets.splice(index + 1, 0, "");
      onChange(newBullets);
      // Focus new bullet after render
      setTimeout(() => {
        const items = listRef.current?.querySelectorAll('[contenteditable="true"]');
        if (items && items[index + 1]) {
          (items[index + 1] as HTMLElement).focus();
        }
      }, 10);
    }
    if (e.key === "Backspace" && !bullets[index]) {
      e.preventDefault();
      if (bullets.length > 1) {
        const newBullets = bullets.filter((_, i) => i !== index);
        onChange(newBullets);
        // Focus previous bullet
        setTimeout(() => {
          const items = listRef.current?.querySelectorAll('[contenteditable="true"]');
          if (items && items[Math.max(0, index - 1)]) {
            (items[Math.max(0, index - 1)] as HTMLElement).focus();
          }
        }, 10);
      }
    }
  };

  const addBullet = () => {
    onChange([...bullets, ""]);
    setTimeout(() => {
      const items = listRef.current?.querySelectorAll('[contenteditable="true"]');
      if (items && items[items.length - 1]) {
        (items[items.length - 1] as HTMLElement).focus();
      }
    }, 10);
  };

  const removeBullet = (index: number) => {
    if (bullets.length > 1) {
      onChange(bullets.filter((_, i) => i !== index));
    }
  };

  return (
    <div className={cn("group", className)}>
      <ul ref={listRef} className="space-y-1.5 text-sm">
        {bullets.map((bullet, index) => (
          <li key={index} className="flex items-start gap-2 group/item">
            <span className="text-muted-foreground mt-0.5 select-none">{bulletChar}</span>
            <span
              contentEditable
              suppressContentEditableWarning
              onInput={(e) => handleBulletChange(index, e.currentTarget.textContent || "")}
              onKeyDown={(e) => handleKeyDown(e, index)}
              data-placeholder="Add achievement or responsibility..."
              className={cn(
                "flex-1 outline-none focus:bg-blue-50/50 rounded px-0.5 -mx-0.5",
                "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/50",
                "hover:bg-muted/30 cursor-text transition-colors"
              )}
            >
              {bullet}
            </span>
            <button
              onClick={() => removeBullet(index)}
              className="opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive transition-opacity p-0.5"
              title="Remove bullet"
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        ))}
      </ul>
      <button
        onClick={addBullet}
        className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <Plus className="h-3 w-3" />
        Add bullet
      </button>
    </div>
  );
}
