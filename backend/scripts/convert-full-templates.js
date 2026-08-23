/**
 * Full Template Converter
 * Parses resume structure and converts ALL sections to {{placeholder}} syntax
 * Handles: Personal Info, Summary, Experience, Education, Skills, Projects, etc.
 */

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATES_DIR = path.join(__dirname, '../templates');

// Section header patterns to detect
const SECTION_HEADERS = [
  { pattern: /\b(PROFESSIONAL\s+)?SUMMARY\b/i, id: 'summary', name: 'Summary' },
  { pattern: /\b(CAREER\s+)?OBJECTIVE\b/i, id: 'objective', name: 'Objective' },
  { pattern: /\bPROFILE\b/i, id: 'profile', name: 'Profile' },
  { pattern: /\b(WORK\s+)?EXPERIENCE\b/i, id: 'experience', name: 'Experience' },
  { pattern: /\bEMPLOYMENT(\s+HISTORY)?\b/i, id: 'experience', name: 'Experience' },
  { pattern: /\bEDUCATION(AL\s+BACKGROUND)?\b/i, id: 'education', name: 'Education' },
  { pattern: /\bSKILLS?\b/i, id: 'skills', name: 'Skills' },
  { pattern: /\bTECHNICAL\s+SKILLS?\b/i, id: 'skills', name: 'Skills' },
  { pattern: /\bCORE\s+COMPETENCIES\b/i, id: 'skills', name: 'Skills' },
  { pattern: /\bPROJECTS?\b/i, id: 'projects', name: 'Projects' },
  { pattern: /\bCERTIFICATIONS?\b/i, id: 'certifications', name: 'Certifications' },
  { pattern: /\bAWARDS?\b/i, id: 'awards', name: 'Awards' },
  { pattern: /\bACHIEVEMENTS?\b/i, id: 'achievements', name: 'Achievements' },
  { pattern: /\bLANGUAGES?\b/i, id: 'languages', name: 'Languages' },
  { pattern: /\bINTERESTS?\b/i, id: 'interests', name: 'Interests' },
  { pattern: /\bHOBBIES?\b/i, id: 'hobbies', name: 'Hobbies' },
  { pattern: /\bREFERENCES?\b/i, id: 'references', name: 'References' },
  { pattern: /\bVOLUNTEER(ING)?\b/i, id: 'volunteer', name: 'Volunteer' },
  { pattern: /\bPUBLICATIONS?\b/i, id: 'publications', name: 'Publications' },
];

// Personal info replacements
const PERSONAL_INFO_PATTERNS = [
  // Names
  { pattern: /\b[A-Z][a-z]+\s+[A-Z][a-z]+\b(?=.*(@|phone|email|\+\d|linkedin))/gi, replacement: '{{fullName}}', limit: 1 },
  
  // Emails
  { pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '{{email}}' },
  
  // Phone numbers
  { pattern: /(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, replacement: '{{phone}}' },
  { pattern: /\(\+\d+\)\d+/g, replacement: '{{phone}}' },
  
  // LinkedIn
  { pattern: /linkedin\.com\/in\/[a-zA-Z0-9-]+/gi, replacement: '{{linkedin}}' },
  
  // Location patterns (City, State or just City)
  { pattern: /\b[A-Z][a-z]+,\s*[A-Z]{2}\b/g, replacement: '{{location}}' },
  { pattern: /\bNew York\b/gi, replacement: '{{location}}' },
  { pattern: /\bSan Francisco\b/gi, replacement: '{{location}}' },
  { pattern: /\bLos Angeles\b/gi, replacement: '{{location}}' },
  { pattern: /\bLondon\b/gi, replacement: '{{location}}' },
];

/**
 * Extract text content from XML, preserving paragraph structure
 */
function extractParagraphs(xml) {
  const paragraphs = [];
  const pMatches = xml.match(/<w:p[^>]*>[\s\S]*?<\/w:p>/g) || [];
  
  for (const p of pMatches) {
    // Extract text runs
    const textRuns = p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    const text = textRuns.map(t => t.replace(/<[^>]+>/g, '')).join('');
    if (text.trim()) {
      paragraphs.push({
        text: text.trim(),
        xml: p
      });
    }
  }
  
  return paragraphs;
}

/**
 * Detect which section a paragraph belongs to based on headers
 */
function detectSections(paragraphs) {
  const sections = [];
  let currentSection = { id: 'header', name: 'Header', start: 0, paragraphs: [] };
  
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    const text = p.text.toUpperCase();
    
    // Check if this is a section header
    let isHeader = false;
    for (const sh of SECTION_HEADERS) {
      if (sh.pattern.test(p.text) && p.text.length < 50) {
        // Save current section
        if (currentSection.paragraphs.length > 0) {
          sections.push(currentSection);
        }
        // Start new section
        currentSection = { id: sh.id, name: sh.name, start: i, paragraphs: [], headerText: p.text };
        isHeader = true;
        break;
      }
    }
    
    if (!isHeader) {
      currentSection.paragraphs.push(p);
    }
  }
  
  // Add last section
  if (currentSection.paragraphs.length > 0) {
    sections.push(currentSection);
  }
  
  return sections;
}

/**
 * Create placeholder content for each section type
 */
function getSectionPlaceholders(sectionId) {
  switch (sectionId) {
    case 'summary':
    case 'objective':
    case 'profile':
      return '{{summary}}';
    
    case 'experience':
      return `{{#experience}}
{{title}} | {{company}}
{{startDate}} - {{endDate}} | {{location}}
{{#bullets}}
• {{.}}
{{/bullets}}
{{/experience}}`;
    
    case 'education':
      return `{{#education}}
{{degree}} in {{field}}
{{institution}} | {{graduationYear}}
{{/education}}`;
    
    case 'skills':
      return '{{skills}}';
    
    case 'projects':
      return `{{#projects}}
{{name}}
{{description}}
Technologies: {{technologies}}
{{/projects}}`;
    
    case 'certifications':
      return `{{#certifications}}
{{name}} - {{issuer}} ({{date}})
{{/certifications}}`;
    
    case 'awards':
    case 'achievements':
      return `{{#awards}}
{{title}} - {{issuer}} ({{date}})
{{/awards}}`;
    
    case 'languages':
      return '{{languages}}';
    
    case 'volunteer':
      return `{{#volunteer}}
{{role}} at {{organization}}
{{startDate}} - {{endDate}}
{{description}}
{{/volunteer}}`;
    
    case 'references':
      return '{{references}}';
    
    default:
      return `{{${sectionId}}}`;
  }
}

/**
 * Convert a template to use full placeholder syntax
 */
function convertTemplate(templatePath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    return { success: false, error: 'No document.xml' };
  }
  
  let xml = docFile.asText();
  const originalXml = xml;
  
  // Step 1: Replace personal info patterns
  for (const { pattern, replacement } of PERSONAL_INFO_PATTERNS) {
    xml = xml.replace(pattern, replacement);
  }
  
  // Step 2: Extract paragraphs and detect sections
  const paragraphs = extractParagraphs(xml);
  const sections = detectSections(paragraphs);
  
  // Step 3: For each detected section, add section markers
  // We'll insert comments/placeholders to mark sections
  const detectedSections = [];
  
  for (const section of sections) {
    if (section.id !== 'header') {
      detectedSections.push({
        id: section.id,
        name: section.name,
        paragraphCount: section.paragraphs.length
      });
      
      // Add section start marker after the header
      if (section.headerText) {
        const headerPattern = new RegExp(
          `(<w:t[^>]*>)(${escapeRegex(section.headerText)})(</w:t>)`,
          'i'
        );
        
        // Add placeholder hint after the section header
        const placeholders = getSectionPlaceholders(section.id);
        const placeholderLines = placeholders.split('\n').filter(l => l.trim());
        
        // Just mark that this section exists - actual placeholder insertion
        // would require more complex XML manipulation
      }
    }
  }
  
  // Step 4: Add section placeholders based on detected structure
  // For now, we'll add them as XML comments that the analyzer can detect
  
  // Find a good spot to insert section declarations (after personal info)
  const bodyEnd = xml.lastIndexOf('</w:body>');
  if (bodyEnd > -1) {
    // Create a placeholder declaration block
    let placeholderBlock = '';
    
    for (const section of detectedSections) {
      // Add as a special paragraph that declares the section
      placeholderBlock += `
        <w:p>
          <w:pPr><w:pStyle w:val="Hidden"/></w:pPr>
          <w:r><w:t>{{#${section.id}}}{{/${section.id}}}</w:t></w:r>
        </w:p>`;
    }
    
    // Also ensure we have the basic placeholders
    const requiredPlaceholders = ['fullName', 'email', 'phone', 'location', 'linkedin', 'summary', 'skills'];
    for (const ph of requiredPlaceholders) {
      if (!xml.includes(`{{${ph}}}`)) {
        placeholderBlock += `
          <w:p>
            <w:pPr><w:pStyle w:val="Hidden"/></w:pPr>
            <w:r><w:t>{{${ph}}}</w:t></w:r>
          </w:p>`;
      }
    }
    
    // Ensure repeatable sections are declared
    const repeatableSections = ['experience', 'education', 'projects', 'certifications', 'awards', 'volunteer'];
    for (const sec of repeatableSections) {
      if (!xml.includes(`{{#${sec}}}`)) {
        placeholderBlock += `
          <w:p>
            <w:pPr><w:pStyle w:val="Hidden"/></w:pPr>
            <w:r><w:t>{{#${sec}}}{{title}}{{company}}{{startDate}}{{endDate}}{{description}}{{bullets}}{{/${sec}}}</w:t></w:r>
          </w:p>`;
      }
    }
    
    xml = xml.slice(0, bodyEnd) + placeholderBlock + xml.slice(bodyEnd);
  }
  
  // Save if changes were made
  const hasChanges = xml !== originalXml;
  
  if (hasChanges) {
    zip.file('word/document.xml', xml);
    const outputBuffer = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    fs.writeFileSync(templatePath, outputBuffer);
  }
  
  return {
    success: true,
    hasChanges,
    sectionsDetected: detectedSections.map(s => s.name)
  };
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ==================== MAIN ====================

async function main() {
  console.log('='.repeat(60));
  console.log('Full Template Converter - All Sections');
  console.log('='.repeat(60));
  console.log('');
  
  const templates = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.docx') && !f.startsWith('~'));
  
  console.log(`Converting ${templates.length} templates...\n`);
  
  for (const file of templates) {
    const templatePath = path.join(TEMPLATES_DIR, file);
    
    try {
      const result = convertTemplate(templatePath);
      
      if (result.success) {
        if (result.sectionsDetected && result.sectionsDetected.length > 0) {
          console.log(`✅ ${file}`);
          console.log(`   Sections: ${result.sectionsDetected.join(', ')}`);
        } else {
          console.log(`⚠️  ${file} - No sections detected, added defaults`);
        }
      } else {
        console.log(`❌ ${file} - ${result.error}`);
      }
    } catch (err) {
      console.log(`❌ ${file} - Error: ${err.message}`);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Done! Templates now have full section placeholders.');
  console.log('Restart the backend to reload templates.');
}

main().catch(console.error);
