import { Plus, GripVertical, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ResumeData, ExperienceItem, EducationItem } from "@/types/resume";

interface SectionProps {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function EditorSection({ title, isOpen, onToggle, children }: SectionProps) {
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

interface ResumeEditorProps {
  data: ResumeData;
  openSections: Record<string, boolean>;
  onToggleSection: (section: string) => void;
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

export function ResumeEditor({
  data,
  openSections,
  onToggleSection,
  onUpdatePersonalInfo,
  onUpdateSummary,
  onUpdateExperience,
  onAddExperience,
  onRemoveExperience,
  onUpdateEducation,
  onAddEducation,
  onRemoveEducation,
  onUpdateSkills,
}: ResumeEditorProps) {
  return (
    <div className="space-y-3">
      {/* Personal Information */}
      <EditorSection
        title="Personal Information"
        isOpen={openSections.personal}
        onToggle={() => onToggleSection("personal")}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Full Name</label>
            <Input
              placeholder="John Smith"
              value={data.personalInfo.fullName}
              onChange={(e) => onUpdatePersonalInfo("fullName", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Email</label>
            <Input
              type="email"
              placeholder="john@example.com"
              value={data.personalInfo.email}
              onChange={(e) => onUpdatePersonalInfo("email", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Phone</label>
            <Input
              type="tel"
              placeholder="+1 (555) 000-0000"
              value={data.personalInfo.phone}
              onChange={(e) => onUpdatePersonalInfo("phone", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Location</label>
            <Input
              placeholder="San Francisco, CA"
              value={data.personalInfo.location}
              onChange={(e) => onUpdatePersonalInfo("location", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">LinkedIn</label>
            <Input
              placeholder="linkedin.com/in/johnsmith"
              value={data.personalInfo.linkedin || ""}
              onChange={(e) => onUpdatePersonalInfo("linkedin", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">Website</label>
            <Input
              placeholder="johnsmith.com"
              value={data.personalInfo.website || ""}
              onChange={(e) => onUpdatePersonalInfo("website", e.target.value)}
            />
          </div>
        </div>
      </EditorSection>

      {/* Professional Summary */}
      <EditorSection
        title="Professional Summary"
        isOpen={openSections.summary}
        onToggle={() => onToggleSection("summary")}
      >
        <div className="space-y-2">
          <Textarea
            placeholder="Write a brief summary of your professional background and key strengths..."
            className="min-h-[120px] resize-none"
            value={data.summary}
            onChange={(e) => onUpdateSummary(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Keep it concise - 2-3 sentences highlighting your value proposition.
          </p>
        </div>
      </EditorSection>

      {/* Work Experience */}
      <EditorSection
        title="Work Experience"
        isOpen={openSections.experience}
        onToggle={() => onToggleSection("experience")}
      >
        <div className="space-y-4">
          {data.experience.map((exp) => (
            <div key={exp.id} className="rounded-lg border border-border bg-secondary/30 p-4">
              <div className="mb-4 flex items-start justify-between">
                <div className="flex-1 space-y-3">
                  <Input
                    placeholder="Job Title"
                    className="font-medium"
                    value={exp.title}
                    onChange={(e) => onUpdateExperience(exp.id, "title", e.target.value)}
                  />
                  <Input
                    placeholder="Company Name"
                    value={exp.company}
                    onChange={(e) => onUpdateExperience(exp.id, "company", e.target.value)}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      placeholder="Start Date (e.g., Jan 2022)"
                      value={exp.startDate}
                      onChange={(e) => onUpdateExperience(exp.id, "startDate", e.target.value)}
                    />
                    <Input
                      placeholder="End Date (or Present)"
                      value={exp.endDate}
                      onChange={(e) => onUpdateExperience(exp.id, "endDate", e.target.value)}
                    />
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-2 shrink-0"
                  onClick={() => onRemoveExperience(exp.id)}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <Textarea
                placeholder="Describe your responsibilities and achievements (one per line for bullet points)..."
                className="min-h-[100px] resize-none"
                value={exp.bullets.join("\n")}
                onChange={(e) =>
                  onUpdateExperience(exp.id, "bullets", e.target.value.split("\n").filter(Boolean))
                }
              />
            </div>
          ))}

          <Button variant="outline" className="w-full" onClick={onAddExperience}>
            <Plus className="mr-2 h-4 w-4" />
            Add Experience
          </Button>
        </div>
      </EditorSection>

      {/* Education */}
      <EditorSection
        title="Education"
        isOpen={openSections.education}
        onToggle={() => onToggleSection("education")}
      >
        <div className="space-y-4">
          {data.education.map((edu) => (
            <div key={edu.id} className="rounded-lg border border-border bg-secondary/30 p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1 space-y-3">
                  <Input
                    placeholder="Degree (e.g., Bachelor of Science)"
                    value={edu.degree}
                    onChange={(e) => onUpdateEducation(edu.id, "degree", e.target.value)}
                  />
                  <Input
                    placeholder="Institution Name"
                    value={edu.institution}
                    onChange={(e) => onUpdateEducation(edu.id, "institution", e.target.value)}
                  />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input
                      placeholder="Field of Study"
                      value={edu.field}
                      onChange={(e) => onUpdateEducation(edu.id, "field", e.target.value)}
                    />
                    <Input
                      placeholder="Graduation Year"
                      value={edu.graduationYear}
                      onChange={(e) => onUpdateEducation(edu.id, "graduationYear", e.target.value)}
                    />
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-2 shrink-0"
                  onClick={() => onRemoveEducation(edu.id)}
                >
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          ))}

          <Button variant="outline" className="w-full" onClick={onAddEducation}>
            <Plus className="mr-2 h-4 w-4" />
            Add Education
          </Button>
        </div>
      </EditorSection>

      {/* Skills */}
      <EditorSection
        title="Skills"
        isOpen={openSections.skills}
        onToggle={() => onToggleSection("skills")}
      >
        <div className="space-y-4">
          <Textarea
            placeholder="Enter your skills, separated by commas (e.g., JavaScript, React, Project Management)"
            className="min-h-[80px] resize-none"
            value={data.skills.join(", ")}
            onChange={(e) =>
              onUpdateSkills(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))
            }
          />
          <p className="text-xs text-muted-foreground">
            Include both technical skills and soft skills relevant to your target role.
          </p>
        </div>
      </EditorSection>
    </div>
  );
}
