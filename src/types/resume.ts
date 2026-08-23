// Resume data types for Clearance

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

export interface CustomSection {
  id: string;
  title: string;
  content: string;
  type: 'text' | 'list' | 'entries';
  entries?: CustomEntry[];
}

export interface CustomEntry {
  id: string;
  title: string;
  subtitle?: string;
  date?: string;
  description?: string;
  bullets?: string[];
}

// Page configuration for multi-page resumes
export interface ResumePage {
  id: string;
  pageNumber: number;
  // Section IDs assigned to this page (optional - if not set, sections flow automatically)
  sectionIds?: string[];
  // Custom content for blank pages
  customContent?: CustomSection[];
}

export interface ResumeData {
  personalInfo: PersonalInfo;
  summary: string;
  experience: ExperienceItem[];
  education: EducationItem[];
  skills: string[];
  customSections?: CustomSection[];
  // Multi-page support
  pages?: ResumePage[];
  // Whether to use automatic page breaks (default) or manual page assignment
  useManualPages?: boolean;
}

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
  lastATSScore?: number | null;
  variants?: ResumeVariant[];
}

export interface ResumeVariant {
  id: string;
  resumeId: string;
  name: string;
  targetJob?: string;
  createdAt: string;
}

// ==================== DYNAMIC TEMPLATE TYPES ====================
// These types support the dynamic template system where different templates
// can have different sections

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

// Dynamic resume data - flexible structure based on template
export interface DynamicSectionData {
  // For single-value sections (summary, skills as comma-separated)
  value?: string | string[];
  // For repeatable sections (experience, education, projects)
  entries?: Array<Record<string, unknown> & { id: string }>;
}

export interface DynamicResumeData {
  templateId: string;
  sections: Record<string, DynamicSectionData>;
  // Original values from template for text find-replace (key: field name, value: original text)
  originalValues?: Record<string, string>;
}

// Helper to convert old ResumeData to DynamicResumeData
export function convertToDynamicData(data: ResumeData, templateId: string = 'classic'): DynamicResumeData {
  return {
    templateId,
    sections: {
      header: {
        value: undefined,
        entries: [{
          id: 'header-1',
          fullName: data.personalInfo.fullName,
          email: data.personalInfo.email,
          phone: data.personalInfo.phone,
          location: data.personalInfo.location,
          linkedin: data.personalInfo.linkedin || '',
          website: data.personalInfo.website || '',
        }]
      },
      summary: {
        value: data.summary
      },
      experience: {
        entries: data.experience.map(exp => ({
          id: exp.id,
          title: exp.title,
          company: exp.company,
          startDate: exp.startDate,
          endDate: exp.endDate,
          bullets: exp.bullets,
        }))
      },
      education: {
        entries: data.education.map(edu => ({
          id: edu.id,
          degree: edu.degree,
          institution: edu.institution,
          field: edu.field,
          graduationYear: edu.graduationYear,
        }))
      },
      skills: {
        value: data.skills
      }
    }
  };
}

// Helper to create empty dynamic data for a template
export function createEmptyDynamicData(template: TemplateInfo): DynamicResumeData {
  const sections: Record<string, DynamicSectionData> = {};
  
  for (const section of template.sections) {
    if (section.isRepeatable) {
      sections[section.id] = { entries: [] };
    } else if (section.type === 'list') {
      sections[section.id] = { value: [] };
    } else {
      sections[section.id] = { value: '' };
    }
  }
  
  return {
    templateId: template.id,
    sections
  };
}

// Helper to create dynamic data with sample content for a template
// Uses actual content extracted from the template if available, otherwise falls back to defaults
export function createSampleDynamicData(template: TemplateInfo): DynamicResumeData {
  const sections: Record<string, DynamicSectionData> = {};
  const originalValues: Record<string, string> = {};
  const sampleSections = template.sampleContent?.sections || {};
  
  const headerSection = sampleSections['header'];
  const headerEntry = headerSection?.entries?.[0] || {};
  const headerContent = headerSection?.content || [];
  
  const isValidName = (name: string): boolean => {
    if (!name || name.trim().length === 0) return false;
    if (name.includes('@') || name.includes('http') || name.includes('www.')) return false;
    if (/linkedin|\.com|\.org|\.io/i.test(name)) return false;
    if (/^\d{3}[-.\s]?\d{3}/.test(name)) return false;
    if (name.length < 2 || name.length > 100) return false;
    return true;
  };
  
  const getTemplateValue = (templateValue: string | undefined, fallback: string): string => {
    if (templateValue && templateValue.trim().length > 0) {
      return templateValue.trim();
    }
    return fallback;
  };
  
  const parseHeaderForField = (field: 'email' | 'phone' | 'location' | 'linkedin' | 'website'): string => {
    if (headerEntry[field]) return String(headerEntry[field]);
    
    for (const line of headerContent) {
      if (field === 'email' && line.includes('@')) return line;
      if (field === 'phone' && /\d{3}[-.)\\s]?\d{3}[-.)\\s]?\d{4}/.test(line)) return line;
      if (field === 'location' && /^[A-Za-z\s]+,\s*[A-Z]{2}/.test(line)) return line;
      if (field === 'linkedin' && /linkedin/i.test(line)) return line;
      if (field === 'website' && /https?:|www\.|\.(com|org|io|net)/i.test(line) && !/linkedin/i.test(line)) return line;
    }
    return '';
  };
  
  for (const section of template.sections) {
    const sectionId = section.id.toLowerCase();
    
    // Match section by ID to provide appropriate sample data
    if (sectionId === 'header' || sectionId.includes('personal') || sectionId.includes('contact')) {
      // Prefer headerContent[0] (first line, clean name) over headerEntry['fullName'] (may have location appended)
      const candidateName = headerContent[0] || headerEntry['fullName'] as string || '';
      const templateName = isValidName(candidateName) ? candidateName : (headerEntry['fullName'] as string || '');
      const hasValidName = isValidName(templateName);
      const fullName = hasValidName ? templateName.trim() : defaultResumeData.personalInfo.fullName;
      const email = getTemplateValue(parseHeaderForField('email'), defaultResumeData.personalInfo.email);
      const phone = getTemplateValue(parseHeaderForField('phone'), defaultResumeData.personalInfo.phone);
      const location = getTemplateValue(parseHeaderForField('location'), defaultResumeData.personalInfo.location);
      const linkedin = parseHeaderForField('linkedin') || defaultResumeData.personalInfo.linkedin || '';
      const website = parseHeaderForField('website') || defaultResumeData.personalInfo.website || '';
      
      if (hasValidName) originalValues['fullName'] = templateName.trim();
      if (headerEntry['email']) originalValues['email'] = String(headerEntry['email']);
      if (headerEntry['phone']) originalValues['phone'] = String(headerEntry['phone']);
      if (headerEntry['location']) originalValues['location'] = String(headerEntry['location']);
      
      sections[section.id] = {
        entries: [{
          id: `${section.id}-1`,
          fullName,
          name: fullName,
          email,
          phone,
          location,
          address: location,
          linkedin,
          website,
        }]
      };
    } else if (sectionId === 'summary' || sectionId.includes('objective') || sectionId.includes('profile')) {
      const summarySection = sampleSections['summary'] || sampleSections['profile'] || sampleSections['professional_summary'];
      const templateSummary = summarySection?.content?.join(' ') || '';
      const summaryContent = getTemplateValue(templateSummary, defaultResumeData.summary);
      
      if (templateSummary.trim()) originalValues['summary'] = templateSummary.trim();
      sections[section.id] = { value: summaryContent };
    } else if (sectionId === 'experience' || sectionId.includes('work') || sectionId.includes('employment')) {
      const expSection = sampleSections['experience'] || sampleSections['work_experience'] || sampleSections['professional_experience'];
      if (expSection?.entries && expSection.entries.length > 0) {
        sections[section.id] = {
          entries: expSection.entries.map((exp, idx) => {
            const entry = {
              id: `exp-${idx + 1}`,
              title: exp['title'] || exp['position'] || '',
              position: exp['title'] || exp['position'] || '',
              jobTitle: exp['title'] || '',
              company: exp['company'] || exp['organization'] || '',
              employer: exp['company'] || '',
              organization: exp['company'] || '',
              location: exp['location'] || '',
              startDate: exp['startDate'] || exp['dateRange'] || '',
              endDate: exp['endDate'] || '',
              description: exp['description'] || '',
              bullets: [] as string[],
              responsibilities: [] as string[],
            };
            // Store original experience values
            if (entry.title) originalValues[`exp_${idx}_title`] = entry.title;
            if (entry.company) originalValues[`exp_${idx}_company`] = entry.company;
            return entry;
          })
        };
      } else {
        sections[section.id] = {
          entries: defaultResumeData.experience.map(exp => ({
            id: exp.id,
            title: exp.title,
            position: exp.title,
            jobTitle: exp.title,
            company: exp.company,
            employer: exp.company,
            organization: exp.company,
            startDate: exp.startDate,
            start: exp.startDate,
            endDate: exp.endDate,
            end: exp.endDate,
            description: exp.description,
            bullets: exp.bullets,
            responsibilities: exp.bullets,
          }))
        };
      }
    } else if (sectionId === 'education' || sectionId.includes('academic')) {
      const eduSection = sampleSections['education'];
      if (eduSection?.entries && eduSection.entries.length > 0) {
        sections[section.id] = {
          entries: eduSection.entries.map((edu, idx) => {
            const entry = {
              id: `edu-${idx + 1}`,
              degree: edu['degree'] || '',
              institution: edu['institution'] || '',
              university: edu['institution'] || '',
              school: edu['institution'] || '',
              field: edu['field'] || '',
              major: edu['field'] || '',
              location: edu['location'] || '',
              graduationYear: edu['graduationYear'] || edu['graduationDate'] || '',
              year: edu['graduationYear'] || '',
              graduation: edu['graduationYear'] || '',
            };
            // Store original education values
            if (entry.institution) originalValues[`edu_${idx}_institution`] = entry.institution;
            if (entry.degree) originalValues[`edu_${idx}_degree`] = entry.degree;
            return entry;
          })
        };
      } else {
        sections[section.id] = {
          entries: defaultResumeData.education.map(edu => ({
            id: edu.id,
            degree: edu.degree,
            institution: edu.institution,
            university: edu.institution,
            school: edu.institution,
            field: edu.field,
            major: edu.field,
            graduationYear: edu.graduationYear,
            year: edu.graduationYear,
            graduation: edu.graduationYear,
          }))
        };
      }
    } else if (sectionId === 'skills' || sectionId.includes('skill') || sectionId.includes('competenc')) {
      const skillsSection = sampleSections['skills'] || sampleSections['technical_skills'] || sampleSections['core_competencies'];
      const skillsContent = skillsSection?.content || [];
      
      if (skillsContent.length > 0) {
        const templateSkills = skillsContent.flatMap(s => s.split(/,\s*/));
        originalValues['skills'] = skillsContent.join(', ');
        sections[section.id] = { value: templateSkills };
      } else {
        sections[section.id] = { value: defaultResumeData.skills };
      }
    } else if (section.isRepeatable) {
      sections[section.id] = { entries: [] };
    } else if (section.type === 'list') {
      sections[section.id] = { value: [] };
    } else {
      sections[section.id] = { value: '' };
    }
  }
  
  return {
    templateId: template.id,
    sections,
    originalValues
  };
}

// ==================== DEFAULT DATA ====================

export const defaultResumeData: ResumeData = {
  personalInfo: {
    fullName: "John Smith",
    email: "john@example.com",
    phone: "+1 (555) 000-0000",
    location: "San Francisco, CA",
    linkedin: "linkedin.com/in/johnsmith",
    website: "johnsmith.com",
  },
  summary:
    "Results-driven software engineer with 8+ years of experience building scalable web applications. Passionate about clean code, user experience, and mentoring junior developers. Led teams of 5-10 engineers at high-growth startups.",
  experience: [
    {
      id: "exp-1",
      title: "Senior Software Engineer",
      company: "TechCorp Inc.",
      startDate: "Jan 2021",
      endDate: "Present",
      description: "",
      bullets: [
        "Led development of customer-facing dashboard, increasing user engagement by 40%",
        "Architected microservices infrastructure handling 1M+ daily requests",
        "Mentored 5 junior engineers, establishing code review best practices",
      ],
    },
    {
      id: "exp-2",
      title: "Software Engineer",
      company: "StartupXYZ",
      startDate: "Mar 2018",
      endDate: "Dec 2020",
      description: "",
      bullets: [
        "Built real-time collaboration features using WebSocket technology",
        "Reduced page load time by 60% through performance optimisation",
      ],
    },
  ],
  education: [
    {
      id: "edu-1",
      degree: "Bachelor of Science in Computer Science",
      institution: "University of California, Berkeley",
      field: "Computer Science",
      graduationYear: "2018",
    },
  ],
  skills: [
    "JavaScript",
    "TypeScript",
    "React",
    "Node.js",
    "Python",
    "PostgreSQL",
    "AWS",
    "Docker",
    "CI/CD",
    "Agile",
  ],
};

// Default dynamic resume data (for new users)
export const defaultDynamicResumeData: DynamicResumeData = convertToDynamicData(defaultResumeData);

// Helper to convert DynamicResumeData back to legacy ResumeData (for preview sync)
export function convertToLegacyData(data: DynamicResumeData): ResumeData {
  const sections = data.sections;
  
  // Extract personal info from header section
  const headerEntry = (sections.header?.entries?.[0] || {}) as Record<string, unknown>;
  const personalInfo: PersonalInfo = {
    fullName: String(headerEntry['fullName'] || headerEntry['name'] || ''),
    email: String(headerEntry['email'] || ''),
    phone: String(headerEntry['phone'] || ''),
    location: String(headerEntry['location'] || headerEntry['address'] || ''),
    linkedin: String(headerEntry['linkedin'] || ''),
    website: String(headerEntry['website'] || headerEntry['portfolio'] || ''),
  };
  
  // Extract summary
  const summary = typeof sections.summary?.value === 'string' 
    ? sections.summary.value 
    : '';
  
  // Extract experience entries
  const experience: ExperienceItem[] = (sections.experience?.entries || []).map((entry, idx) => {
    const e = entry as Record<string, unknown>;
    return {
      id: entry.id || `exp-${idx}`,
      title: String(e['title'] || e['position'] || e['jobTitle'] || ''),
      company: String(e['company'] || e['employer'] || e['organization'] || ''),
      startDate: String(e['startDate'] || e['start'] || ''),
      endDate: String(e['endDate'] || e['end'] || 'Present'),
      description: String(e['description'] || ''),
      bullets: Array.isArray(e['bullets']) 
        ? (e['bullets'] as unknown[]).map(b => String(b))
        : Array.isArray(e['responsibilities'])
          ? (e['responsibilities'] as unknown[]).map(r => String(r))
          : [],
    };
  });
  
  // Extract education entries
  const education: EducationItem[] = (sections.education?.entries || []).map((entry, idx) => {
    const e = entry as Record<string, unknown>;
    return {
      id: entry.id || `edu-${idx}`,
      degree: String(e['degree'] || ''),
      institution: String(e['institution'] || e['university'] || e['school'] || ''),
      field: String(e['field'] || e['major'] || ''),
      graduationYear: String(e['graduationYear'] || e['year'] || e['graduation'] || ''),
    };
  });
  
  // Extract skills
  let skills: string[] = [];
  if (sections.skills?.value) {
    if (Array.isArray(sections.skills.value)) {
      skills = sections.skills.value.map(s => String(s));
    } else if (typeof sections.skills.value === 'string') {
      skills = sections.skills.value.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  
  return {
    personalInfo,
    summary,
    experience,
    education,
    skills,
  };
}
