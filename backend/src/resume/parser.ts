// Resume parser for uploaded files (PDF, DOCX, TXT)
// Per security.md: Validate file uploads for size, type, and safety

import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { BadRequestError } from '../shared/errors.js';
import { leaseNextLlmKey, markKeySuccess, markKeyFailure, isRateLimitError } from '../ai/keyManager.js';
import { getProviderModel, runLlmCompletion, createLlmClient } from '../ai/providerModels.js';

// File constraints
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain'
];

// Parsed resume structure
export interface ParsedResume {
  personalInfo: {
    fullName: string;
    email: string;
    phone: string;
    location: string;
    linkedin?: string;
    website?: string;
  };
  summary: string;
  experience: Array<{
    id: string;
    title: string;
    company: string;
    startDate: string;
    endDate: string;
    description: string;
    bullets: string[];
  }>;
  education: Array<{
    id: string;
    degree: string;
    institution: string;
    field: string;
    graduationYear: string;
  }>;
  projects: Array<{
    id: string;
    title: string;
    role: string;
    description: string;
    tech: string[];
    bullets: string[];
  }>;
  skills: string[];
  languages: string[];
  rawText: string; // Always include raw text for LLM fallback
}

/**
 * Validates uploaded file for security
 */
export function validateUploadedFile(
  buffer: Buffer,
  mimeType: string,
  filename: string
): void {
  // Check file size
  if (!buffer || buffer.length === 0) {
    throw new BadRequestError('File is empty. Upload a non-empty file.');
  }
  if (buffer.length > MAX_FILE_SIZE) {
    throw new BadRequestError('File too large. Maximum size is 10MB.');
  }
  
  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    throw new BadRequestError('Invalid file type. Allowed: PDF, DOCX, TXT');
  }
  
  // Sanitize filename - prevent path traversal
  const sanitizedName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  
  // Check for dangerous extensions
  const dangerousExtensions = ['.exe', '.sh', '.bat', '.cmd', '.ps1', '.js', '.php', '.py'];
  const lowerName = sanitizedName.toLowerCase();
  for (const ext of dangerousExtensions) {
    if (lowerName.endsWith(ext)) {
      throw new BadRequestError('File type not allowed');
    }
  }
}

/**
 * Extract raw text from file without parsing structure.
 * Used as fallback for LLM evaluator when structured parsing fails.
 *
 * Never throws for empty or corrupt-but-allowed buffers: callers store the
 * raw bytes regardless so the original file stays downloadable/viewable.
 * An empty return only means "no extractable text" (surfaced as a warning
 * by the upload route), never a reason to reject the upload.
 */
export async function extractRawText(
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  if (!buffer || buffer.length === 0) {
    return '';
  }
  if (mimeType === 'application/pdf') {
    try {
      const pdfData = await pdfParse(buffer);
      return pdfData.text || '';
    } catch {
      return '';
    }
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
    } catch {
      return '';
    }
  } else if (mimeType === 'text/plain') {
    return buffer.toString('utf-8');
  }
  throw new BadRequestError(`Unsupported file type: ${mimeType}`);
}

/**
 * Main parsing function - extracts structured data + always includes rawText
 */
export async function parseUploadedResume(
  buffer: Buffer,
  mimeType: string
): Promise<ParsedResume> {
  let text: string;
  
  // Extract text based on file type
  if (mimeType === 'application/pdf') {
    try {
      const pdfData = await pdfParse(buffer);
      text = pdfData.text || '';
    } catch {
      text = '';
    }
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value || '';
    } catch {
      text = '';
    }
  } else if (mimeType === 'text/plain') {
    text = buffer.toString('utf-8');
  } else {
    throw new BadRequestError(`Unsupported file type: ${mimeType}`);
  }
  
  // Parse text into structured resume (best effort)
  const parsed = parseResumeText(text);
  
  // Always include raw text for LLM fallback
  return { ...parsed, rawText: text };
}

// ==================== LLM-BASED STRUCTURED PARSE ====================

const RESUME_PARSE_SYSTEM = `You are an expert resume parser. Convert the provided resume text into a clean JSON structure that preserves the candidate's actual content and section ordering as faithfully as possible.

Rules:
- Do NOT invent, embellish, or change any facts. Only extract what is present.
- Preserve job titles, company names, dates, bullet points, and skills exactly as written.
- Keep bullet points as separate array items under each experience entry.
- Infer section structure: summary, experience (array), education (array), skills (array of strings), projects (array), languages (array of strings).
- personalInfo should include fullName, email, phone, location, linkedin, website if present.
- For experience entries: title, company, startDate, endDate, description (free text), bullets (array of strings).
- For education entries: degree, institution, field, graduationYear.
- For projects entries: title, role (e.g. tech used / your role), description (free text), tech (array of strings), bullets (array of strings). Capture each named project (e.g. "ToRIS", "GeoVision") as a separate entry.
- For languages: an array of language names the candidate knows (e.g. English, Hindi, Marathi).

Return ONLY valid JSON (no markdown) matching exactly:
{
  "personalInfo": { "fullName": "", "email": "", "phone": "", "location": "", "linkedin": "", "website": "" },
  "summary": "",
  "experience": [ { "title": "", "company": "", "startDate": "", "endDate": "", "description": "", "bullets": [] } ],
  "education": [ { "degree": "", "institution": "", "field": "", "graduationYear": "" } ],
  "projects": [ { "title": "", "role": "", "description": "", "tech": [], "bullets": [] } ],
  "languages": []
}`;

function extractJson(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : '';
}

// Parse a resume using an LLM (Groq BYOK) for far better layout/content fidelity.
export async function parseResumeWithLLM(
  rawText: string,
  userId?: string
): Promise<ParsedResume | null> {
  if (!rawText || rawText.trim().length < 30) return null;

  let key;
  try {
    key = await leaseNextLlmKey(userId);
  } catch {
    return null;
  }

  const model = await getProviderModel(key.provider, { envOverride: process.env.RESUME_PARSE_MODEL });

  const client = createLlmClient(key);

  try {
    const response = await runLlmCompletion(key.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 2000,
        temperature: 0.0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: RESUME_PARSE_SYSTEM },
          { role: 'user', content: `RESUME TEXT:\n${rawText}` },
        ],
      })
    );

    const content = response.choices[0]?.message?.content || '';
    const jsonStr = extractJson(content);
    if (!jsonStr) {
      await markKeyFailure(key, false).catch(() => {});
      return null;
    }

    const parsed = JSON.parse(jsonStr) as Partial<ParsedResume>;
    await markKeySuccess(key).catch(() => {});

    return {
      personalInfo: {
        fullName: parsed.personalInfo?.fullName || '',
        email: parsed.personalInfo?.email || '',
        phone: parsed.personalInfo?.phone || '',
        location: parsed.personalInfo?.location || '',
        linkedin: parsed.personalInfo?.linkedin || '',
        website: parsed.personalInfo?.website || '',
      },
      summary: parsed.summary || '',
      experience: (parsed.experience || []).map((e, i) => ({
        id: `exp-${i}-${Math.random().toString(36).substring(2, 9)}`,
        title: e.title || '',
        company: e.company || '',
        startDate: normalizeDate(e.startDate || ''),
        endDate: normalizeDate(e.endDate || ''),
        description: e.description || '',
        bullets: Array.isArray(e.bullets) ? e.bullets : [],
      })),
      education: (parsed.education || []).map((e, i) => ({
        id: `edu-${i}-${Math.random().toString(36).substring(2, 9)}`,
        degree: e.degree || '',
        institution: e.institution || '',
        field: e.field || '',
        graduationYear: normalizeDate(e.graduationYear || ''),
      })),
      projects: (parsed.projects || []).map((p, i) => ({
        id: `proj-${i}-${Math.random().toString(36).substring(2, 9)}`,
        title: p.title || '',
        role: p.role || '',
        description: p.description || '',
        tech: Array.isArray(p.tech) ? p.tech.map((t) => String(t)) : [],
        bullets: Array.isArray(p.bullets) ? p.bullets.map((b) => String(b)) : [],
      })),
      skills: Array.isArray(parsed.skills) ? parsed.skills.map((s) => String(s)) : [],
      languages: Array.isArray(parsed.languages) ? parsed.languages.map((l) => String(l)) : [],
      rawText,
    };
  } catch (error) {
    await markKeyFailure(key, isRateLimitError(error)).catch(() => {});
    return null;
  }
}

/**
 * Parse an uploaded file into structured resume data.
 * Primary: LLM-based parse (best layout/content fidelity) when a key is available.
 * Fallback: deterministic rules-based parser. Always includes rawText.
 */
export async function parseUploadedResumeSmart(
  buffer: Buffer,
  mimeType: string,
  userId?: string
): Promise<ParsedResume> {
  const base = await parseUploadedResume(buffer, mimeType);
  if (base.rawText && base.rawText.trim().length > 0) {
    try {
      const llmResult = await parseResumeWithLLM(base.rawText, userId);
      if (llmResult) return llmResult;
    } catch {
      // fall through to rules parse
    }
  }
  return base;
}

/**
 * Parse raw text into structured resume data
 * This is best-effort parsing - not perfect but functional
 */
function parseResumeText(text: string): ParsedResume {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  
  // Extract contact information
  const email = extractEmail(text);
  const phone = extractPhone(text);
  const linkedin = extractLinkedIn(text);
  const website = extractWebsite(text);
  
  // First substantial line is usually the name
  const fullName = extractName(lines);
  
  // Detect sections
  const sections = detectSections(lines);
  
  // Parse each section
  const summary = parseSummary(sections.summary || []);
  const experience = parseExperience(sections.experience || []);
  const education = parseEducation(sections.education || []);
  const skills = parseSkills(sections.skills || []);
  const projects = parseProjects(sections.projects || []);
  const languages = parseLanguages(sections.languages || []);
  const location = extractLocation(text);
  
  return {
    personalInfo: {
      fullName,
      email,
      phone,
      location,
      linkedin,
      website
    },
    summary,
    experience,
    education,
    skills,
    projects,
    languages,
    rawText: text
  };
}

// ==================== EXTRACTION HELPERS ====================

function extractEmail(text: string): string {
  const match = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  return match ? match[0] : '';
}

function extractPhone(text: string): string {
  const match = text.match(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return match ? match[0] : '';
}

function extractLinkedIn(text: string): string {
  const match = text.match(/linkedin\.com\/in\/[\w-]+/i);
  return match ? match[0] : '';
}

function extractWebsite(text: string): string {
  // Match URLs that aren't LinkedIn or common email domains
  const match = text.match(/https?:\/\/(?!.*linkedin)[^\s]+|(?:www\.)?(?!linkedin)[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s]*)?/i);
  if (match && !match[0].includes('linkedin') && !match[0].includes('gmail') && !match[0].includes('yahoo')) {
    return match[0];
  }
  return '';
}

function extractName(lines: string[]): string {
  // Name is typically first substantial line that:
  // - Doesn't contain @ (email)
  // - Doesn't start with numbers (phone)
  // - Isn't too long
  for (const line of lines.slice(0, 5)) {
    if (
      !line.includes('@') &&
      !/^\+?\d/.test(line) &&
      line.length < 50 &&
      line.length > 2
    ) {
      return line;
    }
  }
  return '';
}

// ==================== SECTION DETECTION ====================

interface Sections {
  summary: string[];
  experience: string[];
  education: string[];
  skills: string[];
  projects: string[];
  languages: string[];
  [key: string]: string[];
}

const SECTION_PATTERNS: Record<string, RegExp> = {
  summary: /^(summary|profile|objective|about|professional\s+summary|career\s+snapshot)/i,
  experience: /^(experience|work|employment|professional\s+experience|work\s+history)/i,
  education: /^(education|academic|school|qualifications)/i,
  skills: /^(skills|technical|competencies|expertise|technologies)/i,
  projects: /^(projects|project\s+work|portfolio|personal\s+projects)/i,
  languages: /^(languages|language\s+proficiency|spoken\s+languages)/i
};

function detectSections(lines: string[]): Sections {
  const sections: Sections = {
    summary: [],
    experience: [],
    education: [],
    skills: [],
    projects: [],
    languages: []
  };
  
  let currentSection: string | null = null;
  
  for (const line of lines) {
    // Check if this line is a section header
    let isHeader = false;
    for (const [section, pattern] of Object.entries(SECTION_PATTERNS)) {
      if (pattern.test(line)) {
        currentSection = section;
        isHeader = true;
        break;
      }
    }
    
    // Add line to current section (if not a header)
    if (!isHeader && currentSection && sections[currentSection]) {
      sections[currentSection].push(line);
    }
  }
  
  return sections;
}

// ==================== SECTION PARSERS ====================

function parseSummary(lines: string[]): string {
  return lines.join(' ').trim();
}

function parseExperience(lines: string[]): ParsedResume['experience'] {
  const experiences: ParsedResume['experience'] = [];
  let current: ParsedResume['experience'][0] | null = null;
  
  const datePattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}|present)\b/i;
  const bulletPattern = /^[•\-\*\u2022\u2023\u25E6\u2043]/;
  
  for (const line of lines) {
    // Check if this looks like a job title/company line
    if (datePattern.test(line) && !bulletPattern.test(line)) {
      // Save previous experience
      if (current) {
        experiences.push(current);
      }
      
      // Start new experience
      current = {
        id: `exp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title: '',
        company: '',
        startDate: '',
        endDate: '',
        description: '',
        bullets: []
      };
      
      // Try to extract title, company, dates from line
      const parts = line.split(/\s+at\s+|\s+[|–-]\s+/i);
      if (parts.length >= 1) {
        current.title = parts[0].trim();
      }
      if (parts.length >= 2) {
        current.company = parts[1].replace(datePattern, '').trim();
      }
      
      // Extract dates
      const dates = line.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d{4}\b|\b\d{4}\b|present/gi);
      if (dates && dates.length >= 1) {
        current.startDate = dates[0];
        current.endDate = dates[1] || 'Present';
      }
    } else if (bulletPattern.test(line) && current) {
      // Add bullet point
      current.bullets.push(line.replace(bulletPattern, '').trim());
    }
  }
  
  // Don't forget last experience
  if (current) {
    experiences.push(current);
  }
  
  return experiences;
}

function parseEducation(lines: string[]): ParsedResume['education'] {
  const educations: ParsedResume['education'] = [];
  
  const degreePattern = /bachelor|master|phd|doctorate|associate|diploma|certificate|b\.?s\.?|m\.?s\.?|m\.?b\.?a\.?|b\.?a\.?/i;
  const yearPattern = /\b(19|20)\d{2}\b/;
  
  let current: ParsedResume['education'][0] | null = null;
  
  for (const line of lines) {
    if (degreePattern.test(line) || yearPattern.test(line)) {
      if (current) {
        educations.push(current);
      }
      
      current = {
        id: `edu-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        degree: '',
        institution: '',
        field: '',
        graduationYear: ''
      };
      
      // Extract degree
      const degreeMatch = line.match(degreePattern);
      if (degreeMatch) {
        // Get the full degree text around the match
        const startIdx = Math.max(0, line.indexOf(degreeMatch[0]) - 20);
        const endIdx = Math.min(line.length, line.indexOf(degreeMatch[0]) + degreeMatch[0].length + 30);
        current.degree = line.substring(startIdx, endIdx).trim();
      }
      
      // Extract year
      const yearMatch = line.match(yearPattern);
      if (yearMatch) {
        current.graduationYear = yearMatch[0];
      }
      
      // Institution is often the remaining text
      current.institution = line
        .replace(current.degree, '')
        .replace(current.graduationYear, '')
        .replace(/[,|–-]/g, '')
        .trim();
    }
  }
  
  if (current) {
    educations.push(current);
  }
  
  return educations;
}

function parseSkills(lines: string[]): string[] {
  const skills: string[] = [];
  
  for (const line of lines) {
    // Skills are often comma or bullet separated
    const parts = line.split(/[,;•\-\*\u2022]/).map(s => s.trim()).filter(Boolean);
    skills.push(...parts);
  }
  
  // Deduplicate and limit
  return [...new Set(skills)].slice(0, 50);
}

function extractLocation(text: string): string {
  // Location often appears on the contact line after the email, separated by |
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) {
    const after = text.slice(text.indexOf(emailMatch[0]) + emailMatch[0].length);
    const locMatch = after.match(/\|?\s*([^|\n]+(?:,\s*[A-Z][a-z]+){1,3})/);
    if (locMatch && locMatch[1].trim().length > 3 && locMatch[1].trim().length < 80) {
      return locMatch[1].trim().replace(/^\|\s*/, '');
    }
  }
  return '';
}

/**
 * The TECHNOLOGY-LINE label (T1053).
 *
 * The previous inline pattern at the "attach it to the project" branch was
 * `/^technologies|tech|stack\s*:/i` - and because the alternation had NO GROUP it was read as
 * `(^technologies)|(tech)|(stack\s*:)`, i.e. an UNANCHORED alternation. Two consequences
 * followed from that one missing bracket:
 *   - a `Tech:` line matched only by accident, through the bare `tech` substring alternative,
 *     and the `\s*:` guard applied to the WRONG branch, so nothing required a colon; and
 *   - any line merely CONTAINING `tech` anywhere ("We shipped fintech products", "mytech
 *     stack") satisfied that test.
 *
 * It is ONE constant, used by BOTH sites that ask the question - "is this line a technology
 * list?" (which decides whether a line starts a new project) and "attach it to the current
 * project" - because those two drifting apart is precisely how the defect survived and then
 * stayed invisible: with the sites holding DIFFERENT patterns, the one that asks the question
 * was correct and masked the one that acted on the answer. One constant means they cannot
 * disagree again, and it is what makes the Fintech case a live test rather than a comment.
 *
 * WHAT DID NOT CHANGE: the capture contract and the value split (`:,-`, then `.slice(1)`),
 * which is why "scikit-learn" still splits into two entries. T1053 narrows the pattern and
 * nothing else.
 */
const TECH_LINE_LABEL = /^(?:technologies|tech|stack)\s*:/i;

function parseProjects(lines: string[]): ParsedResume['projects'] {
  const projects: ParsedResume['projects'] = [];
  let current: ParsedResume['projects'][0] | null = null;
  const bulletPattern = /^[•\-\*\u2022\u2023\u25E6\u2043]/;

  for (const line of lines) {
    // A project title is typically a standalone bold-ish line (no bullet, not a sub-detail line)
    if (bulletPattern.test(line)) {
      if (current) current.bullets.push(line.replace(bulletPattern, '').trim());
    } else if (line.length > 2 && !TECH_LINE_LABEL.test(line)) {
      if (current) projects.push(current);
      current = {
        id: `proj-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title: line.trim(),
        role: '',
        description: '',
        tech: [],
        bullets: []
      };
    } else if (current && TECH_LINE_LABEL.test(line)) {
      current.tech = line.split(/[:,-]/).slice(1).map(s => s.trim()).filter(Boolean);
    }
  }
  if (current) projects.push(current);
  return projects.slice(0, 30);
}

function parseLanguages(lines: string[]): string[] {
  const langs: string[] = [];
  for (const line of lines) {
    const parts = line.split(/[,;•\-\*\u2022]/).map(s => s.trim()).filter(Boolean);
    langs.push(...parts);
  }
  return [...new Set(langs)].slice(0, 30);
}

// ==================== MARKDOWN / DATE HELPERS (markitdown-grade) ====================

const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
};

// Normalize a loosely-formatted date to "YYYY-MM" (or "Present" / "").
export function normalizeDate(raw: string): string {
  if (!raw) return '';
  const r = raw.trim();
  if (/present|current|now/i.test(r)) return 'Present';
  const m = r.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i);
  const y = r.match(/\b(19|20)\d{2}\b/);
  if (m && y) return `${y[0]}-${MONTH_MAP[m[1].toLowerCase()]}`;
  if (y) return y[0];
  return r;
}

// Convert a structured ParsedResume into a faithful Markdown representation
// (the "Markdown intermediate" of a markitdown-grade pipeline).
export function resumeToMarkdown(p: ParsedResume): string {
  const lines: string[] = [];
  const pi = p.personalInfo;
  if (pi.fullName) lines.push(`# ${pi.fullName}`);
  const contact = [pi.email, pi.phone, pi.location, pi.linkedin, pi.website].filter(Boolean).join(' · ');
  if (contact) lines.push(contact);
  if (p.summary) { lines.push('', '## Summary', p.summary); }
  if (p.experience.length) {
    lines.push('', '## Experience');
    for (const e of p.experience) {
      lines.push(`### ${e.title}${e.company ? ' — ' + e.company : ''} (${e.startDate} – ${e.endDate})`);
      if (e.description) lines.push(e.description);
      for (const b of e.bullets) lines.push(`- ${b}`);
    }
  }
  if (p.education.length) {
    lines.push('', '## Education');
    for (const e of p.education) lines.push(`- ${e.degree} — ${e.institution} (${e.graduationYear})`);
  }
  if (p.projects.length) {
    lines.push('', '## Projects');
    for (const pj of p.projects) lines.push(`- **${pj.title}**: ${pj.description}`);
  }
  if (p.skills.length) lines.push('', '## Skills', p.skills.join(', '));
  if (p.languages.length) lines.push('', '## Languages', p.languages.join(', '));
  return lines.join('\n');
}
