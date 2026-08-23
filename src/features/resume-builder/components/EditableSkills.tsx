import { useState, useRef, KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EditableSkillsProps {
  skills: string[];
  onChange: (skills: string[]) => void;
  className?: string;
  variant?: "tags" | "inline" | "list";
  accentColor?: string;
}

export function EditableSkills({ 
  skills, 
  onChange, 
  className,
  variant = "tags",
  accentColor = "#6366f1",
}: EditableSkillsProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newSkill, setNewSkill] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addSkill = () => {
    if (newSkill.trim()) {
      onChange([...skills, newSkill.trim()]);
      setNewSkill("");
    }
    setIsAdding(false);
  };

  const removeSkill = (index: number) => {
    onChange(skills.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSkill();
    }
    if (e.key === "Escape") {
      setIsAdding(false);
      setNewSkill("");
    }
  };

  const startAdding = () => {
    setIsAdding(true);
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  // Inline variant - comma separated text
  if (variant === "inline") {
    return (
      <div className={cn("group", className)}>
        <div className="text-sm">
          {skills.map((skill, index) => (
            <span key={index} className="group/skill">
              <span
                contentEditable
                suppressContentEditableWarning
                onBlur={(e) => {
                  const newSkills = [...skills];
                  newSkills[index] = e.currentTarget.textContent || skill;
                  onChange(newSkills);
                }}
                className="outline-none hover:bg-muted/30 rounded px-0.5 cursor-text"
              >
                {skill}
              </span>
              <button
                onClick={() => removeSkill(index)}
                className="opacity-0 group-hover/skill:opacity-100 text-muted-foreground hover:text-destructive transition-opacity ml-0.5"
                title="Remove skill"
              >
                <X className="h-3 w-3 inline" />
              </button>
              {index < skills.length - 1 && <span className="text-muted-foreground"> • </span>}
            </span>
          ))}
          {isAdding ? (
            <span className="inline-flex items-center ml-1">
              <input
                ref={inputRef}
                type="text"
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={addSkill}
                placeholder="Type skill..."
                className="w-20 bg-transparent text-sm outline-none border-b border-primary"
              />
            </span>
          ) : (
            <button
              onClick={startAdding}
              className="ml-2 inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-primary transition-colors opacity-0 group-hover:opacity-100"
            >
              <Plus className="h-3 w-3" />
              Add
            </button>
          )}
        </div>
      </div>
    );
  }

  // Tags variant (default)
  return (
    <div className={cn("group", className)}>
      <div className="flex flex-wrap gap-2">
        {skills.map((skill, index) => (
          <span
            key={index}
            className="group/skill inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            style={{ 
              backgroundColor: `${accentColor}15`,
              color: accentColor,
            }}
          >
            <span
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => {
                const newSkills = [...skills];
                newSkills[index] = e.currentTarget.textContent || skill;
                onChange(newSkills);
              }}
              className="outline-none"
            >
              {skill}
            </span>
            <button
              onClick={() => removeSkill(index)}
              className="opacity-0 group-hover/skill:opacity-100 hover:text-destructive transition-opacity"
              title="Remove skill"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        
        {isAdding ? (
          <span 
            className="inline-flex items-center rounded-md border bg-background px-2.5 py-1"
            style={{ borderColor: accentColor }}
          >
            <input
              ref={inputRef}
              type="text"
              value={newSkill}
              onChange={(e) => setNewSkill(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={addSkill}
              placeholder="Type skill..."
              className="w-20 bg-transparent text-xs outline-none"
            />
          </span>
        ) : (
          <button
            onClick={startAdding}
            className="inline-flex items-center gap-1 rounded-md border border-dashed px-2.5 py-1 text-xs transition-colors opacity-0 group-hover:opacity-100"
            style={{ 
              borderColor: `${accentColor}50`,
              color: accentColor,
            }}
          >
            <Plus className="h-3 w-3" />
            Add skill
          </button>
        )}
      </div>
    </div>
  );
}
