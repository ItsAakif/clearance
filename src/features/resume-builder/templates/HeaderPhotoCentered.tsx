import { TemplateProps, defaultCustomization, getSpacing } from './types';
import { ResumePage, EntryGroup, EntryWrapper } from './BaseComponents';
import { EditableField, EditableBulletList, EditableSkills } from './EditableField';
import { EditablePhoto } from './EditablePhoto';
import { CustomSections } from './CustomSections';
import { Mail, Phone, MapPin } from 'lucide-react';

export function HeaderPhotoCentered({ data, editable = true, onFieldChange, customization = defaultCustomization, onCustomizationChange, scale = 1 }: TemplateProps) {
  const { personalInfo, summary, experience, education, skills } = data;
  const spacing = getSpacing(customization);

  const handleFieldChange = (path: string, value: string | string[]) => {
    onFieldChange?.(path, value);
  };

  return (
    <ResumePage scale={scale} style={{ padding: spacing.pagePadding }} className="bg-white" customization={customization}>
      <header className="flex flex-col items-center" style={{ marginBottom: spacing.sectionGap }}>
        <div style={{ marginBottom: spacing.itemGap }}>
          <EditablePhoto
            photoUrl={customization?.photoUrl}
            onPhotoChange={(url) => onCustomizationChange?.({ photoUrl: url })}
            size={customization?.photoSize || 'small'}
            onSizeChange={(size) => onCustomizationChange?.({ photoSize: size })}
            shape="circle"
            editable={editable}
            resizable={true}
            className="border border-gray-200"
            placeholderClassName="text-gray-400"
          />
        </div>
        
        <h1 
          className="text-xl font-semibold text-gray-900 text-center leading-tight"
          style={{ marginBottom: spacing.itemGap, lineHeight: spacing.lineHeight }}
        >
          <EditableField
            value={personalInfo.fullName}
            onChange={(v) => handleFieldChange('personalInfo.fullName', v)}
            placeholder="Your Name"
            editable={editable}
            as="span"
          />
        </h1>
        
        <div 
          className="flex items-center justify-center flex-wrap text-xs text-gray-500"
          style={{ gap: spacing.itemGap }}
        >
          <span className="inline-flex items-center gap-1">
            <Mail className="w-3 h-3" />
            <EditableField
              value={personalInfo.email}
              onChange={(v) => handleFieldChange('personalInfo.email', v)}
              placeholder="email@example.com"
              editable={editable}
            />
          </span>
          <span className="inline-flex items-center gap-1">
            <Phone className="w-3 h-3" />
            <EditableField
              value={personalInfo.phone}
              onChange={(v) => handleFieldChange('personalInfo.phone', v)}
              placeholder="+1 (555) 000-0000"
              editable={editable}
            />
          </span>
          <span className="inline-flex items-center gap-1">
            <MapPin className="w-3 h-3" />
            <EditableField
              value={personalInfo.location}
              onChange={(v) => handleFieldChange('personalInfo.location', v)}
              placeholder="City, State"
              editable={editable}
            />
          </span>
        </div>
      </header>

      <div className="border-t border-gray-200" style={{ marginBottom: spacing.sectionGap }} />

      <section style={{ marginBottom: spacing.sectionGap }}>
        <p 
          className="text-sm text-gray-600 text-center max-w-xl mx-auto"
          style={{ lineHeight: spacing.lineHeight }}
        >
          <EditableField
            value={summary}
            onChange={(v) => handleFieldChange('summary', v)}
            placeholder="Professional summary highlighting your expertise and career goals..."
            editable={editable}
            as="span"
            multiline
          />
        </p>
      </section>

      <section style={{ marginBottom: spacing.sectionGap }}>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 text-center" style={{ marginBottom: spacing.itemGap }}>
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
            >
              <div className="flex justify-between items-start" style={{ marginBottom: spacing.itemGap }}>
                <div>
                  <div className="text-sm font-medium text-gray-900" style={{ lineHeight: spacing.lineHeight }}>
                    <EditableField
                      value={exp.title}
                      onChange={(v) => handleFieldChange(`experience.${index}.title`, v)}
                      placeholder="Job Title"
                      editable={editable}
                    />
                  </div>
                  <div className="text-sm text-gray-600" style={{ lineHeight: spacing.lineHeight }}>
                    <EditableField
                      value={exp.company}
                      onChange={(v) => handleFieldChange(`experience.${index}.company`, v)}
                      placeholder="Company"
                      editable={editable}
                    />
                  </div>
                </div>
                <div className="text-xs text-gray-400 flex-shrink-0">
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
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 text-center" style={{ marginBottom: spacing.itemGap }}>
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
                <div className="text-xs text-gray-400">
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
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 text-center" style={{ marginBottom: spacing.itemGap }}>
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

export const headerPhotoCenteredInfo = {
  id: 'header-photo-centered',
  name: 'Centered Photo',
  description: 'Clean minimal design with centered photo and elegant typography.',
  category: 'minimal' as const,
  isAtsOptimized: false,
};
