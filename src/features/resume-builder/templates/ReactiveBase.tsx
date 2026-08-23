import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, Section, EntryHeader, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';

export type ReactiveVariant = 'classic' | 'modern' | 'clean' | 'engineering';

const VARIANT_DEFAULTS: Record<ReactiveVariant, { accent: string; heading: 'uppercase' | 'normal' | 'capitalize'; headerAlign: 'center' | 'left'; bulletFont: string; divider: string; pagePad: string }> = {
  classic: { accent: '#1e3a5f', heading: 'uppercase', headerAlign: 'center', bulletFont: 'font-sans', divider: 'border-b-2', pagePad: '1.5rem' },
  modern: { accent: '#0f766e', heading: 'normal', headerAlign: 'left', bulletFont: 'font-sans', divider: 'border-l-4', pagePad: '1.5rem' },
  clean: { accent: '#334155', heading: 'capitalize', headerAlign: 'left', bulletFont: 'font-sans', divider: 'border-b', pagePad: '2.25rem' },
  engineering: { accent: '#1e40af', heading: 'uppercase', headerAlign: 'left', bulletFont: 'font-mono', divider: 'border-b', pagePad: '1.25rem' },
};

// Shared implementation for the four Reactive Resume templates.
// Visual identity is driven by `variant` (accent, heading case, header alignment, bullet font).
export function ReactiveBase({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1, variant = 'classic' }: TemplateProps & { variant?: ReactiveVariant }) {
  const { personalInfo, summary, experience, education, skills } = data;
  const v = VARIANT_DEFAULTS[variant];
  const primaryColor = customization?.primaryColor || v.accent;
  const spacing = getSpacing(customization);
  const align = v.headerAlign;

  const handleFieldChange = (path: string, value: string | string[]) => onFieldChange?.(path, value);
  const handleColorChange = (color: string) => onCustomizationChange?.({ primaryColor: color });

  const sectionTitle: React.CSSProperties = {
    color: primaryColor,
    textTransform: v.heading,
    marginBottom: spacing.itemGap,
  };

  return (
    <ResumePage scale={scale} style={{ padding: v.pagePad }} customization={customization}>
      <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
        <header
          className={`${v.divider} ${align === 'center' ? 'text-center' : 'text-left'}`}
          style={{ marginBottom: spacing.sectionGap, paddingBottom: spacing.itemGap, borderColor: primaryColor }}
        >
          <h1 className="text-3xl font-bold text-gray-900" style={{ marginBottom: spacing.itemGap, lineHeight: spacing.lineHeight }}>
            <EditableField value={personalInfo.fullName} onChange={(val) => handleFieldChange('personalInfo.fullName', val)} placeholder="Your Name" editable={editable} as="span" />
          </h1>
          <div className={`flex flex-wrap gap-4 text-sm text-gray-600 ${align === 'center' ? 'justify-center' : 'justify-start'}`}>
            <span className="inline-flex items-center gap-1"><Mail className="w-3.5 h-3.5" /><EditableField value={personalInfo.email} onChange={(val) => handleFieldChange('personalInfo.email', val)} placeholder="email@example.com" editable={editable} /></span>
            <span className="inline-flex items-center gap-1"><Phone className="w-3.5 h-3.5" /><EditableField value={personalInfo.phone} onChange={(val) => handleFieldChange('personalInfo.phone', val)} placeholder="+1 (555) 000-0000" editable={editable} /></span>
            <span className="inline-flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /><EditableField value={personalInfo.location} onChange={(val) => handleFieldChange('personalInfo.location', val)} placeholder="City, State" editable={editable} /></span>
            {personalInfo.linkedin && (<span className="inline-flex items-center gap-1"><Linkedin className="w-3.5 h-3.5" /><EditableField value={personalInfo.linkedin} onChange={(val) => handleFieldChange('personalInfo.linkedin', val)} placeholder="linkedin.com/in/you" editable={editable} /></span>)}
            {personalInfo.website && (<span className="inline-flex items-center gap-1"><Globe className="w-3.5 h-3.5" /><EditableField value={personalInfo.website} onChange={(val) => handleFieldChange('personalInfo.website', val)} placeholder="yoursite.com" editable={editable} /></span>)}
          </div>
        </header>
      </InlineColorPicker>

      <Section title="Professional Summary" titleStyle={sectionTitle} style={{ marginBottom: spacing.sectionGap }} titleMarginBottom={spacing.itemGap}>
        <div className="text-sm text-gray-700" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField value={summary} onChange={(val) => handleFieldChange('summary', val)} placeholder="Brief professional summary..." editable={editable} as="p" multiline />
        </div>
      </Section>

      <Section title="Work Experience" titleStyle={sectionTitle} style={{ marginBottom: spacing.sectionGap }} titleMarginBottom={spacing.itemGap}>
        <EntryGroup editable={editable} addLabel="Add Experience" onAdd={() => handleFieldChange('experience.add', '')}>
          {experience.map((exp, index) => (
            <EntryWrapper key={exp.id} editable={editable} onDelete={() => handleFieldChange(`experience.${index}.delete`, '')} style={{ marginBottom: spacing.itemGap }}>
              <EntryHeader
                title={<EditableField value={exp.title} onChange={(val) => handleFieldChange(`experience.${index}.title`, val)} placeholder="Job Title" editable={editable} />}
                subtitle={<EditableField value={exp.company} onChange={(val) => handleFieldChange(`experience.${index}.company`, val)} placeholder="Company" editable={editable} />}
                date={<span className="inline-flex items-center gap-1"><EditableField value={exp.startDate} onChange={(val) => handleFieldChange(`experience.${index}.startDate`, val)} placeholder="Start" editable={editable} /><span>–</span><EditableField value={exp.endDate} onChange={(val) => handleFieldChange(`experience.${index}.endDate`, val)} placeholder="End" editable={editable} /></span>}
              />
              <EditableBulletList bullets={exp.bullets} onChange={(b) => handleFieldChange(`experience.${index}.bullets`, b)} editable={editable} style={{ marginTop: spacing.itemGap }} className={v.bulletFont} />
            </EntryWrapper>
          ))}
        </EntryGroup>
      </Section>

      <Section title="Education" titleStyle={sectionTitle} style={{ marginBottom: spacing.sectionGap }} titleMarginBottom={spacing.itemGap}>
        <EntryGroup editable={editable} addLabel="Add Education" onAdd={() => handleFieldChange('education.add', '')}>
          {education.map((edu, index) => (
            <EntryWrapper key={edu.id} editable={editable} onDelete={() => handleFieldChange(`education.${index}.delete`, '')} style={{ marginBottom: spacing.itemGap }}>
              <EntryHeader
                title={<EditableField value={edu.degree} onChange={(val) => handleFieldChange(`education.${index}.degree`, val)} placeholder="Degree" editable={editable} />}
                subtitle={<span className="inline-flex items-center gap-1"><EditableField value={edu.institution} onChange={(val) => handleFieldChange(`education.${index}.institution`, val)} placeholder="Institution" editable={editable} />{edu.field && (<><span className="text-gray-400">·</span><EditableField value={edu.field} onChange={(val) => handleFieldChange(`education.${index}.field`, val)} placeholder="Field" editable={editable} /></>)}</span>}
                date={<EditableField value={edu.graduationYear} onChange={(val) => handleFieldChange(`education.${index}.graduationYear`, val)} placeholder="Year" editable={editable} />}
              />
            </EntryWrapper>
          ))}
        </EntryGroup>
      </Section>

      <Section title="Skills" titleStyle={sectionTitle} style={{ marginBottom: spacing.sectionGap }} titleMarginBottom={spacing.itemGap}>
        <EditableSkills skills={skills} onChange={(s) => handleFieldChange('skills', s)} editable={editable} />
      </Section>

      <CustomSections sections={data.customSections} editable={editable} onFieldChange={handleFieldChange} />
    </ResumePage>
  );
}
