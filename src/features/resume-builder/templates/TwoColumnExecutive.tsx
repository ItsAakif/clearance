import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections, CustomSectionsSidebar } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';
import { ResizableSidebar } from './ResizableLayout';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';

export function TwoColumnExecutive({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#1e293b';
  const sidebarWidth = customization?.layout?.sidebarWidth || 230;
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  const handleWidthChange = (width: number) => {
    onCustomizationChange?.({ layout: { ...customization?.layout, sidebarWidth: width } });
  };

  const sidebarContent = (
    <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
      <div className="min-h-[11in] text-white flex flex-col" style={{ backgroundColor: primaryColor, padding: spacing.pagePadding }}>
        <div style={{ marginBottom: spacing.sectionGap }}>
          <h1 className="text-2xl font-bold leading-tight" style={{ marginBottom: spacing.itemGap, lineHeight: spacing.lineHeight }}>
            <EditableField
              value={personalInfo.fullName}
              onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
              placeholder="Your Name"
              editable={editable}
              as="span"
              className="text-white"
            />
          </h1>
        </div>

        <div style={{ marginBottom: spacing.sectionGap }}>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400 border-b border-slate-600 pb-1" style={{ marginBottom: spacing.itemGap }}>
            Contact
          </h2>
          <div className="text-sm" style={{ display: 'flex', flexDirection: 'column', gap: spacing.itemGap }}>
            <div className="flex items-start gap-2">
              <Mail className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />
              <EditableField
                value={personalInfo.email}
                onChange={(v) => handleFieldChange('personalInfo.email', v)}
                placeholder="email@example.com"
                editable={editable}
                className="text-slate-200"
              />
            </div>
            <div className="flex items-start gap-2">
              <Phone className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />
              <EditableField
                value={personalInfo.phone}
                onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                placeholder="+1 (555) 000-0000"
                editable={editable}
                className="text-slate-200"
              />
            </div>
            <div className="flex items-start gap-2">
              <MapPin className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />
              <EditableField
                value={personalInfo.location}
                onChange={(v) => handleFieldChange('personalInfo.location', v)}
                placeholder="City, State"
                editable={editable}
                className="text-slate-200"
              />
            </div>
            {personalInfo.linkedin && (
              <div className="flex items-start gap-2">
                <Linkedin className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />
                <EditableField
                  value={personalInfo.linkedin}
                  onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                  placeholder="linkedin.com/in/you"
                  editable={editable}
                  className="text-slate-200"
                />
              </div>
            )}
            {personalInfo.website && (
              <div className="flex items-start gap-2">
                <Globe className="w-3.5 h-3.5 mt-0.5 text-slate-400 shrink-0" />
                <EditableField
                  value={personalInfo.website}
                  onChange={(v) => handleFieldChange('personalInfo.website', v)}
                  placeholder="yoursite.com"
                  editable={editable}
                  className="text-slate-200"
                />
              </div>
            )}
          </div>
        </div>

        <div style={{ marginBottom: spacing.sectionGap }}>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400 border-b border-slate-600 pb-1" style={{ marginBottom: spacing.itemGap }}>
            Skills
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {skills.map((skill, index) => (
              <span
                key={index}
                className="px-2 py-0.5 text-xs bg-slate-700 text-slate-200 rounded"
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
                  className="text-slate-200"
                />
              </span>
            ))}
            {editable && (
              <button
                type="button"
                onClick={() => handleFieldChange('skills', [...skills, ''])}
                className="px-2 py-0.5 text-xs border border-dashed border-slate-600 text-slate-400 rounded hover:border-slate-400 hover:text-slate-300"
              >
                +
              </button>
            )}
          </div>
        </div>

        <div className="mt-auto">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400 border-b border-slate-600 pb-1" style={{ marginBottom: spacing.itemGap }}>
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
                <div className="text-sm font-medium text-white">
                  <EditableField
                    value={edu.degree}
                    onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                    placeholder="Degree"
                    editable={editable}
                    className="text-white"
                  />
                </div>
                <div className="text-xs text-slate-300">
                  <EditableField
                    value={edu.institution}
                    onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                    placeholder="Institution"
                    editable={editable}
                    className="text-slate-300"
                  />
                </div>
                <div className="text-xs text-slate-400">
                  <EditableField
                    value={edu.graduationYear}
                    onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                    placeholder="Year"
                    editable={editable}
                    className="text-slate-400"
                  />
                </div>
              </EntryWrapper>
            ))}
          </EntryGroup>
        </div>
      </div>
    </InlineColorPicker>
  );

  return (
    <ResumePage scale={scale} className="p-0" customization={customization}>
      <ResizableSidebar
        sidebarPosition="left"
        initialWidth={sidebarWidth}
        minWidth={180}
        maxWidth={300}
        onWidthChange={handleWidthChange}
        editable={editable}
        sidebarContent={sidebarContent}
        sidebarClassName=""
        mainClassName=""
      >
        <main className="flex-1 min-h-[11in]" style={{ padding: spacing.pagePadding }}>
          <section style={{ marginBottom: spacing.sectionGap }}>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 border-b-2 border-slate-800 pb-1" style={{ marginBottom: spacing.itemGap }}>
              Professional Summary
            </h2>
            <div className="text-sm text-gray-700" style={{ lineHeight: spacing.lineHeight }}>
              <EditableField
                value={summary}
                onChange={(v) => handleFieldChange('summary', v)}
                placeholder="A compelling executive summary highlighting your leadership experience, strategic vision, and key achievements..."
                editable={editable}
                as="p"
                multiline
              />
            </div>
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500 border-b-2 border-slate-800 pb-1" style={{ marginBottom: spacing.itemGap }}>
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
                  <div className="flex justify-between items-baseline" style={{ marginBottom: spacing.itemGap }}>
                    <div>
                      <span className="text-base font-semibold text-gray-900">
                        <EditableField
                          value={exp.title}
                          onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                          placeholder="Job Title"
                          editable={editable}
                        />
                      </span>
                    </div>
                    <span className="text-sm text-gray-500 shrink-0">
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
                  <div className="text-sm text-gray-600" style={{ marginBottom: spacing.itemGap }}>
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
                    className="text-sm text-gray-600"
                  />
                </EntryWrapper>
              ))}
            </EntryGroup>
          </section>

          <CustomSections
            sections={data.customSections}
            editable={editable}
            onFieldChange={handleFieldChange}
          />
        </main>
      </ResizableSidebar>
    </ResumePage>
  );
}

export const twoColumnExecutiveInfo = {
  id: 'two-column-executive',
  name: 'Executive',
  description: 'Two-column layout with dark sidebar. Perfect for executives and senior professionals.',
  category: 'professional' as const,
  isAtsOptimized: true,
};
