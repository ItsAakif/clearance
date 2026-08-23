// Template types for Clearance

export interface TemplateSettings {
  marginX: number; // in inches (0.5-1.5)
  marginY: number; // in inches (0.5-1.5)
  fontSize: number; // base font size (10-14)
  lineSpacing: number; // line height multiplier (1.2-1.8)
  sectionSpacing: number; // spacing between sections (1-3)
}

export interface ResumeTemplate {
  id: string;
  name: string;
  description: string;
  category: "classic" | "modern" | "minimal" | "creative" | "professional";
  isAtsOptimized: boolean;
  defaultSettings: TemplateSettings;
  preview?: string; // preview image URL
  fileType?: "docx" | "doc"; // doc files need manual conversion
}

export const defaultTemplateSettings: TemplateSettings = {
  marginX: 0.75,
  marginY: 0.75,
  fontSize: 11,
  lineSpacing: 1.4,
  sectionSpacing: 1.5,
};

// All 22 handpicked resume templates
export const templates: ResumeTemplate[] = [
  // ==================== DEFAULT TEMPLATE ====================
  {
    id: "professional-standard",
    name: "Professional Standard",
    description: "Clean, professional layout with excellent ATS compatibility. The recommended default for most job applications.",
    category: "professional",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.75,
      marginY: 0.75,
      fontSize: 11,
      lineSpacing: 1.4,
      sectionSpacing: 1.5,
    },
    preview: "/previews/professional-standard.png",
  },
  
  // ==================== CLASSIC TEMPLATES ====================
  {
    id: "Classic",
    name: "Classic",
    description: "Traditional single-column layout. Clean, timeless, and universally accepted.",
    category: "classic",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.75,
      marginY: 0.75,
      fontSize: 11,
      lineSpacing: 1.4,
      sectionSpacing: 1.5,
    },
    preview: "/previews/classic.png",
  },
  {
    id: "Standard",
    name: "Standard",
    description: "Industry-standard resume format. Works perfectly for corporate and traditional roles.",
    category: "classic",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.75,
      marginY: 0.75,
      fontSize: 11,
      lineSpacing: 1.4,
      sectionSpacing: 1.5,
    },
    preview: "/previews/standard.png",
  },
  {
    id: "Bullets",
    name: "Bullets",
    description: "Achievement-focused layout with prominent bullet points for easy scanning.",
    category: "classic",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.7,
      marginY: 0.7,
      fontSize: 11,
      lineSpacing: 1.35,
      sectionSpacing: 1.4,
    },
    preview: "/previews/bullets.png",
  },
  {
    id: "descriptive",
    name: "Descriptive",
    description: "Detailed format with room for comprehensive job descriptions and project details.",
    category: "classic",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.75,
      marginY: 0.75,
      fontSize: 11,
      lineSpacing: 1.4,
      sectionSpacing: 1.5,
    },
    preview: "/previews/descriptive.png",
  },
  {
    id: "Accountant",
    name: "Accountant",
    description: "Structured layout perfect for finance, accounting, and analytical roles.",
    category: "professional",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.75,
      marginY: 0.75,
      fontSize: 11,
      lineSpacing: 1.4,
      sectionSpacing: 1.5,
    },
    preview: "/previews/accountant.png",
  },
  
  // ==================== MINIMAL TEMPLATES ====================
  {
    id: "ats-minimilistic",
    name: "ATS Minimalistic",
    description: "Ultra-clean design optimized specifically for Applicant Tracking Systems.",
    category: "minimal",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 1,
      marginY: 1,
      fontSize: 11,
      lineSpacing: 1.5,
      sectionSpacing: 2,
    },
    preview: "/previews/ats-minimalistic.png",
  },
  {
    id: "Minimalist_1",
    name: "Minimalist",
    description: "Clean and elegant with maximum white space. Lets your content shine.",
    category: "minimal",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 1,
      marginY: 1,
      fontSize: 11,
      lineSpacing: 1.5,
      sectionSpacing: 2,
    },
    preview: "/previews/minimalist-1.png",
  },
  {
    id: "minimalist_2column",
    name: "Minimalist Two Column",
    description: "Modern two-column layout with clean lines and organized sections.",
    category: "minimal",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.6,
      marginY: 0.6,
      fontSize: 10,
      lineSpacing: 1.3,
      sectionSpacing: 1.25,
    },
    preview: "/previews/minimalist-2column.png",
  },
  {
    id: "Minimal-Green",
    name: "Minimal Green",
    description: "Minimalist design with subtle green accents for a fresh, modern look.",
    category: "minimal",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.8,
      marginY: 0.8,
      fontSize: 11,
      lineSpacing: 1.45,
      sectionSpacing: 1.6,
    },
    preview: "/previews/minimal-green.png",
  },
  {
    id: "Minimal_Blue",
    name: "Minimal Blue",
    description: "Clean minimalist layout with professional blue accents.",
    category: "minimal",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.8,
      marginY: 0.8,
      fontSize: 11,
      lineSpacing: 1.45,
      sectionSpacing: 1.6,
    },
    preview: "/previews/minimal-blue.png",
  },
  
  // ==================== CREATIVE TEMPLATES ====================
  {
    id: "Graphic",
    name: "Graphic Designer",
    description: "Creative layout for design professionals. Showcases visual thinking.",
    category: "creative",
    isAtsOptimized: false,
    defaultSettings: {
      marginX: 0.6,
      marginY: 0.6,
      fontSize: 10,
      lineSpacing: 1.3,
      sectionSpacing: 1.2,
    },
    preview: "/previews/graphic.png",
  },
  {
    id: "Graphic2",
    name: "Graphic Designer II",
    description: "Alternative creative layout with bold visual elements.",
    category: "creative",
    isAtsOptimized: false,
    defaultSettings: {
      marginX: 0.6,
      marginY: 0.6,
      fontSize: 10,
      lineSpacing: 1.3,
      sectionSpacing: 1.2,
    },
    preview: "/previews/graphic2.png",
  },
  {
    id: "Graphic3",
    name: "Graphic Designer III",
    description: "Modern creative template with infographic-style elements.",
    category: "creative",
    isAtsOptimized: false,
    defaultSettings: {
      marginX: 0.6,
      marginY: 0.6,
      fontSize: 10,
      lineSpacing: 1.3,
      sectionSpacing: 1.2,
    },
    preview: "/previews/graphic3.png",
  },
  {
    id: "Desinger",
    name: "Designer",
    description: "Portfolio-style layout for creative professionals and artists.",
    category: "creative",
    isAtsOptimized: false,
    defaultSettings: {
      marginX: 0.65,
      marginY: 0.65,
      fontSize: 10,
      lineSpacing: 1.35,
      sectionSpacing: 1.3,
    },
    preview: "/previews/designer.png",
  },
  {
    id: "Marketting",
    name: "Marketing",
    description: "Dynamic layout designed for marketing and communications professionals.",
    category: "modern",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.7,
      marginY: 0.7,
      fontSize: 10.5,
      lineSpacing: 1.35,
      sectionSpacing: 1.4,
    },
    preview: "/previews/marketing.png",
  },
  
  // ==================== ADDITIONAL TEMPLATES ====================
  {
    id: "Marketting2",
    name: "Marketing II",
    description: "Alternative marketing template with different section emphasis.",
    category: "modern",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.7,
      marginY: 0.7,
      fontSize: 10.5,
      lineSpacing: 1.35,
      sectionSpacing: 1.4,
    },
    preview: "/previews/marketing2.png",
  },
  {
    id: "Minimalist_2",
    name: "Minimalist II",
    description: "Second minimalist variant with subtle differences.",
    category: "minimal",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 1,
      marginY: 1,
      fontSize: 11,
      lineSpacing: 1.5,
      sectionSpacing: 2,
    },
    preview: "/previews/minimalist-2.png",
  },
  {
    id: "Minimalist_3",
    name: "Minimalist III",
    description: "Third minimalist variant with unique styling.",
    category: "minimal",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 1,
      marginY: 1,
      fontSize: 11,
      lineSpacing: 1.5,
      sectionSpacing: 2,
    },
    preview: "/previews/minimalist-3.png",
  },
  {
    id: "Minimal_color",
    name: "Minimal Color",
    description: "Minimalist design with colorful accents.",
    category: "minimal",
    isAtsOptimized: true,
    defaultSettings: {
      marginX: 0.8,
      marginY: 0.8,
      fontSize: 11,
      lineSpacing: 1.45,
      sectionSpacing: 1.6,
    },
    preview: "/previews/minimal-color.png",
  },
  {
    id: "UX-Designer",
    name: "UX Designer",
    description: "Specialized template for UX/UI designers and researchers.",
    category: "creative",
    isAtsOptimized: false,
    defaultSettings: {
      marginX: 0.65,
      marginY: 0.65,
      fontSize: 10,
      lineSpacing: 1.35,
      sectionSpacing: 1.3,
    },
    preview: "/previews/ux-designer.png",
  },
  {
    id: "With-Image",
    name: "With Photo",
    description: "Professional template with space for a profile photo.",
    category: "modern",
    isAtsOptimized: false,
    defaultSettings: {
      marginX: 0.7,
      marginY: 0.7,
      fontSize: 10.5,
      lineSpacing: 1.35,
      sectionSpacing: 1.4,
    },
    preview: "/previews/with-image.png",
  },
];

// All templates are ready to use
export const readyTemplates = templates;

// No pending templates
export const pendingTemplates: ResumeTemplate[] = [];

// Get default template
export const defaultTemplate = templates.find(t => t.id === "professional-standard") || templates[0];
