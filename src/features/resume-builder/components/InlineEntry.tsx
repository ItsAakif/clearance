import { useRef, useCallback, KeyboardEvent } from "react";
import { EntryDeleteButton } from "./SectionControls";

interface InlineEditableProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  as?: "span" | "div" | "p";
  onEnter?: () => void;
  onBackspaceEmpty?: () => void;
}

function InlineEditable({
  value,
  onChange,
  placeholder = "Click to edit...",
  className = "",
  as: Tag = "span",
  onEnter,
  onBackspaceEmpty,
}: InlineEditableProps) {
  const ref = useRef<HTMLElement>(null);

  const handleInput = useCallback(() => {
    if (ref.current) {
      onChange(ref.current.textContent || "");
    }
  }, [onChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onEnter?.();
      }
      if (e.key === "Backspace" && !value && onBackspaceEmpty) {
        e.preventDefault();
        onBackspaceEmpty();
      }
    },
    [value, onEnter, onBackspaceEmpty]
  );

  return (
    <Tag
      ref={ref as any}
      contentEditable
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      data-placeholder={placeholder}
      className={`inline-editable ${className}`}
    >
      {value}
    </Tag>
  );
}

interface InlineExperienceEntryProps {
  entry: {
    id: string;
    title?: string;
    company?: string;
    startDate?: string;
    endDate?: string;
    bullets?: string[];
    [key: string]: unknown;
  };
  onUpdate: (field: string, value: unknown) => void;
  onDelete: () => void;
}

export function InlineExperienceEntry({
  entry,
  onUpdate,
  onDelete,
}: InlineExperienceEntryProps) {
  const bullets = Array.isArray(entry.bullets) ? entry.bullets : [];

  const handleBulletChange = (index: number, value: string) => {
    const newBullets = [...bullets];
    newBullets[index] = value;
    onUpdate("bullets", newBullets);
  };

  const handleBulletEnter = (index: number) => {
    const newBullets = [...bullets];
    newBullets.splice(index + 1, 0, "");
    onUpdate("bullets", newBullets);
  };

  const handleBulletBackspace = (index: number) => {
    if (bullets.length > 1) {
      const newBullets = bullets.filter((_, i) => i !== index);
      onUpdate("bullets", newBullets);
    }
  };

  const addBullet = () => {
    onUpdate("bullets", [...bullets, ""]);
  };

  return (
    <div className="inline-entry group">
      <EntryDeleteButton onDelete={onDelete} />

      <div className="inline-experience__header">
        <div>
          <div className="inline-experience__title">
            <InlineEditable
              value={String(entry.title || "")}
              onChange={(v) => onUpdate("title", v)}
              placeholder="Job Title"
            />
          </div>
          <div className="inline-experience__company">
            <InlineEditable
              value={String(entry.company || "")}
              onChange={(v) => onUpdate("company", v)}
              placeholder="Company Name"
            />
          </div>
        </div>
        <div className="inline-experience__dates">
          <InlineEditable
            value={String(entry.startDate || "")}
            onChange={(v) => onUpdate("startDate", v)}
            placeholder="Start"
          />
          <span className="mx-1">–</span>
          <InlineEditable
            value={String(entry.endDate || "")}
            onChange={(v) => onUpdate("endDate", v)}
            placeholder="End"
          />
        </div>
      </div>

      {bullets.length > 0 && (
        <ul className="inline-bullets">
          {bullets.map((bullet, index) => (
            <li key={index}>
              <InlineEditable
                value={bullet}
                onChange={(v) => handleBulletChange(index, v)}
                placeholder="Add achievement..."
                onEnter={() => handleBulletEnter(index)}
                onBackspaceEmpty={() => handleBulletBackspace(index)}
              />
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="inline-add-btn text-xs mt-2"
        onClick={addBullet}
      >
        + Add bullet
      </button>
    </div>
  );
}

interface InlineEducationEntryProps {
  entry: {
    id: string;
    degree?: string;
    institution?: string;
    field?: string;
    graduationYear?: string;
    [key: string]: unknown;
  };
  onUpdate: (field: string, value: unknown) => void;
  onDelete: () => void;
}

export function InlineEducationEntry({
  entry,
  onUpdate,
  onDelete,
}: InlineEducationEntryProps) {
  return (
    <div className="inline-entry group">
      <EntryDeleteButton onDelete={onDelete} />

      <div className="inline-experience__header">
        <div>
          <div className="inline-experience__title">
            <InlineEditable
              value={String(entry.degree || "")}
              onChange={(v) => onUpdate("degree", v)}
              placeholder="Degree"
            />
          </div>
          <div className="inline-experience__company">
            <InlineEditable
              value={String(entry.institution || "")}
              onChange={(v) => onUpdate("institution", v)}
              placeholder="Institution"
            />
            {entry.field && (
              <>
                <span className="mx-1">·</span>
                <InlineEditable
                  value={String(entry.field || "")}
                  onChange={(v) => onUpdate("field", v)}
                  placeholder="Field of Study"
                />
              </>
            )}
          </div>
        </div>
        <div className="inline-experience__dates">
          <InlineEditable
            value={String(entry.graduationYear || "")}
            onChange={(v) => onUpdate("graduationYear", v)}
            placeholder="Year"
          />
        </div>
      </div>
    </div>
  );
}

export { InlineEditable };
