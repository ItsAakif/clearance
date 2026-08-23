import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { EditablePhoto } from './EditablePhoto';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';

export function TechModern({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#1e293b';
  const secondaryColor = customization?.secondaryColor || '#3b82f6';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handlePrimaryColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  const handleSecondaryColorChange = (color: string) => {
    onCustomizationChange?.({ secondaryColor: color });
  };

  return (
    <ResumePage scale={scale} className="p-0" customization={customization}>
      <InlineColorPicker color={primaryColor} onChange={handlePrimaryColorChange} colorType="primary" editable={editable}>
        <header className="text-white" style={{ background: `linear-gradient(135deg, ${primaryColor} 0%, ${secondaryColor} 100%)`, padding: spacing.pagePadding }}>
        <div className="flex items-center gap-6">
          <EditablePhoto
            photoUrl={customization?.photoUrl}
            onPhotoChange={(url) => onCustomizationChange?.({ photoUrl: url })}
            size={customization?.photoSize || 'medium'}
            onSizeChange={(size) => onCustomizationChange?.({ photoSize: size })}
            resizable={true}
            shape="rounded"
            editable={editable}
            className="border-2 border-white/30 shrink-0"
            placeholderClassName="text-white/60"
          />
          <div className="flex-1">
            <h1 className="text-3xl font-bold" style={{ marginBottom: spacing.itemGap }}>
              <EditableField
                value={personalInfo.fullName}
                onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
                placeholder="Your Name"
                editable={editable}
                as="span"
                className="text-white"
              />
            </h1>
            <div className="flex flex-wrap gap-4 text-sm text-white/80">
              <span className="flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5" />
                <EditableField
                  value={personalInfo.email}
                  onChange={(v) => handleFieldChange('personalInfo.email', v)}
                  placeholder="email@example.com"
                  editable={editable}
                  className="text-white/80"
                />
              </span>
              <span className="flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5" />
                <EditableField
                  value={personalInfo.phone}
                  onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                  placeholder="+1 (555) 000-0000"
                  editable={editable}
                  className="text-white/80"
                />
              </span>
              <span className="flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" />
                <EditableField
                  value={personalInfo.location}
                  onChange={(v) => handleFieldChange('personalInfo.location', v)}
                  placeholder="City, State"
                  editable={editable}
                  className="text-white/80"
                />
              </span>
              {personalInfo.linkedin && (
                <span className="flex items-center gap-1.5">
                  <Linkedin className="w-3.5 h-3.5" />
                  <EditableField
                    value={personalInfo.linkedin}
                    onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                    placeholder="linkedin.com/in/you"
                    editable={editable}
                    className="text-white/80"
                  />
                </span>
              )}
              {personalInfo.website && (
                <span className="flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" />
                  <EditableField
                    value={personalInfo.website}
                    onChange={(v) => handleFieldChange('personalInfo.website', v)}
                    placeholder="yoursite.com"
                    editable={editable}
                    className="text-white/80"
                  />
                </span>
              )}
            </div>
          </div>
        </div>
        </header>
      </InlineColorPicker>

      <div className="bg-white" style={{ padding: spacing.pagePadding }}>
        <section style={{ marginBottom: spacing.sectionGap }}>
          <InlineColorPicker color={secondaryColor} onChange={handleSecondaryColorChange} colorType="secondary" editable={editable}>
            <div className="text-sm text-gray-600 border-l-4 pl-4" style={{ borderColor: secondaryColor, lineHeight: spacing.lineHeight }}>
            <EditableField
              value={summary}
              onChange={(v) => handleFieldChange('summary', v)}
              placeholder="Professional summary..."
              editable={editable}
              as="p"
              multiline
            />
            </div>
          </InlineColorPicker>
        </section>

        <section style={{ marginBottom: spacing.sectionGap }}>
          <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Experience</h2>
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
                    <div className="text-sm" style={{ color: secondaryColor }}>
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
              </EntryWrapper>
            ))}
          </EntryGroup>
        </section>

        <div className="grid grid-cols-2" style={{ gap: spacing.sectionGap }}>
          <section>
            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Education</h2>
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
          </section>

          <section>
            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>Skills</h2>
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
    </ResumePage>
  );
}

export const techModernInfo = {
  id: 'tech-modern',
  name: 'Tech Modern',
  description: 'Gradient header with modern tech-focused aesthetic.',
  category: 'modern' as const,
  isAtsOptimized: false,
};
