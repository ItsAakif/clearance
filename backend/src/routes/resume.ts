// Resume Routes - CRUD, upload, export
// Per security.md: Validate all input, enforce ownership

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError, BadRequestError, ForbiddenError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, createResumeSchema, updateResumeSchema, createVariantSchema } from '../shared/validation.js';
import { parseUploadedResume, parseUploadedResumeSmart } from '../resume/parser.js';

// Dynamic imports for docx (ESM/CJS compatibility)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const docx = require('docx');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = docx;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZip = require('pizzip');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Docxtemplater = require('docxtemplater');

// Template directory path - where user places their .docx templates
const TEMPLATES_DIR = path.join(__dirname, '../../templates');

const router = Router();

// Configure multer for file uploads (5MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a PDF or DOCX file.'));
    }
  }
});

// Default template settings
const DEFAULT_TEMPLATE_SETTINGS = {
  marginX: 0.75,
  marginY: 0.75,
  fontSize: 11,
  lineSpacing: 1.4,
  sectionSpacing: 1.5
};

// Default personal info structure
const DEFAULT_PERSONAL_INFO = {
  fullName: '',
  email: '',
  phone: '',
  location: '',
  linkedin: '',
  website: ''
};

// Default sections
const DEFAULT_SECTIONS = [
  { id: 'personal', type: 'personal', title: 'Personal Information', order: 0, visible: true },
  { id: 'summary', type: 'summary', title: 'Professional Summary', order: 1, visible: true },
  { id: 'experience', type: 'experience', title: 'Work Experience', order: 2, visible: true },
  { id: 'education', type: 'education', title: 'Education', order: 3, visible: true },
  { id: 'skills', type: 'skills', title: 'Skills', order: 4, visible: true }
];

// ==================== GET ALL RESUMES ====================
router.get('/', requireAuth, async (req, res) => {
  try {
    const resumes = await prisma.resume.findMany({
      where: { userId: req.user!.id },
      orderBy: { updatedAt: 'desc' },
      include: {
        variants: {
          select: {
            id: true,
            name: true,
            targetJob: true,
            createdAt: true
          }
        }
      }
    });
    
    res.json(resumes);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET SINGLE RESUME ====================
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const resume = await prisma.resume.findUnique({
      where: { id },
      include: {
        variants: {
          select: {
            id: true,
            name: true,
            targetJob: true,
            createdAt: true
          }
        }
      }
    });
    
    if (!resume) {
      throw new NotFoundError('Resume');
    }
    
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');
    
    res.json(resume);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== CREATE RESUME ====================
router.post('/', requireAuth, async (req, res) => {
  try {
    // Validate input
    const data = validateInput(createResumeSchema, req.body);
    
    // Create resume with defaults
    const resume = await prisma.resume.create({
      data: {
        userId: req.user!.id,
        name: data.name || 'Untitled Resume',
        personalInfo: data.personalInfo || DEFAULT_PERSONAL_INFO,
        summary: data.summary || '',
        experience: data.experience || [],
        education: data.education || [],
        skills: data.skills || [],
        projects: data.projects || undefined,
        sections: data.sections || DEFAULT_SECTIONS,
        templateId: data.templateId || 'professional-standard',
        templateSettings: data.templateSettings || DEFAULT_TEMPLATE_SETTINGS
      }
    });
    
    res.status(201).json(resume);
  } catch (error) {
    handleApiError(error, res);
  }
});

async function updateResumeHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    
    // Check exists and ownership
    const existing = await prisma.resume.findUnique({
      where: { id },
      select: { userId: true }
    });
    
    if (!existing) {
      throw new NotFoundError('Resume');
    }
    
    await ensureOwnership(req.user!.id, existing.userId, 'Resume');
    
    // Validate input
    const data = validateInput(updateResumeSchema, req.body);
    
    // Build update object
    const updateData: Record<string, any> = {};
    
    if (data.name !== undefined) updateData.name = data.name;
    if (data.personalInfo !== undefined) updateData.personalInfo = data.personalInfo;
    if (data.summary !== undefined) updateData.summary = data.summary;
    if (data.experience !== undefined) updateData.experience = data.experience;
    if (data.education !== undefined) updateData.education = data.education;
    if (data.skills !== undefined) updateData.skills = data.skills;
    if (data.projects !== undefined) updateData.projects = data.projects;
    if (data.sections !== undefined) updateData.sections = data.sections;
    if (data.templateId !== undefined) updateData.templateId = data.templateId;
    if (data.templateSettings !== undefined) updateData.templateSettings = data.templateSettings;
    
    const resume = await prisma.resume.update({
      where: { id },
      data: updateData
    });
    
    res.json(resume);
  } catch (error) {
    handleApiError(error, res);
  }
}

// ==================== UPDATE RESUME ====================
router.put('/:id', requireAuth, updateResumeHandler);
router.patch('/:id', requireAuth, updateResumeHandler);

// ==================== DELETE RESUME ====================
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const existing = await prisma.resume.findUnique({
      where: { id },
      select: { userId: true }
    });
    
    if (!existing) {
      throw new NotFoundError('Resume');
    }
    
    await ensureOwnership(req.user!.id, existing.userId, 'Resume');
    
    await prisma.resume.delete({ where: { id } });
    
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== UPLOAD RESUME FILE ====================
router.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    
    if (!file) {
      throw new BadRequestError('No file uploaded');
    }
    
    // Parse the uploaded file (LLM-enhanced when a key is available, rules fallback)
    const parsedData = await parseUploadedResumeSmart(file.buffer, file.mimetype, req.user!.id);
    
    // Create resume from parsed data (also store original file for preview)
    const resume = await prisma.resume.create({
      data: {
        userId: req.user!.id,
        name: file.originalname.replace(/\.[^/.]+$/, '') || 'Uploaded Resume',
        personalInfo: parsedData.personalInfo || DEFAULT_PERSONAL_INFO,
        summary: parsedData.summary || '',
        experience: parsedData.experience || [],
        education: parsedData.education || [],
        skills: parsedData.skills || [],
        projects: (parsedData.projects && parsedData.projects.length > 0) ? parsedData.projects : undefined,
        languages: (parsedData.languages && parsedData.languages.length > 0) ? parsedData.languages : undefined,
        sections: DEFAULT_SECTIONS,
        templateId: 'professional-standard',
        templateSettings: DEFAULT_TEMPLATE_SETTINGS,
        originalFile: file.buffer,
        originalFileType: file.mimetype,
      }
    });
    
    res.status(201).json(resume);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET ORIGINAL UPLOADED FILE ====================
router.get('/:id/original', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const resume = await prisma.resume.findUnique({
      where: { id },
      select: { userId: true, originalFile: true, originalFileType: true, name: true },
    });
    if (!resume) throw new NotFoundError('Resume');
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');
    if (!resume.originalFile) {
      res.status(404).json({ error: 'No original file stored for this resume' });
      return;
    }
    const ext = (resume.originalFileType || '').includes('pdf')
      ? 'pdf'
      : (resume.originalFileType || '').includes('word')
      ? 'docx'
      : 'bin';
    res.setHeader('Content-Type', resume.originalFileType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${resume.name}.${ext}"`);
    res.send(Buffer.from(resume.originalFile));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== CREATE VARIANT ====================
router.post('/:id/variants', requireAuth, async (req, res) => {
  try {
    const { id: resumeId } = req.params;
    
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { userId: true }
    });
    
    if (!resume) {
      throw new NotFoundError('Resume');
    }
    
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');
    
    const data = validateInput(createVariantSchema, req.body);
    
    const variant = await prisma.resumeVariant.create({
      data: {
        resumeId,
        name: data.name,
        targetJob: data.targetJob || null
      }
    });
    
    res.status(201).json(variant);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET VARIANTS ====================
router.get('/:id/variants', requireAuth, async (req, res) => {
  try {
    const { id: resumeId } = req.params;

    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { userId: true }
    });

    if (!resume) {
      throw new NotFoundError('Resume');
    }

    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    const variants = await prisma.resumeVariant.findMany({
      where: { resumeId },
      orderBy: { createdAt: 'desc' }
    });

    res.json(variants);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== DELETE VARIANT ====================
router.delete('/:id/variants/:variantId', requireAuth, async (req, res) => {
  try {
    const { id: resumeId, variantId } = req.params;

    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { userId: true }
    });

    if (!resume) {
      throw new NotFoundError('Resume');
    }

    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    const variant = await prisma.resumeVariant.findFirst({
      where: { id: variantId, resumeId }
    });

    if (!variant) {
      throw new NotFoundError('Resume variant');
    }

    await prisma.resumeVariant.delete({
      where: { id: variantId }
    });

    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== ARCHIVE RESUME ====================
router.patch('/:id/archive', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.resume.findUnique({
      where: { id },
      select: { userId: true }
    });

    if (!existing) {
      throw new NotFoundError('Resume');
    }

    await ensureOwnership(req.user!.id, existing.userId, 'Resume');

    const resume = await prisma.resume.update({
      where: { id },
      data: { isArchived: true }
    });

    res.json(resume);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== UNARCHIVE RESUME ====================
router.patch('/:id/unarchive', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.resume.findUnique({
      where: { id },
      select: { userId: true }
    });

    if (!existing) {
      throw new NotFoundError('Resume');
    }

    await ensureOwnership(req.user!.id, existing.userId, 'Resume');

    const resume = await prisma.resume.update({
      where: { id },
      data: { isArchived: false }
    });

    res.json(resume);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET ATS REPORTS (ALIAS) ====================
router.get('/:id/ats-reports', requireAuth, async (req, res) => {
  try {
    const { id: resumeId } = req.params;

    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { userId: true }
    });

    if (!resume) {
      throw new NotFoundError('Resume');
    }

    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    const reports = await prisma.aTSReport.findMany({
      where: { resumeId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        overallScore: true,
        status: true,
        createdAt: true,
        categories: true,
        keywords: true,
        formatting: true
      }
    });

    res.json(reports.map(report => ({
      id: report.id,
      resumeId,
      overallScore: report.overallScore,
      status: report.status,
      createdAt: report.createdAt,
      categories: report.categories,
      keywords: report.keywords,
      formatting: report.formatting
    })));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== EXPORT DOCX FROM DYNAMIC DATA (no auth required for preview) ====================
router.post('/export/docx-preview', requireAuth, async (req, res) => {
  try {
    const { templateId, sections } = req.body;
    
    if (!templateId) {
      throw new BadRequestError('templateId is required');
    }
    
    if (!sections || typeof sections !== 'object') {
      throw new BadRequestError('sections object is required');
    }
    
    // Find template file
    const templatePath = path.join(TEMPLATES_DIR, `${templateId}.docx`);
    
    if (!fs.existsSync(templatePath)) {
      throw new NotFoundError(`Template ${templateId}`);
    }
    
    // Convert dynamic sections to legacy format for template generation
    const resumeData = convertDynamicToLegacy(sections);
    
    // Generate DOCX from template
    const docxBuffer = await generateFromTemplate(resumeData, templatePath);
    
    const filename = sanitizeFilename(templateId) + '-preview.docx';
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', docxBuffer.length);
    res.send(docxBuffer);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== EXPORT PDF FROM DYNAMIC DATA (no auth required for preview) ====================
router.post('/export/pdf-preview', requireAuth, async (req, res) => {
  try {
    const { sections } = req.body;
    
    if (!sections || typeof sections !== 'object') {
      throw new BadRequestError('sections object is required');
    }
    
    // Convert dynamic sections to legacy format for PDF generation
    const resumeData = convertDynamicToLegacy(sections);
    
    // Generate PDF
    const pdfBuffer = await generatePdf(resumeData);
    
    const filename = 'resume-preview.pdf';
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    handleApiError(error, res);
  }
});

/**
 * Convert dynamic section data to legacy ResumeData format
 * Used for template generation compatibility
 */
function convertDynamicToLegacy(sections: Record<string, DynamicSectionData>): ResumeData {
  // Extract header/personal info
  const headerEntry = (sections.header?.entries?.[0] || {}) as Record<string, unknown>;
  const personalInfo: PersonalInfo = {
    fullName: String(headerEntry.fullName || ''),
    email: String(headerEntry.email || ''),
    phone: String(headerEntry.phone || ''),
    location: String(headerEntry.location || ''),
    linkedin: String(headerEntry.linkedin || ''),
    website: String(headerEntry.website || ''),
  };
  
  // Extract summary
  const summary = (sections.summary?.value as string) || '';
  
  // Extract experience
  const experience: ExperienceItem[] = (sections.experience?.entries || []).map((entry, idx) => ({
    id: (entry.id as string) || `exp-${idx}`,
    title: (entry.title as string) || '',
    company: (entry.company as string) || '',
    startDate: (entry.startDate as string) || '',
    endDate: (entry.endDate as string) || '',
    description: (entry.description as string) || '',
    bullets: Array.isArray(entry.bullets) ? entry.bullets as string[] : [],
  }));
  
  // Extract education
  const education: EducationItem[] = (sections.education?.entries || []).map((entry, idx) => ({
    id: (entry.id as string) || `edu-${idx}`,
    degree: (entry.degree as string) || '',
    institution: (entry.institution as string) || '',
    field: (entry.field as string) || '',
    graduationYear: (entry.graduationYear as string) || '',
  }));
  
  // Extract skills
  let skills: string[] = [];
  if (Array.isArray(sections.skills?.value)) {
    skills = sections.skills.value as string[];
  } else if (typeof sections.skills?.value === 'string') {
    skills = sections.skills.value.split(',').map(s => s.trim()).filter(Boolean);
  }
  
  return {
    id: 'preview',
    name: 'Preview Resume',
    personalInfo,
    summary,
    experience,
    education,
    skills,
  };
}

// Dynamic section data type for the converter
interface DynamicSectionData {
  value?: string | string[];
  entries?: Array<Record<string, unknown> & { id: string }>;
}

// ==================== EXPORT PDF ====================
router.get('/:id/export/pdf', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const resume = await prisma.resume.findUnique({ where: { id } });
    
    if (!resume) {
      throw new NotFoundError('Resume');
    }
    
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');
    
    // Generate PDF
    const pdfBuffer = await generatePdf(resume as any);
    
    const filename = sanitizeFilename(resume.name) + '.pdf';
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== EXPORT DOCX ====================
router.get('/:id/export/docx', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { template: templateParam } = req.query;
    
    const resume = await prisma.resume.findUnique({ where: { id } });
    
    if (!resume) {
      throw new NotFoundError('Resume');
    }
    
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');
    
    // Determine which template to use
    const templateId = (templateParam as string) || resume.templateId || 'professional-standard';
    const templatePath = path.join(TEMPLATES_DIR, `${templateId}.docx`);
    
    let docxBuffer: Buffer;
    
    // Check if a template file exists for this template ID
    if (fs.existsSync(templatePath)) {
      // Use template-based generation
      docxBuffer = await generateFromTemplate(resume as any, templatePath);
    } else {
      // Fall back to programmatic generation
      const doc = createDocxDocument(resume as any);
      docxBuffer = await Packer.toBuffer(doc);
    }
    
    const filename = sanitizeFilename(resume.name) + '.docx';
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', docxBuffer.length);
    res.send(docxBuffer);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== HELPER FUNCTIONS ====================

// ==================== TEMPLATE-BASED GENERATION ====================

/**
 * Generate DOCX from a template file using docxtemplater
 * Template should use {{placeholder}} syntax
 */
async function generateFromTemplate(resume: ResumeData, templatePath: string): Promise<Buffer> {
  // Load the template file
  const templateBuffer = fs.readFileSync(templatePath);
  
  // Create a zip from the template
  let zip;
  try {
    zip = new PizZip(templateBuffer);
  } catch (err) {
    console.error('[DOCX Export] Failed to parse template zip:', err);
    throw new BadRequestError('Template file is corrupted or invalid');
  }
  
  // Initialize docxtemplater with proper error handling
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    delimiters: {
      start: '{{',
      end: '}}'
    },
    // Handle undefined values gracefully - replace with empty string
    nullGetter: () => '',
    // Don't throw on unknown tags - just leave them empty
    parser: (tag: string) => {
      return {
        get: (scope: Record<string, unknown>) => {
          // Handle nested paths like "experience.title"
          const parts = tag.split('.');
          let value: unknown = scope;
          for (const part of parts) {
            if (value && typeof value === 'object') {
              value = (value as Record<string, unknown>)[part];
            } else {
              value = undefined;
              break;
            }
          }
          return value ?? '';
        }
      };
    }
  });
  
  const { personalInfo, experience, education, skills, summary } = resume;
  
  // Prepare data for template - supports both simple and loop syntax
  const data: Record<string, unknown> = {
    // Personal info - flatten for simple templates
    fullName: personalInfo?.fullName || '',
    name: personalInfo?.fullName || '',
    email: personalInfo?.email || '',
    phone: personalInfo?.phone || '',
    location: personalInfo?.location || '',
    linkedin: personalInfo?.linkedin || '',
    website: personalInfo?.website || '',
    
    // Contact line (combined)
    contactLine: [
      personalInfo?.email,
      personalInfo?.phone,
      personalInfo?.location
    ].filter(Boolean).join(' | '),
    
    // Links line
    linksLine: [
      personalInfo?.linkedin,
      personalInfo?.website
    ].filter(Boolean).join(' | '),
    
    // Summary variations
    summary: summary || '',
    professionalSummary: summary || '',
    objective: summary || '',
    hasSummary: Boolean(summary && summary.trim()),
    
    // Experience section - for loops in template
    experience: (experience || []).map(exp => ({
      title: exp.title || '',
      position: exp.title || '',
      jobTitle: exp.title || '',
      company: exp.company || '',
      employer: exp.company || '',
      organization: exp.company || '',
      startDate: exp.startDate || '',
      endDate: exp.endDate || '',
      dateRange: `${exp.startDate || ''} - ${exp.endDate || ''}`,
      dates: `${exp.startDate || ''} - ${exp.endDate || ''}`,
      description: exp.description || '',
      responsibilities: exp.description || '',
      bullets: (exp.bullets || []).map(bullet => ({ text: bullet, bullet })),
      bulletsText: (exp.bullets || []).map(b => `• ${b}`).join('\n'),
      achievements: (exp.bullets || []).map(b => `• ${b}`).join('\n'),
      hasBullets: (exp.bullets || []).length > 0
    })),
    hasExperience: (experience || []).length > 0,
    
    // Education section - for loops in template
    education: (education || []).map(edu => ({
      degree: edu.degree || '',
      field: edu.field || '',
      major: edu.field || '',
      institution: edu.institution || '',
      university: edu.institution || '',
      school: edu.institution || '',
      graduationYear: edu.graduationYear || '',
      year: edu.graduationYear || '',
      graduationDate: edu.graduationYear || '',
      degreeAndField: [edu.degree, edu.field].filter(Boolean).join(' in ')
    })),
    hasEducation: (education || []).length > 0,
    
    // Skills section
    skills: (skills || []).join(', '),
    skillsList: (skills || []).map(skill => ({ name: skill, skill })),
    technicalSkills: (skills || []).join(', '),
    hasSkills: (skills || []).length > 0
  };
  
  try {
    // Render the document with data
    doc.render(data);
  } catch (err: unknown) {
    const error = err as { properties?: { errors?: unknown[] }; message?: string };
    console.error('[DOCX Export] Template render error:', error);
    
    // Log specific errors for debugging
    if (error.properties && error.properties.errors) {
      console.error('[DOCX Export] Render errors:', JSON.stringify(error.properties.errors, null, 2));
    }
    
    throw new BadRequestError(`Template rendering failed: ${error.message || 'Unknown error'}`);
  }
  
  // Generate output buffer with proper settings for Windows compatibility
  const outputBuffer = doc.getZip().generate({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {
      level: 9
    },
    // Force UNIX mode for cross-platform compatibility
    platform: 'UNIX'
  });
  
  return outputBuffer;
}

interface PersonalInfo {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin?: string;
  website?: string;
}

interface ExperienceItem {
  id: string;
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  description?: string;
  bullets: string[];
}

interface EducationItem {
  id: string;
  degree: string;
  institution: string;
  field: string;
  graduationYear: string;
}

interface ResumeData {
  id: string;
  name: string;
  personalInfo: PersonalInfo;
  summary: string;
  experience: ExperienceItem[];
  education: EducationItem[];
  skills: string[];
  templateSettings?: {
    marginX?: number;
    marginY?: number;
    fontSize?: number;
    lineSpacing?: number;
  };
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\.\./g, '')
    .substring(0, 100)
    .trim() || 'resume';
}

function createDocxDocument(resume: ResumeData): Document {
  const personalInfo = resume.personalInfo as PersonalInfo;
  const experience = resume.experience as ExperienceItem[] || [];
  const education = resume.education as EducationItem[] || [];
  const skills = resume.skills as string[] || [];
  
  const children: any[] = [];
  
  // Header - Name
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: personalInfo?.fullName || 'Your Name',
          bold: true,
          size: 32,
        }),
      ],
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
    })
  );
  
  // Contact info
  const contactParts: string[] = [];
  if (personalInfo?.email) contactParts.push(personalInfo.email);
  if (personalInfo?.phone) contactParts.push(personalInfo.phone);
  if (personalInfo?.location) contactParts.push(personalInfo.location);
  
  if (contactParts.length > 0) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: contactParts.join(' | '), size: 20 })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      })
    );
  }
  
  // Summary
  if (resume.summary) {
    children.push(createSectionHeader('Professional Summary'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: resume.summary, size: 22 })],
        spacing: { after: 200 },
      })
    );
  }
  
  // Experience
  if (experience.length > 0) {
    children.push(createSectionHeader('Work Experience'));
    
    for (const exp of experience) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: exp.title, bold: true, size: 22 }),
            new TextRun({ text: ` at ${exp.company}`, size: 22 }),
          ],
          spacing: { before: 100 },
        })
      );
      
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `${exp.startDate} - ${exp.endDate}`, italics: true, size: 20 })],
          spacing: { after: 50 },
        })
      );
      
      for (const bullet of exp.bullets || []) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: `\u2022 ${bullet}`, size: 22 })],
            indent: { left: 360 },
            spacing: { after: 50 },
          })
        );
      }
    }
  }
  
  // Education
  if (education.length > 0) {
    children.push(createSectionHeader('Education'));
    
    for (const edu of education) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: edu.degree, bold: true, size: 22 }),
            new TextRun({ text: ` in ${edu.field}`, size: 22 }),
          ],
          spacing: { before: 100 },
        })
      );
      
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `${edu.institution} - ${edu.graduationYear}`, italics: true, size: 20 })],
          spacing: { after: 100 },
        })
      );
    }
  }
  
  // Skills
  if (skills.length > 0) {
    children.push(createSectionHeader('Skills'));
    children.push(
      new Paragraph({
        children: [new TextRun({ text: skills.join(', '), size: 22 })],
        spacing: { after: 200 },
      })
    );
  }
  
  return new Document({
    sections: [{ properties: { page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, children }],
  });
}

function createSectionHeader(title: string): any {
  return new Paragraph({
    children: [new TextRun({ text: title.toUpperCase(), bold: true, size: 24 })],
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 200, after: 100 },
    border: { bottom: { color: '000000', space: 1, style: BorderStyle.SINGLE, size: 6 } },
  });
}

async function generatePdf(resume: ResumeData): Promise<Buffer> {
  const html = generateResumeHtml(resume);

  let browser;
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    return Buffer.from(pdfBuffer);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

function generateResumeHtml(resume: ResumeData): string {
  const personalInfo = resume.personalInfo as PersonalInfo;
  const experience = resume.experience as ExperienceItem[] || [];
  const education = resume.education as EducationItem[] || [];
  const skills = resume.skills as string[] || [];
  const settings = resume.templateSettings || {};
  
  const fontSize = settings.fontSize || 11;
  const lineSpacing = settings.lineSpacing || 1.4;
  const marginX = settings.marginX || 0.75;
  const marginY = settings.marginY || 0.75;
  
  const escape = (text: string): string => {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };
  
  const contactParts: string[] = [];
  if (personalInfo?.email) contactParts.push(escape(personalInfo.email));
  if (personalInfo?.phone) contactParts.push(escape(personalInfo.phone));
  if (personalInfo?.location) contactParts.push(escape(personalInfo.location));
  
  const experienceHtml = experience.map(exp => `
    <div class="experience-item">
      <div class="job-header">
        <span class="job-title">${escape(exp.title)}</span>
        <span class="company"> at ${escape(exp.company)}</span>
      </div>
      <div class="dates">${escape(exp.startDate)} - ${escape(exp.endDate)}</div>
      <ul class="bullets">
        ${(exp.bullets || []).map(b => `<li>${escape(b)}</li>`).join('')}
      </ul>
    </div>
  `).join('');
  
  const educationHtml = education.map(edu => `
    <div class="education-item">
      <div class="degree"><strong>${escape(edu.degree)}</strong> in ${escape(edu.field)}</div>
      <div class="institution">${escape(edu.institution)} - ${escape(edu.graduationYear)}</div>
    </div>
  `).join('');
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Times New Roman', Georgia, serif;
      font-size: ${fontSize}pt;
      line-height: ${lineSpacing};
      color: #000;
      padding: ${marginY}in ${marginX}in;
    }
    .header { text-align: center; margin-bottom: 16px; }
    .name { font-size: 18pt; font-weight: bold; margin-bottom: 4px; }
    .contact { font-size: 10pt; color: #333; }
    .section { margin-bottom: 12px; }
    .section-title {
      font-size: 12pt; font-weight: bold; text-transform: uppercase;
      border-bottom: 1px solid #000; padding-bottom: 2px; margin-bottom: 8px;
    }
    .summary { text-align: justify; }
    .experience-item, .education-item { margin-bottom: 10px; }
    .job-title { font-weight: bold; }
    .dates, .institution { font-style: italic; font-size: 10pt; color: #333; }
    .bullets { margin-left: 20px; margin-top: 4px; }
    .bullets li { margin-bottom: 2px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="name">${escape(personalInfo?.fullName || 'Your Name')}</div>
    ${contactParts.length > 0 ? `<div class="contact">${contactParts.join(' | ')}</div>` : ''}
  </div>
  
  ${resume.summary ? `
  <div class="section">
    <div class="section-title">Professional Summary</div>
    <div class="summary">${escape(resume.summary)}</div>
  </div>
  ` : ''}
  
  ${experience.length > 0 ? `
  <div class="section">
    <div class="section-title">Work Experience</div>
    ${experienceHtml}
  </div>
  ` : ''}
  
  ${education.length > 0 ? `
  <div class="section">
    <div class="section-title">Education</div>
    ${educationHtml}
  </div>
  ` : ''}
  
  ${skills.length > 0 ? `
  <div class="section">
    <div class="section-title">Skills</div>
    <div>${skills.map(s => escape(s)).join(', ')}</div>
  </div>
  ` : ''}
</body>
</html>
  `;
}

export default router;
