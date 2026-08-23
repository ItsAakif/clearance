import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function AccentLine({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const secondaryColor = customization?.secondaryColor || '#3b82f6';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleSecondaryColorChange = (color: string) => {
    onCustomizationChange?.({ secondaryColor: color });
  };

  return (
    <ResumePage scale={scale} className="bg-white" style={{ padding: spacing.pagePadding }} customization={customization}>
      <InlineColorPicker color={secondaryColor} onChange={handleSecondaryColorChange} colorType="secondary" editable={editable}>
        <div className="h-2 w-full rounded-full" style={{ backgroundColor: secondaryColor, marginBottom: spacing.sectionGap }}></div>
      </InlineColorPicker>

      <header style={{ marginBottom: spacing.sectionGap }}>
        <h1 className="text-4xl font-bold text-gray-900" style={{ marginBottom: spacing.itemGap }}>
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="flex flex-wrap gap-4 text-sm text-gray-600">
          <EditableField
            value={personalInfo.email}
            onChange={(v) => handleFieldChange('personalInfo.email', v)}
            placeholder="email@example.com"
            editable={editable}
          />
          <span className="text-gray-300">•</span>
          <EditableField
            value={personalInfo.phone}
            onChange={(v) => handleFieldChange('personalInfo.phone', v)}
            placeholder="+1 (555) 000-0000"
            editable={editable}
          />
          <span className="text-gray-300">•</span>
          <EditableField
            value={personalInfo.location}
            onChange={(v) => handleFieldChange('personalInfo.location', v)}
            placeholder="City, State"
            editable={editable}
          />
          {personalInfo.linkedin && (
            <>
              <span className="text-gray-300">•</span>
              <EditableField
                value={personalInfo.linkedin}
                onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                placeholder="linkedin.com/in/you"
                editable={editable}
              />
            </>
          )}
        </div>
      </header>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <div className="text-base text-gray-600" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="Professional summary..."
            editable={editable}
            as="p"
            multiline
          />
        </div>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-lg font-bold text-gray-900 flex items-center gap-3" style={{ marginBottom: spacing.itemGap }}>
          <span className="w-3 h-3 rounded-full" style={{ backgroundColor: secondaryColor }}></span>
          Experience
        </h2>
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
              style={{ marginBottom: spacing.itemGap }}
              className="ml-6 pl-4 border-l-2 border-gray-200 last:mb-0"
            >
              <div className="flex justify-between items-start" style={{ marginBottom: spacing.itemGap }}>
                <div>
                  <div className="text-base font-semibold text-gray-900">
                    <EditableField
                      value={exp.title}
                      onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                      placeholder="Job Title"
                      editable={editable}
                    />
                  </div>
                  <div className="text-sm font-medium" style={{ color: secondaryColor }}>
                    <EditableField
                      value={exp.company}
                      onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                      placeholder="Company"
                      editable={editable}
                    />
                  </div>
                </div>
                <div className="text-xs text-gray-500">
                  <EditableField
                    value={exp.startDate}
                    onChange={(v) => handleFieldChange(`experience.${index}.startDate`, v)}
                    placeholder="Start"
                    editable={editable}
                  />
                  <span className="mx-1">–</span>
                  <EditableField
                    value={exp.endDate}
                    onChange={(v) => handleFieldChange(`experience.${index}.endDate`, v)}
                    placeholder="End"
                    editable={editable}
                  />
                </div>
              </div>
              <EditableBulletList
                bullets={exp.bullets}
                onChange={(bullets) => handleFieldChange(`experience.${index}.bullets`, bullets)}
                editable={editable}
                className="text-sm text-gray-600"
              />
            </EntryWrapper>
          ))}
        </EntryGroup>
      </section>

      <div className="grid grid-cols-2" style={{ gap: spacing.sectionGap }}>
        <section>
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-3" style={{ marginBottom: spacing.itemGap }}>
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: secondaryColor }}></span>
            Education
          </h2>
          <EntryGroup
            editable={editable}
            addLabel="Add"
            onAdd={() => handleFieldChange('education.add', '')}
          >
            {education.map((edu, index) => (
              <EntryWrapper
                key={edu.id}
                editable={editable}
                onDelete={() => handleFieldChange(`education.${index}.delete`, '')}
                style={{ marginBottom: spacing.itemGap }}
                className="ml-6 last:mb-0"
              >
                <div className="text-base font-medium text-gray-900">
                  <EditableField
                    value={edu.degree}
                    onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                    placeholder="Degree"
                    editable={editable}
                  />
                </div>
                <div className="text-sm text-gray-600">
                  <EditableField
                    value={edu.institution}
                    onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                    placeholder="Institution"
                    editable={editable}
                  />
                </div>
                <div className="text-xs text-gray-500">
                  <EditableField
                    value={edu.graduationYear}
                    onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                    placeholder="Year"
                    editable={editable}
                  />
                </div>
              </EntryWrapper>
            ))}
          </EntryGroup>
        </section>

        <section>
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-3" style={{ marginBottom: spacing.itemGap }}>
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: secondaryColor }}></span>
            Skills
          </h2>
          <div className="ml-6">
            <EditableSkills
              skills={skills}
              onChange={(newSkills) => handleFieldChange('skills', newSkills)}
              editable={editable}
            />
          </div>
        </section>

        <CustomSections
          sections={data.customSections}
          editable={editable}
          onFieldChange={handleFieldChange}
        />
      </div>
    </ResumePage>
  );
}

export const accentLineInfo = {
  id: 'accent-line',
  name: 'Accent Line',
  description: 'Clean design with colorful accent line and bullet markers.',
  category: 'modern' as const,
  isAtsOptimized: true,
};
