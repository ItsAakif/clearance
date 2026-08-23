import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function ExecutiveClassic({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#6b7280';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  return (
    <ResumePage scale={scale} className="bg-white" style={{ padding: spacing.pagePadding }} customization={customization}>
      <header className="text-center pb-6 border-b border-gray-300" style={{ marginBottom: spacing.sectionGap }}>
        <h1 className="text-4xl font-serif font-normal tracking-wide text-gray-900" style={{ fontFamily: 'Georgia, serif', marginBottom: spacing.itemGap }}>
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="flex justify-center flex-wrap gap-4 text-sm text-gray-600">
          <EditableField
            value={personalInfo.email}
            onChange={(v) => handleFieldChange('personalInfo.email', v)}
            placeholder="email@example.com"
            editable={editable}
          />
          <span className="text-gray-300">|</span>
          <EditableField
            value={personalInfo.phone}
            onChange={(v) => handleFieldChange('personalInfo.phone', v)}
            placeholder="+1 (555) 000-0000"
            editable={editable}
          />
          <span className="text-gray-300">|</span>
          <EditableField
            value={personalInfo.location}
            onChange={(v) => handleFieldChange('personalInfo.location', v)}
            placeholder="City, State"
            editable={editable}
          />
          {personalInfo.linkedin && (
            <>
              <span className="text-gray-300">|</span>
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
        <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="secondary" editable={editable}>
          <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-center" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Executive Summary</h2>
        </InlineColorPicker>
        <div className="text-base text-gray-700 text-center max-w-3xl mx-auto" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="A seasoned professional with extensive experience in..."
            editable={editable}
            as="p"
            multiline
          />
        </div>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-sm font-bold uppercase tracking-[0.2em] pb-2 border-b border-gray-200" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Professional Experience</h2>
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
              className="last:mb-0"
            >
              <div className="flex justify-between items-baseline" style={{ marginBottom: spacing.itemGap }}>
                <div>
                  <span className="text-lg font-semibold text-gray-900">
                    <EditableField
                      value={exp.title}
                      onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                      placeholder="Executive Title"
                      editable={editable}
                    />
                  </span>
                  <span className="mx-2 text-gray-400">-</span>
                  <span className="text-base text-gray-700">
                    <EditableField
                      value={exp.company}
                      onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                      placeholder="Company Name"
                      editable={editable}
                    />
                  </span>
                </div>
                <div className="text-sm text-gray-500 italic">
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
                    placeholder="Present"
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
          <h2 className="text-sm font-bold uppercase tracking-[0.2em] pb-2 border-b border-gray-200" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Education</h2>
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
                <div className="text-sm text-gray-500 italic">
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
          <h2 className="text-sm font-bold uppercase tracking-[0.2em] pb-2 border-b border-gray-200" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Core Competencies</h2>
          <EditableSkills
            skills={skills}
            onChange={(newSkills) => handleFieldChange('skills', newSkills)}
            editable={editable}
          />
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

export const executiveClassicInfo = {
  id: 'executive-classic',
  name: 'Executive Classic',
  description: 'Refined serif-based design for senior professionals.',
  category: 'classic' as const,
  isAtsOptimized: true,
};
