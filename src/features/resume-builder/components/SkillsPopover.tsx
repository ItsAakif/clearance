import { useState, useRef, KeyboardEvent } from "react";
import { X, Plus } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface SkillsPopoverProps {
  skills: string[];
  onChange: (skills: string[]) => void;
  children: React.ReactNode;
}

export function SkillsPopover({ skills, onChange, children }: SkillsPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [newSkill, setNewSkill] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addSkill = () => {
    if (newSkill.trim() && !skills.includes(newSkill.trim())) {
      onChange([...skills, newSkill.trim()]);
      setNewSkill("");
      inputRef.current?.focus();
    }
  };

  const removeSkill = (index: number) => {
    onChange(skills.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addSkill();
    }
    if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-80 p-4" align="start">
        <div className="space-y-3">
          <div className="text-sm font-medium text-foreground">Edit Skills</div>

          <div className="flex flex-wrap gap-2">
            {skills.map((skill, index) => (
              <span
                key={index}
                className="inline-flex items-center gap-1 rounded-md bg-secondary px-2.5 py-1 text-xs font-medium"
              >
                {skill}
                <button
                  type="button"
                  onClick={() => removeSkill(index)}
                  className="rounded-full p-0.5 hover:bg-destructive/20 hover:text-destructive transition-colors"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              ref={inputRef}
              type="text"
              value={newSkill}
              onChange={(e) => setNewSkill(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add a skill..."
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <button
              type="button"
              onClick={addSkill}
              disabled={!newSkill.trim()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          <p className="text-xs text-muted-foreground">
            Press Enter to add, click X to remove
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface InlineSkillsProps {
  skills: string[];
  onChange: (skills: string[]) => void;
}

export function InlineSkills({ skills, onChange }: InlineSkillsProps) {
  const removeSkill = (index: number) => {
    onChange(skills.filter((_, i) => i !== index));
  };

  return (
    <SkillsPopover skills={skills} onChange={onChange}>
      <div className="inline-skills cursor-pointer group">
        {skills.length > 0 ? (
          skills.map((skill, index) => (
            <span key={index} className="inline-skill-tag">
              {skill}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeSkill(index);
                }}
                className="inline-skill-tag__remove"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))
        ) : (
          <span className="text-sm text-muted-foreground/50 italic">
            Click to add skills...
          </span>
        )}
      </div>
    </SkillsPopover>
  );
}
