import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { CustomSectionsCards } from './CustomSections';
import { InlineColorPicker } from './InlineColorPicker';

export function ModernCards({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const primaryColor = customization?.primaryColor || '#1e293b';
  const secondaryColor = customization?.secondaryColor || '#3b82f6';
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  const handleSecondaryColorChange = (color: string) => {
    onCustomizationChange?.({ secondaryColor: color });
  };

  return (
    <ResumePage scale={scale} className="bg-gray-100" style={{ padding: spacing.pagePadding }} customization={customization}>
      <header className="bg-white rounded-xl shadow-sm p-6" style={{ marginBottom: spacing.itemGap }}>
        <h1 className="text-3xl font-bold" style={{ color: primaryColor, marginBottom: spacing.itemGap }}>
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        <div className="flex flex-wrap gap-3 text-sm text-gray-600">
          <span className="px-3 py-1 bg-gray-100 rounded-full">
            <EditableField
              value={personalInfo.email}
              onChange={(v) => handleFieldChange('personalInfo.email', v)}
              placeholder="email@example.com"
              editable={editable}
            />
          </span>
          <span className="px-3 py-1 bg-gray-100 rounded-full">
            <EditableField
              value={personalInfo.phone}
              onChange={(v) => handleFieldChange('personalInfo.phone', v)}
              placeholder="+1 (555) 000-0000"
              editable={editable}
            />
          </span>
          <span className="px-3 py-1 bg-gray-100 rounded-full">
            <EditableField
              value={personalInfo.location}
              onChange={(v) => handleFieldChange('personalInfo.location', v)}
              placeholder="City, State"
              editable={editable}
            />
          </span>
        </div>
      </header>

      <div className="bg-white rounded-xl shadow-sm p-6" style={{ marginBottom: spacing.itemGap }}>
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
      </div>

      <div className="bg-white rounded-xl shadow-sm p-6" style={{ marginBottom: spacing.itemGap }}>
        <InlineColorPicker color={secondaryColor} onChange={handleSecondaryColorChange} colorType="secondary" editable={editable}>
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: secondaryColor, marginBottom: spacing.itemGap }}>Experience</h2>
        </InlineColorPicker>
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
              className="p-4 bg-gray-50 rounded-lg last:mb-0"
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
                <div className="text-xs text-gray-500 bg-white px-2 py-1 rounded">
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
      </div>

      <div className="grid grid-cols-2" style={{ gap: spacing.itemGap }}>
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: secondaryColor, marginBottom: spacing.itemGap }}>Education</h2>
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
                <div className="text-sm font-medium text-gray-900">
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
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: secondaryColor, marginBottom: spacing.itemGap }}>Skills</h2>
          <EditableSkills
            skills={skills}
            onChange={(newSkills) => handleFieldChange('skills', newSkills)}
            editable={editable}
          />
        </div>

        <CustomSectionsCards
          sections={data.customSections}
          editable={editable}
          onFieldChange={handleFieldChange}
        />
      </div>
    </ResumePage>
  );
}

export const modernCardsInfo = {
  id: 'modern-cards',
  name: 'Modern Cards',
  description: 'Contemporary card-based design with rounded corners and shadows.',
  category: 'modern' as const,
  isAtsOptimized: true,
};
