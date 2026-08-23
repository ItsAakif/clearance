// Template Routes - Get available resume templates with dynamic section analysis
// Analyzes DOCX templates to extract section structure for form generation
// Updated: Force hot-reload after metadata changes

import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { 
  SectionDefinition, 
  analyzeAllTemplates, 
  getTemplateMetadata, 
  clearTemplateCache 
} from '../templates/analyzer.js';
import { CATEGORY_INFO, getTemplateDisplayInfo } from '../templates/metadata.js';
import { handleApiError } from '../shared/errors.js';

const router = Router();

// Template directory
const TEMPLATES_DIR = path.join(__dirname, '../../templates');

// Infer template category from template ID
function inferCategory(templateId: string): 'classic' | 'modern' | 'minimal' | 'creative' | 'professional' {
  const lowerName = templateId.toLowerCase();
  
  if (lowerName.includes('graphic') || lowerName.includes('design') || lowerName === 'desinger') {
    return 'creative';
  }
  if (lowerName.includes('minimal') || lowerName.includes('ats')) {
    return 'minimal';
  }
  if (lowerName.includes('marketing') || lowerName.includes('marketting') || lowerName.includes('2column')) {
    return 'modern';
  }
  if (lowerName === 'classic' || lowerName === 'standard' || lowerName === 'bullets' || lowerName === 'descriptive') {
    return 'classic';
  }
  if (lowerName.includes('professional') || lowerName.includes('accountant')) {
    return 'professional';
  }
  
  return 'classic'; // Default to classic
}

// Default template settings (styling options)
const DEFAULT_TEMPLATE_SETTINGS = {
  marginX: 0.75,
  marginY: 0.75,
  fontSize: 11,
  lineSpacing: 1.4,
  sectionSpacing: 1.5,
  primaryColor: '#000000',
  accentColor: '#2563eb'
};

const SAMPLE_PREVIEW_DATA = {
  fullName: 'Jordan Avery',
  title: 'Senior Product Designer',
  summary:
    'Design leader with 7 years of experience shipping user-centered products across SaaS, growth, and platform teams.',
  highlights: [
    'Led redesign that improved activation by 28%',
    'Built design systems adopted by 4 cross-functional teams',
    'Partnered with engineering and PM to ship ATS-safe resume workflows',
  ],
  skills: ['Figma', 'Design Systems', 'Product Strategy', 'User Research', 'Accessibility', 'Prototyping'],
};

function getPreviewPalette(category: string) {
  switch (category) {
    case 'creative':
      return { accent: '#d97706', muted: '#fff7ed', line: '#fed7aa' };
    case 'minimal':
      return { accent: '#166534', muted: '#f0fdf4', line: '#bbf7d0' };
    case 'modern':
      return { accent: '#1d4ed8', muted: '#eff6ff', line: '#bfdbfe' };
    case 'professional':
      return { accent: '#0f172a', muted: '#f8fafc', line: '#cbd5e1' };
    default:
      return { accent: '#334155', muted: '#f8fafc', line: '#cbd5e1' };
  }
}

function buildPreviewHtml(templateName: string, category: string, sectionCount: number) {
  const palette = getPreviewPalette(category);
  const sectionBadges = Array.from({ length: Math.max(3, Math.min(sectionCount, 6)) })
    .map(
      (_, index) =>
        `<span style="padding:6px 10px;border-radius:999px;background:${palette.muted};color:${palette.accent};font-size:12px;font-weight:600;">Section ${index + 1}</span>`
    )
    .join('');

  const highlights = SAMPLE_PREVIEW_DATA.highlights
    .map(
      (highlight) =>
        `<li style="margin:0 0 10px 18px;color:#334155;font-size:13px;line-height:1.5;">${highlight}</li>`
    )
    .join('');

  const skills = SAMPLE_PREVIEW_DATA.skills
    .map(
      (skill) =>
        `<span style="display:inline-block;margin:0 8px 8px 0;padding:6px 10px;border-radius:999px;border:1px solid ${palette.line};font-size:12px;color:#334155;">${skill}</span>`
    )
    .join('');

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 32px;
          background: #e2e8f0;
          font-family: "Segoe UI", Arial, sans-serif;
        }
        .sheet {
          width: 816px;
          min-height: 1056px;
          margin: 0 auto;
          background: white;
          border-radius: 18px;
          overflow: hidden;
          box-shadow: 0 30px 80px rgba(15, 23, 42, 0.18);
        }
        .hero {
          padding: 40px 44px 28px;
          background: linear-gradient(135deg, ${palette.muted} 0%, #ffffff 70%);
          border-bottom: 1px solid ${palette.line};
        }
        .eyebrow {
          color: ${palette.accent};
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .name {
          margin: 10px 0 6px;
          color: #0f172a;
          font-size: 34px;
          font-weight: 700;
        }
        .role {
          color: #475569;
          font-size: 18px;
        }
        .summary {
          margin-top: 18px;
          color: #334155;
          font-size: 14px;
          line-height: 1.6;
        }
        .content {
          padding: 28px 44px 40px;
        }
        .meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 22px;
        }
        .template {
          color: #0f172a;
          font-size: 18px;
          font-weight: 700;
        }
        .grid {
          display: grid;
          grid-template-columns: 1.5fr 0.9fr;
          gap: 24px;
        }
        .panel {
          border: 1px solid ${palette.line};
          border-radius: 16px;
          padding: 18px;
        }
        .panel-title {
          color: ${palette.accent};
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          margin-bottom: 14px;
        }
      </style>
    </head>
    <body>
      <div class="sheet">
        <section class="hero">
          <div class="eyebrow">${category} template</div>
          <div class="name">${SAMPLE_PREVIEW_DATA.fullName}</div>
          <div class="role">${SAMPLE_PREVIEW_DATA.title}</div>
          <p class="summary">${SAMPLE_PREVIEW_DATA.summary}</p>
        </section>
        <section class="content">
          <div class="meta">
            <div class="template">${templateName}</div>
            <div>${sectionBadges}</div>
          </div>
          <div class="grid">
            <div class="panel">
              <div class="panel-title">Experience Highlights</div>
              <ul style="margin:0;padding:0;">${highlights}</ul>
            </div>
            <div class="panel">
              <div class="panel-title">Core Skills</div>
              <div>${skills}</div>
            </div>
          </div>
        </section>
      </div>
    </body>
  </html>`;
}

/**
 * Fallback templates when no DOCX files are found
 */
interface FallbackTemplate {
  id: string;
  name: string;
  fileName: string;
  description: string;
  category: string;
  tags: string[];
  recommended: string[];
  isAtsOptimized: boolean;
  sections: SectionDefinition[];
  sectionCount: number;
  placeholders: string[];
  defaultSettings: typeof DEFAULT_TEMPLATE_SETTINGS;
}

const FALLBACK_TEMPLATES: FallbackTemplate[] = [
  {
    id: 'professional-standard',
    name: 'Professional Standard',
    fileName: 'professional-standard.docx',
    description: 'A clean, ATS-optimized template suitable for any profession.',
    category: 'professional',
    tags: ['ats-friendly', 'clean', 'versatile'],
    recommended: ['All Roles'],
    isAtsOptimized: true,
    sections: [],
    sectionCount: 5,
    placeholders: [],
    defaultSettings: DEFAULT_TEMPLATE_SETTINGS
  }
];

// Initialize fallback sections lazily
function getFallbackTemplates(): FallbackTemplate[] {
  const sections = getDefaultSections();
  return FALLBACK_TEMPLATES.map(t => ({
    ...t,
    sections,
    sectionCount: sections.length
  }));
}

/**
 * Default sections when no template is analyzed
 */
function getDefaultSections(): SectionDefinition[] {
  return [
    {
      id: 'header',
      name: 'Personal Information',
      type: 'header',
      order: 0,
      isRepeatable: false,
      fields: [
        { name: 'fullName', label: 'Full Name', type: 'text', required: true },
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'phone', label: 'Phone', type: 'phone' },
        { name: 'location', label: 'Location', type: 'text' },
        { name: 'linkedin', label: 'LinkedIn', type: 'url' },
        { name: 'website', label: 'Website', type: 'url' }
      ]
    },
    {
      id: 'summary',
      name: 'Professional Summary',
      type: 'text',
      order: 1,
      isRepeatable: false,
      fields: [
        { name: 'summary', label: 'Summary', type: 'textarea' }
      ]
    },
    {
      id: 'experience',
      name: 'Work Experience',
      type: 'entries',
      order: 2,
      isRepeatable: true,
      fields: [
        { name: 'title', label: 'Job Title', type: 'text', required: true },
        { name: 'company', label: 'Company', type: 'text', required: true },
        { name: 'startDate', label: 'Start Date', type: 'text' },
        { name: 'endDate', label: 'End Date', type: 'text' },
        { name: 'bullets', label: 'Achievements', type: 'list' }
      ]
    },
    {
      id: 'education',
      name: 'Education',
      type: 'entries',
      order: 3,
      isRepeatable: true,
      fields: [
        { name: 'degree', label: 'Degree', type: 'text', required: true },
        { name: 'field', label: 'Field of Study', type: 'text' },
        { name: 'institution', label: 'Institution', type: 'text', required: true },
        { name: 'graduationYear', label: 'Graduation Year', type: 'text' }
      ]
    },
    {
      id: 'skills',
      name: 'Skills',
      type: 'list',
      order: 4,
      isRepeatable: false,
      fields: [
        { name: 'skills', label: 'Skills', type: 'list' }
      ]
    }
  ];
}

// ==================== GET ALL TEMPLATES ====================
// Returns list of available templates with their sections
router.get('/', async (req, res) => {
  try {
    // Check if templates directory exists and has .docx files
    if (fs.existsSync(TEMPLATES_DIR)) {
      const docxFiles = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.docx'));
      
      if (docxFiles.length > 0) {
        // Analyze all templates and return metadata
        const templates = analyzeAllTemplates(TEMPLATES_DIR);
        
        const response = templates.map(t => {
          const displayInfo = getTemplateDisplayInfo(t.id);
          // Use inferCategory to ensure correct category is returned
          const category = inferCategory(t.id);
          return {
            id: t.id,
            name: displayInfo.name,
            fileName: t.fileName,
            description: displayInfo.description,
            category: category,
            tags: displayInfo.tags,
            recommended: displayInfo.recommended,
            isAtsOptimized: true,
            sections: t.sections,
            sectionCount: t.sections.length,
            placeholders: t.placeholders,
            sampleContent: t.sampleContent,
            defaultSettings: DEFAULT_TEMPLATE_SETTINGS,
            analyzedAt: t.analyzedAt
          };
        });
        
        return res.json(response);
      }
    }
    
    // No templates found - return fallback
    res.json(getFallbackTemplates());
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET SINGLE TEMPLATE ====================
// Returns detailed metadata for a specific template
router.get('/meta/categories', async (_req, res) => {
  res.json(CATEGORY_INFO);
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const templatePath = path.join(TEMPLATES_DIR, `${id}.docx`);
    
    if (!fs.existsSync(templatePath)) {
      // Check fallback
      const fallbacks = getFallbackTemplates();
      const fallback = fallbacks.find(t => t.id === id);
      if (fallback) {
        return res.json(fallback);
      }
      return res.status(404).json({ error: 'Template not found' });
    }
    
    const metadata = getTemplateMetadata(templatePath, id);
    
    if (!metadata) {
      return res.status(500).json({ error: 'Failed to analyze template' });
    }
    
    const displayInfo = getTemplateDisplayInfo(id);
    const category = inferCategory(id);
    
    res.json({
      id: metadata.id,
      name: displayInfo.name,
      fileName: metadata.fileName,
      description: displayInfo.description,
      category: category,
      tags: displayInfo.tags,
      recommended: displayInfo.recommended,
      sections: metadata.sections,
      sectionCount: metadata.sections.length,
      placeholders: metadata.placeholders,
      sampleContent: metadata.sampleContent,
      defaultSettings: DEFAULT_TEMPLATE_SETTINGS,
      analyzedAt: metadata.analyzedAt
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== REFRESH TEMPLATES ====================
// Force re-analyze all templates (clear cache)
router.post('/refresh', requireAuth, requireAdmin, async (req, res) => {
  try {
    clearTemplateCache();
    
    if (!fs.existsSync(TEMPLATES_DIR)) {
      return res.json({ message: 'No templates directory found', templates: 0 });
    }
    
    const templates = analyzeAllTemplates(TEMPLATES_DIR);
    
    res.json({
      message: 'Templates refreshed',
      templates: templates.length,
      ids: templates.map(t => t.id)
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GENERATE PREVIEW IMAGES ====================
router.post('/generate-previews', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const templates = fs.existsSync(TEMPLATES_DIR) && fs.readdirSync(TEMPLATES_DIR).some((file) => file.endsWith('.docx'))
      ? analyzeAllTemplates(TEMPLATES_DIR).map((template) => ({
          id: template.id,
          name: getTemplateDisplayInfo(template.id).name,
          category: inferCategory(template.id),
          sectionCount: template.sections.length,
        }))
      : getFallbackTemplates().map((template) => ({
          id: template.id,
          name: template.name,
          category: inferCategory(template.id),
          sectionCount: template.sectionCount,
        }));

    const previewDir = path.join(__dirname, '../../previews');
    fs.mkdirSync(previewDir, { recursive: true });

    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const generated: Array<{ id: string; url: string }> = [];

    try {
      for (const template of templates) {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 900, height: 1200 });
        await page.setContent(buildPreviewHtml(template.name, template.category, template.sectionCount), {
          waitUntil: 'networkidle',
        });

        const outputPath = path.join(previewDir, `${template.id}.png`);
        await page.screenshot({ path: outputPath, type: 'png', fullPage: true });
        await page.close();

        generated.push({
          id: template.id,
          url: `/api/previews/${template.id}.png`,
        });
      }
    } finally {
      await browser.close();
    }

    res.json({
      generated: generated.length,
      previews: generated,
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET TEMPLATE SECTIONS ====================
// Quick endpoint to get just the sections for a template (for form rendering)
router.get('/:id/sections', async (req, res) => {
  try {
    const { id } = req.params;
    const templatePath = path.join(TEMPLATES_DIR, `${id}.docx`);
    
    if (!fs.existsSync(templatePath)) {
      // Return default sections
      return res.json(getDefaultSections());
    }
    
    const metadata = getTemplateMetadata(templatePath, id);
    
    if (!metadata) {
      return res.json(getDefaultSections());
    }
    
    res.json(metadata.sections);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET TEMPLATE DOCX BLOB FOR PREVIEW ====================
// Returns the actual DOCX file with text replacement for browser rendering
// Uses find-replace on original template text instead of {{placeholder}} substitution
router.post('/:id/preview-blob', async (req, res) => {
  try {
    const { id } = req.params;
    const { sections, originalValues } = req.body;
    
    const templatePath = path.join(TEMPLATES_DIR, `${id}.docx`);
    
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: `Template ${id} not found` });
    }
    
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PizZip = require('pizzip');
    
    const templateBuffer = fs.readFileSync(templatePath);
    
    let zip;
    try {
      zip = new PizZip(templateBuffer);
    } catch (err) {
      console.error('[Preview] Failed to parse template zip:', err);
      return res.status(500).json({ error: 'Template file is corrupted or invalid' });
    }
    
    const headerEntry = (sections?.header?.entries?.[0] || {}) as Record<string, unknown>;
    const experience = (sections?.experience?.entries || []) as Array<Record<string, unknown>>;
    const education = (sections?.education?.entries || []) as Array<Record<string, unknown>>;
    const summary = (sections?.summary?.value as string) || '';
    let skills: string[] = [];
    if (Array.isArray(sections?.skills?.value)) {
      skills = sections.skills.value as string[];
    } else if (typeof sections?.skills?.value === 'string') {
      skills = sections.skills.value.split(',').map((s: string) => s.trim()).filter(Boolean);
    }
    
    const docXmlFile = zip.file('word/document.xml');
    if (!docXmlFile) {
      return res.status(500).json({ error: 'Invalid DOCX: missing document.xml' });
    }
    
    let xmlContent = docXmlFile.asText();
    
    const escapeXml = (text: string): string => {
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };
    
    const escapeRegex = (text: string): string => {
      return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };
    
    const safeReplace = (xml: string, original: string, replacement: string): string => {
      if (!original || original.trim().length === 0) return xml;
      
      const escapedOriginal = escapeRegex(original);
      const escapedReplacement = escapeXml(replacement);
      
      try {
        const regex = new RegExp(escapedOriginal, 'g');
        return xml.replace(regex, escapedReplacement);
      } catch {
        return xml;
      }
    };
    
    const origVals = (originalValues || {}) as Record<string, string>;
    
    if (origVals['fullName'] && headerEntry.fullName) {
      xmlContent = safeReplace(xmlContent, origVals['fullName'], String(headerEntry.fullName));
    }
    if (origVals['email'] && headerEntry.email) {
      xmlContent = safeReplace(xmlContent, origVals['email'], String(headerEntry.email));
    }
    if (origVals['phone'] && headerEntry.phone) {
      xmlContent = safeReplace(xmlContent, origVals['phone'], String(headerEntry.phone));
    }
    if (origVals['location'] && headerEntry.location) {
      xmlContent = safeReplace(xmlContent, origVals['location'], String(headerEntry.location));
    }
    if (origVals['summary'] && summary) {
      xmlContent = safeReplace(xmlContent, origVals['summary'], summary);
    }
    if (origVals['skills'] && skills.length > 0) {
      xmlContent = safeReplace(xmlContent, origVals['skills'], skills.join(', '));
    }
    
    experience.forEach((exp, idx) => {
      const origTitle = origVals[`exp_${idx}_title`];
      const origCompany = origVals[`exp_${idx}_company`];
      if (origTitle && exp.title) {
        xmlContent = safeReplace(xmlContent, origTitle, String(exp.title));
      }
      if (origCompany && exp.company) {
        xmlContent = safeReplace(xmlContent, origCompany, String(exp.company));
      }
    });
    
    education.forEach((edu, idx) => {
      const origInstitution = origVals[`edu_${idx}_institution`];
      const origDegree = origVals[`edu_${idx}_degree`];
      if (origInstitution && edu.institution) {
        xmlContent = safeReplace(xmlContent, origInstitution, String(edu.institution));
      }
      if (origDegree && edu.degree) {
        xmlContent = safeReplace(xmlContent, origDegree, String(edu.degree));
      }
    });
    
    const placeholderRegex = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
    const placeholderData: Record<string, string> = {
      fullName: String(headerEntry.fullName || ''),
      name: String(headerEntry.fullName || ''),
      email: String(headerEntry.email || ''),
      phone: String(headerEntry.phone || ''),
      location: String(headerEntry.location || ''),
      linkedin: String(headerEntry.linkedin || ''),
      website: String(headerEntry.website || ''),
      summary: summary,
      professionalSummary: summary,
      skills: skills.join(', '),
    };
    
    xmlContent = xmlContent.replace(placeholderRegex, (match: string, key: string) => {
      return placeholderData[key] !== undefined ? escapeXml(placeholderData[key]) : match;
    });
    
    zip.file('word/document.xml', xmlContent);
    
    const outputBuffer = zip.generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
      platform: 'UNIX'
    });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `inline; filename="${id}-preview.docx"`);
    res.setHeader('Content-Length', outputBuffer.length);
    res.send(outputBuffer);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET TEMPLATE PREVIEW IMAGE ====================
// Generates a preview image of the template with sample data
router.get('/:id/preview', async (req, res) => {
  try {
    const { id } = req.params;
    const templatePath = path.join(TEMPLATES_DIR, `${id}.docx`);
    
    // Check for cached preview first
    const previewDir = path.join(__dirname, '../../previews');
    const previewPath = path.join(previewDir, `${id}.png`);
    
    if (fs.existsSync(previewPath)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 24 hour cache
      return res.sendFile(previewPath);
    }
    
    // Return placeholder if template doesn't exist
    if (!fs.existsSync(templatePath)) {
      return res.status(404).json({ error: 'Template not found' });
    }
    
    // Return a simple placeholder response - previews need to be pre-generated
    // The /generate-previews endpoint will create them
    res.status(202).json({ 
      message: 'Preview not yet generated',
      generateUrl: `/api/templates/generate-previews`
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
