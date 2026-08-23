import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, Section, EntryHeader, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSections } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';
import { Mail, Phone, MapPin, Linkedin, Globe } from 'lucide-react';

export function ProfessionalStandard({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#1e293b';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleColorChange = (color: string) => {
    onCustomizationChange?.({ primaryColor: color });
  };

  return (
    <ResumePage scale={scale} style={{ padding: spacing.pagePadding }} customization={customization}>
      <InlineColorPicker color={primaryColor} onChange={handleColorChange} colorType="primary" editable={editable}>
        <header className="text-center border-b-2" style={{ marginBottom: spacing.sectionGap, paddingBottom: spacing.itemGap, borderColor: primaryColor }}>
        <h1 className="text-3xl font-bold text-gray-900" style={{ marginBottom: spacing.itemGap, lineHeight: spacing.lineHeight }}>
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="flex flex-wrap justify-center gap-4 text-sm text-gray-600">
          <span className="inline-flex items-center gap-1">
            <Mail className="w-3.5 h-3.5" />
            <EditableField
              value={personalInfo.email}
              onChange={(v) => handleFieldChange('personalInfo.email', v)}
              placeholder="email@example.com"
              editable={editable}
            />
          </span>
          <span className="inline-flex items-center gap-1">
            <Phone className="w-3.5 h-3.5" />
            <EditableField
              value={personalInfo.phone}
              onChange={(v) => handleFieldChange('personalInfo.phone', v)}
              placeholder="+1 (555) 000-0000"
              editable={editable}
            />
          </span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="w-3.5 h-3.5" />
            <EditableField
              value={personalInfo.location}
              onChange={(v) => handleFieldChange('personalInfo.location', v)}
              placeholder="City, State"
              editable={editable}
            />
          </span>
          {personalInfo.linkedin && (
            <span className="inline-flex items-center gap-1">
              <Linkedin className="w-3.5 h-3.5" />
              <EditableField
                value={personalInfo.linkedin}
                onChange={(v) => handleFieldChange('personalInfo.linkedin', v)}
                placeholder="linkedin.com/in/you"
                editable={editable}
              />
            </span>
          )}
          {personalInfo.website && (
            <span className="inline-flex items-center gap-1">
              <Globe className="w-3.5 h-3.5" />
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

      <Section title="Professional Summary" titleStyle={{ color: primaryColor }} style={{ marginBottom: spacing.sectionGap }} titleMarginBottom={spacing.itemGap}>
        <div className="text-sm text-gray-700" style={{ lineHeight: spacing.lineHeight }}>
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="Write a brief professional summary highlighting your key qualifications and career objectives..."
            editable={editable}
            as="p"
            multiline
          />
        </div>
      </Section>

      <Section title="Work Experience" titleStyle={{ color: primaryColor }} style={{ marginBottom: spacing.sectionGap }} titleMarginBottom={spacing.itemGap}>
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
              <EntryHeader
                title={
                  <EditableField
                    value={exp.title}
                    onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                    placeholder="Job Title"
                    editable={editable}
                  />
                }
                subtitle={
                  <EditableField
                    value={exp.company}
                    onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                    placeholder="Company Name"
                    editable={editable}
                  />
                }
                date={
                  <span className="inline-flex items-center gap-1">
                    <EditableField
                      value={exp.startDate}
                      onChange={(v) => handleFieldChange(`experience.${index}.startDate`, v)}
                      placeholder="Start"
                      editable={editable}
                    />
                    <span>–</span>
                    <EditableField
                      value={exp.endDate}
                      onChange={(v) => handleFieldChange(`experience.${index}.endDate`, v)}
                      placeholder="End"
                      editable={editable}
                    />
                  </span>
                }
              />
              <EditableBulletList
                bullets={exp.bullets}
                onChange={(bullets) => handleFieldChange(`experience.${index}.bullets`, bullets)}
                editable={editable}
                style={{ marginTop: spacing.itemGap }}
              />
            </EntryWrapper>
          ))}
        </EntryGroup>
      </Section>

      <Section title="Education" titleStyle={{ color: primaryColor }} style={{ marginBottom: spacing.sectionGap }} titleMarginBottom={spacing.itemGap}>
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
            >
              <EntryHeader
                title={
                  <EditableField
                    value={edu.degree}
                    onChange={(v) => handleFieldChange(`education.${index}.degree`, v)}
                    placeholder="Degree"
                    editable={editable}
                  />
                }
                subtitle={
                  <span className="inline-flex items-center gap-1">
                    <EditableField
                      value={edu.institution}
                      onChange={(v) => handleFieldChange(`education.${index}.institution`, v)}
                      placeholder="Institution"
                      editable={editable}
                    />
                    {edu.field && (
                      <>
                        <span className="text-gray-400">·</span>
                        <EditableField
                          value={edu.field}
                          onChange={(v) => handleFieldChange(`education.${index}.field`, v)}
                          placeholder="Field of Study"
                          editable={editable}
                        />
                      </>
                    )}
                  </span>
                }
                date={
                  <EditableField
                    value={edu.graduationYear}
                    onChange={(v) => handleFieldChange(`education.${index}.graduationYear`, v)}
                    placeholder="Year"
                    editable={editable}
                  />
                }
              />
            </EntryWrapper>
          ))}
        </EntryGroup>
      </Section>

      <Section title="Skills" titleStyle={{ color: primaryColor }} style={{ marginBottom: spacing.sectionGap }} titleMarginBottom={spacing.itemGap}>
        <EditableSkills
          skills={skills}
          onChange={(newSkills) => handleFieldChange('skills', newSkills)}
          editable={editable}
        />
      </Section>

      <CustomSections
        sections={data.customSections}
        editable={editable}
        onFieldChange={handleFieldChange}
      />
    </ResumePage>
  );
}

export const professionalStandardInfo = {
  id: 'professional-standard',
  name: 'Professional Standard',
  description: 'Clean, ATS-optimized layout suitable for any profession. Single column with clear hierarchy.',
  category: 'professional' as const,
  isAtsOptimized: true,
};
