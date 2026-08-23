import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList } from './EditableField';
import { EditablePhoto } from './EditablePhoto';
import { CustomSections } from './CustomSections';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';
import { InlineColorPicker } from './InlineColorPicker';
import { ResizableSidebar } from './ResizableLayout';

export function SidebarPhotoRight({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const secondaryColor = customization?.secondaryColor || '#3b82f6';
  const sidebarWidth = customization?.layout?.sidebarWidth || 256;
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleSecondaryColorChange = (color: string) => {
    onCustomizationChange?.({ secondaryColor: color });
  };

  const handleWidthChange = (width: number) => {
    onCustomizationChange?.({ layout: { ...customization?.layout, sidebarWidth: width } });
  };

  const sidebarContent = (
    <div className="min-h-[11in] bg-gray-50 border-l border-gray-200" style={{ padding: spacing.pagePadding }}>
      <div className="flex justify-center" style={{ marginBottom: spacing.sectionGap }}>
        <EditablePhoto
          photoUrl={customization?.photoUrl}
          onPhotoChange={(url) => onCustomizationChange?.({ photoUrl: url })}
          size={customization?.photoSize || 'large'}
          onSizeChange={(size) => onCustomizationChange?.({ photoSize: size })}
          shape="rounded"
          editable={editable}
          resizable={true}
          className="shadow-lg"
        />
      </div>

      <div className="text-sm" style={{ display: 'flex', flexDirection: 'column', gap: spacing.sectionGap }}>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400" style={{ marginBottom: spacing.itemGap }}>Contact</h3>
          <div className="text-gray-600" style={{ display: 'flex', flexDirection: 'column', gap: spacing.itemGap }}>
            <div className="flex items-center gap-2">
              <Mail className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <EditableField
                value={personalInfo.email}
                onChange={(v) => handleFieldChange('personalInfo.email', v)}
                placeholder="email@example.com"
                editable={editable}
              />
            </div>
            <div className="flex items-center gap-2">
              <Phone className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <EditableField
                value={personalInfo.phone}
                onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                placeholder="+1 (555) 000-0000"
                editable={editable}
              />
            </div>
            <div className="flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5 text-gray-400 shrink-0" />
              <EditableField
                value={personalInfo.location}
                onChange={(v) => handleFieldChange('personalInfo.location', v)}
                placeholder="City, State"
                editable={editable}
              />
            </div>
            {personalInfo.linkedin && (
              <div className="flex items-center gap-2">
                <Linkedin className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <EditableField
                  value={personalInfo.linkedin}
                  onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                  placeholder="linkedin.com/in/you"
                  editable={editable}
                />
              </div>
            )}
            {personalInfo.website && (
              <div className="flex items-center gap-2">
                <Globe className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                <EditableField
                  value={personalInfo.website}
                  onChange={(v) => handleFieldChange('personalInfo.website', v)}
                  placeholder="yoursite.com"
                  editable={editable}
                />
              </div>
            )}
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400" style={{ marginBottom: spacing.itemGap }}>Skills</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.itemGap }}>
            {skills.map((skill, index) => (
              <div key={index} className="text-gray-700">
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
              </div>
            ))}
            {editable && (
              <button
                type="button"
                onClick={() => handleFieldChange('skills', [...skills, ''])}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                + Add skill
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
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
            <InlineColorPicker color={secondaryColor} onChange={handleSecondaryColorChange} colorType="secondary" editable={editable}>
              <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: secondaryColor, marginBottom: spacing.itemGap }}>Profile</h2>
            </InlineColorPicker>
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

          <section style={{ marginBottom: spacing.sectionGap }}>
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: secondaryColor, marginBottom: spacing.itemGap }}>Experience</h2>
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
                  <div className="pl-4 border-l-2" style={{ borderColor: secondaryColor }}>
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
                            placeholder="Company"
                            editable={editable}
                          />
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
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
                  </div>
                </EntryWrapper>
              ))}
            </EntryGroup>
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: secondaryColor, marginBottom: spacing.itemGap }}>Education</h2>
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
                  <div className="flex justify-between items-start">
                    <div>
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
                    </div>
                    <div className="text-xs text-gray-500">
                      <EditableField
                        value={edu.graduationYear}
                        onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                        placeholder="Year"
                        editable={editable}
                      />
                    </div>
                  </div>
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

export const sidebarPhotoRightInfo = {
  id: 'sidebar-photo-right',
  name: 'Sidebar Photo Right',
  description: 'Clean layout with photo and skills in light right sidebar.',
  category: 'modern' as const,
  isAtsOptimized: false,
};
