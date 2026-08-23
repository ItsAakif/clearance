import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, Section, EntryHeader, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function ClassicElegant({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#1f2937';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  return (
    <ResumePage scale={scale} style={{ padding: spacing.pagePadding }} customization={customization}>
      <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
        <header className="text-center border-b-2" style={{ marginBottom: spacing.sectionGap, paddingBottom: spacing.itemGap, borderColor: primaryColor }}>
          <h1 className="text-3xl font-serif font-bold tracking-wide text-gray-900 uppercase" style={{ marginBottom: spacing.itemGap, lineHeight: spacing.lineHeight }}>
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm text-gray-600">
          <EditableField
            value={personalInfo.email}
            onChange={(v) => handleFieldChange('personalInfo.email', v)}
            placeholder="email@example.com"
            editable={editable}
          />
          <span className="text-gray-400">|</span>
          <EditableField
            value={personalInfo.phone}
            onChange={(v) => handleFieldChange('personalInfo.phone', v)}
            placeholder="+1 (555) 000-0000"
            editable={editable}
          />
          <span className="text-gray-400">|</span>
          <EditableField
            value={personalInfo.location}
            onChange={(v) => handleFieldChange('personalInfo.location', v)}
            placeholder="City, State"
            editable={editable}
          />
          {personalInfo.linkedin && (
            <>
              <span className="text-gray-400">|</span>
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
      </InlineColorPicker>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-sm font-serif font-bold uppercase tracking-widest border-b pb-1" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
          Professional Profile
        </h2>
        <div className="text-sm text-gray-700 text-justify" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="A compelling professional summary that highlights your experience, expertise, and career objectives..."
            editable={editable}
            as="p"
            multiline
          />
        </div>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-sm font-serif font-bold uppercase tracking-widest border-b pb-1" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
          Professional Experience
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
              className="last:mb-0"
            >
              <div className="flex justify-between items-baseline mb-1">
                <div>
                  <span className="text-base font-semibold text-gray-900">
                    <EditableField
                      value={exp.title}
                      onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                      placeholder="Job Title"
                      editable={editable}
                    />
                  </span>
                  <span className="text-gray-500 mx-2">-</span>
                  <span className="text-base italic text-gray-700">
                    <EditableField
                      value={exp.company}
                      onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                      placeholder="Company Name"
                      editable={editable}
                    />
                  </span>
                </div>
                <span className="text-sm text-gray-500 italic shrink-0">
                  <EditableField
                    value={exp.startDate}
                    onChange={(v) => handleFieldChange(`experience.${index}.startDate`, v)}
                    placeholder="Start"
                    editable={editable}
                  />
                  <span className="mx-1">to</span>
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
        <h2 className="text-sm font-serif font-bold uppercase tracking-widest border-b pb-1" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
          Education
        </h2>
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
              style={{ marginBottom: spacing.itemGap }}
              className="last:mb-0"
            >
              <div className="flex justify-between items-baseline">
                <div>
                  <span className="text-base font-semibold text-gray-900">
                    <EditableField
                      value={edu.degree}
                      onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                      placeholder="Degree"
                      editable={editable}
                    />
                  </span>
                  {edu.field && (
                    <>
                      <span className="text-gray-500 mx-1">in</span>
                      <span className="text-gray-700">
                        <EditableField
                          value={edu.field}
                          onChange={(v) => handleFieldChange(`education.${index}.field`, v)}
                          placeholder="Field of Study"
                          editable={editable}
                        />
                      </span>
                    </>
                  )}
                </div>
                <span className="text-sm text-gray-500 italic">
                  <EditableField
                    value={edu.graduationYear}
                    onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                    placeholder="Year"
                    editable={editable}
                  />
                </span>
              </div>
              <div className="text-sm italic text-gray-600">
                <EditableField
                  value={edu.institution}
                  onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                  placeholder="Institution Name"
                  editable={editable}
                />
              </div>
            </EntryWrapper>
          ))}
        </EntryGroup>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-sm font-serif font-bold uppercase tracking-widest border-b pb-1" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
          Core Competencies
        </h2>
        <EditableSkills
          skills={skills}
          onChange={(newSkills) => handleFieldChange('skills', newSkills)}
          editable={editable}
          className="text-sm"
        />
      </section>

      <CustomSections
        sections={data.customSections}
        editable={editable}
        onFieldChange={handleFieldChange}
      />
    </ResumePage>
  );
}

export const classicElegantInfo = {
  id: 'classic-elegant',
  name: 'Classic Elegant',
  description: 'Traditional serif typography with timeless formatting. Professional and refined.',
  category: 'classic' as const,
  isAtsOptimized: true,
};
