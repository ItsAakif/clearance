// Resume data types for Clearance.
//
// T1110 (cutover) - WHAT IS LEFT IN THIS FILE, AND WHY IT IS NOT EMPTY.
// FREEZE.md A-33 verdicts `src/types/resume.ts` "REHOME then REMOVE": the legacy editor model
// is dead, but the file was also the home of the BACKEND DTOs that several adopted surfaces
// still read, and deleting it wholesale would have broken live code. The deletion was driven by
// REACHABILITY, not by the manifest's wording, and this file is the residue that survived:
//
//   KEPT - the `Resume` row DTO and everything it is structurally made of
//          (`PersonalInfo`, `ExperienceItem`, `EducationItem`, `Skill`, `ResumeSection`,
//          `ResumeVariant`). Read by `services/api/resume.ts`, `hooks/useResumeApi.ts`,
//          `pages/Resumes.tsx`, `pages/Upload.tsx`, `pages/ATSHistory.tsx` and the ATS
//          surfaces. These describe a STORED legacy row, which is still the shape the
//          `/resumes` list endpoint returns; they are not the editor model.
//
//   KEPT - `TemplateInfo` and the definition vocabulary under it. Read by
//          `services/api/templates.ts`, which serves the `.docx` template registry
//          (FREEZE K-04: frozen, deliberately kept - `docxtemplater` stays the DOCX fallback
//          for user `.docx` templates). Deleting these would delete a live API client's types.
//
//   DELETED - the editor model and everything only the editor used: `ResumeData`, `ResumePage`,
//          `CustomSection`, `CustomEntry`, `useManualPages`, the whole `DynamicResumeData`
//          family (`DynamicSectionData`, `FieldDefinition`, `SectionDefinition`,
//          `SectionContent`, `TemplateSampleContent`, `convertToDynamicData`,
//          `createEmptyDynamicData`, `createSampleDynamicData`, `convertToLegacyData`,
//          `defaultResumeData`, `defaultDynamicResumeData`).
//
// WHY THE DYNAMIC FAMILY WENT WITH IT. Its only importers were the deleted builder tree and
// `hooks/useDynamicResumeData.ts`. `DynamicResumeData` also appeared in TWO method signatures
// on `services/api/resume.ts` (`exportDynamicDocx`, `exportDynamicPdf`) - and those two methods
// had ZERO callers anywhere in `src/`, which is how they were proved dead. They were removed
// rather than rehomed, so this file's `DynamicResumeData` really did become unreachable.
//
// WHAT THIS FILE MUST NOT BECOME. Not a place to re-add a document model. The canonical resume
// document is Resume JSON (`x-clearance` block and all), and it is typed by
// `services/api/studio.ts` on the way in and `backend/src/resume/json/` on the way out.

export interface PersonalInfo {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin?: string;
  website?: string;
}

export interface ExperienceItem {
  id: string;
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  description: string;
  bullets: string[];
}

export interface EducationItem {
  id: string;
  degree: string;
  institution: string;
  field: string;
  graduationYear: string;
}

export interface Skill {
  id: string;
  name: string;
  level?: "beginner" | "intermediate" | "advanced" | "expert";
}

export interface ResumeSection {
  id: string;
  type: "personal" | "summary" | "experience" | "education" | "skills" | "custom";
  title: string;
  order: number;
  visible: boolean;
}

/**
 * A stored legacy `Resume` row, as the list/detail endpoints return it.
 *
 * NOT the editor's model and not the V2 document: the canonical content of a V2 resume lives in
 * its `ResumeRevision` rows as Resume JSON, and the Studio reads those through
 * `services/api/studio.ts`. This type describes the `Resume` row itself, which is retained
 * read-only (FREEZE sec. 4: "Never dropped in V2").
 */
export interface Resume {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  personalInfo: PersonalInfo;
  summary: string;
  experience: ExperienceItem[];
  education: EducationItem[];
  skills: Skill[];
  sections: ResumeSection[];
  templateId?: string;
  templateSettings?: Record<string, unknown>;
  isArchived?: boolean;
  /** T1101: `lastATSScore` removed. Still written server-side, never presented. */
  variants?: ResumeVariant[];
}

export interface ResumeVariant {
  id: string;
  resumeId: string;
  name: string;
  targetJob?: string;
  createdAt: string;
}

// ==================== THE .docx TEMPLATE REGISTRY DTOs ====================
//
// Read by `services/api/templates.ts` only. FREEZE K-04 keeps that registry serving: the
// `docxtemplater` path is the DOCX fallback for a user's own `.docx`, and `TemplateInfo` is its
// wire shape. They are here because that client is live, not because V2 adopted them.

export type FieldType = 'text' | 'textarea' | 'date' | 'url' | 'email' | 'phone' | 'list';
export type SectionType = 'header' | 'text' | 'list' | 'entries' | 'custom';

export interface FieldDefinition {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
}

export interface SectionDefinition {
  id: string;
  name: string;
  type: SectionType;
  order: number;
  fields: FieldDefinition[];
  isRepeatable: boolean;
  entryFields?: FieldDefinition[];
}

export interface SectionContent {
  title: string;
  content: string[];
  entries?: Array<Record<string, string>>;
}

export interface TemplateSampleContent {
  sections: Record<string, SectionContent>;
  rawText?: string;
}

export interface TemplateInfo {
  id: string;
  name: string;
  fileName?: string;
  description?: string;
  category?: string;
  tags?: string[];
  recommended?: string[];
  isAtsOptimized?: boolean;
  sectionCount?: number;
  sections: SectionDefinition[];
  placeholders?: string[];
  sampleContent?: TemplateSampleContent;
  defaultSettings?: {
    marginX: number;
    marginY: number;
    fontSize: number;
    lineSpacing: number;
    sectionSpacing: number;
    primaryColor?: string;
    accentColor?: string;
  };
}