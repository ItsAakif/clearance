import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList } from './EditableField';
import { CustomSectionsMinimal } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function MinimalistDesigner({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#000000';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  return (
    <ResumePage scale={scale} className="bg-white" style={{ padding: spacing.pagePadding }} customization={customization}>
      <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
        <header className="pb-6 border-b" style={{ borderColor: primaryColor, marginBottom: spacing.sectionGap }}>
        <h1 className="text-5xl font-light tracking-tight text-black" style={{ fontFamily: 'Helvetica Neue, Arial, sans-serif', marginBottom: spacing.itemGap }}>
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="flex flex-wrap gap-6 text-sm text-neutral-600">
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
      </InlineColorPicker>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <div className="text-base text-neutral-700 max-w-3xl" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="A concise statement about your design philosophy and approach..."
            editable={editable}
            as="p"
            multiline
          />
        </div>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-xs font-medium uppercase tracking-[0.3em]" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Experience</h2>
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
              className="grid grid-cols-4 gap-6 last:mb-0"
            >
              <div className="col-span-1 text-sm text-neutral-500">
                <EditableField
                  value={exp.startDate}
                  onChange={(v) => handleFieldChange(`experience.${index}.startDate`, v)}
                  placeholder="2020"
                  editable={editable}
                />
                <span className="mx-1">–</span>
                <EditableField
                  value={exp.endDate}
                  onChange={(v) => handleFieldChange(`experience.${index}.endDate`, v)}
                  placeholder="Present"
                  editable={editable}
                />
              </div>
              <div className="col-span-3">
                <div className="text-base font-medium" style={{ color: primaryColor }}>
                  <EditableField
                    value={exp.title}
                    onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                    placeholder="Design Lead"
                    editable={editable}
                  />
                </div>
                <div className="text-sm text-neutral-600" style={{ marginBottom: spacing.itemGap }}>
                  <EditableField
                    value={exp.company}
                    onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                    placeholder="Company Name"
                    editable={editable}
                  />
                </div>
                <EditableBulletList
                  bullets={exp.bullets}
                  onChange={(bullets) => handleFieldChange(`experience.${index}.bullets`, bullets)}
                  editable={editable}
                  className="text-sm text-neutral-600"
                />
              </div>
            </EntryWrapper>
          ))}
        </EntryGroup>
      </section>

      <div className="grid grid-cols-2" style={{ gap: spacing.sectionGap }}>
        <section>
          <h2 className="text-xs font-medium uppercase tracking-[0.3em]" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Education</h2>
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
                <div className="text-base font-medium text-black">
                  <EditableField
                    value={edu.degree}
                    onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                    placeholder="Bachelor of Design"
                    editable={editable}
                  />
                </div>
                <div className="text-sm text-neutral-600">
                  <EditableField
                    value={edu.institution}
                    onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                    placeholder="University"
                    editable={editable}
                  />
                  <span className="mx-2">·</span>
                  <EditableField
                    value={edu.graduationYear}
                    onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                    placeholder="2018"
                    editable={editable}
                  />
                </div>
              </EntryWrapper>
            ))}
          </EntryGroup>
        </section>

        <section>
          <h2 className="text-xs font-medium uppercase tracking-[0.3em]" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Skills</h2>
          <div className="text-sm text-neutral-700" style={{ lineHeight: spacing.lineHeight }}>
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
                  className="inline"
                />
                {index < skills.length - 1 && <span className="mx-2">·</span>}
              </span>
            ))}
            {editable && (
              <button
                type="button"
                onClick={() => handleFieldChange('skills', [...skills, ''])}
                className="ml-2 text-neutral-400 hover:text-black"
              >
                +
              </button>
            )}
          </div>
        </section>
      </div>

      <CustomSectionsMinimal
        sections={data.customSections}
        editable={editable}
        onFieldChange={handleFieldChange}
      />
    </ResumePage>
  );
}

export const minimalistDesignerInfo = {
  id: 'minimalist-designer',
  name: 'Minimalist',
  description: 'Clean Helvetica-inspired design with maximum whitespace and clarity.',
  category: 'minimal' as const,
  isAtsOptimized: true,
};
