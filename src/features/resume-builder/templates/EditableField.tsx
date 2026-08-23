import { useRef, useCallback, KeyboardEvent, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface EditableFieldProps {
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  as?: 'span' | 'div' | 'p' | 'h1' | 'h2' | 'h3';
  editable?: boolean;
  multiline?: boolean;
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
}

export function EditableField({
  value,
  onChange,
  placeholder = '',
  className = '',
  as: Tag = 'span',
  editable = true,
  multiline = false,
  onEnter,
  onBackspaceEmpty,
}: EditableFieldProps) {
  const ref = useRef<HTMLElement>(null);
  const lastValueRef = useRef(value);

  useEffect(() => {
    if (ref.current && value !== lastValueRef.current) {
      if (ref.current.textContent !== value) {
        ref.current.textContent = value;
      }
      lastValueRef.current = value;
    }
  }, [value]);

  const handleInput = useCallback(() => {
    if (ref.current && onChange) {
      const newValue = ref.current.textContent || '';
      lastValueRef.current = newValue;
      onChange(newValue);
    }
  }, [onChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        if (!multiline || !e.shiftKey) {
          e.preventDefault();
          onEnter?.();
          (e.target as HTMLElement).blur();
        }
      }
      if (e.key === 'Backspace' && !value && onBackspaceEmpty) {
        e.preventDefault();
        onBackspaceEmpty();
      }
    },
    [value, multiline, onEnter, onBackspaceEmpty]
  );

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  if (!editable) {
    return (
      <Tag className={className}>
        {value || placeholder}
      </Tag>
    );
  }

  return (
    <Tag
      ref={ref as any}
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      data-placeholder={placeholder}
      className={cn(
        'editable-field',
        'outline-none rounded-sm transition-colors duration-150',
        'hover:bg-primary/5 focus:bg-primary/10',
        'empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground/50 empty:before:pointer-events-none',
        className
      )}
    >
      {value}
    </Tag>
  );
}

interface EditableBulletListProps {
  bullets: string[];
  onChange?: (bullets: string[]) => void;
  editable?: boolean;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function EditableBulletList({
  bullets,
  onChange,
  editable = true,
  placeholder = 'Add achievement...',
  className = '',
  style,
}: EditableBulletListProps) {
  const handleBulletChange = useCallback(
    (index: number, value: string) => {
      if (!onChange) return;
      const newBullets = [...bullets];
      newBullets[index] = value;
      onChange(newBullets);
    },
    [bullets, onChange]
  );

  const handleBulletEnter = useCallback(
    (index: number) => {
      if (!onChange) return;
      const newBullets = [...bullets];
      newBullets.splice(index + 1, 0, '');
      onChange(newBullets);
    },
    [bullets, onChange]
  );

  const handleBulletBackspace = useCallback(
    (index: number) => {
      if (!onChange || bullets.length <= 1) return;
      const newBullets = bullets.filter((_, i) => i !== index);
      onChange(newBullets);
    },
    [bullets, onChange]
  );

  const addBullet = useCallback(() => {
    if (!onChange) return;
    onChange([...bullets, '']);
  }, [bullets, onChange]);

  return (
    <div className={className} style={style}>
      <ul className="list-none p-0 m-0 space-y-0.5">
        {bullets.map((bullet, index) => (
          <li key={index} className="relative pl-4 text-sm leading-snug before:content-['•'] before:absolute before:left-0 before:text-muted-foreground">
            <EditableField
              value={bullet}
              onChange={(v) => handleBulletChange(index, v)}
              placeholder={placeholder}
              editable={editable}
              onEnter={() => handleBulletEnter(index)}
              onBackspaceEmpty={() => handleBulletBackspace(index)}
            />
          </li>
        ))}
      </ul>
      {editable && (
        <button
          type="button"
          onClick={addBullet}
          className="mt-1 text-xs text-muted-foreground hover:text-primary border border-dashed border-border hover:border-primary rounded px-2 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          + Add bullet
        </button>
      )}
    </div>
  );
}

interface EditableSkillsProps {
  skills: string[];
  onChange?: (skills: string[]) => void;
  editable?: boolean;
  className?: string;
}

export function EditableSkills({
  skills,
  onChange,
  editable = true,
  className = '',
}: EditableSkillsProps) {
  const handleSkillChange = useCallback(
    (index: number, value: string) => {
      if (!onChange) return;
      const newSkills = [...skills];
      newSkills[index] = value;
      onChange(newSkills);
    },
    [skills, onChange]
  );

  const removeSkill = useCallback(
    (index: number) => {
      if (!onChange) return;
      const newSkills = skills.filter((_, i) => i !== index);
      onChange(newSkills);
    },
    [skills, onChange]
  );

  const addSkill = useCallback(() => {
    if (!onChange) return;
    onChange([...skills, '']);
  }, [skills, onChange]);

  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {skills.map((skill, index) => (
        <div
          key={index}
          className="group/skill inline-flex items-center gap-1 px-2.5 py-1 text-sm bg-secondary text-secondary-foreground rounded"
        >
          <EditableField
            value={skill}
            onChange={(v) => handleSkillChange(index, v)}
            placeholder="Skill"
            editable={editable}
            className="min-w-[40px]"
          />
          {editable && (
            <button
              type="button"
              onClick={() => removeSkill(index)}
              className="w-4 h-4 flex items-center justify-center rounded-full opacity-0 group-hover/skill:opacity-100 hover:bg-destructive/20 hover:text-destructive transition-all"
            >
              ×
            </button>
          )}
        </div>
      ))}
      {editable && (
        <button
          type="button"
          onClick={addSkill}
          className="px-2.5 py-1 text-sm text-muted-foreground border border-dashed border-border hover:border-primary hover:text-primary rounded transition-colors"
        >
          + Add
        </button>
      )}
    </div>
  );
}
