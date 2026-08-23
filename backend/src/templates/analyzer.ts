// Template Analyzer - Extracts sections and placeholders from .docx templates
// Scans template files and generates metadata about what sections/fields they contain

import fs from 'fs';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require('pizzip');

// ==================== TYPES ====================

export type SectionType = 
  | 'header'      // Name, contact info
  | 'text'        // Single text block (summary, objective)
  | 'list'        // Simple list (skills, languages, interests)
  | 'entries'     // Repeatable entries with sub-fields (experience, education, projects)
  | 'custom';     // Unknown/custom section

export interface FieldDefinition {
  name: string;           // Field identifier (e.g., "fullName", "email")
  label: string;          // Display label (e.g., "Full Name", "Email Address")
  type: 'text' | 'textarea' | 'date' | 'url' | 'email' | 'phone' | 'list';
  required?: boolean;
  placeholder?: string;
}

export interface SectionDefinition {
  id: string;             // Unique section ID
  name: string;           // Display name
  type: SectionType;
  order: number;          // Display order in form
  fields: FieldDefinition[];
  isRepeatable: boolean;  // Can have multiple entries (experience, education)
  entryFields?: FieldDefinition[];  // Fields for each entry if repeatable
}

export interface TemplateMetadata {
  id: string;
  name: string;
  fileName: string;
  sections: SectionDefinition[];
  placeholders: string[];  // Raw list of all placeholders found
  sampleContent?: TemplateSampleContent;  // Extracted sample content from template
  analyzedAt: string;
}

// Sample content extracted from template - generic structure for any section
export interface TemplateSampleContent {
  // All extracted sections keyed by section name (lowercase)
  sections: Record<string, SectionContent>;
  rawText?: string;  // Full raw text for reference
}

export interface SectionContent {
  // Section header/title as found in template
  title: string;
  // All text content under this section (array of lines/paragraphs)
  content: string[];
  // For repeatable sections, parsed entries
  entries?: Array<Record<string, string>>;
}

// ==================== ANALYZER ====================

// Common section patterns to detect
const SECTION_PATTERNS: Record<string, { type: SectionType; isRepeatable: boolean; fields: FieldDefinition[] }> = {
  // Header/Contact
  'fullName': { type: 'header', isRepeatable: false, fields: [{ name: 'fullName', label: 'Full Name', type: 'text', required: true }] },
  'email': { type: 'header', isRepeatable: false, fields: [{ name: 'email', label: 'Email', type: 'email', required: true }] },
  'phone': { type: 'header', isRepeatable: false, fields: [{ name: 'phone', label: 'Phone', type: 'phone' }] },
  'location': { type: 'header', isRepeatable: false, fields: [{ name: 'location', label: 'Location', type: 'text' }] },
  'linkedin': { type: 'header', isRepeatable: false, fields: [{ name: 'linkedin', label: 'LinkedIn', type: 'url' }] },
  'website': { type: 'header', isRepeatable: false, fields: [{ name: 'website', label: 'Website/Portfolio', type: 'url' }] },
  'github': { type: 'header', isRepeatable: false, fields: [{ name: 'github', label: 'GitHub', type: 'url' }] },
  
  // Text sections
  'summary': { type: 'text', isRepeatable: false, fields: [{ name: 'summary', label: 'Professional Summary', type: 'textarea' }] },
  'objective': { type: 'text', isRepeatable: false, fields: [{ name: 'objective', label: 'Career Objective', type: 'textarea' }] },
  'profile': { type: 'text', isRepeatable: false, fields: [{ name: 'profile', label: 'Profile', type: 'textarea' }] },
  
  // List sections
  'skills': { type: 'list', isRepeatable: false, fields: [{ name: 'skills', label: 'Skills', type: 'list' }] },
  'languages': { type: 'list', isRepeatable: false, fields: [{ name: 'languages', label: 'Languages', type: 'list' }] },
  'interests': { type: 'list', isRepeatable: false, fields: [{ name: 'interests', label: 'Interests', type: 'list' }] },
  'tools': { type: 'list', isRepeatable: false, fields: [{ name: 'tools', label: 'Tools & Technologies', type: 'list' }] },
  'certifications': { type: 'list', isRepeatable: false, fields: [{ name: 'certifications', label: 'Certifications', type: 'list' }] },
  
  // Repeatable entry sections (detected by loop syntax)
  'experience': { 
    type: 'entries', 
    isRepeatable: true, 
    fields: [
      { name: 'title', label: 'Job Title', type: 'text', required: true },
      { name: 'company', label: 'Company', type: 'text', required: true },
      { name: 'startDate', label: 'Start Date', type: 'text' },
      { name: 'endDate', label: 'End Date', type: 'text' },
      { name: 'location', label: 'Location', type: 'text' },
      { name: 'bullets', label: 'Achievements', type: 'list' }
    ]
  },
  'education': { 
    type: 'entries', 
    isRepeatable: true, 
    fields: [
      { name: 'degree', label: 'Degree', type: 'text', required: true },
      { name: 'field', label: 'Field of Study', type: 'text' },
      { name: 'institution', label: 'Institution', type: 'text', required: true },
      { name: 'graduationYear', label: 'Graduation Year', type: 'text' },
      { name: 'gpa', label: 'GPA', type: 'text' }
    ]
  },
  'projects': { 
    type: 'entries', 
    isRepeatable: true, 
    fields: [
      { name: 'name', label: 'Project Name', type: 'text', required: true },
      { name: 'description', label: 'Description', type: 'textarea' },
      { name: 'technologies', label: 'Technologies Used', type: 'text' },
      { name: 'link', label: 'Project Link', type: 'url' },
      { name: 'bullets', label: 'Key Points', type: 'list' }
    ]
  },
  'awards': { 
    type: 'entries', 
    isRepeatable: true, 
    fields: [
      { name: 'title', label: 'Award Title', type: 'text', required: true },
      { name: 'issuer', label: 'Issuing Organization', type: 'text' },
      { name: 'date', label: 'Date', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea' }
    ]
  },
  'publications': { 
    type: 'entries', 
    isRepeatable: true, 
    fields: [
      { name: 'title', label: 'Publication Title', type: 'text', required: true },
      { name: 'publisher', label: 'Publisher/Journal', type: 'text' },
      { name: 'date', label: 'Date', type: 'text' },
      { name: 'link', label: 'Link', type: 'url' }
    ]
  },
  'volunteer': { 
    type: 'entries', 
    isRepeatable: true, 
    fields: [
      { name: 'role', label: 'Role', type: 'text', required: true },
      { name: 'organization', label: 'Organization', type: 'text', required: true },
      { name: 'startDate', label: 'Start Date', type: 'text' },
      { name: 'endDate', label: 'End Date', type: 'text' },
      { name: 'description', label: 'Description', type: 'textarea' }
    ]
  },
  'references': { 
    type: 'entries', 
    isRepeatable: true, 
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true },
      { name: 'title', label: 'Title', type: 'text' },
      { name: 'company', label: 'Company', type: 'text' },
      { name: 'email', label: 'Email', type: 'email' },
      { name: 'phone', label: 'Phone', type: 'phone' }
    ]
  }
};

// Subfields that belong INSIDE entry sections - should NOT become standalone sections
// NOTE: Use lowercase since we compare against lowerPlaceholder
const SUBFIELDS_TO_IGNORE = new Set([
  // Experience subfields
  'title', 'company', 'startdate', 'enddate', 'description', 'bullets', 'location',
  // Education subfields
  'degree', 'field', 'institution', 'graduationyear', 'gpa',
  // Project subfields
  'name', 'technologies', 'link',
  // Award/Cert subfields
  'issuer', 'date',
  // Volunteer subfields
  'role', 'organization',
  // Reference subfields
  'publisher'
]);

/**
 * Extract all placeholders from a .docx template
 */
export function extractPlaceholders(templatePath: string): string[] {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  
  // Get the main document content
  const documentXml = zip.file('word/document.xml');
  if (!documentXml) {
    throw new Error('Invalid template: missing document.xml');
  }
  
  const xmlContent = documentXml.asText();
  
  // Find all placeholders: {{placeholder}}, {{#loop}}, {{/loop}}
  const placeholderRegex = /\{\{[#/]?([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
  const placeholders = new Set<string>();
  
  let match;
  while ((match = placeholderRegex.exec(xmlContent)) !== null) {
    placeholders.add(match[1]);
  }
  
  return Array.from(placeholders);
}

// Map section header names to SECTION_PATTERNS keys
const HEADER_TO_SECTION_KEY: Record<string, string> = {
  'education': 'education',
  'experience': 'experience',
  'work_experience': 'experience',
  'professional_experience': 'experience',
  'skills': 'skills',
  'technical_skills': 'skills',
  'core_competencies': 'skills',
  'summary': 'summary',
  'professional_summary': 'summary',
  'objective': 'objective',
  'career_objective': 'objective',
  'profile': 'profile',
  'projects': 'projects',
  'certifications': 'certifications',
  'certificates': 'certifications',
  'licenses': 'certifications',
  'awards': 'awards',
  'honors': 'awards',
  'achievements': 'awards',
  'publications': 'publications',
  'research': 'publications',
  'volunteer': 'volunteer',
  'volunteer_experience': 'volunteer',
  'community_involvement': 'volunteer',
  'languages': 'languages',
  'interests': 'interests',
  'hobbies': 'interests',
  'references': 'references',
  'leadership': 'volunteer',
  'leadership_and_activities': 'volunteer',
  'additional_information': 'custom',
  'other': 'custom'
};

/**
 * Analyze a template and generate section metadata
 * Enhanced to detect sections from content headers, not just placeholders
 */
export function analyzeTemplate(templatePath: string, templateId: string): TemplateMetadata {
  const placeholders = extractPlaceholders(templatePath);
  const sections: SectionDefinition[] = [];
  let order = 0;
  
  // Extract sample content FIRST to detect section headers
  const sampleContent = extractSampleContent(templatePath);
  
  // Group placeholders into sections
  const headerFields: FieldDefinition[] = [];
  const processedSections = new Set<string>();
  
  // STEP 1: Process placeholders (original behavior)
  for (const placeholder of placeholders) {
    const lowerPlaceholder = placeholder.toLowerCase();
    
    // Skip subfields - they're handled within their parent entry sections
    if (SUBFIELDS_TO_IGNORE.has(lowerPlaceholder)) {
      continue;
    }
    
    // Check if this is a known pattern
    const pattern = SECTION_PATTERNS[lowerPlaceholder] || SECTION_PATTERNS[placeholder];
    
    if (pattern) {
      if (pattern.type === 'header') {
        // Collect header fields together
        headerFields.push(...pattern.fields.map(f => ({ ...f, name: placeholder })));
      } else if (!processedSections.has(lowerPlaceholder)) {
        // Add as a separate section
        processedSections.add(lowerPlaceholder);
        
        sections.push({
          id: lowerPlaceholder,
          name: formatSectionName(placeholder),
          type: pattern.type,
          order: order++,
          fields: pattern.fields,
          isRepeatable: pattern.isRepeatable,
          entryFields: pattern.isRepeatable ? pattern.fields : undefined
        });
      }
    } else {
      // Unknown placeholder - add as custom text field
      if (!processedSections.has(lowerPlaceholder)) {
        processedSections.add(lowerPlaceholder);
        
        sections.push({
          id: lowerPlaceholder,
          name: formatSectionName(placeholder),
          type: 'text',
          order: order++,
          fields: [{ 
            name: placeholder, 
            label: formatSectionName(placeholder), 
            type: 'textarea' 
          }],
          isRepeatable: false
        });
      }
    }
  }
  
  // STEP 2: Detect sections from content headers (NEW BEHAVIOR)
  // This ensures templates without explicit placeholders still get proper form sections
  if (sampleContent && sampleContent.sections) {
    for (const [sectionKey, sectionData] of Object.entries(sampleContent.sections)) {
      // Skip header - handled separately
      if (sectionKey === 'header') continue;
      
      // Map section header to SECTION_PATTERNS key
      const patternKey = HEADER_TO_SECTION_KEY[sectionKey] || sectionKey;
      
      // Skip if already processed from placeholders
      if (processedSections.has(patternKey)) continue;
      
      // Get pattern for this section type
      const pattern = SECTION_PATTERNS[patternKey];
      
      if (pattern) {
        processedSections.add(patternKey);
        
        sections.push({
          id: patternKey,
          name: sectionData.title || formatSectionName(patternKey),
          type: pattern.type,
          order: order++,
          fields: pattern.fields,
          isRepeatable: pattern.isRepeatable,
          entryFields: pattern.isRepeatable ? pattern.fields : undefined
        });
      } else {
        // Unknown section - add as custom text field
        processedSections.add(sectionKey);
        
        sections.push({
          id: sectionKey,
          name: sectionData.title || formatSectionName(sectionKey),
          type: 'text',
          order: order++,
          fields: [{ 
            name: sectionKey, 
            label: sectionData.title || formatSectionName(sectionKey), 
            type: 'textarea' 
          }],
          isRepeatable: false
        });
      }
    }
  }
  
  // STEP 3: Add default sections if STILL nothing detected
  // This ensures every template has at least basic resume sections
  if (sections.length === 0 || (sections.length === 1 && processedSections.size === 0)) {
    const defaultSections = ['summary', 'experience', 'education', 'skills'];
    
    for (const sectionId of defaultSections) {
      if (!processedSections.has(sectionId)) {
        const pattern = SECTION_PATTERNS[sectionId];
        if (pattern) {
          processedSections.add(sectionId);
          sections.push({
            id: sectionId,
            name: formatSectionName(sectionId),
            type: pattern.type,
            order: order++,
            fields: pattern.fields,
            isRepeatable: pattern.isRepeatable,
            entryFields: pattern.isRepeatable ? pattern.fields : undefined
          });
        }
      }
    }
  }
  
  // Add header section if we have header fields
  if (headerFields.length > 0) {
    sections.unshift({
      id: 'header',
      name: 'Personal Information',
      type: 'header',
      order: -1,
      fields: headerFields,
      isRepeatable: false
    });
  } else {
    // ALWAYS add header section with default contact fields
    sections.unshift({
      id: 'header',
      name: 'Personal Information',
      type: 'header',
      order: -1,
      fields: [
        { name: 'fullName', label: 'Full Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'phone', label: 'Phone', type: 'phone' },
        { name: 'location', label: 'Location', type: 'text' },
        { name: 'linkedin', label: 'LinkedIn', type: 'url' },
        { name: 'website', label: 'Website/Portfolio', type: 'url' }
      ],
      isRepeatable: false
    });
  }
  
  // Re-order sections
  sections.sort((a, b) => a.order - b.order);
  sections.forEach((s, i) => s.order = i);
  
  return {
    id: templateId,
    name: formatSectionName(templateId),
    fileName: path.basename(templatePath),
    sections,
    placeholders,
    sampleContent,
    analyzedAt: new Date().toISOString()
  };
}

/**
 * Analyze all templates in a directory
 */
export function analyzeAllTemplates(templatesDir: string): TemplateMetadata[] {
  if (!fs.existsSync(templatesDir)) {
    return [];
  }
  
  const templates: TemplateMetadata[] = [];
  const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.docx'));
  
  for (const file of files) {
    const templateId = file.replace('.docx', '');
    const templatePath = path.join(templatesDir, file);
    
    try {
      const metadata = analyzeTemplate(templatePath, templateId);
      templates.push(metadata);
    } catch (error) {
      console.error(`Failed to analyze template ${file}:`, error);
    }
  }
  
  return templates;
}

/**
 * Format a camelCase or snake_case string as a title
 */
function formatSectionName(name: string): string {
  return name
    // Insert space before capitals
    .replace(/([A-Z])/g, ' $1')
    // Replace underscores with spaces
    .replace(/_/g, ' ')
    // Capitalize first letter of each word
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .trim();
}

// ==================== CACHING ====================

// Cache for analyzed templates (in-memory for speed)
const templateCache: Map<string, TemplateMetadata> = new Map();
const cacheTimestamp: Map<string, number> = new Map();

/**
 * Get template metadata with caching
 * Only re-analyzes if the file has changed
 */
export function getTemplateMetadata(templatePath: string, templateId: string): TemplateMetadata | null {
  if (!fs.existsSync(templatePath)) {
    return null;
  }
  
  const stats = fs.statSync(templatePath);
  const fileModified = stats.mtimeMs;
  
  // Check cache
  const cached = templateCache.get(templateId);
  const cachedTime = cacheTimestamp.get(templateId);
  
  if (cached && cachedTime && cachedTime >= fileModified) {
    return cached;
  }
  
  // Analyze and cache
  const metadata = analyzeTemplate(templatePath, templateId);
  templateCache.set(templateId, metadata);
  cacheTimestamp.set(templateId, Date.now());
  
  return metadata;
}

/**
 * Clear the template cache
 */
export function clearTemplateCache(): void {
  templateCache.clear();
  cacheTimestamp.clear();
}

/**
 * Extract sample content from a .docx template
 * Parses the actual text content and identifies ALL sections dynamically
 * Enhanced to handle cases where all content is on a single line
 */
export function extractSampleContent(templatePath: string): TemplateSampleContent {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  
  const documentXml = zip.file('word/document.xml');
  if (!documentXml) {
    return { sections: {}, rawText: '' };
  }
  
  const xmlContent = documentXml.asText();
  
  // Extract text from XML, preserving paragraph structure
  let rawText = xmlContent
    .replace(/<w:p[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  
  // Common section header patterns (case-insensitive) - ORDERED by specificity (longer first)
  const SECTION_HEADERS = [
    'professional summary', 'professional experience', 'work experience',
    'technical skills', 'core competencies', 'career objective',
    'volunteer experience', 'community involvement', 'leadership & activities',
    'leadership and activities', 'additional information',
    'education', 'experience', 'skills', 'summary', 'objective', 'profile',
    'projects', 'project', 'certifications', 'certificates', 'licenses',
    'awards', 'honors', 'achievements',
    'publications', 'research',
    'volunteer', 'languages', 'interests', 'hobbies',
    'references', 'leadership', 'other'
  ];
  
  // KEY FIX: Insert newlines before section headers that appear mid-text
  // This handles the case where everything ends up on one line
  for (const header of SECTION_HEADERS) {
    // Create regex to find header in the middle of text (preceded by non-newline)
    // Must be followed by content (not just end of string)
    const headerRegex = new RegExp(
      `([^\\n])\\s+(${header.toUpperCase()}|${header.charAt(0).toUpperCase() + header.slice(1)})\\s+(?=[A-Z])`,
      'g'
    );
    rawText = rawText.replace(headerRegex, '$1\n$2\n');
  }
  
  // Also handle ALL CAPS section headers that might be stuck to content
  const allCapsHeaders = [
    'PROFESSIONAL SUMMARY', 'PROFESSIONAL EXPERIENCE', 'WORK EXPERIENCE',
    'TECHNICAL SKILLS', 'CORE COMPETENCIES', 'CAREER OBJECTIVE',
    'EDUCATION', 'EXPERIENCE', 'SKILLS', 'SUMMARY', 'OBJECTIVE', 'PROFILE',
    'PROJECTS', 'PROJECT', 'CERTIFICATIONS', 'CERTIFICATES',
    'AWARDS', 'HONORS', 'ACHIEVEMENTS', 'PUBLICATIONS', 'RESEARCH',
    'VOLUNTEER', 'LANGUAGES', 'INTERESTS', 'REFERENCES', 'LEADERSHIP'
  ];
  
  for (const header of allCapsHeaders) {
    // Insert newline before and after the header
    const regex = new RegExp(`\\s(${header})\\s`, 'g');
    rawText = rawText.replace(regex, '\n$1\n');
  }
  
  // Clean up multiple newlines again
  rawText = rawText.replace(/\n{3,}/g, '\n\n').trim();
  
  const lines: string[] = rawText.split('\n').map((l: string) => l.trim()).filter(Boolean);
  
  const sampleContent: TemplateSampleContent = { sections: {}, rawText };
  
  // Find all section boundaries
  const sectionBoundaries: Array<{ index: number; title: string; normalizedTitle: string }> = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLower = line.toLowerCase().replace(/[&]/g, 'and').trim();
    
    // Check if this line is a section header (exact match or starts with header)
    for (const header of SECTION_HEADERS) {
      if (lineLower === header || 
          lineLower === header.toUpperCase() ||
          lineLower.startsWith(header + ':') || 
          (lineLower.startsWith(header) && lineLower.length < header.length + 3)) {
        sectionBoundaries.push({
          index: i,
          title: line,
          normalizedTitle: header.replace(/\s+/g, '_').replace(/[^a-z_]/g, '')
        });
        break;
      }
    }
  }
  
  // Extract content for each section
  for (let i = 0; i < sectionBoundaries.length; i++) {
    const current = sectionBoundaries[i];
    const nextIndex = i < sectionBoundaries.length - 1 
      ? sectionBoundaries[i + 1].index 
      : lines.length;
    
    // Get all lines between this header and the next
    const sectionLines = lines.slice(current.index + 1, nextIndex);
    
    // Filter out placeholder syntax and notes
    const contentLines = sectionLines.filter((l: string) => 
      !l.includes('{{') && 
      !l.includes('}}') && 
      !l.startsWith('[Note') &&
      l.length > 0
    );
    
    sampleContent.sections[current.normalizedTitle] = {
      title: current.title,
      content: contentLines,
      entries: parseEntriesFromContent(contentLines, current.normalizedTitle)
    };
  }
  
  // Extract header/personal info (content before first section)
  const firstSectionIndex = sectionBoundaries.length > 0 ? sectionBoundaries[0].index : lines.length;
  const headerLines = lines.slice(0, firstSectionIndex).filter((l: string) => 
    !l.includes('{{') && 
    !l.includes('}}') && 
    !l.startsWith('[Note') &&
    l.length > 0
  );
  
  if (headerLines.length > 0) {
    const headerContent = headerLines.join(' ');
    const parsedHeader = parseHeaderContent(headerContent);
    
    const firstLine = headerLines[0].trim();
    const firstLineIsName = /^[A-Z][a-z]+(\s+[A-Z][a-z'-]+){0,3}$/.test(firstLine) &&
      !firstLine.includes('@') &&
      !firstLine.includes('.com') &&
      !/\d{3}/.test(firstLine);
    
    if (firstLineIsName && firstLine.length < 50) {
      parsedHeader.fullName = firstLine;
    }
    
    sampleContent.sections['header'] = {
      title: 'Personal Information',
      content: headerLines,
      entries: [parsedHeader]
    };
  }
  
  return sampleContent;
}

/**
 * Parse header content to extract name and contact info
 * Handles cases where everything is on one line
 */
function parseHeaderContent(content: string): Record<string, string> {
  const info: Record<string, string> = {};
  
  const emailMatch = content.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (emailMatch) info.email = emailMatch[0];
  
  const phoneMatch = content.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  if (phoneMatch) info.phone = phoneMatch[0];
  
  const linkedinMatch = content.match(/(?:linkedin\.com\/in\/|in\/)[^\s,|]+/i);
  if (linkedinMatch) info.linkedin = linkedinMatch[0];
  
  const locationMatch = content.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),?\s*([A-Z]{2}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/);
  if (locationMatch) info.location = locationMatch[0];
  
  const nameCandidate = content
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '')
    .replace(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '')
    .replace(/(?:linkedin\.com\/in\/|in\/)[^\s,|]+/gi, '')
    .replace(/(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(?:\/[^\s,|]*)*/g, '')
    .trim();
  
  const words = nameCandidate.split(/\s+/);
  const nameWords: string[] = [];
  
  const locationStopWords = /^(seoul|tokyo|beijing|london|paris|berlin|new|york|los|angeles|san|francisco|chicago|boston|austin|seattle|denver|portland|miami|atlanta|dallas|houston|phoenix|philadelphia|detroit|minneapolis|charlotte|tampa|orlando|nashville|raleigh|salt|lake|vegas|diego|jose|jacksonville|columbus|indianapolis|fort|worth|north|south|east|west|korea|japan|china|india|usa|uk|canada|australia|germany|france|spain|italy|brazil|mexico|singapore|hong|kong|taiwan|vietnam|thailand|indonesia|malaysia|philippines|state|city|street|avenue|road|drive|boulevard|lane|way|place|court|circle)$/i;
  
  for (const word of words) {
    if (/^[A-Z]{2}$/.test(word) ||
        /^\d/.test(word) ||
        locationStopWords.test(word) ||
        /summary|experience|education|skills|objective|profile|professional/i.test(word) ||
        word.includes('@') || word.includes('.com') || word.includes('.org')) {
      break;
    }
    
    if (/^[A-Z][a-zA-Z'-]*$/.test(word) && word.length > 1) {
      nameWords.push(word);
    }
    
    if (nameWords.length >= 3) break;
  }
  
  if (nameWords.length >= 2) {
    info.fullName = nameWords.join(' ');
  } else if (nameWords.length === 1) {
    info.fullName = nameWords[0];
  }
  
  return info;
}

/**
 * Parse entries from section content (for repeatable sections like experience, education)
 */
function parseEntriesFromContent(lines: string[], sectionType: string): Array<Record<string, string>> {
  if (lines.length === 0) return [];
  
  const entries: Array<Record<string, string>> = [];
  
  if (sectionType === 'education' || sectionType === 'experience' || sectionType === 'work_experience' || sectionType === 'professional_experience') {
    // Look for entries separated by location patterns (City, State) or date patterns
    let currentEntry: Record<string, string> = {};
    let entryLines: string[] = [];
    
    for (const line of lines) {
      // Check if this looks like a new entry (contains location pattern or is an institution/company)
      const isNewEntry = /^[A-Z][a-zA-Z\s]+,?\s+[A-Z]{2}$/.test(line) || // "City, ST" or "City ST"
                         /university|college|institute|school|inc\.|corp\.|llc|company/i.test(line);
      
      if (isNewEntry && entryLines.length > 0) {
        // Save previous entry
        currentEntry = parseEntryLines(entryLines, sectionType);
        if (Object.keys(currentEntry).length > 0) {
          entries.push(currentEntry);
        }
        entryLines = [line];
      } else {
        entryLines.push(line);
      }
    }
    
    // Don't forget the last entry
    if (entryLines.length > 0) {
      currentEntry = parseEntryLines(entryLines, sectionType);
      if (Object.keys(currentEntry).length > 0) {
        entries.push(currentEntry);
      }
    }
  } else {
    // For non-repeatable sections, just return content as single entry
    entries.push({ content: lines.join('\n') });
  }
  
  return entries;
}

/**
 * Parse individual entry lines into structured data
 */
function parseEntryLines(lines: string[], sectionType: string): Record<string, string> {
  if (lines.length === 0) return {};
  
  const entry: Record<string, string> = {};
  
  if (sectionType === 'education') {
    // First line is usually institution
    entry.institution = lines[0] || '';
    // Look for degree
    const degreeLine = lines.find((l: string) => /degree|bachelor|master|phd|b\.\s?[as]|m\.\s?[as]|concentration/i.test(l));
    if (degreeLine) entry.degree = degreeLine;
    // Look for graduation date
    const dateLine = lines.find((l: string) => /graduation|20\d{2}|19\d{2}/i.test(l));
    if (dateLine) entry.graduationDate = dateLine;
  } else if (sectionType.includes('experience')) {
    // First line is usually company/organization
    entry.company = lines[0] || '';
    // Look for title
    const titleLine = lines.find((l: string) => /title|position|manager|engineer|analyst|developer|director|lead|senior|junior/i.test(l));
    if (titleLine) entry.title = titleLine;
    // Rest is description
    const descLines = lines.filter((l: string) => l !== entry.company && l !== entry.title);
    if (descLines.length > 0) entry.description = descLines.join('\n');
  }
  
  return entry;
}

/**
 * Parse contact info from header lines
 */
function parseContactInfo(lines: string[]): Record<string, string> {
  const info: Record<string, string> = {};
  const allText = lines.join(' ');
  
  const emailMatch = allText.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (emailMatch) info.email = emailMatch[0];
  
  const phoneMatch = allText.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  if (phoneMatch) info.phone = phoneMatch[0];
  
  const locationMatch = allText.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),?\s*([A-Z]{2})\b/);
  if (locationMatch) info.location = locationMatch[0];
  
  const linkedinMatch = allText.match(/(?:linkedin\.com\/in\/|in\/)[^\s,|]+/i);
  if (linkedinMatch) info.linkedin = linkedinMatch[0];
  
  const websiteMatch = allText.match(/(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9][a-zA-Z0-9-]*\.[a-zA-Z]{2,}(?:\/[^\s,|]*)*/);
  if (websiteMatch && !websiteMatch[0].includes('linkedin')) info.website = websiteMatch[0];
  
  return info;
}
