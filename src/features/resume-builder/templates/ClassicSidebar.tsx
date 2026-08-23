import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections } from './CustomSections';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';
import { InlineColorPicker } from './InlineColorPicker';
import { ResizableSidebar } from './ResizableLayout';

export function ClassicSidebar({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#1e293b';
  const sidebarWidth = customization?.layout?.sidebarWidth || 256;
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
    <div className="min-h-[11in] bg-gray-100 border-r border-gray-200" style={{ padding: spacing.pagePadding }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.sectionGap }}>
        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500" style={{ marginBottom: spacing.itemGap }}>Contact</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.itemGap }} className="text-sm text-gray-700">
            <div className="flex items-start gap-2">
              <Mail className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
              <EditableField
                value={personalInfo.email}
                onChange={(v) => handleFieldChange('personalInfo.email', v)}
                placeholder="email@example.com"
                editable={editable}
              />
            </div>
            <div className="flex items-start gap-2">
              <Phone className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
              <EditableField
                value={personalInfo.phone}
                onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                placeholder="+1 (555) 000-0000"
                editable={editable}
              />
            </div>
            <div className="flex items-start gap-2">
              <MapPin className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
              <EditableField
                value={personalInfo.location}
                onChange={(v) => handleFieldChange('personalInfo.location', v)}
                placeholder="City, State"
                editable={editable}
              />
            </div>
            {personalInfo.linkedin && (
              <div className="flex items-start gap-2">
                <Linkedin className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
                <EditableField
                  value={personalInfo.linkedin}
                  onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                  placeholder="linkedin.com/in/you"
                  editable={editable}
                />
              </div>
            )}
            {personalInfo.website && (
              <div className="flex items-start gap-2">
                <Globe className="w-4 h-4 mt-0.5 text-gray-400 shrink-0" />
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
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500" style={{ marginBottom: spacing.itemGap }}>Education</h3>
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
              >
                <div className="text-sm font-medium text-gray-900" style={{ lineHeight: spacing.lineHeight }}>
                  <EditableField
                    value={edu.degree}
                    onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                    placeholder="Degree"
                    editable={editable}
                  />
                </div>
                <div className="text-sm text-gray-600" style={{ lineHeight: spacing.lineHeight }}>
                  <EditableField
                    value={edu.institution}
                    onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                    placeholder="Institution"
                    editable={editable}
                  />
                </div>
                <div className="text-xs text-gray-500">
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
        </div>

        <div>
          <h3 className="text-xs font-bold uppercase tracking-wider text-gray-500" style={{ marginBottom: spacing.itemGap }}>Skills</h3>
          <EditableSkills
            skills={skills}
            onChange={(newSkills) => handleFieldChange('skills', newSkills)}
            editable={editable}
          />
        </div>
      </div>
    </div>
  );

  return (
    <ResumePage scale={scale} className="p-0" customization={customization}>
      <ResizableSidebar
        sidebarPosition="left"
        initialWidth={sidebarWidth}
        minWidth={180}
        maxWidth={320}
        onWidthChange={handleWidthChange}
        editable={editable}
        sidebarContent={sidebarContent}
      >
        <div className="bg-white min-h-[11in]" style={{ padding: spacing.pagePadding }}>
          <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
            <header style={{ marginBottom: spacing.sectionGap, paddingBottom: spacing.itemGap, borderColor: primaryColor }} className="border-b-2">
              <h1 className="text-3xl font-bold" style={{ color: primaryColor, lineHeight: spacing.lineHeight }}>
                <EditableField
                  value={personalInfo.fullName}
                  onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
                  placeholder="Your Name"
                  editable={editable}
                  as="span"
                />
              </h1>
            </header>
          </InlineColorPicker>

          <section style={{ marginBottom: spacing.sectionGap }}>
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500" style={{ marginBottom: spacing.itemGap }}>Summary</h2>
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
            <h2 className="text-sm font-bold uppercase tracking-wider text-gray-500" style={{ marginBottom: spacing.itemGap }}>Experience</h2>
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
                >
                  <div className="flex justify-between items-start" style={{ marginBottom: spacing.itemGap }}>
                    <div>
                      <div className="text-base font-semibold text-gray-900" style={{ lineHeight: spacing.lineHeight }}>
                        <EditableField
                          value={exp.title}
                          onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                          placeholder="Job Title"
                          editable={editable}
                        />
                      </div>
                      <div className="text-sm" style={{ color: primaryColor, lineHeight: spacing.lineHeight }}>
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

export const classicSidebarInfo = {
  id: 'classic-sidebar',
  name: 'Classic Sidebar',
  description: 'Traditional layout with light gray sidebar for contact and skills.',
  category: 'classic' as const,
  isAtsOptimized: true,
};
