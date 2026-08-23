/**
 * Template Converter Script
 * Converts sample resume documents into templates with {{placeholder}} syntax
 * This allows the analyzer to detect sections and the form editor to work dynamically
 */

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATES_DIR = path.join(__dirname, '../templates');

// Patterns to find and replace with template placeholders
const CONVERSIONS = [
  // Personal info - common name patterns
  { pattern: /Jane\s+Doe/gi, replacement: '{{fullName}}' },
  { pattern: /John\s+Doe/gi, replacement: '{{fullName}}' },
  { pattern: /John\s+Smith/gi, replacement: '{{fullName}}' },
  { pattern: /\[Your Name\]/gi, replacement: '{{fullName}}' },
  { pattern: /\[Full Name\]/gi, replacement: '{{fullName}}' },
  { pattern: /First\s+Last/gi, replacement: '{{fullName}}' },
  { pattern: /FIRST\s+LAST/gi, replacement: '{{fullName}}' },
  { pattern: /Candidate\s+Name/gi, replacement: '{{fullName}}' },
  
  // Email patterns
  { pattern: /jane\.doe@gmail\.com/gi, replacement: '{{email}}' },
  { pattern: /john\.doe@gmail\.com/gi, replacement: '{{email}}' },
  { pattern: /john\.smith@email\.com/gi, replacement: '{{email}}' },
  { pattern: /\[email@example\.com\]/gi, replacement: '{{email}}' },
  { pattern: /yourname@email\.com/gi, replacement: '{{email}}' },
  { pattern: /email@email\.com/gi, replacement: '{{email}}' },
  { pattern: /name@email\.com/gi, replacement: '{{email}}' },
  
  // Phone patterns
  { pattern: /\(\+44\)7123123123/gi, replacement: '{{phone}}' },
  { pattern: /\+1\s*\(\d{3}\)\s*\d{3}-\d{4}/g, replacement: '{{phone}}' },
  { pattern: /\(\d{3}\)\s*\d{3}-\d{4}/g, replacement: '{{phone}}' },
  { pattern: /\d{3}-\d{3}-\d{4}/g, replacement: '{{phone}}' },
  { pattern: /\[Phone Number\]/gi, replacement: '{{phone}}' },
  { pattern: /\+1-000-000-0000/gi, replacement: '{{phone}}' },
  
  // Location patterns
  { pattern: /City,\s*State/gi, replacement: '{{location}}' },
  { pattern: /San Francisco,\s*CA/gi, replacement: '{{location}}' },
  { pattern: /New York,\s*NY/gi, replacement: '{{location}}' },
  { pattern: /\[City,\s*State\]/gi, replacement: '{{location}}' },
  { pattern: /London/gi, replacement: '{{location}}' },
  
  // LinkedIn
  { pattern: /linkedin\.com\/in\/[\w-]+/gi, replacement: '{{linkedin}}' },
  { pattern: /\[LinkedIn URL\]/gi, replacement: '{{linkedin}}' },
  
  // Common section headers (keep as-is but add markers)
  // These help identify section structure
];

/**
 * Convert a template to use placeholder syntax
 */
function convertTemplate(templatePath, outputPath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  
  let changesMade = 0;
  
  const file = zip.file('word/document.xml');
  if (!file) {
    console.log('  No document.xml found');
    return 0;
  }
  
  let xmlContent = file.asText();
  
  for (const { pattern, replacement } of CONVERSIONS) {
    const before = xmlContent;
    xmlContent = xmlContent.replace(pattern, replacement);
    if (xmlContent !== before) {
      changesMade++;
    }
  }
  
  if (changesMade > 0) {
    zip.file('word/document.xml', xmlContent);
    
    const outputBuffer = zip.generate({
      type: 'nodebuffer',
      compression: 'DEFLATE'
    });
    
    fs.writeFileSync(outputPath, outputBuffer);
  }
  
  return changesMade;
}

// ==================== MAIN ====================

async function main() {
  console.log('='.repeat(60));
  console.log('Template Converter - Adding {{placeholder}} syntax');
  console.log('='.repeat(60));
  console.log('');
  
  // Create converted directory
  const convertedDir = path.join(TEMPLATES_DIR, 'converted');
  if (!fs.existsSync(convertedDir)) {
    fs.mkdirSync(convertedDir, { recursive: true });
  }
  
  const templates = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.docx') && !f.startsWith('~'));
  
  console.log(`Converting ${templates.length} templates...\n`);
  
  for (const file of templates) {
    const inputPath = path.join(TEMPLATES_DIR, file);
    const outputPath = path.join(convertedDir, file);
    
    const changes = convertTemplate(inputPath, outputPath);
    
    if (changes > 0) {
      console.log(`🔄 ${file} - ${changes} replacements`);
    } else {
      console.log(`⏭️  ${file} - no changes needed`);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Converted templates saved to: backend/templates/converted/');
  console.log('\nTo use: move converted files to backend/templates/');
}

main().catch(console.error);
