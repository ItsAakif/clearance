import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList } from './EditableField';
import { EditablePhoto } from './EditablePhoto';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';
import { ResizableSidebar } from './ResizableLayout';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';

export function SidebarPhotoLeft({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#1e293b';
  const sidebarWidth = customization?.layout?.sidebarWidth || 280;
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
      <div className="min-h-[11in] text-white" style={{ backgroundColor: primaryColor, padding: spacing.pagePadding }}>
        <div className="flex justify-center" style={{ marginBottom: spacing.sectionGap }}>
          <EditablePhoto
            photoUrl={customization?.photoUrl}
            onPhotoChange={(url) => onCustomizationChange?.({ photoUrl: url })}
            size={customization?.photoSize || 'large'}
            onSizeChange={(size) => onCustomizationChange?.({ photoSize: size })}
            shape="circle"
            editable={editable}
            resizable={true}
            className="border-4 border-white/20"
            placeholderClassName="text-white/50"
          />
        </div>

        <div className="text-sm" style={{ display: 'flex', flexDirection: 'column', gap: spacing.sectionGap }}>
          <div>
            <h3 className="text-xs uppercase tracking-wider opacity-60 border-b border-white/20 pb-1" style={{ marginBottom: spacing.itemGap }}>Contact</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.itemGap }}>
              <div className="flex items-center gap-2">
                <Mail className="w-3.5 h-3.5 opacity-60 shrink-0" />
                <EditableField
                  value={personalInfo.email}
                  onChange={(v) => handleFieldChange('personalInfo.email', v)}
                  placeholder="email@example.com"
                  editable={editable}
                  className="text-white/90"
                />
              </div>
              <div className="flex items-center gap-2">
                <Phone className="w-3.5 h-3.5 opacity-60 shrink-0" />
                <EditableField
                  value={personalInfo.phone}
                  onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                  placeholder="+1 (555) 000-0000"
                  editable={editable}
                  className="text-white/90"
                />
              </div>
              <div className="flex items-center gap-2">
                <MapPin className="w-3.5 h-3.5 opacity-60 shrink-0" />
                <EditableField
                  value={personalInfo.location}
                  onChange={(v) => handleFieldChange('personalInfo.location', v)}
                  placeholder="City, State"
                  editable={editable}
                  className="text-white/90"
                />
              </div>
              {personalInfo.linkedin && (
                <div className="flex items-center gap-2">
                  <Linkedin className="w-3.5 h-3.5 opacity-60 shrink-0" />
                  <EditableField
                    value={personalInfo.linkedin}
                    onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                    placeholder="linkedin.com/in/you"
                    editable={editable}
                    className="text-white/90"
                  />
                </div>
              )}
              {personalInfo.website && (
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 opacity-60 shrink-0" />
                  <EditableField
                    value={personalInfo.website}
                    onChange={(v) => handleFieldChange('personalInfo.website', v)}
                    placeholder="yoursite.com"
                    editable={editable}
                    className="text-white/90"
                  />
                </div>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wider opacity-60 border-b border-white/20 pb-1" style={{ marginBottom: spacing.itemGap }}>Skills</h3>
            <div className="flex flex-wrap gap-1.5">
              {skills.map((skill, index) => (
                <span key={index} className="px-2 py-1 bg-white/10 rounded text-xs">
                  <EditableField
                    value={skill}
                    onChange={(v) => {
                      const newSkills = [...skills];
                      newSkills[index] = v;
                      handleFieldChange('skills', newSkills);
                    }}
                    placeholder="Skill"
                    editable={editable}
                    className="text-white/90"
                  />
                </span>
              ))}
              {editable && (
                <button
                  type="button"
                  onClick={() => handleFieldChange('skills', [...skills, ''])}
                  className="px-2 py-1 text-xs border border-dashed border-white/30 text-white/50 rounded hover:border-white/50"
                >
                  +
                </button>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wider opacity-60 border-b border-white/20 pb-1" style={{ marginBottom: spacing.itemGap }}>Education</h3>
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
                  <div className="text-xs text-white/50">
                    <EditableField
                      value={edu.graduationYear}
                      onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                      placeholder="Year"
                      editable={editable}
                      className="text-white/50"
                    />
                  </div>
                </EntryWrapper>
              ))}
            </EntryGroup>
          </div>
        </div>
      </div>
    </InlineColorPicker>
  );

  return (
    <ResumePage scale={scale} className="p-0" customization={customization}>
      <ResizableSidebar
        sidebarPosition="left"
        initialWidth={sidebarWidth}
        minWidth={200}
        maxWidth={350}
        onWidthChange={handleWidthChange}
        editable={editable}
        sidebarContent={sidebarContent}
      >
        <div className="bg-white min-h-[11in]" style={{ padding: spacing.pagePadding }}>
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
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400" style={{ marginBottom: spacing.itemGap }}>About</h2>
            <div className="text-sm text-gray-600" style={{ lineHeight: spacing.lineHeight }}>
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

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400" style={{ marginBottom: spacing.itemGap }}>Experience</h2>
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
                      <div className="text-sm font-medium" style={{ color: primaryColor }}>
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

          <CustomSections
            sections={data.customSections}
            editable={editable}
            onFieldChange={handleFieldChange}
          />
        </div>
      </ResizableSidebar>
    </ResumePage>
  );
}

export const sidebarPhotoLeftInfo = {
  id: 'sidebar-photo-left',
  name: 'Sidebar Photo Left',
  description: 'Two-column layout with photo and contact info in dark left sidebar.',
  category: 'modern' as const,
  isAtsOptimized: false,
};
