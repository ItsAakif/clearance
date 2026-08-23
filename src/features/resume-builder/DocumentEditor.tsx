import { Mail, Phone, MapPin, Linkedin, Globe, Plus, Trash2, ChevronRight } from "lucide-react";
import { ResumeData, ExperienceItem, EducationItem } from "@/types/resume";
import { TemplateSettings, defaultTemplateSettings } from "@/types/template";
import { TemplateCategory, TemplateStyle, getTemplateStyle, getBulletCharacter } from "./templateStyles";
import { EditableField } from "./components/EditableField";
import { EditableBulletList } from "./components/EditableBulletList";
import { EditableSkills } from "./components/EditableSkills";
import { FloatingToolbar } from "./components/FloatingToolbar";
import { cn } from "@/lib/utils";
import { useMemo } from "react";

interface DocumentEditorProps {
  data: ResumeData;
  templateSettings?: TemplateSettings;
  templateCategory?: TemplateCategory;
  onUpdatePersonalInfo: (field: keyof ResumeData["personalInfo"], value: string) => void;
  onUpdateSummary: (value: string) => void;
  onUpdateExperience: (id: string, field: keyof ExperienceItem, value: string | string[]) => void;
  onAddExperience: () => void;
  onRemoveExperience: (id: string) => void;
  onUpdateEducation: (id: string, field: keyof EducationItem, value: string) => void;
  onAddEducation: () => void;
  onRemoveEducation: (id: string) => void;
  onUpdateSkills: (skills: string[]) => void;
}

export function DocumentEditor({
  data,
  templateSettings = defaultTemplateSettings,
  templateCategory = "classic",
  onUpdatePersonalInfo,
  onUpdateSummary,
  onUpdateExperience,
  onAddExperience,
  onRemoveExperience,
  onUpdateEducation,
  onAddEducation,
  onRemoveEducation,
  onUpdateSkills,
}: DocumentEditorProps) {
  // Get template style based on category
  const style = useMemo(() => getTemplateStyle(templateCategory), [templateCategory]);
  const bulletChar = useMemo(() => getBulletCharacter(style.bulletStyle), [style.bulletStyle]);

  const pageStyle = {
    padding: `${templateSettings.marginY}in ${templateSettings.marginX}in`,
    fontSize: `${templateSettings.fontSize}pt`,
    lineHeight: templateSettings.lineSpacing,
    fontFamily: style.bodyFont,
  };

  // Dynamic styles based on template category
  const headerBgStyle = style.headerBg.includes("gradient") 
    ? { background: style.headerBg } 
    : { backgroundColor: style.headerBg };

  const getSectionTitleStyle = (): React.CSSProperties => {
    const base: React.CSSProperties = {
      fontSize: style.sectionTitleSize,
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.1em",
      color: style.secondaryColor,
      marginBottom: "0.5rem",
      paddingBottom: "0.25rem",
    };

    switch (style.sectionStyle) {
      case "underline":
        return { ...base, borderBottom: `1px solid ${style.sectionBorderColor}` };
      case "border-left":
        return { ...base, borderLeft: `3px solid ${style.accentColor}`, paddingLeft: "0.75rem", borderBottom: "none" };
      case "background":
        return { ...base, backgroundColor: `${style.accentColor}15`, padding: "0.5rem 0.75rem", borderRadius: style.roundedCorners ? "0.25rem" : 0 };
      case "uppercase":
        return { ...base, borderBottom: "none", letterSpacing: "0.15em" };
      case "simple":
      default:
        return base;
    }
  };

  const sectionTitleStyle = getSectionTitleStyle();

  // Render based on layout type
  if (style.layout === "two-column") {
    return (
      <>
        <FloatingToolbar />
        <div className="min-h-full bg-neutral-200 dark:bg-neutral-800 py-8 px-4">
          <div
            className={cn(
              "mx-auto bg-white dark:bg-zinc-900 shadow-xl overflow-hidden",
              style.roundedCorners && "rounded-lg",
              style.shadowEffects && "shadow-2xl"
            )}
            style={{
              width: "8.5in",
              minHeight: "11in",
            }}
          >
            {/* Creative Header - Full Width with Gradient */}
            <header
              className="text-white p-8"
              style={headerBgStyle}
            >
              <EditableField
                value={data.personalInfo.fullName}
                onChange={(v) => onUpdatePersonalInfo("fullName", v)}
                placeholder="Your Full Name"
                as="h1"
                className="text-3xl font-bold text-center text-white block"
                style={{ fontFamily: style.headerFont, fontSize: style.nameSize }}
              />

              <div className="mt-4 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-white/90">
                {style.showIcons && (
                  <>
                    <span className="flex items-center gap-2">
                      <Mail className="h-4 w-4" />
                      <EditableField
                        value={data.personalInfo.email}
                        onChange={(v) => onUpdatePersonalInfo("email", v)}
                        placeholder="email@example.com"
                        className="text-sm text-white"
                      />
                    </span>
                    <span className="flex items-center gap-2">
                      <Phone className="h-4 w-4" />
                      <EditableField
                        value={data.personalInfo.phone}
                        onChange={(v) => onUpdatePersonalInfo("phone", v)}
                        placeholder="+1 (555) 000-0000"
                        className="text-sm text-white"
                      />
                    </span>
                    <span className="flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      <EditableField
                        value={data.personalInfo.location}
                        onChange={(v) => onUpdatePersonalInfo("location", v)}
                        placeholder="City, State"
                        className="text-sm text-white"
                      />
                    </span>
                  </>
                )}
              </div>
            </header>

            {/* Two Column Layout */}
            <div className="flex" style={pageStyle}>
              {/* Left Column - Main Content */}
              <div className="flex-1 pr-6 border-r" style={{ borderColor: style.sectionBorderColor }}>
                {/* Summary */}
                <section style={{ marginBottom: style.sectionSpacing }}>
                  <h2 style={sectionTitleStyle}>Professional Summary</h2>
                  <EditableField
                    value={data.summary}
                    onChange={onUpdateSummary}
                    placeholder="Write a compelling summary..."
                    as="p"
                    className="text-sm leading-relaxed block"
                    style={{ color: style.primaryColor }}
                  />
                </section>

                {/* Experience */}
                <section className="group/section" style={{ marginBottom: style.sectionSpacing }}>
                  <h2 style={sectionTitleStyle}>Work Experience</h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: style.itemSpacing }}>
                    {data.experience.map((exp) => (
                      <div key={exp.id} className="group/item relative">
                        <button
                          onClick={() => onRemoveExperience(exp.id)}
                          className="absolute -left-6 top-0 opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                          title="Remove experience"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>

                        <div className="flex items-baseline justify-between gap-4">
                          <div className="flex-1">
                            <EditableField
                              value={exp.title}
                              onChange={(v) => onUpdateExperience(exp.id, "title", v)}
                              placeholder="Job Title"
                              className="font-semibold"
                              style={{ color: style.primaryColor }}
                            />
                            <span style={{ color: style.secondaryColor }}> at </span>
                            <EditableField
                              value={exp.company}
                              onChange={(v) => onUpdateExperience(exp.id, "company", v)}
                              placeholder="Company Name"
                              style={{ color: style.accentColor }}
                            />
                          </div>
                          <div className="flex items-center gap-1 text-sm shrink-0" style={{ color: style.secondaryColor }}>
                            <EditableField
                              value={exp.startDate}
                              onChange={(v) => onUpdateExperience(exp.id, "startDate", v)}
                              placeholder="Start"
                            />
                            <span>–</span>
                            <EditableField
                              value={exp.endDate}
                              onChange={(v) => onUpdateExperience(exp.id, "endDate", v)}
                              placeholder="End"
                            />
                          </div>
                        </div>

                        <EditableBulletList
                          bullets={exp.bullets}
                          onChange={(bullets) => onUpdateExperience(exp.id, "bullets", bullets)}
                          className="mt-2"
                          bulletChar={bulletChar}
                        />
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={onAddExperience}
                    className="mt-3 flex items-center gap-1 text-xs opacity-0 group-hover/section:opacity-100 transition-opacity"
                    style={{ color: style.accentColor }}
                  >
                    <Plus className="h-3 w-3" />
                    Add experience
                  </button>
                </section>
              </div>

              {/* Right Column - Sidebar */}
              <div className="w-64 pl-6">
                {/* Education */}
                <section className="group/section" style={{ marginBottom: style.sectionSpacing }}>
                  <h2 style={sectionTitleStyle}>Education</h2>
                  <div style={{ display: "flex", flexDirection: "column", gap: style.itemSpacing }}>
                    {data.education.map((edu) => (
                      <div key={edu.id} className="group/item relative">
                        <button
                          onClick={() => onRemoveEducation(edu.id)}
                          className="absolute -left-6 top-0 opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                          title="Remove education"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>

                        <EditableField
                          value={edu.degree}
                          onChange={(v) => onUpdateEducation(edu.id, "degree", v)}
                          placeholder="Degree"
                          className="font-semibold text-sm"
                          style={{ color: style.primaryColor }}
                        />
                        <EditableField
                          value={edu.field}
                          onChange={(v) => onUpdateEducation(edu.id, "field", v)}
                          placeholder="Field of Study"
                          className="text-sm block"
                          style={{ color: style.secondaryColor }}
                        />
                        <EditableField
                          value={edu.institution}
                          onChange={(v) => onUpdateEducation(edu.id, "institution", v)}
                          placeholder="Institution"
                          className="text-xs block"
                          style={{ color: style.secondaryColor }}
                        />
                        <EditableField
                          value={edu.graduationYear}
                          onChange={(v) => onUpdateEducation(edu.id, "graduationYear", v)}
                          placeholder="Year"
                          className="text-xs block"
                          style={{ color: style.accentColor }}
                        />
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={onAddEducation}
                    className="mt-3 flex items-center gap-1 text-xs opacity-0 group-hover/section:opacity-100 transition-opacity"
                    style={{ color: style.accentColor }}
                  >
                    <Plus className="h-3 w-3" />
                    Add education
                  </button>
                </section>

                {/* Skills */}
                <section style={{ marginBottom: style.sectionSpacing }}>
                  <h2 style={sectionTitleStyle}>Skills</h2>
                  <EditableSkills
                    skills={data.skills}
                    onChange={onUpdateSkills}
                    variant="tags"
                    accentColor={style.accentColor}
                  />
                </section>

                {/* Contact in Sidebar */}
                <section>
                  <h2 style={sectionTitleStyle}>Contact</h2>
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Linkedin className="h-4 w-4" style={{ color: style.accentColor }} />
                      <EditableField
                        value={data.personalInfo.linkedin || ""}
                        onChange={(v) => onUpdatePersonalInfo("linkedin", v)}
                        placeholder="linkedin.com/in/you"
                        className="text-sm"
                        style={{ color: style.secondaryColor }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4" style={{ color: style.accentColor }} />
                      <EditableField
                        value={data.personalInfo.website || ""}
                        onChange={(v) => onUpdatePersonalInfo("website", v)}
                        placeholder="yourwebsite.com"
                        className="text-sm"
                        style={{ color: style.secondaryColor }}
                      />
                    </div>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  // Single Column Layout (Classic, Modern, Minimal, Professional)
  return (
    <>
      <FloatingToolbar />
      <div className="min-h-full bg-neutral-200 dark:bg-neutral-800 py-8 px-4">
        <div
          className={cn(
            "mx-auto bg-white dark:bg-zinc-900 shadow-xl",
            style.roundedCorners && "rounded-lg",
            style.shadowEffects && "shadow-2xl"
          )}
          style={{
            width: "8.5in",
            minHeight: "11in",
            ...pageStyle,
          }}
        >
          {/* Header - Personal Info */}
          <header
            className={cn(
              "pb-4 mb-4",
              style.sectionStyle === "underline" && "border-b",
            )}
            style={{
              borderColor: style.sectionBorderColor,
              ...headerBgStyle,
              ...(style.headerBg !== "transparent" && { 
                margin: `-${templateSettings.marginY}in -${templateSettings.marginX}in ${templateSettings.marginY}in`,
                padding: `${templateSettings.marginY}in ${templateSettings.marginX}in`,
              }),
            }}
          >
            <EditableField
              value={data.personalInfo.fullName}
              onChange={(v) => onUpdatePersonalInfo("fullName", v)}
              placeholder="Your Full Name"
              as="h1"
              className={cn(
                "font-bold block",
                style.headerAlignment === "center" && "text-center",
                style.headerAlignment === "left" && "text-left",
                style.headerAlignment === "right" && "text-right",
                style.headerBg.includes("gradient") && "text-white"
              )}
              style={{ 
                fontFamily: style.headerFont, 
                fontSize: style.nameSize,
                color: style.headerBg.includes("gradient") ? "white" : style.primaryColor,
              }}
            />

            <div 
              className={cn(
                "mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm",
                style.headerAlignment === "center" && "justify-center",
                style.headerAlignment === "left" && "justify-start",
                style.headerAlignment === "right" && "justify-end",
              )}
              style={{ color: style.headerBg.includes("gradient") ? "rgba(255,255,255,0.9)" : style.secondaryColor }}
            >
              {style.showIcons ? (
                <>
                  <span className="flex items-center gap-1">
                    <Mail className="h-3.5 w-3.5 shrink-0" />
                    <EditableField
                      value={data.personalInfo.email}
                      onChange={(v) => onUpdatePersonalInfo("email", v)}
                      placeholder="email@example.com"
                      className="text-sm"
                    />
                  </span>
                  <span className="flex items-center gap-1">
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    <EditableField
                      value={data.personalInfo.phone}
                      onChange={(v) => onUpdatePersonalInfo("phone", v)}
                      placeholder="+1 (555) 000-0000"
                      className="text-sm"
                    />
                  </span>
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3.5 w-3.5 shrink-0" />
                    <EditableField
                      value={data.personalInfo.location}
                      onChange={(v) => onUpdatePersonalInfo("location", v)}
                      placeholder="City, State"
                      className="text-sm"
                    />
                  </span>
                  <span className="flex items-center gap-1">
                    <Linkedin className="h-3.5 w-3.5 shrink-0" />
                    <EditableField
                      value={data.personalInfo.linkedin || ""}
                      onChange={(v) => onUpdatePersonalInfo("linkedin", v)}
                      placeholder="linkedin.com/in/you"
                      className="text-sm"
                    />
                  </span>
                  <span className="flex items-center gap-1">
                    <Globe className="h-3.5 w-3.5 shrink-0" />
                    <EditableField
                      value={data.personalInfo.website || ""}
                      onChange={(v) => onUpdatePersonalInfo("website", v)}
                      placeholder="yourwebsite.com"
                      className="text-sm"
                    />
                  </span>
                </>
              ) : (
                // Minimal style - no icons, pipe separated
                <div className="flex flex-wrap gap-x-2">
                  <EditableField
                    value={data.personalInfo.email}
                    onChange={(v) => onUpdatePersonalInfo("email", v)}
                    placeholder="email@example.com"
                    className="text-sm"
                  />
                  <span>|</span>
                  <EditableField
                    value={data.personalInfo.phone}
                    onChange={(v) => onUpdatePersonalInfo("phone", v)}
                    placeholder="+1 (555) 000-0000"
                    className="text-sm"
                  />
                  <span>|</span>
                  <EditableField
                    value={data.personalInfo.location}
                    onChange={(v) => onUpdatePersonalInfo("location", v)}
                    placeholder="City, State"
                    className="text-sm"
                  />
                </div>
              )}
            </div>
          </header>

          {/* Professional Summary */}
          <section style={{ marginBottom: style.sectionSpacing }}>
            <h2 style={sectionTitleStyle}>
              Professional Summary
            </h2>
            <EditableField
              value={data.summary}
              onChange={onUpdateSummary}
              placeholder="Write a compelling 2-3 sentence summary of your professional background and key strengths..."
              as="p"
              className="text-sm leading-relaxed block"
              style={{ color: style.primaryColor }}
            />
          </section>

          {/* Work Experience */}
          <section className="group/section" style={{ marginBottom: style.sectionSpacing }}>
            <h2 style={sectionTitleStyle}>
              Work Experience
            </h2>

            <div style={{ display: "flex", flexDirection: "column", gap: style.itemSpacing }}>
              {data.experience.map((exp) => (
                <div key={exp.id} className="group/item relative">
                  <button
                    onClick={() => onRemoveExperience(exp.id)}
                    className="absolute -left-6 top-0 opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                    title="Remove experience"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>

                  <div className="flex items-baseline justify-between gap-4">
                    <div className="flex-1">
                      <EditableField
                        value={exp.title}
                        onChange={(v) => onUpdateExperience(exp.id, "title", v)}
                        placeholder="Job Title"
                        className="font-semibold"
                        style={{ color: style.primaryColor }}
                      />
                      <span style={{ color: style.secondaryColor }}> at </span>
                      <EditableField
                        value={exp.company}
                        onChange={(v) => onUpdateExperience(exp.id, "company", v)}
                        placeholder="Company Name"
                        style={{ color: style.accentColor }}
                      />
                    </div>
                    <div className="flex items-center gap-1 text-sm shrink-0" style={{ color: style.secondaryColor }}>
                      <EditableField
                        value={exp.startDate}
                        onChange={(v) => onUpdateExperience(exp.id, "startDate", v)}
                        placeholder="Start"
                        className="text-right"
                      />
                      <span>–</span>
                      <EditableField
                        value={exp.endDate}
                        onChange={(v) => onUpdateExperience(exp.id, "endDate", v)}
                        placeholder="End"
                      />
                    </div>
                  </div>

                  <EditableBulletList
                    bullets={exp.bullets}
                    onChange={(bullets) => onUpdateExperience(exp.id, "bullets", bullets)}
                    className="mt-2"
                    bulletChar={bulletChar}
                  />
                </div>
              ))}
            </div>

            <button
              onClick={onAddExperience}
              className="mt-3 flex items-center gap-1 text-xs opacity-0 group-hover/section:opacity-100 transition-opacity"
              style={{ color: style.accentColor }}
            >
              <Plus className="h-3 w-3" />
              Add experience
            </button>
          </section>

          {/* Education */}
          <section className="group/section" style={{ marginBottom: style.sectionSpacing }}>
            <h2 style={sectionTitleStyle}>
              Education
            </h2>

            <div style={{ display: "flex", flexDirection: "column", gap: style.itemSpacing }}>
              {data.education.map((edu) => (
                <div key={edu.id} className="group/item relative">
                  <button
                    onClick={() => onRemoveEducation(edu.id)}
                    className="absolute -left-6 top-0 opacity-0 group-hover/item:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                    title="Remove education"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>

                  <div className="flex items-baseline justify-between gap-4">
                    <div className="flex-1">
                      <EditableField
                        value={edu.degree}
                        onChange={(v) => onUpdateEducation(edu.id, "degree", v)}
                        placeholder="Degree"
                        className="font-semibold"
                        style={{ color: style.primaryColor }}
                      />
                      <span style={{ color: style.secondaryColor }}> in </span>
                      <EditableField
                        value={edu.field}
                        onChange={(v) => onUpdateEducation(edu.id, "field", v)}
                        placeholder="Field of Study"
                        style={{ color: style.secondaryColor }}
                      />
                    </div>
                    <EditableField
                      value={edu.graduationYear}
                      onChange={(v) => onUpdateEducation(edu.id, "graduationYear", v)}
                      placeholder="Year"
                      className="text-sm shrink-0"
                      style={{ color: style.secondaryColor }}
                    />
                  </div>
                  <EditableField
                    value={edu.institution}
                    onChange={(v) => onUpdateEducation(edu.id, "institution", v)}
                    placeholder="Institution Name"
                    className="text-sm block"
                    style={{ color: style.secondaryColor }}
                  />
                </div>
              ))}
            </div>

            <button
              onClick={onAddEducation}
              className="mt-3 flex items-center gap-1 text-xs opacity-0 group-hover/section:opacity-100 transition-opacity"
              style={{ color: style.accentColor }}
            >
              <Plus className="h-3 w-3" />
              Add education
            </button>
          </section>

          {/* Skills */}
          <section>
            <h2 style={sectionTitleStyle}>
              Skills
            </h2>
            <EditableSkills
              skills={data.skills}
              onChange={onUpdateSkills}
              variant={templateCategory === "creative" || templateCategory === "modern" ? "tags" : "inline"}
              accentColor={style.accentColor}
            />
          </section>
        </div>
      </div>
    </>
  );
}
