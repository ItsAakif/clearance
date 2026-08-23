import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function Compact({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#374151';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  return (
    <ResumePage scale={scale} className="text-[13px]" style={{ padding: spacing.pagePadding }} customization={customization}>
      <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
        <header className="pb-2 border-b" style={{ borderColor: primaryColor, marginBottom: spacing.sectionGap }}>
        <div className="flex justify-between items-start">
          <h1 className="text-2xl font-bold text-gray-900">
            <EditableField
              value={personalInfo.fullName}
              onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
              placeholder="Your Name"
              editable={editable}
              as="span"
            />
          </h1>
          <div className="text-right text-xs text-gray-600 space-y-0.5">
            <div>
              <EditableField
                value={personalInfo.email}
                onChange={(v) => handleFieldChange('personalInfo.email', v)}
                placeholder="email@example.com"
                editable={editable}
              />
            </div>
            <div>
              <EditableField
                value={personalInfo.phone}
                onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                placeholder="+1 (555) 000-0000"
                editable={editable}
              />
            </div>
            <div>
              <EditableField
                value={personalInfo.location}
                onChange={(v) => handleFieldChange('personalInfo.location', v)}
                placeholder="City, State"
                editable={editable}
              />
            </div>
          </div>
        </div>
        </header>
      </InlineColorPicker>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <div className="text-xs text-gray-700" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="Concise professional summary..."
            editable={editable}
            as="p"
            multiline
          />
        </div>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-700 pb-0.5 border-b border-gray-200" style={{ marginBottom: spacing.itemGap }}>
          Experience
        </h2>
        <EntryGroup
          editable={editable}
          addLabel="Add"
          onAdd={() => handleFieldChange('experience.add', '')}
        >
          {experience.map((exp, index) => (
            <EntryWrapper
              key={exp.id}
              editable={editable}
              onDelete={() => handleFieldChange(`experience.${index}.delete`, '')}
              style={{ marginBottom: spacing.itemGap }}
              className="last:mb-0"
            >
              <div className="flex justify-between items-baseline">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-gray-900">
                    <EditableField
                      value={exp.title}
                      onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                      placeholder="Title"
                      editable={editable}
                    />
                  </span>
                  <span className="text-gray-400">|</span>
                  <span className="text-gray-600">
                    <EditableField
                      value={exp.company}
                      onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                      placeholder="Company"
                      editable={editable}
                    />
                  </span>
                </div>
                <span className="text-xs text-gray-500 shrink-0">
                  <EditableField
                    value={exp.startDate}
                    onChange={(v) => handleFieldChange(`experience.${index}.startDate`, v)}
                    placeholder="Start"
                    editable={editable}
                  />
                  <span className="mx-0.5">–</span>
                  <EditableField
                    value={exp.endDate}
                    onChange={(v) => handleFieldChange(`experience.${index}.endDate`, v)}
                    placeholder="End"
                    editable={editable}
                  />
                </span>
              </div>
              <EditableBulletList
                bullets={exp.bullets}
                onChange={(bullets) => handleFieldChange(`experience.${index}.bullets`, bullets)}
                editable={editable}
                className="mt-1 text-xs text-gray-600"
              />
            </EntryWrapper>
          ))}
        </EntryGroup>
      </section>

      <div className="grid grid-cols-3" style={{ gap: spacing.sectionGap }}>
        <section className="col-span-2">
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-700 pb-0.5 border-b border-gray-200" style={{ marginBottom: spacing.itemGap }}>
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
                className="last:mb-0"
              >
                <div className="flex justify-between items-baseline">
                  <div className="flex items-baseline gap-1">
                    <span className="font-semibold text-gray-900">
                      <EditableField
                        value={edu.degree}
                        onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                        placeholder="Degree"
                        editable={editable}
                      />
                    </span>
                    <span className="text-gray-400">-</span>
                    <span className="text-gray-600">
                      <EditableField
                        value={edu.institution}
                        onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                        placeholder="Institution"
                        editable={editable}
                      />
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">
                    <EditableField
                      value={edu.graduationYear}
                      onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                      placeholder="Year"
                      editable={editable}
                    />
                  </span>
                </div>
              </EntryWrapper>
            ))}
          </EntryGroup>
        </section>

        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider text-gray-700 pb-0.5 border-b border-gray-200" style={{ marginBottom: spacing.itemGap }}>
            Skills
          </h2>
          <div className="text-xs text-gray-700" style={{ lineHeight: spacing.lineHeight }}>
            {skills.map((skill, index) => (
              <span key={index}>
                <EditableField
                  value={skill}
                  onChange={(v) => {
                    const newSkills = [...skills];
                    newSkills[index] = v;
                    handleFieldChange('skills', newSkills);
                  }}
                  placeholder="Skill"
                  editable={editable}
                />
                {index < skills.length - 1 && <span className="text-gray-400"> • </span>}
              </span>
            ))}
            {editable && (
              <button
                type="button"
                onClick={() => handleFieldChange('skills', [...skills, ''])}
                className="text-gray-400 hover:text-gray-600 ml-1"
              >
                [+]
              </button>
            )}
          </div>
        </section>
      </div>

      <CustomSections
        sections={data.customSections}
        editable={editable}
        onFieldChange={handleFieldChange}
      />
    </ResumePage>
  );
}

export const compactInfo = {
  id: 'compact',
  name: 'Compact',
  description: 'Dense layout that fits more content on one page. For experienced professionals.',
  category: 'professional' as const,
  isAtsOptimized: true,
};
