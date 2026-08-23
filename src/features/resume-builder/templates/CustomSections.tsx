import { cn } from '@/lib/utils';
import { CustomSection, CustomEntry } from '@/types/resume';
import { EditableField, EditableBulletList } from './EditableField';
import { EntryGroup, EntryWrapper } from './BaseComponents';
import { Trash2, Plus } from 'lucide-react';

interface CustomSectionsProps {
  sections?: CustomSection[];
  editable?: boolean;
  onFieldChange?: (path: string, value: string | string[]) => void;
  sectionClassName?: string;
  headingClassName?: string;
  contentClassName?: string;
  entryClassName?: string;
  bulletClassName?: string;
  primaryColor?: string;
  variant?: 'default' | 'sidebar' | 'cards' | 'minimal';
}

export function CustomSections({
  sections = [],
  editable = true,
  onFieldChange,
  sectionClassName,
  headingClassName,
  contentClassName,
  entryClassName,
  bulletClassName,
  primaryColor = '#1e293b',
  variant = 'default',
}: CustomSectionsProps) {
  if (!sections || sections.length === 0) {
    return null;
  }

  const handleTitleChange = (sectionIndex: number, value: string) => {
    onFieldChange?.(`customSection.${sectionIndex}.title`, value);
  };

  const handleContentChange = (sectionIndex: number, value: string) => {
    onFieldChange?.(`customSection.${sectionIndex}.content`, value);
  };

  const handleDeleteSection = (sectionIndex: number) => {
    onFieldChange?.(`customSection.${sectionIndex}.delete`, '');
  };

  const handleAddEntry = (sectionIndex: number) => {
    onFieldChange?.(`customSection.${sectionIndex}.entry.add`, '');
  };

  const handleDeleteEntry = (sectionIndex: number, entryIndex: number) => {
    onFieldChange?.(`customSection.${sectionIndex}.entry.${entryIndex}.delete`, '');
  };

  const handleEntryFieldChange = (sectionIndex: number, entryIndex: number, field: string, value: string | string[]) => {
    onFieldChange?.(`customSection.${sectionIndex}.entry.${entryIndex}.${field}`, value);
  };

  const getVariantStyles = () => {
    switch (variant) {
      case 'sidebar':
        return {
          section: 'mb-5',
          heading: 'text-xs font-bold uppercase tracking-wider mb-3 text-white/80',
          content: 'text-sm text-white/90 leading-relaxed',
          entry: 'mb-3 pb-3 border-b border-white/20 last:border-b-0',
        };
      case 'cards':
        return {
          section: 'mb-6 bg-white rounded-lg shadow-sm border border-gray-100 p-4',
          heading: 'text-sm font-bold uppercase tracking-wider mb-3',
          content: 'text-sm text-gray-600 leading-relaxed',
          entry: 'mb-4 p-3 bg-gray-50 rounded-lg last:mb-0',
        };
      case 'minimal':
        return {
          section: 'mb-6',
          heading: 'text-xs font-semibold uppercase tracking-[0.2em] text-gray-400 mb-3',
          content: 'text-sm text-gray-700 leading-relaxed',
          entry: 'mb-3 pb-3 border-b border-gray-100 last:border-b-0 last:pb-0',
        };
      default:
        return {
          section: 'mb-6',
          heading: 'text-sm font-bold uppercase tracking-wider mb-3 pb-1 border-b-2',
          content: 'text-sm text-gray-700 leading-relaxed',
          entry: 'mb-4 last:mb-0',
        };
    }
  };

  const styles = getVariantStyles();

  const renderTextSection = (section: CustomSection, sectionIndex: number) => (
    <div className={cn(styles.content, contentClassName)}>
      <EditableField
        value={section.content || ''}
        onChange={(v) => handleContentChange(sectionIndex, v)}
        placeholder="Add content here..."
        editable={editable}
        as="p"
        multiline
      />
    </div>
  );

  const renderListSection = (section: CustomSection, sectionIndex: number) => {
    const items = section.content
      ? section.content.split(/[,\n]/).map(item => item.trim()).filter(Boolean)
      : [];

    return (
      <div className={cn(styles.content, contentClassName)}>
        <EditableBulletList
          bullets={items.length > 0 ? items : ['']}
          onChange={(bullets) => handleContentChange(sectionIndex, bullets.join('\n'))}
          editable={editable}
          className={cn('text-sm', bulletClassName)}
        />
      </div>
    );
  };

  const renderEntriesSection = (section: CustomSection, sectionIndex: number) => {
    const entries = section.entries || [];

    return (
      <EntryGroup
        editable={editable}
        addLabel="Add Entry"
        onAdd={() => handleAddEntry(sectionIndex)}
      >
        {entries.map((entry, entryIndex) => (
          <EntryWrapper
            key={entry.id}
            editable={editable}
            onDelete={() => handleDeleteEntry(sectionIndex, entryIndex)}
            className={cn(styles.entry, entryClassName)}
          >
            <div className="flex justify-between items-start mb-1">
              <div>
                <div className="font-medium text-gray-900">
                  <EditableField
                    value={entry.title || ''}
                    onChange={(v) => handleEntryFieldChange(sectionIndex, entryIndex, 'title', v)}
                    placeholder="Title"
                    editable={editable}
                  />
                </div>
                {entry.subtitle && (
                  <div className="text-sm" style={{ color: primaryColor }}>
                    <EditableField
                      value={entry.subtitle}
                      onChange={(v) => handleEntryFieldChange(sectionIndex, entryIndex, 'subtitle', v)}
                      placeholder="Subtitle"
                      editable={editable}
                    />
                  </div>
                )}
              </div>
              {entry.date && (
                <span className="text-xs text-gray-500 shrink-0">
                  <EditableField
                    value={entry.date}
                    onChange={(v) => handleEntryFieldChange(sectionIndex, entryIndex, 'date', v)}
                    placeholder="Date"
                    editable={editable}
                  />
                </span>
              )}
            </div>
            {entry.description && (
              <div className="text-sm text-gray-600 mt-1">
                <EditableField
                  value={entry.description}
                  onChange={(v) => handleEntryFieldChange(sectionIndex, entryIndex, 'description', v)}
                  placeholder="Description"
                  editable={editable}
                  as="p"
                  multiline
                />
              </div>
            )}
            {entry.bullets && entry.bullets.length > 0 && (
              <EditableBulletList
                bullets={entry.bullets}
                onChange={(bullets) => handleEntryFieldChange(sectionIndex, entryIndex, 'bullets', bullets)}
                editable={editable}
                className="mt-2 text-sm text-gray-600"
              />
            )}
            {!entry.subtitle && !entry.date && !entry.description && (!entry.bullets || entry.bullets.length === 0) && editable && (
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleEntryFieldChange(sectionIndex, entryIndex, 'subtitle', 'Organization')}
                  className="text-xs px-2 py-1 border border-dashed border-gray-300 rounded text-gray-400 hover:border-blue-400 hover:text-blue-500"
                >
                  + Subtitle
                </button>
                <button
                  type="button"
                  onClick={() => handleEntryFieldChange(sectionIndex, entryIndex, 'date', '2024')}
                  className="text-xs px-2 py-1 border border-dashed border-gray-300 rounded text-gray-400 hover:border-blue-400 hover:text-blue-500"
                >
                  + Date
                </button>
                <button
                  type="button"
                  onClick={() => handleEntryFieldChange(sectionIndex, entryIndex, 'description', 'Description...')}
                  className="text-xs px-2 py-1 border border-dashed border-gray-300 rounded text-gray-400 hover:border-blue-400 hover:text-blue-500"
                >
                  + Description
                </button>
                <button
                  type="button"
                  onClick={() => handleEntryFieldChange(sectionIndex, entryIndex, 'bullets', ['Achievement or responsibility'])}
                  className="text-xs px-2 py-1 border border-dashed border-gray-300 rounded text-gray-400 hover:border-blue-400 hover:text-blue-500"
                >
                  + Bullets
                </button>
              </div>
            )}
          </EntryWrapper>
        ))}
        {entries.length === 0 && editable && (
          <button
            type="button"
            onClick={() => handleAddEntry(sectionIndex)}
            className="w-full py-3 border border-dashed border-gray-300 rounded-lg text-gray-400 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50/50 transition-all text-sm flex items-center justify-center gap-1"
          >
            <Plus className="w-4 h-4" />
            Add First Entry
          </button>
        )}
      </EntryGroup>
    );
  };

  return (
    <>
      {sections.map((section, sectionIndex) => (
        <section
          key={section.id}
          className={cn('relative group', styles.section, sectionClassName)}
        >
          {editable && (
            <button
              type="button"
              onClick={() => handleDeleteSection(sectionIndex)}
              className="absolute -right-2 -top-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600 z-10"
              title="Delete section"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}

          <h2
            className={cn(styles.heading, headingClassName)}
            style={variant === 'default' ? { borderColor: primaryColor, color: primaryColor } : undefined}
          >
            <EditableField
              value={section.title}
              onChange={(v) => handleTitleChange(sectionIndex, v)}
              placeholder="Section Title"
              editable={editable}
              as="span"
            />
          </h2>

          {section.type === 'text' && renderTextSection(section, sectionIndex)}
          {section.type === 'list' && renderListSection(section, sectionIndex)}
          {section.type === 'entries' && renderEntriesSection(section, sectionIndex)}
        </section>
      ))}
    </>
  );
}

export function CustomSectionsSidebar(props: Omit<CustomSectionsProps, 'variant'>) {
  return <CustomSections {...props} variant="sidebar" />;
}

export function CustomSectionsCards(props: Omit<CustomSectionsProps, 'variant'>) {
  return <CustomSections {...props} variant="cards" />;
}

export function CustomSectionsMinimal(props: Omit<CustomSectionsProps, 'variant'>) {
  return <CustomSections {...props} variant="minimal" />;
}
