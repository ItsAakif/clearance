// StudioNav.tsx - the horizontal section strip above the editor.
//
// The Studio's editor fields and the A4 preview own the width, so the old fixed-width
// vertical rail is gone. One section is selected at a time and the editor pane renders only
// that one. Contact and Summary are the two halves of `basics`, so they are two strip entries
// rather than one oversized block.
//
// THE COUNT IS NOT A SCORE. It is the number of filled contact fields, or the number of
// entries in a list section, so a user can see at a glance which parts of the resume are
// still empty. It is 12px and never a percentage, never a rating.
//
// KEYBOARD. This is a real tablist with roving focus: Left/Right move the strip, Home/End
// jump to the ends, and an arrow key activates the section it lands on (automatic
// activation, which is the expected behaviour for a single-pane editor). It lives ABOVE the
// editor/preview grid so it can use the full content width. Below `sm` it scrolls
// horizontally and hides its scrollbar, so gaining a scrollbar cannot change the strip's
// height; from `sm` up it wraps instead of clipping when the labels do not fit on one row.

import { useRef, type KeyboardEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlignLeft,
  Award,
  Briefcase,
  Folder,
  GraduationCap,
  User,
  Wrench,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StudioModel } from './blockModel';
import type { StudioSection } from './StructureEditor';

interface SectionItem {
  section: StudioSection;
  label: string;
  icon: LucideIcon;
  count: (model: StudioModel) => number;
  /** Whether Add is meaningful for this section. Contact/Summary are field edits, not lists. */
  addLabel: string | null;
}

const SECTION_ITEMS: readonly SectionItem[] = [
  {
    section: 'contact',
    label: 'Contact',
    icon: User,
    count: (model) =>
      [
        model.basics.name,
        model.basics.label,
        model.basics.email,
        model.basics.phone,
        model.basics.url,
        model.basics.location,
      ].filter((value) => value.trim().length > 0).length,
    addLabel: null,
  },
  {
    section: 'summary',
    label: 'Summary',
    icon: AlignLeft,
    count: (model) => (model.basics.summary.trim().length > 0 ? 1 : 0),
    addLabel: null,
  },
  {
    section: 'work',
    label: 'Experience',
    icon: Briefcase,
    count: (model) => model.work.length,
    addLabel: 'Add experience',
  },
  {
    section: 'education',
    label: 'Education',
    icon: GraduationCap,
    count: (model) => model.education.length,
    addLabel: 'Add education',
  },
  {
    section: 'projects',
    label: 'Projects',
    icon: Folder,
    count: (model) => model.projects.length,
    addLabel: 'Add project',
  },
  {
    section: 'skills',
    label: 'Skills',
    icon: Wrench,
    count: (model) => model.skills.length,
    addLabel: 'Add skill',
  },
  {
    section: 'certificates',
    label: 'Certifications',
    icon: Award,
    count: (model) => model.certificates.length,
    addLabel: 'Add certificate',
  },
];

export interface StudioNavProps {
  model: StudioModel;
  section: StudioSection;
  onSelect: (section: StudioSection) => void;
  className?: string;
}

export function StudioNav({ model, section, onSelect, className }: StudioNavProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const focusAt = (index: number) => {
    const next = (index + SECTION_ITEMS.length) % SECTION_ITEMS.length;
    refs.current[next]?.focus();
    onSelect(SECTION_ITEMS[next].section);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusAt(index + 1);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusAt(index - 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusAt(SECTION_ITEMS.length - 1);
    }
  };

  return (
    <div
      role="tablist"
      aria-label="Resume sections"
      aria-orientation="horizontal"
      data-testid="studio-section-strip"
      className={cn(
        // Below `sm` the scrollbar is hidden rather than merely styled: an appearing scrollbar
        // would otherwise shave 8-15px off a 40px strip exactly when the viewport gets narrow.
        // From `sm` up the pills WRAP rather than clip, so every section is visible without
        // horizontal effort; `min-h-10` keeps the one-row height identical to before.
        'flex min-h-10 min-w-0 flex-nowrap items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-x-visible',
        className,
      )}
    >
      {SECTION_ITEMS.map((item, index) => {
        const active = item.section === section;
        const count = item.count(model);
        const Icon = item.icon;
        return (
          <button
            key={item.section}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={item.addLabel ? `${item.label} (${count}) - ${item.addLabel}` : `${item.label} (${count})`}
            onClick={() => onSelect(item.section)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-ink-3 hover:bg-paper-2 hover:text-ink',
            )}
          >
            <Icon
              className={cn(
                'h-[15px] w-[15px] shrink-0',
                active ? 'text-primary-foreground' : 'text-ink-3',
              )}
              aria-hidden="true"
            />
            <span className="truncate text-left">{item.label}</span>
            <span
              className={cn(
                'num text-[12px] tabular-nums',
                active ? 'text-primary-foreground/80' : 'text-ink-3',
              )}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default StudioNav;
