import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';
import { ResizableHeader } from './ResizableLayout';

export function BoldHeader({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#1e293b';
  const headerHeight = customization?.layout?.headerHeight || 160;
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  const handleHeightChange = (height: number) => {
    onCustomizationChange?.({ layout: { ...customization?.layout, headerHeight: height } });
  };

  const headerContent = (
    <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
      <div className="px-10 py-8 text-white h-full flex flex-col justify-center" style={{ backgroundColor: primaryColor }}>
        <h1 className="text-5xl font-black tracking-tight mb-3">
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="YOUR NAME"
            editable={editable}
            as="span"
            className="text-white"
          />
        </h1>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm opacity-90">
          <EditableField
            value={personalInfo.email}
            onChange={(v) => handleFieldChange('personalInfo.email', v)}
            placeholder="email@example.com"
            editable={editable}
            className="text-white"
          />
          <span className="opacity-50">|</span>
          <EditableField
            value={personalInfo.phone}
            onChange={(v) => handleFieldChange('personalInfo.phone', v)}
            placeholder="+1 (555) 000-0000"
            editable={editable}
            className="text-white"
          />
          <span className="opacity-50">|</span>
          <EditableField
            value={personalInfo.location}
            onChange={(v) => handleFieldChange('personalInfo.location', v)}
            placeholder="City, State"
            editable={editable}
            className="text-white"
          />
          {personalInfo.linkedin && (
            <>
              <span className="opacity-50">|</span>
              <EditableField
                value={personalInfo.linkedin}
                onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                placeholder="linkedin.com/in/you"
                editable={editable}
                className="text-white"
              />
            </>
          )}
        </div>
      </div>
    </InlineColorPicker>
  );

  return (
    <ResumePage scale={scale} className="p-0" customization={customization}>
      <ResizableHeader
        initialHeight={headerHeight}
        minHeight={100}
        maxHeight={250}
        onHeightChange={handleHeightChange}
        editable={editable}
        headerContent={headerContent}
        headerClassName=""
        mainClassName=""
      >
        <div className="bg-white flex-1" style={{ padding: spacing.pagePadding }}>
          <section style={{ marginBottom: spacing.sectionGap }}>
            <div className="text-base text-gray-700" style={{ lineHeight: spacing.lineHeight }}>
              <EditableField
                value={summary}
                onChange={(v) => handleFieldChange('summary', v)}
                placeholder="Professional summary highlighting your expertise and career goals..."
                editable={editable}
                as="p"
                multiline
              />
            </div>
          </section>

          <section style={{ marginBottom: spacing.sectionGap }}>
            <h2 className="text-lg font-bold uppercase tracking-wider pb-2 border-b-4" style={{ borderColor: primaryColor, color: primaryColor, marginBottom: spacing.itemGap }}>
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
                  <div className="flex justify-between items-start" style={{ marginBottom: spacing.itemGap }}>
                    <div>
                      <div className="text-lg font-bold text-gray-900">
                        <EditableField
                          value={exp.title}
                          onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                          placeholder="Job Title"
                          editable={editable}
                        />
                      </div>
                      <div className="text-base font-medium" style={{ color: primaryColor }}>
                        <EditableField
                          value={exp.company}
                          onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                          placeholder="Company Name"
                          editable={editable}
                        />
                      </div>
                    </div>
                    <div className="text-sm text-gray-500 font-medium">
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

          <div className="grid grid-cols-2 gap-8">
            <section>
              <h2 className="text-lg font-bold uppercase tracking-wider pb-2 border-b-4" style={{ borderColor: primaryColor, color: primaryColor, marginBottom: spacing.itemGap }}>
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
                    <div className="text-base font-bold text-gray-900">
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
                    <div className="text-sm text-gray-500">
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
              <h2 className="text-lg font-bold uppercase tracking-wider pb-2 border-b-4" style={{ borderColor: primaryColor, color: primaryColor, marginBottom: spacing.itemGap }}>
                Skills
              </h2>
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
        </div>
      </ResizableHeader>
    </ResumePage>
  );
}

export const boldHeaderInfo = {
  id: 'bold-header',
  name: 'Bold Header',
  description: 'Impactful design with bold header and strong typography.',
  category: 'professional' as const,
  isAtsOptimized: true,
};
