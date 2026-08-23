// Template Metadata - Human-readable names, descriptions, and categories
// Maps template IDs (filenames without .docx) to display information

export type TemplateCategory = 'classic' | 'modern' | 'minimal' | 'creative' | 'professional';

export interface TemplateDisplayInfo {
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  recommended?: string[]; // Job types this template is best for
  previewImage?: string; // Path to preview image
}

// Template display information mapped by ID (filename without .docx)
export const TEMPLATE_METADATA: Record<string, TemplateDisplayInfo> = {
  // ==================== CLASSIC TEMPLATES ====================
  'Classic': {
    name: 'Classic',
    description: 'Traditional single-column layout. Clean, timeless, and universally accepted.',
    category: 'classic',
    tags: ['traditional', 'single-column', 'ats-friendly'],
    recommended: ['Any Role', 'Corporate', 'Finance'],
  },
  
  'Standard': {
    name: 'Standard',
    description: 'Industry-standard resume format. Works perfectly for corporate and traditional roles.',
    category: 'classic',
    tags: ['standard', 'versatile', 'ats-friendly'],
    recommended: ['Any Role', 'Business', 'Administration'],
  },
  
  'Bullets': {
    name: 'Bullets',
    description: 'Achievement-focused layout with prominent bullet points for easy scanning.',
    category: 'classic',
    tags: ['bullet-points', 'achievements', 'ats-friendly'],
    recommended: ['Sales', 'Marketing', 'Management'],
  },
  
  'descriptive': {
    name: 'Descriptive',
    description: 'Detailed format with room for comprehensive job descriptions and project details.',
    category: 'classic',
    tags: ['detailed', 'comprehensive', 'ats-friendly'],
    recommended: ['Research', 'Academic', 'Technical Writing'],
  },
  
  'Accountant': {
    name: 'Accountant',
    description: 'Structured layout perfect for finance, accounting, and analytical roles.',
    category: 'professional',
    tags: ['finance', 'structured', 'ats-friendly'],
    recommended: ['Accountant', 'Financial Analyst', 'Auditor'],
  },
  
  // ==================== PROFESSIONAL TEMPLATES ====================
  'Professional-Standard(Make-this-default)': {
    name: 'Professional Standard',
    description: 'Clean, professional layout with excellent ATS compatibility. Recommended default.',
    category: 'professional',
    tags: ['professional', 'default', 'ats-optimized'],
    recommended: ['Any Role', 'Corporate', 'Enterprise'],
  },
  
  // ==================== MINIMAL TEMPLATES ====================
  'ats-minimilistic': {
    name: 'ATS Minimalistic',
    description: 'Ultra-clean design optimized specifically for Applicant Tracking Systems.',
    category: 'minimal',
    tags: ['minimal', 'ats-optimized', 'clean'],
    recommended: ['Tech', 'Startup', 'Any Role'],
  },
  
  'Minimalist_1': {
    name: 'Minimalist',
    description: 'Clean and elegant with maximum white space. Lets your content shine.',
    category: 'minimal',
    tags: ['minimal', 'elegant', 'whitespace'],
    recommended: ['Designer', 'Developer', 'Creative'],
  },
  
  'minimalist_2column': {
    name: 'Minimalist Two Column',
    description: 'Modern two-column layout with clean lines and organized sections.',
    category: 'modern',
    tags: ['two-column', 'modern', 'organized'],
    recommended: ['Tech', 'Marketing', 'Consulting'],
  },
  
  'Minimal-Green': {
    name: 'Minimal Green',
    description: 'Minimalist design with subtle green accents for a fresh, modern look.',
    category: 'minimal',
    tags: ['minimal', 'green', 'fresh'],
    recommended: ['Healthcare', 'Environmental', 'Nonprofit'],
  },
  
  'Minimal_Blue': {
    name: 'Minimal Blue',
    description: 'Clean minimalist layout with professional blue accents.',
    category: 'minimal',
    tags: ['minimal', 'blue', 'professional'],
    recommended: ['Tech', 'Finance', 'Corporate'],
  },
  
  // ==================== CREATIVE TEMPLATES ====================
  'Graphic': {
    name: 'Graphic Designer',
    description: 'Creative layout for design professionals. Showcases visual thinking.',
    category: 'creative',
    tags: ['creative', 'design', 'visual'],
    recommended: ['Graphic Designer', 'Art Director', 'Creative Director'],
  },
  
  'Graphic2': {
    name: 'Graphic Designer II',
    description: 'Alternative creative layout with bold visual elements.',
    category: 'creative',
    tags: ['creative', 'bold', 'visual'],
    recommended: ['UI Designer', 'Brand Designer', 'Illustrator'],
  },
  
  'Graphic3': {
    name: 'Graphic Designer III',
    description: 'Modern creative template with infographic-style elements.',
    category: 'creative',
    tags: ['creative', 'infographic', 'modern'],
    recommended: ['UX Designer', 'Product Designer', 'Motion Designer'],
  },
  
  'Desinger': {
    name: 'Designer',
    description: 'Portfolio-style layout for creative professionals and artists.',
    category: 'creative',
    tags: ['portfolio', 'creative', 'artistic'],
    recommended: ['Designer', 'Artist', 'Photographer'],
  },
  
  // ==================== MODERN TEMPLATES ====================
  'Marketting': {
    name: 'Marketing',
    description: 'Dynamic layout designed for marketing and communications professionals.',
    category: 'modern',
    tags: ['marketing', 'dynamic', 'modern'],
    recommended: ['Marketing Manager', 'Content Strategist', 'Brand Manager'],
  },
};

// Category display information
export const CATEGORY_INFO: Record<TemplateCategory, { label: string; description: string }> = {
  'classic': {
    label: 'Classic',
    description: 'Traditional layouts that are timeless and universally accepted',
  },
  'modern': {
    label: 'Modern',
    description: 'Contemporary designs with fresh, current aesthetics',
  },
  'minimal': {
    label: 'Minimal',
    description: 'Clean, simple layouts with focus on content and whitespace',
  },
  'creative': {
    label: 'Creative',
    description: 'Unique designs for design and creative professionals',
  },
  'professional': {
    label: 'Professional',
    description: 'Polished layouts for corporate and business roles',
  },
};

/**
 * Get display info for a template, with fallback
 */
export function getTemplateDisplayInfo(templateId: string): TemplateDisplayInfo {
  const metadata = TEMPLATE_METADATA[templateId];
  
  if (metadata) {
    return metadata;
  }
  
  // Generate fallback from ID - guess category from name
  const name = templateId
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\(.*\)/g, '')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
  
  // Try to infer category from template name
  const lowerName = templateId.toLowerCase();
  let category: TemplateCategory = 'classic';
  
  if (lowerName.includes('minimal') || lowerName.includes('ats')) {
    category = 'minimal';
  } else if (lowerName.includes('graphic') || lowerName.includes('design') || lowerName.includes('creative')) {
    category = 'creative';
  } else if (lowerName.includes('modern') || lowerName.includes('marketing') || lowerName.includes('2column')) {
    category = 'modern';
  } else if (lowerName.includes('professional') || lowerName.includes('accountant') || lowerName.includes('executive')) {
    category = 'professional';
  }
  
  return {
    name,
    description: 'ATS-optimized resume template',
    category,
    tags: ['ats-friendly'],
  };
}
