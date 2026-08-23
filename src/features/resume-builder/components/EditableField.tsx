import { useRef, useEffect, KeyboardEvent, CSSProperties } from "react";
import { cn } from "@/lib/utils";

export interface EditableFieldProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  as?: "span" | "div" | "h1" | "h2" | "p";
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
  style?: CSSProperties;
}

export function EditableField({
  value,
  onChange,
  className,
  placeholder = "Click to edit...",
  as: Tag = "span",
  onEnter,
  onBackspaceEmpty,
  style,
}: EditableFieldProps) {
  const ref = useRef<HTMLElement>(null);

  // Sync external value changes
  useEffect(() => {
    if (ref.current && ref.current.textContent !== value) {
      ref.current.textContent = value;
    }
  }, [value]);

  const handleInput = () => {
    if (ref.current) {
      const newValue = ref.current.textContent || "";
      onChange(newValue);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (onEnter) {
        onEnter();
      }
    }
    if (e.key === "Backspace" && !value && onBackspaceEmpty) {
      e.preventDefault();
      onBackspaceEmpty();
    }
  };

  const handleBlur = () => {
    if (ref.current) {
      const newValue = ref.current.textContent || "";
      onChange(newValue);
    }
  };

  return (
    <Tag
      ref={ref as any}
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      data-placeholder={placeholder}
      style={style}
      className={cn(
        "outline-none focus:bg-blue-50/50 rounded px-0.5 -mx-0.5 transition-colors",
        "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/50",
        "hover:bg-muted/30 cursor-text",
        className
      )}
    >
      {value}
    </Tag>
  );
}
