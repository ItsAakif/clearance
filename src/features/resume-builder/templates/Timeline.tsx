import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, Section, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';

export function Timeline({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const accentColor = customization?.secondaryColor || '#2563eb';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ secondaryColor: color });
  };

  return (
    <ResumePage scale={scale} style={{ padding: spacing.pagePadding }} customization={customization}>
      <InlineColorPicker color={accentColor} onChange={handleColorChange} colorType="secondary" editable={editable}>
        <header className="text-center pb-6 border-b-2" style={{ borderColor: accentColor, marginBottom: spacing.sectionGap }}>
        <h1 className="text-3xl font-bold text-gray-900" style={{ marginBottom: spacing.itemGap }}>
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="flex flex-wrap justify-center gap-4 text-sm text-gray-600">
          <span className="inline-flex items-center gap-1.5">
            <Mail className="w-4 h-4" style={{ color: accentColor }} />
            <EditableField
              value={personalInfo.email}
              onChange={(v) => handleFieldChange('personalInfo.email', v)}
              placeholder="email@example.com"
              editable={editable}
            />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Phone className="w-4 h-4" style={{ color: accentColor }} />
            <EditableField
              value={personalInfo.phone}
              onChange={(v) => handleFieldChange('personalInfo.phone', v)}
              placeholder="+1 (555) 000-0000"
              editable={editable}
            />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="w-4 h-4" style={{ color: accentColor }} />
            <EditableField
              value={personalInfo.location}
              onChange={(v) => handleFieldChange('personalInfo.location', v)}
              placeholder="City, State"
              editable={editable}
            />
          </span>
          {personalInfo.linkedin && (
            <span className="inline-flex items-center gap-1.5">
              <Linkedin className="w-4 h-4" style={{ color: accentColor }} />
              <EditableField
                value={personalInfo.linkedin}
                onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                placeholder="linkedin.com/in/you"
                editable={editable}
              />
            </span>
          )}
          {personalInfo.website && (
            <span className="inline-flex items-center gap-1.5">
              <Globe className="w-4 h-4" style={{ color: accentColor }} />
              <EditableField
                value={personalInfo.website}
                onChange={(v) => handleFieldChange('personalInfo.website', v)}
                placeholder="yoursite.com"
                editable={editable}
              />
            </span>
          )}
        </div>
        </header>
      </InlineColorPicker>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <div className="text-sm text-gray-700 text-center max-w-3xl mx-auto" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="A professional summary highlighting your career trajectory and key achievements..."
            editable={editable}
            as="p"
            multiline
          />
        </div>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-sm font-bold uppercase tracking-wider text-center" style={{ color: accentColor, marginBottom: spacing.itemGap }}>
          Career Timeline
        </h2>
        <div className="relative">
          <div className="absolute left-[120px] top-0 bottom-0 w-0.5" style={{ backgroundColor: accentColor, opacity: 0.3 }}></div>
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
                className="relative pl-[140px] last:mb-0"
              >
                <div className="absolute left-0 w-[110px] text-right pr-4">
                  <div className="text-xs font-medium text-gray-500">
                    <EditableField
                      value={exp.startDate}
                      onChange={(v) => handleFieldChange(`experience.${index}.startDate`, v)}
                      placeholder="Start"
                      editable={editable}
                    />
                  </div>
                  <div className="text-xs text-gray-400">to</div>
                  <div className="text-xs font-medium text-gray-500">
                    <EditableField
                      value={exp.endDate}
                      onChange={(v) => handleFieldChange(`experience.${index}.endDate`, v)}
                      placeholder="Present"
                      editable={editable}
                    />
                  </div>
                </div>
                <div className="absolute left-[116px] top-1 w-3 h-3 rounded-full border-2 border-white shadow" style={{ backgroundColor: accentColor }}></div>
                <div className="bg-gray-50 p-4 rounded-lg border border-gray-100">
                  <div className="text-base font-semibold text-gray-900">
                    <EditableField
                      value={exp.title}
                      onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                      placeholder="Job Title"
                      editable={editable}
                    />
                  </div>
                  <div className="text-sm font-medium" style={{ color: accentColor, marginBottom: spacing.itemGap }}>
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
                </div>
              </EntryWrapper>
            ))}
          </EntryGroup>
        </div>
      </section>

      <div className="grid grid-cols-2" style={{ gap: spacing.sectionGap }}>
        <section>
          <h2 className="text-sm font-bold uppercase tracking-wider pb-1 border-b" style={{ color: accentColor, borderColor: accentColor, marginBottom: spacing.itemGap }}>
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
          <h2 className="text-sm font-bold uppercase tracking-wider pb-1 border-b" style={{ color: accentColor, borderColor: accentColor, marginBottom: spacing.itemGap }}>
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
    </ResumePage>
  );
}

export const timelineInfo = {
  id: 'timeline',
  name: 'Timeline',
  description: 'Visual timeline showing career progression. Perfect for showing growth and promotions.',
  category: 'modern' as const,
  isAtsOptimized: true,
};
