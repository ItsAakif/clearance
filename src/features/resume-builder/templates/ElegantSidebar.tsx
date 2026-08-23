import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';
import { ResizableSidebar } from './ResizableLayout';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';

export function ElegantSidebar({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const sidebarColor = customization?.primaryColor || '#4f46e5';
  const sidebarWidth = customization?.layout?.sidebarWidth || 240;
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
    <InlineColorPicker color={sidebarColor} onChange={handleColorChange} colorType="primary" editable={editable}>
      <div className="min-h-[11in] text-white" style={{ backgroundColor: sidebarColor, padding: spacing.pagePadding }}>
        <div style={{ marginBottom: spacing.sectionGap }}>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-white/70 border-b border-white/30 pb-1" style={{ marginBottom: spacing.itemGap }}>
            Contact
          </h2>
          <div className="text-sm" style={{ display: 'flex', flexDirection: 'column', gap: spacing.itemGap }}>
            <div className="flex items-start gap-2">
              <Mail className="w-4 h-4 mt-0.5 text-white/60 shrink-0" />
              <EditableField
                value={personalInfo.email}
                onChange={(v) => handleFieldChange('personalInfo.email', v)}
                placeholder="email@example.com"
                editable={editable}
                className="text-white"
              />
            </div>
            <div className="flex items-start gap-2">
              <Phone className="w-4 h-4 mt-0.5 text-white/60 shrink-0" />
              <EditableField
                value={personalInfo.phone}
                onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                placeholder="+1 (555) 000-0000"
                editable={editable}
                className="text-white"
              />
            </div>
            <div className="flex items-start gap-2">
              <MapPin className="w-4 h-4 mt-0.5 text-white/60 shrink-0" />
              <EditableField
                value={personalInfo.location}
                onChange={(v) => handleFieldChange('personalInfo.location', v)}
                placeholder="City, State"
                editable={editable}
                className="text-white"
              />
            </div>
            {personalInfo.linkedin && (
              <div className="flex items-start gap-2">
                <Linkedin className="w-4 h-4 mt-0.5 text-white/60 shrink-0" />
                <EditableField
                  value={personalInfo.linkedin}
                  onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                  placeholder="linkedin.com/in/you"
                  editable={editable}
                  className="text-white"
                />
              </div>
            )}
            {personalInfo.website && (
              <div className="flex items-start gap-2">
                <Globe className="w-4 h-4 mt-0.5 text-white/60 shrink-0" />
                <EditableField
                  value={personalInfo.website}
                  onChange={(v) => handleFieldChange('personalInfo.website', v)}
                  placeholder="yoursite.com"
                  editable={editable}
                  className="text-white"
                />
              </div>
            )}
          </div>
        </div>

        <div style={{ marginBottom: spacing.sectionGap }}>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-white/70 border-b border-white/30 pb-1" style={{ marginBottom: spacing.itemGap }}>
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
                <div className="text-xs text-white/70">
                  <EditableField
                    value={edu.institution}
                    onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                    placeholder="Institution"
                    editable={editable}
                    className="text-white/70"
                  />
                </div>
                {edu.field && (
                  <div className="text-xs text-white/60">
                    <EditableField
                      value={edu.field}
                      onChange={(v) => handleFieldChange(`education.${index}.field`, v)}
                      placeholder="Field"
                      editable={editable}
                      className="text-white/60"
                    />
                  </div>
                )}
                <div className="text-xs text-white/60 mt-1">
                  <EditableField
                    value={edu.graduationYear}
                    onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                    placeholder="Year"
                    editable={editable}
                    className="text-white/60"
                  />
                </div>
              </EntryWrapper>
            ))}
          </EntryGroup>
        </div>

        <div>
          <h2 className="text-xs font-semibold uppercase tracking-widest text-white/70 border-b border-white/30 pb-1" style={{ marginBottom: spacing.itemGap }}>
            Skills
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.itemGap }}>
            {skills.map((skill, index) => (
              <div
                key={index}
                className="text-sm text-white flex items-center gap-2"
              >
                <span className="w-1.5 h-1.5 bg-white/60 rounded-full shrink-0"></span>
                <EditableField
                  value={skill}
                  onChange={(v) => {
                    const newSkills = [...skills];
                    newSkills[index] = v;
                    handleFieldChange('skills', newSkills);
                  }}
                  placeholder="Skill"
                  editable={editable}
                  className="text-white"
                />
              </div>
            ))}
            {editable && (
              <button
                type="button"
                onClick={() => handleFieldChange('skills', [...skills, ''])}
                className="text-xs text-white/60 hover:text-white border border-dashed border-white/40 hover:border-white rounded px-2 py-1 mt-2"
              >
                + Add Skill
              </button>
            )}
          </div>
        </div>
      </div>
    </InlineColorPicker>
  );

  return (
    <ResumePage scale={scale} className="p-0" customization={customization}>
      <ResizableSidebar
        sidebarPosition="right"
        initialWidth={sidebarWidth}
        minWidth={180}
        maxWidth={320}
        onWidthChange={handleWidthChange}
        editable={editable}
        sidebarContent={sidebarContent}
        sidebarClassName=""
        mainClassName=""
      >
        <main className="flex-1 min-h-[11in]" style={{ padding: spacing.pagePadding }}>
          <header style={{ marginBottom: spacing.sectionGap }}>
            <h1 className="text-3xl font-bold text-gray-900" style={{ marginBottom: spacing.itemGap, lineHeight: spacing.lineHeight }}>
              <EditableField
                value={personalInfo.fullName}
                onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
                placeholder="Your Name"
                editable={editable}
                as="span"
              />
            </h1>
          </header>

          <section style={{ marginBottom: spacing.sectionGap }}>
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-700 pb-1 border-b border-gray-300" style={{ marginBottom: spacing.itemGap }}>
              Profile
            </h2>
            <div className="text-sm text-gray-600" style={{ lineHeight: spacing.lineHeight }}>
              <EditableField
                value={summary}
                onChange={(v) => handleFieldChange('summary', v)}
                placeholder="A professional summary highlighting your expertise and career goals..."
                editable={editable}
                as="p"
                multiline
              />
            </div>
          </section>

          <section>
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-700 pb-1 border-b border-gray-300" style={{ marginBottom: spacing.itemGap }}>
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
                      <div className="text-base font-semibold text-gray-900">
                        <EditableField
                          value={exp.title}
                          onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                          placeholder="Job Title"
                          editable={editable}
                        />
                      </div>
                      <div className="text-sm text-gray-600">
                        <EditableField
                          value={exp.company}
                          onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                          placeholder="Company Name"
                          editable={editable}
                        />
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 shrink-0 text-right">
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
                    className="mt-2 text-sm text-gray-600"
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

export const elegantSidebarInfo = {
  id: 'elegant-sidebar',
  name: 'Elegant',
  description: 'Two-column with vibrant colored sidebar on the right. Modern and eye-catching.',
  category: 'modern' as const,
  isAtsOptimized: true,
};
