import { Mail, Phone, MapPin, Linkedin, Globe } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ResumeData, ExperienceItem, EducationItem } from "@/types/resume";
import { TemplateSettings, defaultTemplateSettings } from "@/types/template";
import { cn } from "@/lib/utils";

interface ResumePreviewProps {
  data: ResumeData;
  templateSettings?: TemplateSettings;
  onUpdatePersonalInfo: (field: keyof ResumeData["personalInfo"], value: string) => void;
  onUpdateSummary: (value: string) => void;
  onUpdateExperience: (id: string, field: keyof ExperienceItem, value: string | string[]) => void;
  onUpdateEducation: (id: string, field: keyof EducationItem, value: string) => void;
  onUpdateSkills: (skills: string[]) => void;
}

// Inline editable text component
function EditableText({
  value,
  onChange,
  className,
  placeholder,
  multiline = false,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const baseClasses = cn(
    "bg-transparent border-0 p-0 focus:ring-0 focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
    "hover:bg-accent/30 focus:bg-accent/50 rounded px-1 -mx-1 transition-colors",
    className
  );

  if (multiline) {
    return (
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(baseClasses, "resize-none min-h-0")}
        placeholder={placeholder}
        rows={3}
      />
    );
  }

  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={baseClasses}
      placeholder={placeholder}
    />
  );
}

export function ResumePreview({
  data,
  templateSettings = defaultTemplateSettings,
  onUpdatePersonalInfo,
  onUpdateSummary,
  onUpdateExperience,
  onUpdateEducation,
  onUpdateSkills,
}: ResumePreviewProps) {
  // Apply template settings as inline styles
  const containerStyle = {
    padding: `${templateSettings.marginY}in ${templateSettings.marginX}in`,
    fontSize: `${templateSettings.fontSize}pt`,
    lineHeight: templateSettings.lineSpacing,
  };

  const sectionSpacingClass = `mt-${Math.round(templateSettings.sectionSpacing * 4)}`;

  return (
    <div
      className="mx-auto max-w-[8.5in] rounded-lg border border-border bg-card shadow-sm"
      style={containerStyle}
    >
      {/* Header */}
      <header className="border-b border-border pb-6">
        <EditableText
          value={data.personalInfo.fullName}
          onChange={(v) => onUpdatePersonalInfo("fullName", v)}
          className="text-2xl font-semibold text-foreground w-full"
          placeholder="Your Name"
        />

        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5 shrink-0" />
            <EditableText
              value={data.personalInfo.email}
              onChange={(v) => onUpdatePersonalInfo("email", v)}
              className="text-sm text-muted-foreground"
              placeholder="email@example.com"
            />
          </span>
          <span className="flex items-center gap-1.5">
            <Phone className="h-3.5 w-3.5 shrink-0" />
            <EditableText
              value={data.personalInfo.phone}
              onChange={(v) => onUpdatePersonalInfo("phone", v)}
              className="text-sm text-muted-foreground"
              placeholder="+1 (555) 000-0000"
            />
          </span>
          <span className="flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5 shrink-0" />
            <EditableText
              value={data.personalInfo.location}
              onChange={(v) => onUpdatePersonalInfo("location", v)}
              className="text-sm text-muted-foreground"
              placeholder="City, State"
            />
          </span>
          {data.personalInfo.linkedin && (
            <span className="flex items-center gap-1.5">
              <Linkedin className="h-3.5 w-3.5 shrink-0" />
              <EditableText
                value={data.personalInfo.linkedin}
                onChange={(v) => onUpdatePersonalInfo("linkedin", v)}
                className="text-sm text-muted-foreground"
                placeholder="linkedin.com/in/you"
              />
            </span>
          )}
          {data.personalInfo.website && (
            <span className="flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 shrink-0" />
              <EditableText
                value={data.personalInfo.website}
                onChange={(v) => onUpdatePersonalInfo("website", v)}
                className="text-sm text-muted-foreground"
                placeholder="yourwebsite.com"
              />
            </span>
          )}
        </div>
      </header>

      {/* Summary */}
      <section className="mt-6" style={{ marginTop: `${templateSettings.sectionSpacing * 0.5}rem` }}>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Professional Summary
        </h2>
        <EditableText
          value={data.summary}
          onChange={onUpdateSummary}
          className="text-sm leading-relaxed text-foreground w-full"
          placeholder="Write a brief professional summary..."
          multiline
        />
      </section>

      {/* Experience */}
      {data.experience.length > 0 && (
        <section style={{ marginTop: `${templateSettings.sectionSpacing * 0.5}rem` }}>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Work Experience
          </h2>

          <div className="space-y-5">
            {data.experience.map((exp) => (
              <div key={exp.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <EditableText
                      value={exp.title}
                      onChange={(v) => onUpdateExperience(exp.id, "title", v)}
                      className="font-medium text-foreground"
                      placeholder="Job Title"
                    />
                    <EditableText
                      value={exp.company}
                      onChange={(v) => onUpdateExperience(exp.id, "company", v)}
                      className="text-sm text-muted-foreground"
                      placeholder="Company Name"
                    />
                  </div>
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {exp.startDate} – {exp.endDate}
                  </span>
                </div>
                {exp.bullets.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm text-foreground">
                    {exp.bullets.map((bullet, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-muted-foreground">•</span>
                        <span>{bullet}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Education */}
      {data.education.length > 0 && (
        <section style={{ marginTop: `${templateSettings.sectionSpacing * 0.5}rem` }}>
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Education
          </h2>

          {data.education.map((edu) => (
            <div key={edu.id} className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <EditableText
                  value={edu.degree}
                  onChange={(v) => onUpdateEducation(edu.id, "degree", v)}
                  className="font-medium text-foreground"
                  placeholder="Degree"
                />
                <EditableText
                  value={edu.institution}
                  onChange={(v) => onUpdateEducation(edu.id, "institution", v)}
                  className="text-sm text-muted-foreground"
                  placeholder="Institution"
                />
              </div>
              <span className="shrink-0 text-sm text-muted-foreground">{edu.graduationYear}</span>
            </div>
          ))}
        </section>
      )}

      {/* Skills */}
      {data.skills.length > 0 && (
        <section style={{ marginTop: `${templateSettings.sectionSpacing * 0.5}rem` }}>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Skills
          </h2>
          <div className="flex flex-wrap gap-2">
            {data.skills.map((skill) => (
              <span
                key={skill}
                className="rounded-md bg-secondary px-2.5 py-1 text-xs font-medium text-foreground"
              >
                {skill}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
