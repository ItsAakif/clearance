// Generate unique preview images for all templates
// Each template gets a distinct visual style
// Run with: node scripts/generate-previews.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const TEMPLATES_DIR = path.join(__dirname, '../templates');
const PREVIEWS_DIR = path.join(__dirname, '../previews');

// Sample data for preview generation
const SAMPLE_DATA = {
  fullName: 'Alex Johnson',
  email: 'alex.johnson@email.com',
  phone: '(555) 123-4567',
  location: 'San Francisco, CA',
  linkedin: 'linkedin.com/in/alexjohnson',
  website: 'alexjohnson.dev',
  summary: 'Results-driven professional with 5+ years of experience delivering high-impact solutions. Proven track record of leading cross-functional teams.',
  experience: [
    {
      title: 'Senior Product Manager',
      company: 'TechCorp Inc.',
      dateRange: 'Jan 2021 - Present',
      bullets: [
        'Led product strategy for flagship SaaS platform, increasing ARR by $2M',
        'Managed cross-functional team of 12 engineers and designers',
      ],
    },
    {
      title: 'Product Manager',
      company: 'StartupXYZ',
      dateRange: 'Mar 2018 - Dec 2020',
      bullets: [
        'Launched 3 new product features, driving 40% increase in engagement',
      ],
    }
  ],
  education: [
    { degree: 'MBA', field: 'Technology Management', institution: 'Stanford University', year: '2018' },
  ],
  skills: 'Product Strategy, Agile/Scrum, Data Analysis, SQL, Python, Roadmap Planning'
};

// Template-specific styles for ACTUAL template files
const TEMPLATE_STYLES = {
  // Professional templates
  'Professional-Standard(Make-this-default)': {
    name: 'Professional Standard',
    headerBg: '#1f2937',
    headerText: '#f9fafb',
    accentColor: '#3b82f6',
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    layout: 'standard',
  },
  'Classic': {
    name: 'Classic',
    headerBg: '#ffffff',
    headerText: '#1f2937',
    accentColor: '#1f2937',
    fontFamily: "'Times New Roman', Georgia, serif",
    layout: 'classic',
  },
  'Standard': {
    name: 'Standard',
    headerBg: '#f3f4f6',
    headerText: '#111827',
    accentColor: '#4b5563',
    fontFamily: "'Arial', sans-serif",
    layout: 'standard',
  },
  'Bullets': {
    name: 'Bullets',
    headerBg: '#1a1a2e',
    headerText: '#ffffff',
    accentColor: '#4f46e5',
    fontFamily: "'Inter', sans-serif",
    layout: 'modern',
  },
  'descriptive': {
    name: 'Descriptive',
    headerBg: '#fef3c7',
    headerText: '#92400e',
    accentColor: '#f59e0b',
    fontFamily: "'Merriweather', serif",
    layout: 'detailed',
  },
  
  // Accountant/Finance
  'Accountant': {
    name: 'Accountant',
    headerBg: '#064e3b',
    headerText: '#ecfdf5',
    accentColor: '#10b981',
    fontFamily: "'Roboto', sans-serif",
    layout: 'technical',
  },
  
  // ATS/Minimal templates
  'ats-minimilistic': {
    name: 'ATS Minimalistic',
    headerBg: '#ffffff',
    headerText: '#000000',
    accentColor: '#374151',
    fontFamily: "'Arial', sans-serif",
    layout: 'minimal',
  },
  'Minimalist_1': {
    name: 'Minimalist 1',
    headerBg: '#fafafa',
    headerText: '#18181b',
    accentColor: '#71717a',
    fontFamily: "'Helvetica Neue', sans-serif",
    layout: 'minimal',
  },
  'minimalist_2column': {
    name: 'Minimalist 2-Column',
    headerBg: '#f4f4f5',
    headerText: '#27272a',
    accentColor: '#a1a1aa',
    fontFamily: "'SF Pro', sans-serif",
    layout: 'twocolumn',
  },
  'Minimal-Green': {
    name: 'Minimal Green',
    headerBg: '#f0fdf4',
    headerText: '#166534',
    accentColor: '#22c55e',
    fontFamily: "'Open Sans', sans-serif",
    layout: 'fresh',
  },
  'Minimal_Blue': {
    name: 'Minimal Blue',
    headerBg: '#eff6ff',
    headerText: '#1e40af',
    accentColor: '#3b82f6',
    fontFamily: "'Source Sans Pro', sans-serif",
    layout: 'fresh',
  },
  
  // Creative/Design templates
  'Graphic': {
    name: 'Graphic',
    headerBg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    headerText: '#ffffff',
    accentColor: '#8b5cf6',
    fontFamily: "'Poppins', sans-serif",
    layout: 'creative',
    gradient: true,
  },
  'Graphic2': {
    name: 'Graphic 2',
    headerBg: 'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
    headerText: '#ffffff',
    accentColor: '#ec4899',
    fontFamily: "'Montserrat', sans-serif",
    layout: 'creative',
    gradient: true,
  },
  'Graphic3': {
    name: 'Graphic 3',
    headerBg: 'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
    headerText: '#ffffff',
    accentColor: '#06b6d4',
    fontFamily: "'Raleway', sans-serif",
    layout: 'creative',
    gradient: true,
  },
  'Desinger': {
    name: 'Designer',
    headerBg: '#fdf2f8',
    headerText: '#9d174d',
    accentColor: '#ec4899',
    fontFamily: "'Playfair Display', serif",
    layout: 'creative',
  },
  'Marketting': {
    name: 'Marketing',
    headerBg: '#fef3c7',
    headerText: '#b45309',
    accentColor: '#f59e0b',
    fontFamily: "'Lato', sans-serif",
    layout: 'creative',
  },
};

// Default style for unknown templates
const DEFAULT_STYLE = {
  name: 'Template',
  headerBg: '#f3f4f6',
  headerText: '#111827',
  accentColor: '#2563eb',
  fontFamily: "'Arial', sans-serif",
  layout: 'classic',
};

function getTemplateStyle(templateId) {
  return TEMPLATE_STYLES[templateId] || { ...DEFAULT_STYLE, name: templateId };
}

function generatePreviewHtml(templateId) {
  const style = getTemplateStyle(templateId);
  const bgStyle = style.gradient ? `background: ${style.headerBg};` : `background-color: ${style.headerBg};`;
  
  // Different layouts based on template style
  const layouts = {
    modern: `
      <div style="padding: 0;">
        <div style="${bgStyle} padding: 24px 32px; margin-bottom: 20px;">
          <div style="font-size: 26px; font-weight: 700; color: ${style.headerText}; margin-bottom: 8px;">${SAMPLE_DATA.fullName}</div>
          <div style="font-size: 11px; color: ${style.headerText}; opacity: 0.8;">${SAMPLE_DATA.email} | ${SAMPLE_DATA.phone} | ${SAMPLE_DATA.location}</div>
        </div>
        <div style="padding: 0 32px;">
          <div style="border-left: 3px solid ${style.accentColor}; padding-left: 12px; margin-bottom: 16px;">
            <div style="font-size: 12px; font-weight: 600; color: ${style.accentColor}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">Summary</div>
            <div style="font-size: 10px; color: #4b5563; line-height: 1.5;">${SAMPLE_DATA.summary}</div>
          </div>
        </div>
      </div>
    `,
    elegant: `
      <div style="padding: 32px; ${bgStyle}">
        <div style="text-align: center; border-bottom: 2px solid ${style.accentColor}; padding-bottom: 20px; margin-bottom: 20px;">
          <div style="font-size: 28px; font-weight: 400; color: ${style.headerText}; letter-spacing: 3px; text-transform: uppercase;">${SAMPLE_DATA.fullName}</div>
          <div style="font-size: 10px; color: ${style.accentColor}; margin-top: 8px;">${SAMPLE_DATA.email} | ${SAMPLE_DATA.phone}</div>
        </div>
        <div style="font-size: 10px; color: #555; font-style: italic; text-align: center; line-height: 1.6;">${SAMPLE_DATA.summary}</div>
      </div>
    `,
    classic: `
      <div style="padding: 32px;">
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="font-size: 24px; font-weight: bold; color: ${style.headerText};">${SAMPLE_DATA.fullName}</div>
          <div style="font-size: 10px; color: #555; margin-top: 4px;">${SAMPLE_DATA.email} | ${SAMPLE_DATA.phone} | ${SAMPLE_DATA.location}</div>
        </div>
        <div style="border-top: 1px solid #000; border-bottom: 1px solid #000; padding: 8px 0; margin-bottom: 12px;">
          <div style="font-size: 11px; font-weight: bold; text-transform: uppercase;">Professional Summary</div>
        </div>
        <div style="font-size: 10px; color: #333; line-height: 1.5;">${SAMPLE_DATA.summary}</div>
      </div>
    `,
    technical: `
      <div style="padding: 24px; ${bgStyle}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
          <div>
            <div style="font-size: 22px; font-weight: 600; color: ${style.headerText};">${SAMPLE_DATA.fullName}</div>
            <div style="font-size: 10px; color: ${style.accentColor}; font-family: monospace;">Senior Accountant</div>
          </div>
          <div style="text-align: right; font-size: 9px; color: ${style.headerText}; opacity: 0.8;">
            <div>${SAMPLE_DATA.email}</div>
            <div>${SAMPLE_DATA.phone}</div>
          </div>
        </div>
        <div style="background: rgba(255,255,255,0.1); padding: 12px; border-radius: 4px;">
          <div style="font-size: 10px; color: ${style.headerText}; line-height: 1.5;">${SAMPLE_DATA.summary}</div>
        </div>
      </div>
    `,
    fresh: `
      <div style="padding: 28px; ${bgStyle}">
        <div style="display: flex; gap: 20px; margin-bottom: 20px;">
          <div style="width: 60px; height: 60px; border-radius: 50%; background: ${style.accentColor}; display: flex; align-items: center; justify-content: center; color: white; font-size: 24px; font-weight: bold;">AJ</div>
          <div>
            <div style="font-size: 22px; font-weight: 600; color: ${style.headerText};">${SAMPLE_DATA.fullName}</div>
            <div style="font-size: 10px; color: ${style.accentColor};">${SAMPLE_DATA.email} | ${SAMPLE_DATA.location}</div>
          </div>
        </div>
        <div style="font-size: 10px; color: #555; line-height: 1.6; padding: 12px; background: white; border-radius: 8px; border-left: 4px solid ${style.accentColor};">${SAMPLE_DATA.summary}</div>
      </div>
    `,
    minimal: `
      <div style="padding: 40px 32px;">
        <div style="margin-bottom: 24px;">
          <div style="font-size: 20px; font-weight: 300; color: ${style.headerText}; letter-spacing: 0.5px;">${SAMPLE_DATA.fullName}</div>
          <div style="font-size: 9px; color: ${style.accentColor}; margin-top: 4px; letter-spacing: 2px; text-transform: uppercase;">${SAMPLE_DATA.email}</div>
        </div>
        <div style="font-size: 10px; color: #6b7280; line-height: 1.7;">${SAMPLE_DATA.summary}</div>
      </div>
    `,
    twocolumn: `
      <div style="display: flex; min-height: 100%;">
        <div style="width: 35%; ${bgStyle} padding: 24px; color: ${style.headerText};">
          <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">${SAMPLE_DATA.fullName}</div>
          <div style="font-size: 9px; opacity: 0.8; line-height: 1.6;">
            <div>${SAMPLE_DATA.email}</div>
            <div>${SAMPLE_DATA.phone}</div>
            <div>${SAMPLE_DATA.location}</div>
          </div>
          <div style="margin-top: 20px;">
            <div style="font-size: 10px; font-weight: 600; text-transform: uppercase; margin-bottom: 8px; border-bottom: 1px solid ${style.accentColor}; padding-bottom: 4px;">Skills</div>
            <div style="font-size: 9px; line-height: 1.6;">${SAMPLE_DATA.skills}</div>
          </div>
        </div>
        <div style="flex: 1; padding: 24px;">
          <div style="font-size: 10px; color: #333; line-height: 1.5;">${SAMPLE_DATA.summary}</div>
        </div>
      </div>
    `,
    creative: `
      <div style="padding: 24px; ${bgStyle}">
        <div style="background: white; padding: 20px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
            <div style="width: 48px; height: 48px; border-radius: 12px; background: ${style.gradient ? style.headerBg : `linear-gradient(135deg, ${style.accentColor}, ${style.accentColor}88)`};"></div>
            <div>
              <div style="font-size: 18px; font-weight: 600; color: ${style.gradient ? '#1f2937' : style.headerText};">${SAMPLE_DATA.fullName}</div>
              <div style="font-size: 9px; color: ${style.accentColor};">Creative Professional</div>
            </div>
          </div>
          <div style="font-size: 10px; color: #666; line-height: 1.5;">${SAMPLE_DATA.summary}</div>
        </div>
      </div>
    `,
    standard: `
      <div style="padding: 28px;">
        <div style="${bgStyle} color: ${style.headerText}; padding: 16px 20px; margin: -28px -28px 20px -28px;">
          <div style="font-size: 22px; font-weight: 600;">${SAMPLE_DATA.fullName}</div>
          <div style="font-size: 10px; opacity: 0.9; margin-top: 4px;">${SAMPLE_DATA.email} | ${SAMPLE_DATA.phone}</div>
        </div>
        <div style="font-size: 10px; color: #444; line-height: 1.6;">${SAMPLE_DATA.summary}</div>
      </div>
    `,
    detailed: `
      <div style="padding: 24px; ${bgStyle}">
        <div style="text-align: center; margin-bottom: 20px;">
          <div style="font-size: 24px; font-weight: 500; color: ${style.headerText};">${SAMPLE_DATA.fullName}</div>
          <div style="width: 60px; height: 2px; background: ${style.accentColor}; margin: 8px auto;"></div>
          <div style="font-size: 10px; color: ${style.accentColor};">${SAMPLE_DATA.location} | ${SAMPLE_DATA.phone}</div>
        </div>
        <div style="font-size: 10px; color: #555; line-height: 1.5;">${SAMPLE_DATA.summary}</div>
      </div>
    `,
    executive: `
      <div style="padding: 32px; ${bgStyle}">
        <div style="border: 1px solid ${style.accentColor}; padding: 24px; margin-bottom: 20px;">
          <div style="font-size: 26px; font-weight: 300; color: ${style.headerText}; text-align: center; letter-spacing: 4px; text-transform: uppercase;">${SAMPLE_DATA.fullName}</div>
          <div style="font-size: 9px; color: ${style.accentColor}; text-align: center; margin-top: 8px; letter-spacing: 2px;">EXECUTIVE LEADER</div>
        </div>
        <div style="font-size: 10px; color: ${style.headerText}; opacity: 0.9; line-height: 1.6; text-align: justify;">${SAMPLE_DATA.summary}</div>
      </div>
    `,
  };
  
  const layoutHtml = layouts[style.layout] || layouts.classic;
  
  // Add experience section for all layouts
  const experienceHtml = `
    <div style="padding: 0 32px 20px 32px;">
      <div style="font-size: 12px; font-weight: 600; color: ${style.accentColor}; text-transform: uppercase; letter-spacing: 1px; margin: 16px 0 12px 0; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb;">Experience</div>
      ${SAMPLE_DATA.experience.map(exp => `
        <div style="margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: baseline;">
            <div style="font-size: 11px; font-weight: 600; color: #1f2937;">${exp.title}</div>
            <div style="font-size: 9px; color: #6b7280;">${exp.dateRange}</div>
          </div>
          <div style="font-size: 10px; color: ${style.accentColor}; margin-bottom: 4px;">${exp.company}</div>
          <ul style="margin: 0; padding-left: 14px; font-size: 9px; color: #4b5563; line-height: 1.4;">
            ${exp.bullets.map(b => `<li style="margin-bottom: 2px;">${b}</li>`).join('')}
          </ul>
        </div>
      `).join('')}
    </div>
  `;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Merriweather:wght@400;700&family=Playfair+Display:wght@400;600&family=Poppins:wght@400;500;600&family=Roboto:wght@400;500&family=Source+Sans+Pro:wght@400;600&family=Montserrat:wght@400;500;600&family=Raleway:wght@400;500;600&family=Lato:wght@400;700&family=Open+Sans:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ${style.fontFamily};
      background: white;
      width: 612px;
      height: 792px;
      overflow: hidden;
    }
  </style>
</head>
<body>
  ${layoutHtml}
  ${experienceHtml}
</body>
</html>
  `;
}

// Find Chrome executable
function getChromePath() {
  const paths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  
  throw new Error('Chrome/Edge not found');
}

async function generatePreviews() {
  // Ensure previews directory exists
  if (!fs.existsSync(PREVIEWS_DIR)) {
    fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
  }
  
  // Get all templates
  const templates = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.docx'));
  
  console.log(`Found ${templates.length} templates to preview`);
  console.log('');
  
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: getChromePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    
    for (const templateFile of templates) {
      const templateId = templateFile.replace('.docx', '');
      const previewPath = path.join(PREVIEWS_DIR, `${templateId}.png`);
      const style = getTemplateStyle(templateId);
      
      console.log(`Generating: ${style.name} (${templateId})`);
      console.log(`  Layout: ${style.layout}, Accent: ${style.accentColor}`);
      
      try {
        const html = generatePreviewHtml(templateId);
        
        const page = await browser.newPage();
        await page.setViewport({ width: 612, height: 792 }); // Letter size at 72 DPI
        await page.setContent(html, { waitUntil: 'networkidle0' });
        
        // Wait for fonts to load
        await page.evaluateHandle('document.fonts.ready');
        
        await page.screenshot({
          path: previewPath,
          type: 'png',
        });
        
        await page.close();
        console.log(`  ✓ Saved ${templateId}.png\n`);
      } catch (error) {
        console.error(`  ✗ Error: ${error.message}\n`);
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
  
  console.log('Done! All previews generated.');
}

generatePreviews().catch(console.error);
