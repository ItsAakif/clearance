// StructureEditor.tsx - the editor pane: ONE semantic section at a time (T1050, ADR-037).
//
// This is 06 E.11 flow 4's editor half: "structured block editor (contact, summary, experience,
// ..., reorderable, per-block include/exclude)". The Studio renders a rail, and the rail names
// the section this component renders. The component holds no rules of its own and no layout:
// every mutation goes through `blockModel.ts`, exactly as before the pane was split.
//
// WHY A `section` PROP. The old editor rendered every block in one long form beside the
// preview. That is the part of the Studio a user could not use: seven sections, dozens of
// fields, all at once. The rail chooses one; this file renders one. `contact` and `summary`
// are the two halves of `basics`, so the pane can show contact fields without the summary
// textarea swallowing the column beneath them.
//
// WHAT IS EDITABLE AND WHAT IS NOT, stated here because the boundary is not obvious from the
// markup:
//   - The CLAIM-BACKED statements (`work[].highlights`, `projects[].highlights`) are editable
//     as TEXT, and the edit is recorded as `usage: 'tailored'` in the document's own
//     `x-clearance` block - which is the vocabulary 05 sec.6.3 defines for a re-worded claim.
//     They cannot be ADDED or DELETED here, because a claim-rail string that no `x-clearance`
//     entry names is refused by `createRevision` (`assertClaimBackedTextAccounted`). So the
//     editor offers "re-word what you have", not "type anything", and says so.
//   - A claim's STATUS is never editable. It is `CareerClaim.status` copied by the projector,
//     and `createRevision` refuses a document that disagrees with the rows. Confirming happens
//     on the Career Evidence page, which is where the audit row is written.
//   - `basics`, education, projects, skills and certifications carry no claim-rail text, so
//     their fields are ordinary strings and their entries can be added and removed freely.

import { useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineField } from './InlineField';
import { BlockList } from './BlockList';
import { profileApi } from '@/services/api';
import {
  SECTION_LABELS,
  addBlock,
  editInlineValue,
  inlineFromPlainText,
  inlineToPlainText,
  type InlineValue,
  type SectionKey,
  type StudioModel,
} from './blockModel';

/** The sections the rail can select. `contact` and `summary` split the one `basics` block. */
export type StudioSection =
  | 'contact'
  | 'summary'
  | 'work'
  | 'education'
  | 'projects'
  | 'skills'
  | 'certificates';

const SECTION_HINTS: Record<StudioSection, string> = {
  contact:
    'Who you are and how to reach you. A name is required; the rest is optional.',
  summary:
    'A few sentences in your own words. The summary is an ordinary string, not a claim-backed statement.',
  work:
    'Order is yours to choose, and a statement keeps the claim behind it wherever it moves. Excluding an entry removes it from the resume and records its claims as omitted.',
  education: 'Most recent first. Dates are free text, so "2024" and "2024-06" are both fine.',
  projects:
    'What you built and what it did. Project highlights are claim-backed, so they can be re-worded but not invented here.',
  skills: 'One group of related skills per entry. Keywords are comma separated.',
  certificates: 'Certifications that are still current. An excluded certificate stays in the profile.',
};

/** A single-line basics field. Commits on blur, like every other text control here. */
function BasicsField({
  id,
  label,
  value,
  onCommit,
}: {
  id: string;
  label: string;
  value: string;
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
        onBlur={(event) => {
          if (event.target.value === value) return;
          onCommit(event.target.value);
        }}
      />
    </div>
  );
}

/** The selected section's heading: 16px semibold, a one-line hint, and one action at most. */
function SectionHeading({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-rule pb-3">
      <div className="min-w-0">
        <h2 id="studio-section-heading" className="text-[16px] font-semibold leading-snug text-ink">
          {title}
        </h2>
        <p className="mt-0.5 text-xs2 text-ink-3">{hint}</p>
      </div>
      {action}
    </div>
  );
}

export interface StructureEditorProps {
  model: StudioModel;
  /** The one section the rail selected. Only this section is rendered. */
  section: StudioSection;
  /** Every edit funnels through here so the page can mark the document dirty exactly once. */
  onChange: (model: StudioModel) => void;
  /**
   * Applies a bulk, user-requested change (the profile sync) WITHOUT scheduling the
   * autosave. The page marks the document dirty so the user decides when to save.
   */
  onSync?: (model: StudioModel) => void;
}

export function StructureEditor({ model, section, onChange, onSync }: StructureEditorProps) {
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const setBasics = (name: string) => (value: string) =>
    onChange({ ...model, basics: { ...model.basics, [name]: value } });

  const onEditHighlight = (input: {
    section: 'work' | 'projects';
    blockId: string;
    highlightIndex: number;
    value: InlineValue;
  }) => {
    const { model: next } = editInlineValue(model, input);
    onChange(next);
  };

  const claimStatusFor = (blockId: string, highlightIndex: number): string | null => {
    const list = model[blockId.startsWith('work:') ? 'work' : 'projects'] as Array<{
      id: string;
      highlights: Array<{ claimId: string }>;
    }>;
    const block = list.find((entry) => entry.id === blockId);
    const rail = block?.highlights[highlightIndex];
    if (!rail) return null;
    const entry = model.claims.find((claim) => claim.claimId === rail.claimId);
    return entry?.status ?? null;
  };

  /**
   * Copy the person's contact fields from GET /profile. Only NON-EMPTY values overwrite
   * the document, so a sparse profile cannot blank fields the user already typed.
   * `onSync` (not `onChange`) is used deliberately: this action marks the document dirty
   * but does not schedule an autosave.
   */
  const syncFromProfile = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const profile = await profileApi.get();
      if (!profile) {
        setSyncError('No career profile to sync from yet.');
        return;
      }
      const kept = (value: unknown): string | null =>
        typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
      const links = profile.links ?? {};
      const updates: Array<
        ['name' | 'label' | 'email' | 'phone' | 'url' | 'location', string | null]
      > = [
        ['name', kept(profile.name)],
        ['label', kept(profile.headline)],
        ['email', kept(profile.email) ?? kept(links.email)],
        ['phone', kept(links.phone)],
        ['url', kept(links.website)],
        ['location', kept(profile.locationPref)],
      ];
      let changed = false;
      const basics = { ...model.basics };
      for (const [field, value] of updates) {
        if (value !== null && basics[field] !== value) {
          basics[field] = value;
          changed = true;
        }
      }
      if (!changed) return;
      (onSync ?? onChange)({ ...model, basics });
    } catch {
      setSyncError('Your career profile could not be loaded.');
    } finally {
      setSyncing(false);
    }
  };

  if (section === 'contact') {
    return (
      <div className="space-y-4" data-testid="studio-structure-editor">
        <section className="surface-card p-5" aria-labelledby="studio-section-heading">
          <SectionHeading
            title="Contact"
            hint={SECTION_HINTS.contact}
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={syncing}
                onClick={() => void syncFromProfile()}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                {syncing ? 'Syncing…' : 'Sync from profile'}
              </Button>
            }
          />
          {syncError ? (
            <p className="mt-3 text-xs2 text-destructive" role="alert">
              {syncError}
            </p>
          ) : null}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <BasicsField id="basics-name" label="Name" value={model.basics.name} onCommit={setBasics('name')} />
            <BasicsField id="basics-label" label="Headline" value={model.basics.label} onCommit={setBasics('label')} />
            <BasicsField id="basics-email" label="Email" value={model.basics.email} onCommit={setBasics('email')} />
            <BasicsField id="basics-phone" label="Phone" value={model.basics.phone} onCommit={setBasics('phone')} />
            <BasicsField id="basics-url" label="Website" value={model.basics.url} onCommit={setBasics('url')} />
            <BasicsField id="basics-location" label="Location" value={model.basics.location} onCommit={setBasics('location')} />
          </div>
        </section>
      </div>
    );
  }

  if (section === 'summary') {
    return (
      <div className="space-y-4" data-testid="studio-structure-editor">
        <section className="surface-card p-5" aria-labelledby="studio-section-heading">
          <SectionHeading title="Summary" hint={SECTION_HINTS.summary} />
          <div className="mt-4">
            <InlineField
              id="basics-summary"
              label="Summary"
              value={inlineFromPlainText(model.basics.summary)}
              placeholder="A few sentences in your own words."
              // `basics.summary` is NOT on the claim rail (ADR-043 R-SUMMARY: the projector
              // copies it from the profile column and there is no claim to compare it against),
              // so it is an ordinary string set from the inline value's plain text rather than
              // a claim-rail edit.
              onChange={(value) =>
                onChange({ ...model, basics: { ...model.basics, summary: inlineToPlainText(value) } })
              }
            />
          </div>
        </section>
      </div>
    );
  }

  // A list section: exactly one `LIST_SECTIONS` member per branch above.
  const listSection = section as Exclude<SectionKey, 'basics'>;
  const addLabel: Record<Exclude<SectionKey, 'basics'>, string> = {
    work: 'experience',
    education: 'education',
    projects: 'project',
    skills: 'skill',
    certificates: 'certificate',
  };
  const addName = addLabel[listSection];

  return (
    <div className="space-y-4" data-testid="studio-structure-editor">
      <section className="surface-card space-y-4 p-5" aria-labelledby="studio-section-heading">
        <SectionHeading
          title={SECTION_LABELS[listSection]}
          hint={SECTION_HINTS[listSection]}
          action={
            <Button
              size="sm"
              variant="outline"
              aria-label={`Add ${addName}`}
              onClick={() => onChange(addBlock(model, listSection))}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Add {addName}
            </Button>
          }
        />
        <div className="border-t border-rule pt-4">
          <BlockList
            model={model}
            section={listSection}
            onChange={onChange}
            onEditHighlight={onEditHighlight}
            claimStatusFor={claimStatusFor}
          />
        </div>
      </section>
    </div>
  );
}

export default StructureEditor;
