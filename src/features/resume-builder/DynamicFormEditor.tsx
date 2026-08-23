// Dynamic Form Editor - Renders form fields based on template section definitions
// Supports all section types: header, text, list, entries (repeatable)

import { Plus, Trash2, GripVertical, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SectionDefinition,
  FieldDefinition,
  DynamicSectionData,
} from "@/types/resume";
import { UseDynamicResumeDataReturn } from "@/hooks/useDynamicResumeData";

// ==================== TYPES ====================

interface DynamicFormEditorProps {
  sections: SectionDefinition[];
  resumeData: UseDynamicResumeDataReturn;
  openSections: Record<string, boolean>;
  onToggleSection: (sectionId: string) => void;
}

// ==================== FIELD RENDERERS ====================

interface FieldProps {
  field: FieldDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}

function DynamicField({ field, value, onChange }: FieldProps) {
  const stringValue = typeof value === "string" ? value : "";
  const arrayValue = Array.isArray(value) ? value : [];

  switch (field.type) {
    case "textarea":
      return (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {field.label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </label>
          <Textarea
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}...`}
            className="min-h-[100px] resize-none"
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    case "list":
      // For list fields, we show a textarea where each line is an item
      return (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {field.label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </label>
          <Textarea
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}, one per line...`}
            className="min-h-[80px] resize-none"
            value={arrayValue.join("\n")}
            onChange={(e) =>
              onChange(e.target.value.split("\n").filter((line) => line.trim()))
            }
          />
          <p className="text-xs text-muted-foreground">
            Enter each item on a new line
          </p>
        </div>
      );

    case "email":
      return (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {field.label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </label>
          <Input
            type="email"
            placeholder={field.placeholder || "email@example.com"}
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    case "phone":
      return (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {field.label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </label>
          <Input
            type="tel"
            placeholder={field.placeholder || "+1 (555) 000-0000"}
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    case "url":
      return (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {field.label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </label>
          <Input
            type="url"
            placeholder={field.placeholder || "https://..."}
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    case "date":
      return (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {field.label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </label>
          <Input
            placeholder={field.placeholder || "Jan 2024"}
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );

    case "text":
    default:
      return (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground">
            {field.label}
            {field.required && <span className="text-destructive ml-1">*</span>}
          </label>
          <Input
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}...`}
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
  }
}

// ==================== SECTION RENDERERS ====================

interface SectionWrapperProps {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function SectionWrapper({ title, isOpen, onToggle, children }: SectionWrapperProps) {
  return (
    <Card className="overflow-hidden border border-border">
      <Collapsible open={isOpen} onOpenChange={onToggle}>
        <CollapsibleTrigger asChild>
          <button className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-secondary/50">
            <div className="flex items-center gap-3">
              <GripVertical className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-foreground">{title}</span>
            </div>
            {isOpen ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border px-5 py-4">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

// Header Section (Personal Info)
function HeaderSection({
  section,
  sectionData,
  resumeData,
}: {
  section: SectionDefinition;
  sectionData: DynamicSectionData;
  resumeData: UseDynamicResumeDataReturn;
}) {
  // Header uses first entry (only one allowed)
  const entry = sectionData.entries?.[0] || {};

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {section.fields.map((field) => (
        <DynamicField
          key={field.name}
          field={field}
          value={entry[field.name] || ""}
          onChange={(value) => {
            if (sectionData.entries?.[0]?.id) {
              resumeData.updateEntryField(section.id, sectionData.entries[0].id, field.name, value);
            } else {
              // Create the header entry if it doesn't exist
              resumeData.addEntry(section.id, section);
            }
          }}
        />
      ))}
    </div>
  );
}

// Text Section (Summary, Objective)
function TextSection({
  section,
  sectionData,
  resumeData,
}: {
  section: SectionDefinition;
  sectionData: DynamicSectionData;
  resumeData: UseDynamicResumeDataReturn;
}) {
  const field = section.fields[0];
  if (!field) return null;

  return (
    <div className="space-y-2">
      <Textarea
        placeholder={field.placeholder || `Write your ${section.name.toLowerCase()}...`}
        className="min-h-[120px] resize-none"
        value={typeof sectionData.value === "string" ? sectionData.value : ""}
        onChange={(e) => resumeData.updateSectionValue(section.id, e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        Keep it concise - 2-3 sentences highlighting your value proposition.
      </p>
    </div>
  );
}

// List Section (Skills, Languages)
function ListSection({
  section,
  sectionData,
  resumeData,
}: {
  section: SectionDefinition;
  sectionData: DynamicSectionData;
  resumeData: UseDynamicResumeDataReturn;
}) {
  const value = Array.isArray(sectionData.value) ? sectionData.value : [];

  return (
    <div className="space-y-4">
      <Textarea
        placeholder={`Enter your ${section.name.toLowerCase()}, separated by commas (e.g., JavaScript, React, Project Management)`}
        className="min-h-[80px] resize-none"
        value={value.join(", ")}
        onChange={(e) =>
          resumeData.updateSectionValue(
            section.id,
            e.target.value.split(",").map((s) => s.trim()).filter(Boolean)
          )
        }
      />
      <p className="text-xs text-muted-foreground">
        Separate items with commas. Include both technical and soft skills.
      </p>
    </div>
  );
}

// Entries Section (Experience, Education, Projects)
function EntriesSection({
  section,
  sectionData,
  resumeData,
}: {
  section: SectionDefinition;
  sectionData: DynamicSectionData;
  resumeData: UseDynamicResumeDataReturn;
}) {
  const entries = sectionData.entries || [];
  const fields = section.entryFields || section.fields;

  return (
    <div className="space-y-4">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="rounded-lg border border-border bg-secondary/30 p-4"
        >
          <div className="mb-4 flex items-start justify-between">
            <div className="flex-1 space-y-3">
              {fields.map((field) => (
                <DynamicField
                  key={field.name}
                  field={field}
                  value={entry[field.name] || (field.type === "list" ? [] : "")}
                  onChange={(value) =>
                    resumeData.updateEntryField(section.id, entry.id, field.name, value)
                  }
                />
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="ml-2 shrink-0"
              onClick={() => resumeData.removeEntry(section.id, entry.id)}
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </div>
      ))}

      <Button
        variant="outline"
        className="w-full"
        onClick={() => resumeData.addEntry(section.id, section)}
      >
        <Plus className="mr-2 h-4 w-4" />
        Add {section.name.replace(/s$/, "")}
      </Button>
    </div>
  );
}

// ==================== MAIN COMPONENT ====================

export function DynamicFormEditor({
  sections,
  resumeData,
  openSections,
  onToggleSection,
}: DynamicFormEditorProps) {
  // Sort sections by order
  const sortedSections = [...sections].sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-3">
      {sortedSections.map((section) => {
        const sectionData = resumeData.getSection(section.id);
        const isOpen = openSections[section.id] ?? true;

        return (
          <SectionWrapper
            key={section.id}
            title={section.name}
            isOpen={isOpen}
            onToggle={() => onToggleSection(section.id)}
          >
            {section.type === "header" && (
              <HeaderSection
                section={section}
                sectionData={sectionData}
                resumeData={resumeData}
              />
            )}
            {section.type === "text" && (
              <TextSection
                section={section}
                sectionData={sectionData}
                resumeData={resumeData}
              />
            )}
            {section.type === "list" && (
              <ListSection
                section={section}
                sectionData={sectionData}
                resumeData={resumeData}
              />
            )}
            {(section.type === "entries" || section.isRepeatable) && (
              <EntriesSection
                section={section}
                sectionData={sectionData}
                resumeData={resumeData}
              />
            )}
            {section.type === "custom" && !section.isRepeatable && (
              <TextSection
                section={section}
                sectionData={sectionData}
                resumeData={resumeData}
              />
            )}
          </SectionWrapper>
        );
      })}
    </div>
  );
}

export default DynamicFormEditor;
