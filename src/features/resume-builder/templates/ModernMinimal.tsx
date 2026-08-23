import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSectionsMinimal } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function ModernMinimal({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const accentColor = customization?.secondaryColor || '#64748b';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleAccentColorChange = (color: string) => {
    onCustomizationChange?.({ secondaryColor: color });
  };

  return (
    <ResumePage scale={scale} style={{ padding: spacing.pagePadding }} customization={customization}>
      <header style={{ marginBottom: spacing.sectionGap }}>
        <h1 className="text-4xl font-light tracking-tight text-gray-900" style={{ marginBottom: spacing.itemGap, lineHeight: spacing.lineHeight }}>
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-600">
          <EditableField
            value={personalInfo.email}
            onChange={(v) => handleFieldChange('personalInfo.email', v)}
            placeholder="email@example.com"
            editable={editable}
          />
          <EditableField
            value={personalInfo.phone}
            onChange={(v) => handleFieldChange('personalInfo.phone', v)}
            placeholder="+1 (555) 000-0000"
            editable={editable}
          />
          <EditableField
            value={personalInfo.location}
            onChange={(v) => handleFieldChange('personalInfo.location', v)}
            placeholder="City, State"
            editable={editable}
          />
          {personalInfo.linkedin && (
            <EditableField
              value={personalInfo.linkedin}
              onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
              placeholder="linkedin.com/in/you"
              editable={editable}
            />
          )}
          {personalInfo.website && (
            <EditableField
              value={personalInfo.website}
              onChange={(v) => handleFieldChange('personalInfo.website', v)}
              placeholder="yoursite.com"
              editable={editable}
            />
          )}
        </div>
      </header>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <div className="text-sm text-gray-700" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="A brief professional summary highlighting your key qualifications, expertise, and career objectives..."
            editable={editable}
            as="p"
            multiline
          />
        </div>
      </section>

      <section className="mb-8">
        <InlineColorPicker color={accentColor} onChange={handleAccentColorChange} colorType="secondary" editable={editable}>
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] mb-4" style={{ color: accentColor }}>
            Experience
          </h2>
        </InlineColorPicker>
        <EntryGroup
          editable={editable}
          addLabel="Add Experience"
          onAdd={() => handleFieldChange('experience.add', '')}
        >
          {experience.map((exp, index) => (
            <EntryWrapper
              key={exp.id}
              editable={editable}
              onDelete={() => handleFieldChange(`experience.${index}.delete`, '')}
              style={{ marginBottom: spacing.itemGap, paddingBottom: spacing.itemGap, borderBottom: '1px solid #f3f4f6' }}
              className="last:border-b-0 last:pb-0 last:mb-0"
            >
              <div className="flex justify-between items-baseline mb-1">
                <div>
                  <span className="text-base font-medium text-gray-900">
                    <EditableField
                      value={exp.title}
                      onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                      placeholder="Job Title"
                      editable={editable}
                    />
                  </span>
                  <span className="text-gray-400 mx-2">at</span>
                  <span className="text-base text-gray-700">
                    <EditableField
                      value={exp.company}
                      onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                      placeholder="Company"
                      editable={editable}
                    />
                  </span>
                </div>
                <span className="text-sm text-gray-400 shrink-0">
                  <EditableField
                    value={exp.startDate}
                    onChange={(v) => handleFieldChange(`experience.${index}.startDate`, v)}
                    placeholder="Start"
                    editable={editable}
                  />
                  <span className="mx-1">-</span>
                  <EditableField
                    value={exp.endDate}
                    onChange={(v) => handleFieldChange(`experience.${index}.endDate`, v)}
                    placeholder="Present"
                    editable={editable}
                  />
                </span>
              </div>
              <EditableBulletList
                bullets={exp.bullets}
                onChange={(bullets) => handleFieldChange(`experience.${index}.bullets`, bullets)}
                editable={editable}
                className="mt-2 text-sm text-gray-600"
              />
            </EntryWrapper>
          ))}
        </EntryGroup>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <InlineColorPicker color={accentColor} onChange={handleAccentColorChange} colorType="secondary" editable={editable}>
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: accentColor, marginBottom: spacing.itemGap }}>
            Education
          </h2>
        </InlineColorPicker>
        <EntryGroup
          editable={editable}
          addLabel="Add Education"
          onAdd={() => handleFieldChange('education.add', '')}
        >
          {education.map((edu, index) => (
            <EntryWrapper
              key={edu.id}
              editable={editable}
              onDelete={() => handleFieldChange(`education.${index}.delete`, '')}
              style={{ paddingBottom: spacing.itemGap }}
            >
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="text-base font-medium text-gray-900">
                    <EditableField
                      value={edu.degree}
                      onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                      placeholder="Degree"
                      editable={editable}
                    />
                  </span>
                  {edu.field && (
                    <>
                      <span className="text-gray-400 mx-2">in</span>
                      <span className="text-gray-700">
                        <EditableField
                          value={edu.field}
                          onChange={(v) => handleFieldChange(`education.${index}.field`, v)}
                          placeholder="Field"
                          editable={editable}
                        />
                      </span>
                    </>
                  )}
                </div>
                <span className="text-sm text-gray-400">
                  <EditableField
                    value={edu.graduationYear}
                    onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                    placeholder="Year"
                    editable={editable}
                  />
                </span>
              </div>
              <div className="text-sm text-gray-600">
                <EditableField
                  value={edu.institution}
                  onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                  placeholder="Institution"
                  editable={editable}
                />
              </div>
            </EntryWrapper>
          ))}
        </EntryGroup>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <InlineColorPicker color={accentColor} onChange={handleAccentColorChange} colorType="secondary" editable={editable}>
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: accentColor, marginBottom: spacing.itemGap }}>
            Skills
          </h2>
        </InlineColorPicker>
        <div className="text-sm text-gray-700">
          <EditableSkills
            skills={skills}
            onChange={(newSkills) => handleFieldChange('skills', newSkills)}
            editable={editable}
          />
        </div>
      </section>

      <CustomSectionsMinimal
        sections={data.customSections}
        editable={editable}
        onFieldChange={handleFieldChange}
      />
    </ResumePage>
  );
}

export const modernMinimalInfo = {
  id: 'modern-minimal',
  name: 'Modern Minimal',
  description: 'Ultra-clean design with generous whitespace. ATS-optimized with pure content focus.',
  category: 'minimal' as const,
  isAtsOptimized: true,
};
