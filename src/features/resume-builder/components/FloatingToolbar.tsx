import { useState, useEffect, useCallback } from "react";
import { Bold, Italic, Underline, List } from "lucide-react";
import { cn } from "@/lib/utils";

interface FloatingToolbarProps {
  className?: string;
}

export function FloatingToolbar({ className }: FloatingToolbarProps) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const handleSelectionChange = useCallback(() => {
    const selection = window.getSelection();
    
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setIsVisible(false);
      return;
    }

    const text = selection.toString().trim();
    if (!text) {
      setIsVisible(false);
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    // Position toolbar above selection
    setPosition({
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
    });
    setIsVisible(true);
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", handleSelectionChange);
    
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handleSelectionChange);
    };
  }, [handleSelectionChange]);

  const execCommand = (command: string) => {
    document.execCommand(command, false);
  };

  if (!isVisible || !position) return null;

  return (
    <div
      className={cn(
        "fixed z-50 flex items-center gap-1 rounded-lg bg-popover border border-border shadow-lg px-2 py-1.5 -translate-x-1/2 -translate-y-full",
        "animate-in fade-in-0 zoom-in-95",
        className
      )}
      style={{
        left: position.x,
        top: position.y,
      }}
      onMouseDown={(e) => e.preventDefault()} // Prevent losing selection
    >
      <ToolbarButton
        onClick={() => execCommand("bold")}
        title="Bold (Ctrl+B)"
      >
        <Bold className="h-4 w-4" />
      </ToolbarButton>
      
      <ToolbarButton
        onClick={() => execCommand("italic")}
        title="Italic (Ctrl+I)"
      >
        <Italic className="h-4 w-4" />
      </ToolbarButton>
      
      <ToolbarButton
        onClick={() => execCommand("underline")}
        title="Underline (Ctrl+U)"
      >
        <Underline className="h-4 w-4" />
      </ToolbarButton>

      <div className="w-px h-4 bg-border mx-1" />
      
      <ToolbarButton
        onClick={() => execCommand("insertUnorderedList")}
        title="Bullet List"
      >
        <List className="h-4 w-4" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
    >
      {children}
    </button>
  );
}
