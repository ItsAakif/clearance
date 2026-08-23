import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function SimpleATS({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
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
    <ResumePage scale={scale} style={{ padding: spacing.pagePadding }} customization={customization}>
      <header style={{ marginBottom: spacing.sectionGap }}>
        <h1 className="text-2xl font-bold text-black mb-1">
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="text-sm text-gray-700">
          <EditableField
            value={personalInfo.email}
            onChange={(v) => handleFieldChange('personalInfo.email', v)}
            placeholder="email@example.com"
            editable={editable}
          />
          <span className="mx-2">|</span>
          <EditableField
            value={personalInfo.phone}
            onChange={(v) => handleFieldChange('personalInfo.phone', v)}
            placeholder="+1 (555) 000-0000"
            editable={editable}
          />
          <span className="mx-2">|</span>
          <EditableField
            value={personalInfo.location}
            onChange={(v) => handleFieldChange('personalInfo.location', v)}
            placeholder="City, State"
            editable={editable}
          />
          {personalInfo.linkedin && (
            <>
              <span className="mx-2">|</span>
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
        <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
          <h2 className="text-sm font-bold uppercase border-b pb-1" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
            Summary
          </h2>
        </InlineColorPicker>
        <div className="text-sm text-gray-800" style={{ lineHeight: spacing.lineHeight }}>
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
        <h2 className="text-sm font-bold uppercase border-b pb-1" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
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
              className="last:mb-0"
            >
              <div className="flex justify-between items-baseline mb-1">
                <div>
                  <span className="font-bold text-black">
                    <EditableField
                      value={exp.title}
                      onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                      placeholder="Job Title"
                      editable={editable}
                    />
                  </span>
                  <span className="text-gray-600">, </span>
                  <span className="text-gray-700">
                    <EditableField
                      value={exp.company}
                      onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                      placeholder="Company"
                      editable={editable}
                    />
                  </span>
                </div>
                <span className="text-sm text-gray-600 shrink-0">
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
                </span>
              </div>
              <EditableBulletList
                bullets={exp.bullets}
                onChange={(bullets) => handleFieldChange(`experience.${index}.bullets`, bullets)}
                editable={editable}
                className="text-sm text-gray-700"
              />
            </EntryWrapper>
          ))}
        </EntryGroup>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-sm font-bold uppercase border-b pb-1" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
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
                  <span className="font-bold text-black">
                    <EditableField
                      value={edu.degree}
                      onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                      placeholder="Degree"
                      editable={editable}
                    />
                  </span>
                  {edu.field && (
                    <>
                      <span className="text-gray-600"> in </span>
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
                <span className="text-sm text-gray-600">
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
        <h2 className="text-sm font-bold uppercase border-b pb-1" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
          Skills
        </h2>
        <div className="text-sm text-gray-700">
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
              {index < skills.length - 1 && <span>, </span>}
            </span>
          ))}
          {editable && (
            <button
              type="button"
              onClick={() => handleFieldChange('skills', [...skills, ''])}
              className="ml-2 text-gray-400 hover:text-gray-600"
            >
              [+ Add]
            </button>
          )}
        </div>
      </section>

      <CustomSections
        sections={data.customSections}
        editable={editable}
        onFieldChange={handleFieldChange}
      />
    </ResumePage>
  );
}

export const simpleATSInfo = {
  id: 'simple-ats',
  name: 'Simple ATS',
  description: 'Ultra-clean, no-frills design optimized for ATS parsing. Maximum compatibility.',
  category: 'minimal' as const,
  isAtsOptimized: true,
};
