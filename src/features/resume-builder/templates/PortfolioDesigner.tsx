import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList } from './EditableField';
import { EditablePhoto } from './EditablePhoto';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function PortfolioDesigner({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#44403c';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  return (
    <ResumePage scale={scale} className="p-0 bg-stone-50" customization={customization}>
      <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
        <header className="text-white" style={{ backgroundColor: primaryColor, padding: spacing.pagePadding }}>
        <div className="flex items-center gap-8">
          <EditablePhoto
            photoUrl={customization?.photoUrl}
            onPhotoChange={(url) => onCustomizationChange?.({ photoUrl: url })}
            size={customization?.photoSize || 'large'}
            onSizeChange={(size) => onCustomizationChange?.({ photoSize: size })}
            resizable={true}
            shape="rounded"
            editable={editable}
            className="border-2 border-stone-600 shrink-0"
            placeholderClassName="text-stone-400"
          />
          <div className="flex-1">
            <h1 className="text-3xl font-semibold tracking-wide" style={{ fontFamily: 'Georgia, serif', marginBottom: spacing.itemGap }}>
              <EditableField
                value={personalInfo.fullName}
                onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
                placeholder="Your Name"
                editable={editable}
                as="span"
                className="text-white"
              />
            </h1>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-stone-300">
              <EditableField
                value={personalInfo.email}
                onChange={(v) => handleFieldChange('personalInfo.email', v)}
                placeholder="email@example.com"
                editable={editable}
                className="text-stone-300"
              />
              <span className="text-stone-500">•</span>
              <EditableField
                value={personalInfo.phone}
                onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                placeholder="+1 (555) 000-0000"
                editable={editable}
                className="text-stone-300"
              />
              {personalInfo.website && (
                <>
                  <span className="text-stone-500">•</span>
                  <EditableField
                    value={personalInfo.website}
                    onChange={(v) => handleFieldChange('personalInfo.website', v)}
                    placeholder="portfolio.com"
                    editable={editable}
                    className="text-stone-300"
                  />
                </>
              )}
              {personalInfo.linkedin && (
                <>
                  <span className="text-stone-500">•</span>
                  <EditableField
                    value={personalInfo.linkedin}
                    onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                    placeholder="linkedin.com/in/you"
                    editable={editable}
                    className="text-stone-300"
                  />
                </>
              )}
            </div>
          </div>
        </div>
      </header>
      </InlineColorPicker>

      <div style={{ padding: spacing.pagePadding }}>
        <section style={{ marginBottom: spacing.sectionGap }}>
          <div className="text-base text-stone-600 border-l-2 border-stone-400 pl-5 italic" style={{ lineHeight: spacing.lineHeight }}>
            <EditableField
              value={summary}
              onChange={(v) => handleFieldChange('summary', v)}
              placeholder="I'm a designer passionate about creating meaningful digital experiences that connect with people..."
              editable={editable}
              as="p"
              multiline
            />
          </div>
        </section>

        <section style={{ marginBottom: spacing.sectionGap }}>
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-400 flex items-center gap-3" style={{ marginBottom: spacing.itemGap }}>
            <span className="w-8 h-px bg-stone-300"></span>
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
                className="pl-5 border-l border-stone-200 last:mb-0"
              >
                <div className="flex justify-between items-baseline" style={{ marginBottom: spacing.itemGap }}>
                  <div>
                    <div className="text-lg font-medium text-stone-800">
                      <EditableField
                        value={exp.title}
                        onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                        placeholder="Creative Director"
                        editable={editable}
                      />
                    </div>
                    <div className="text-sm text-stone-500 font-medium">
                      <EditableField
                        value={exp.company}
                        onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                        placeholder="Design Studio"
                        editable={editable}
                      />
                    </div>
                  </div>
                  <div className="text-xs text-stone-400 tracking-wide">
                    <EditableField
                      value={exp.startDate}
                      onChange={(v) => handleFieldChange(`experience.${index}.startDate`, v)}
                      placeholder="2020"
                      editable={editable}
                    />
                    <span className="mx-2">-</span>
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
                  className="text-sm text-stone-600"
                />
              </EntryWrapper>
            ))}
          </EntryGroup>
        </section>

        <div className="grid grid-cols-5" style={{ gap: spacing.sectionGap }}>
          <section className="col-span-2">
            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-400 flex items-center gap-3" style={{ marginBottom: spacing.itemGap }}>
              <span className="w-6 h-px bg-stone-300"></span>
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
                  <div className="text-base font-medium text-stone-800">
                    <EditableField
                      value={edu.degree}
                      onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                      placeholder="BFA Design"
                      editable={editable}
                    />
                  </div>
                  <div className="text-sm text-stone-500">
                    <EditableField
                      value={edu.institution}
                      onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                      placeholder="School of Design"
                      editable={editable}
                    />
                  </div>
                  <div className="text-xs text-stone-400">
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

          <section className="col-span-3">
            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-400 flex items-center gap-3" style={{ marginBottom: spacing.itemGap }}>
              <span className="w-6 h-px bg-stone-300"></span>
              Skills & Expertise
            </h2>
            <div className="flex flex-wrap gap-2">
              {skills.map((skill, index) => (
                <span
                  key={index}
                  className="px-3 py-1.5 text-sm text-stone-700 bg-white border border-stone-200 shadow-sm"
                >
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
                </span>
              ))}
              {editable && (
                <button
                  type="button"
                  onClick={() => handleFieldChange('skills', [...skills, ''])}
                  className="px-3 py-1.5 text-sm border border-dashed border-stone-300 text-stone-400 hover:border-stone-500 hover:text-stone-600 transition-colors"
                >
                  + Add
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
      </div>
    </ResumePage>
  );
}

export const portfolioDesignerInfo = {
  id: 'portfolio-designer',
  name: 'Portfolio Designer',
  description: 'Elegant portfolio-style layout with refined typography.',
  category: 'creative' as const,
  isAtsOptimized: false,
};
