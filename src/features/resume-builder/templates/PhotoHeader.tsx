import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { EditablePhoto } from './EditablePhoto';
import { CustomSections } from './CustomSections';
import { Mail, Phone, MapPin, Linkedin } from 'lucide-react';
import { InlineColorPicker } from './InlineColorPicker';
import { ResizableHeader } from './ResizableLayout';

export function PhotoHeader({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#0d9488';
  const headerHeight = customization?.layout?.headerHeight || 140;
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
      <div className="text-white px-8 py-6 h-full flex items-center" style={{ background: `linear-gradient(to right, ${primaryColor}, ${primaryColor}dd)` }}>
        <div className="flex items-center gap-6 w-full">
          <EditablePhoto
            photoUrl={customization?.photoUrl}
            onPhotoChange={(url) => onCustomizationChange?.({ photoUrl: url })}
            size={customization?.photoSize || 'large'}
            onSizeChange={(size) => onCustomizationChange?.({ photoSize: size })}
            shape="circle"
            editable={editable}
            resizable={true}
            className="border-4 border-white/40 shrink-0"
            placeholderClassName="text-white/70"
          />
          <div className="flex-1">
            <h1 className="text-3xl font-bold mb-2">
              <EditableField
                value={personalInfo.fullName}
                onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
                placeholder="Your Name"
                editable={editable}
                as="span"
                className="text-white"
              />
            </h1>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-teal-100">
              <span className="inline-flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5" />
                <EditableField
                  value={personalInfo.email}
                  onChange={(v) => handleFieldChange('personalInfo.email', v)}
                  placeholder="email@example.com"
                  editable={editable}
                  className="text-teal-100"
                />
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Phone className="w-3.5 h-3.5" />
                <EditableField
                  value={personalInfo.phone}
                  onChange={(v) => handleFieldChange('personalInfo.phone', v)}
                  placeholder="+1 (555) 000-0000"
                  editable={editable}
                  className="text-teal-100"
                />
              </span>
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5" />
                <EditableField
                  value={personalInfo.location}
                  onChange={(v) => handleFieldChange('personalInfo.location', v)}
                  placeholder="City, State"
                  editable={editable}
                  className="text-teal-100"
                />
              </span>
              {personalInfo.linkedin && (
                <span className="inline-flex items-center gap-1.5">
                  <Linkedin className="w-3.5 h-3.5" />
                  <EditableField
                    value={personalInfo.linkedin}
                    onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                    placeholder="linkedin.com/in/you"
                    editable={editable}
                    className="text-teal-100"
                  />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </InlineColorPicker>
  );

  return (
    <ResumePage scale={scale} className="p-0" customization={customization}>
      <ResizableHeader
        initialHeight={headerHeight}
        minHeight={100}
        maxHeight={220}
        onHeightChange={handleHeightChange}
        editable={editable}
        headerContent={headerContent}
        headerClassName=""
        mainClassName=""
      >
        <div style={{ padding: spacing.pagePadding }} className="flex-1">
          <section style={{ marginBottom: spacing.sectionGap }}>
            <h2 className="text-sm font-bold uppercase tracking-wider pb-1 border-b-2" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
              About Me
            </h2>
            <div className="text-sm text-gray-600" style={{ lineHeight: spacing.lineHeight }}>
              <EditableField
                value={summary}
                onChange={(v) => handleFieldChange('summary', v)}
                placeholder="A professional summary highlighting your expertise, achievements, and career goals..."
                editable={editable}
                as="p"
                multiline
              />
            </div>
          </section>

          <section style={{ marginBottom: spacing.sectionGap }}>
            <h2 className="text-sm font-bold uppercase tracking-wider pb-1 border-b-2" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
              Work Experience
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
                      <div className="text-sm font-medium" style={{ color: primaryColor }}>
                        <EditableField
                          value={exp.company}
                          onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                          placeholder="Company Name"
                          editable={editable}
                        />
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 shrink-0 bg-gray-100 px-2 py-1 rounded">
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

          <div className="grid grid-cols-2 gap-8">
            <section>
              <h2 className="text-sm font-bold uppercase tracking-wider pb-1 border-b-2" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
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
                    <div className="text-sm font-semibold text-gray-900">
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
              <h2 className="text-sm font-bold uppercase tracking-wider pb-1 border-b-2" style={{ color: primaryColor, borderColor: primaryColor, marginBottom: spacing.itemGap }}>
                Skills
              </h2>
              <EditableSkills
                skills={skills}
                onChange={(newSkills) => handleFieldChange('skills', newSkills)}
                editable={editable}
              />
            </section>
          </div>

          <CustomSections
            sections={data.customSections}
            editable={editable}
            onFieldChange={handleFieldChange}
          />
        </div>
      </ResizableHeader>
    </ResumePage>
  );
}

export const photoHeaderInfo = {
  id: 'photo-header',
  name: 'Photo Header',
  description: 'Modern layout with photo placeholder and gradient header. Great first impression.',
  category: 'modern' as const,
  isAtsOptimized: false,
};
