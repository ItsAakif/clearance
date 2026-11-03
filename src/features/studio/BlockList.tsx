// BlockList.tsx - one section's blocks, with reorder and include/exclude (T1050).
//
// A THIN VIEW. Every rule - what an id is, what excluding means, how a path is derived -
// lives in `blockModel.ts` and is asserted in `blockModel.test.ts`; this file only renders the
// buttons and wires the handlers. That split is the house style (`features/career`:
// `claimPresentation.ts` holds the rules, `ClaimList.tsx` holds the markup) and it is what
// makes the invariants testable in a node-only runner.
//
// KEYBOARD AND A11Y, because the acceptance item names them:
//   - reorder is TWO REAL BUTTONS (`Move <block> up` / `down`) rather than a drag handle. A
//     drag handle is unusable without a pointer; two buttons are operable by Tab + Enter and
//     their accessible names say what they will do. A disabled button at the ends is how the
//     boundary is communicated, instead of a click that silently does nothing.
//   - include/exclude is a real button with TEXT in both states, because "excluded" is a state
//     a user must be able to see rather than infer from an absence.
//   - every field has a `<label htmlFor>` naming the block it belongs to, so a screen-reader
//     user moving through the list always knows WHICH role they are editing.
//   - a claim's status is icon + TEXT (`StatusBadge`), never colour alone (06 E.11).

import { ArrowDown, ArrowUp, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/features/career/StatusBadge';
import { InlineField } from './InlineField';
import {
  SECTION_LABELS,
  excludeBlock,
  includeBlock,
  reorderBlock,
  setBlockField,
  setBlockList,
  type AnyBlock,
  type InlineValue,
  type RailText,
  type SectionKey,
  type StudioModel,
} from './blockModel';

export interface BlockListProps {
  model: StudioModel;
  section: Exclude<SectionKey, 'basics'>;
  /** A structural edit: reorder, exclude, include. */
  onChange: (model: StudioModel) => void;
  /** One claim-backed statement was re-worded. */
  onEditHighlight: (input: {
    section: 'work' | 'projects';
    blockId: string;
    highlightIndex: number;
    value: InlineValue;
  }) => void;
  /** The status of the claim behind a statement, or `null` when there is none. */
  claimStatusFor: (blockId: string, highlightIndex: number) => string | null;
}

/** What a block is called in the UI: its own name(s), or its position. Never an empty row. */
function blockTitle(section: Exclude<SectionKey, 'basics'>, block: AnyBlock, index: number): string {
  const record = block as unknown as Record<string, unknown>;
  const named = [record.position, record.name, record.institution]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' at ');
  return named.length > 0 ? named : `${SECTION_LABELS[section]} ${index + 1}`;
}

/** A single-line field. Commits on blur, so a keystroke does not create a revision. */
function TextField({
  id,
  label,
  value,
  placeholder,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs2 font-medium text-ink">
        {label}
      </label>
      <Input
        id={id}
        defaultValue={value}
        placeholder={placeholder}
        onBlur={(event) => {
          if (event.target.value === value) return;
          onCommit(event.target.value);
        }}
      />
    </div>
  );
}

/** A list of values as one comma-separated input. */
function ListField({
  id,
  label,
  values,
  onCommit,
}: {
  id: string;
  label: string;
  values: readonly string[];
  onCommit: (value: readonly string[]) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs2 font-medium text-ink">
        {label}
      </label>
      <Input
        id={id}
        defaultValue={values.join(', ')}
        placeholder="comma, separated"
        onBlur={(event) => {
          const next = event.target.value
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
          if (next.join(', ') === values.join(', ')) return;
          onCommit(next);
        }}
      />
    </div>
  );
}

export function BlockList({ model, section, onChange, onEditHighlight, claimStatusFor }: BlockListProps) {
  const blocks = model[section] as AnyBlock[];
  const excluded = model.excluded.filter((entry) => entry.section === section);
  const field = (blockId: string, name: string) => (value: string) =>
    onChange(setBlockField(model, section, blockId, name, value));
  const list = (blockId: string, name: 'roles' | 'keywords') => (value: readonly string[]) =>
    onChange(setBlockList(model, section, blockId, name, value));

  return (
    <div className="space-y-2">
      {blocks.length === 0 && excluded.length === 0 ? (
        <p className="text-sm text-ink-3">
          Nothing in {SECTION_LABELS[section].toLowerCase()} yet.
        </p>
      ) : null}

      <ul className="space-y-4">
        {blocks.map((block, index) => {
          const title = blockTitle(section, block, index);
          const id = block.id;
          const rail = (block as { highlights?: RailText[] }).highlights ?? [];
          return (
            <li key={id} className="space-y-4 rounded-control border border-rule bg-paper p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink">{title}</p>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    aria-label={`Move ${title} up`}
                    onClick={() => onChange(reorderBlock(model, section, index, index - 1))}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                    Up
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === blocks.length - 1}
                    aria-label={`Move ${title} down`}
                    onClick={() => onChange(reorderBlock(model, section, index, index + 1))}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                    Down
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Exclude ${title} from this resume`}
                    onClick={() => onChange(excludeBlock(model, section, index))}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Exclude
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {section === 'work' ? (
                  <>
                    <TextField id={`${id}-name`} label="Employer" value={(block as never as { name: string }).name} onCommit={field(id, 'name')} />
                    <TextField id={`${id}-position`} label="Role" value={(block as never as { position: string }).position} onCommit={field(id, 'position')} />
                    <TextField id={`${id}-start`} label="Started (YYYY-MM)" placeholder="2020-01" value={(block as never as { startDate: string }).startDate} onCommit={field(id, 'startDate')} />
                    <TextField id={`${id}-end`} label="Ended (blank means current)" placeholder="2024-06" value={(block as never as { endDate: string }).endDate} onCommit={field(id, 'endDate')} />
                  </>
                ) : null}
                {section === 'education' ? (
                  <>
                    <TextField id={`${id}-institution`} label="Institution" value={(block as never as { institution: string }).institution} onCommit={field(id, 'institution')} />
                    <TextField id={`${id}-studytype`} label="Credential" value={(block as never as { studyType: string }).studyType} onCommit={field(id, 'studyType')} />
                    <TextField id={`${id}-area`} label="Field" value={(block as never as { area: string }).area} onCommit={field(id, 'area')} />
                    <TextField id={`${id}-end`} label="Finished (YYYY)" value={(block as never as { endDate: string }).endDate} onCommit={field(id, 'endDate')} />
                  </>
                ) : null}
                {section === 'projects' ? (
                  <>
                    <TextField id={`${id}-name`} label="Project" value={(block as never as { name: string }).name} onCommit={field(id, 'name')} />
                    <ListField id={`${id}-keywords`} label="Keywords" values={(block as never as { keywords: string[] }).keywords} onCommit={list(id, 'keywords')} />
                  </>
                ) : null}
                {section === 'skills' ? (
                  <>
                    <TextField id={`${id}-name`} label="Skill" value={(block as never as { name: string }).name} onCommit={field(id, 'name')} />
                    <ListField id={`${id}-keywords`} label="Related keywords" values={(block as never as { keywords: string[] }).keywords} onCommit={list(id, 'keywords')} />
                  </>
                ) : null}
                {section === 'certificates' ? (
                  <>
                    <TextField id={`${id}-name`} label="Certificate" value={(block as never as { name: string }).name} onCommit={field(id, 'name')} />
                    <TextField id={`${id}-issuer`} label="Issuer" value={(block as never as { issuer: string }).issuer} onCommit={field(id, 'issuer')} />
                  </>
                ) : null}
              </div>

              {section === 'work' || section === 'projects' ? (
                <div className="space-y-2 border-t border-rule pt-2">
                  <p className="text-xs2 font-medium text-ink">
                    {section === 'work' ? 'What you did' : 'What it did'}
                    <span className="ml-1 font-normal text-ink-3">
                      - one claim per line. A line with no claim behind it cannot be added here,
                      which is why this list only ever re-words what the profile already asserts.
                    </span>
                  </p>
                  {rail.length === 0 ? (
                    <p className="text-xs2 text-ink-3">No statements on this entry.</p>
                  ) : null}
                  {rail.map((entry, highlightIndex) => {
                    const status = claimStatusFor(id, highlightIndex);
                    return (
                      <div key={`${entry.claimId}-${highlightIndex}`} className="space-y-1">
                        <InlineField
                          id={`${id}-hl-${highlightIndex}`}
                          label={`Statement ${highlightIndex + 1}`}
                          value={{ format: 'inline-v1', runs: [{ text: entry.text }] }}
                          description={
                            status
                              ? undefined
                              : 'This line has no claim behind it, so it cannot be saved.'
                          }
                          onChange={(value) =>
                            onEditHighlight({ section, blockId: id, highlightIndex, value })
                          }
                        />
                        {status ? <StatusBadge status={status} /> : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {excluded.length > 0 ? (
        <div className="space-y-2 rounded-control border border-dashed border-rule p-3">
          <p className="text-xs2 font-medium text-ink">
            Excluded - not in this resume
            <span className="ml-1 font-normal text-ink-3">
              (the claims inside these are recorded as omitted)
            </span>
          </p>
          <ul className="space-y-1">
            {excluded.map((entry) => {
              const globalIndex = model.excluded.indexOf(entry);
              const title = blockTitle(section, entry.block, globalIndex);
              return (
                <li key={`${entry.section}-excluded-${globalIndex}`} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-ink-3">{title}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Include ${title} again`}
                    onClick={() => onChange(includeBlock(model, globalIndex))}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    Include again
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {excluded.length > 0 ? (
        <Badge variant="outline" className="text-xs2 text-ink-3">
          {blocks.length} of {blocks.length + excluded.length} included
        </Badge>
      ) : null}
    </div>
  );
}

export default BlockList;