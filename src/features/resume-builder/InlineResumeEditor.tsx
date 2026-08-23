import { useMemo } from "react";
import { Mail, Phone, MapPin, Linkedin, Globe } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TemplateInfo, SectionDefinition } from "@/types/resume";
import { UseDynamicResumeDataReturn } from "@/hooks/useDynamicResumeData";
import { InlineSection } from "./components/InlineSection";
import {
  InlineEditable,
  InlineExperienceEntry,
  InlineEducationEntry,
} from "./components/InlineEntry";
import { InlineSkills } from "./components/SkillsPopover";
import "./InlineResumeEditor.css";

interface InlineResumeEditorProps {
  template: TemplateInfo;
  resumeData: UseDynamicResumeDataReturn;
}

export function InlineResumeEditor({
  template,
  resumeData,
}: InlineResumeEditorProps) {
  const sortedSections = useMemo(
    () => [...template.sections].sort((a, b) => a.order - b.order),
    [template.sections]
  );

  const renderSection = (section: SectionDefinition) => {
    const sectionData = resumeData.getSection(section.id);
    const sectionId = section.id.toLowerCase();

    if (sectionId === "header" || sectionId.includes("personal") || sectionId.includes("contact")) {
      return renderHeaderSection(section, sectionData);
    }

    if (sectionId === "summary" || sectionId.includes("objective") || sectionId.includes("profile")) {
      return renderTextSection(section, sectionData);
    }

    if (sectionId === "skills" || sectionId.includes("skill") || sectionId.includes("competenc")) {
      return renderSkillsSection(section, sectionData);
    }

    if (sectionId === "experience" || sectionId.includes("work") || sectionId.includes("employment")) {
      return renderExperienceSection(section, sectionData);
    }

    if (sectionId === "education" || sectionId.includes("academic")) {
      return renderEducationSection(section, sectionData);
    }

    if (section.isRepeatable || section.type === "entries") {
      return renderEntriesSection(section, sectionData);
    }

    return renderTextSection(section, sectionData);
  };

  const renderHeaderSection = (
    section: SectionDefinition,
    sectionData: ReturnType<typeof resumeData.getSection>
  ) => {
    const entry = (sectionData.entries?.[0] || {}) as Record<string, unknown>;
    const entryId = entry.id as string | undefined;

    const updateField = (field: string, value: string) => {
      if (entryId) {
        resumeData.updateEntryField(section.id, entryId, field, value);
      }
    };

    return (
      <div className="inline-header" key={section.id}>
        <div className="inline-header__name">
          <InlineEditable
            value={String(entry["fullName"] || entry["name"] || "")}
            onChange={(v) => updateField("fullName", v)}
            placeholder="Your Name"
          />
        </div>
        <div className="inline-header__contact">
          <span className="inline-header__contact-item">
            <Mail className="h-3.5 w-3.5" />
            <InlineEditable
              value={String(entry["email"] || "")}
              onChange={(v) => updateField("email", v)}
              placeholder="email@example.com"
            />
          </span>
          <span className="inline-header__contact-item">
            <Phone className="h-3.5 w-3.5" />
            <InlineEditable
              value={String(entry["phone"] || "")}
              onChange={(v) => updateField("phone", v)}
              placeholder="+1 (555) 000-0000"
            />
          </span>
          <span className="inline-header__contact-item">
            <MapPin className="h-3.5 w-3.5" />
            <InlineEditable
              value={String(entry["location"] || entry["address"] || "")}
              onChange={(v) => updateField("location", v)}
              placeholder="City, State"
            />
          </span>
          {entry["linkedin"] && (
            <span className="inline-header__contact-item">
              <Linkedin className="h-3.5 w-3.5" />
              <InlineEditable
                value={String(entry["linkedin"] || "")}
                onChange={(v) => updateField("linkedin", v)}
                placeholder="linkedin.com/in/you"
              />
            </span>
          )}
          {entry["website"] && (
            <span className="inline-header__contact-item">
              <Globe className="h-3.5 w-3.5" />
              <InlineEditable
                value={String(entry["website"] || "")}
                onChange={(v) => updateField("website", v)}
                placeholder="yoursite.com"
              />
            </span>
          )}
        </div>
      </div>
    );
  };

  const renderTextSection = (
    section: SectionDefinition,
    sectionData: ReturnType<typeof resumeData.getSection>
  ) => {
    const value = typeof sectionData.value === "string" ? sectionData.value : "";

    return (
      <InlineSection key={section.id} title={section.name}>
        <div className="inline-summary">
          <InlineEditable
            value={value}
            onChange={(v) => resumeData.updateSectionValue(section.id, v)}
            placeholder={`Write your ${section.name.toLowerCase()}...`}
            as="div"
          />
        </div>
      </InlineSection>
    );
  };

  const renderSkillsSection = (
    section: SectionDefinition,
    sectionData: ReturnType<typeof resumeData.getSection>
  ) => {
    const skills = Array.isArray(sectionData.value) ? sectionData.value : [];

    return (
      <InlineSection key={section.id} title={section.name}>
        <InlineSkills
          skills={skills.map(String)}
          onChange={(newSkills) =>
            resumeData.updateSectionValue(section.id, newSkills)
          }
        />
      </InlineSection>
    );
  };

  const renderExperienceSection = (
    section: SectionDefinition,
    sectionData: ReturnType<typeof resumeData.getSection>
  ) => {
    const entries = sectionData.entries || [];

    return (
      <InlineSection
        key={section.id}
        title={section.name}
        isRepeatable
        showAddButton
        addButtonLabel="Add Experience"
        onAdd={() => resumeData.addEntry(section.id, section)}
      >
        {entries.map((entry) => (
          <InlineExperienceEntry
            key={entry.id}
            entry={entry as any}
            onUpdate={(field, value) =>
              resumeData.updateEntryField(section.id, entry.id, field, value)
            }
            onDelete={() => resumeData.removeEntry(section.id, entry.id)}
          />
        ))}
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground/50 italic py-4">
            Click "Add Experience" to add your work history
          </p>
        )}
      </InlineSection>
    );
  };

  const renderEducationSection = (
    section: SectionDefinition,
    sectionData: ReturnType<typeof resumeData.getSection>
  ) => {
    const entries = sectionData.entries || [];

    return (
      <InlineSection
        key={section.id}
        title={section.name}
        isRepeatable
        showAddButton
        addButtonLabel="Add Education"
        onAdd={() => resumeData.addEntry(section.id, section)}
      >
        {entries.map((entry) => (
          <InlineEducationEntry
            key={entry.id}
            entry={entry as any}
            onUpdate={(field, value) =>
              resumeData.updateEntryField(section.id, entry.id, field, value)
            }
            onDelete={() => resumeData.removeEntry(section.id, entry.id)}
          />
        ))}
        {entries.length === 0 && (
          <p className="text-sm text-muted-foreground/50 italic py-4">
            Click "Add Education" to add your educational background
          </p>
        )}
      </InlineSection>
    );
  };

  const renderEntriesSection = (
    section: SectionDefinition,
    sectionData: ReturnType<typeof resumeData.getSection>
  ) => {
    const entries = sectionData.entries || [];

    return (
      <InlineSection
        key={section.id}
        title={section.name}
        isRepeatable
        showAddButton
        addButtonLabel={`Add ${section.name.replace(/s$/, "")}`}
        onAdd={() => resumeData.addEntry(section.id, section)}
      >
        {entries.map((entry) => (
          <InlineExperienceEntry
            key={entry.id}
            entry={entry as any}
            onUpdate={(field, value) =>
              resumeData.updateEntryField(section.id, entry.id, field, value)
            }
            onDelete={() => resumeData.removeEntry(section.id, entry.id)}
          />
        ))}
      </InlineSection>
    );
  };

  return (
    <TooltipProvider>
      <div className="inline-resume-editor">
        <div className="inline-resume-editor__content">
          {sortedSections.map((section) => renderSection(section))}
        </div>
      </div>
    </TooltipProvider>
  );
}

export default InlineResumeEditor;
