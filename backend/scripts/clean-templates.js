/**
 * Template Cleaner Script
 * Scans and cleans docx templates to remove branding references
 * Replaces references like "Resume Worded", "MyResumeTemplate", etc. with "xyz"
 */

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATES_DIR = path.join(__dirname, '../templates');

// Branding patterns to find and replace
// NOTE: Avoid matching Microsoft schema URLs (schemas.microsoft.com) - those are required for docx format
const BRANDING_PATTERNS = [
  // Resume Worded variations
  { pattern: /resume\s*worded/gi, replacement: 'xyz', isVisible: true },
  { pattern: /resumeworded/gi, replacement: 'xyz', isVisible: true },
  { pattern: /resume-worded/gi, replacement: 'xyz', isVisible: true },
  { pattern: /www\.resumeworded\.com/gi, replacement: 'xyz.com', isVisible: true },
  { pattern: /resumeworded\.com/gi, replacement: 'xyz.com', isVisible: true },
  
  // My Resume Template variations
  { pattern: /my\s*resume\s*template/gi, replacement: 'xyz', isVisible: true },
  { pattern: /myresumetemplate/gi, replacement: 'xyz', isVisible: true },
  { pattern: /my-resume-template/gi, replacement: 'xyz', isVisible: true },
  
  // AZURIUS (template creator)
  { pattern: /AZURIUS\s*SL/gi, replacement: 'xyz', isVisible: true },
  { pattern: /AZURIUS/gi, replacement: 'xyz', isVisible: true },
  
  // Copyright in document properties
  { pattern: /Copyright\s+[A-Z][a-zA-Z\s]+/g, replacement: '', isVisible: true },
  
  // Common resume site names (in visible text only, not URLs)
  { pattern: /\bCanva\b/g, replacement: 'xyz', isVisible: true },
  { pattern: /\bnovoresume\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bzety\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bresumegenius\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bhloom\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bbeamjobs\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bkickresume\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bvisualcv\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\benhancv\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bcvmaker\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\blivecareer\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bmyperfectresume\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bjobscan\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\brezi\b/gi, replacement: 'xyz', isVisible: true },
  { pattern: /\bstandard\s*resume\b/gi, replacement: 'xyz', isVisible: true },
];

// Files inside docx to scan (XML files containing content)
const FILES_TO_SCAN = [
  'word/document.xml',
  'word/header1.xml',
  'word/header2.xml',
  'word/header3.xml',
  'word/footer1.xml',
  'word/footer2.xml',
  'word/footer3.xml',
  'word/styles.xml',
  'word/settings.xml',
  'docProps/core.xml',
  'docProps/app.xml',
  'docProps/custom.xml',
];

/**
 * Scan a template for branding references
 */
function scanTemplate(templatePath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  
  const findings = [];
  
  for (const filePath of FILES_TO_SCAN) {
    const file = zip.file(filePath);
    if (!file) continue;
    
    const xmlContent = file.asText();
    
    for (const { pattern, isVisible } of BRANDING_PATTERNS) {
      // Skip non-visible patterns in scan (they're just metadata)
      const matches = xmlContent.match(pattern);
      if (matches) {
        // Filter out Microsoft schema URLs (these are required for docx format)
        const filteredMatches = matches.filter(m => !m.includes('schemas.microsoft.com'));
        if (filteredMatches.length > 0) {
          findings.push({
            file: filePath,
            matches: [...new Set(filteredMatches)], // unique matches
            pattern: pattern.toString()
          });
        }
      }
    }
  }
  
  return findings;
}

/**
 * Clean a template by replacing branding references
 */
function cleanTemplate(templatePath, outputPath) {
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  
  let changesMade = 0;
  
  for (const filePath of FILES_TO_SCAN) {
    const file = zip.file(filePath);
    if (!file) continue;
    
    let xmlContent = file.asText();
    let modified = false;
    
    for (const { pattern, replacement } of BRANDING_PATTERNS) {
      const originalContent = xmlContent;
      xmlContent = xmlContent.replace(pattern, replacement);
      if (xmlContent !== originalContent) {
        modified = true;
        changesMade++;
      }
    }
    
    if (modified) {
      zip.file(filePath, xmlContent);
    }
  }
  
  // Write the cleaned file
  const outputBuffer = zip.generate({
    type: 'nodebuffer',
    compression: 'DEFLATE'
  });
  
  fs.writeFileSync(outputPath, outputBuffer);
  
  return changesMade;
}

/**
 * Generate a clean filename from the original
 */
function generateCleanName(originalName, index) {
  // Remove common noise from filenames
  let clean = originalName
    .replace(/\.docx$/i, '')
    .replace(/MAKE A COPY TO EDIT/gi, '')
    .replace(/\(\d+\)/g, '')
    .replace(/\d+\./g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .trim();
  
  // If it's a UUID, give it a generic name
  if (/^[a-f0-9-]{36}$/i.test(clean)) {
    clean = `template-${index + 1}`;
  }
  
  // Shorten and clean
  if (clean.length > 40) {
    clean = clean.substring(0, 40).replace(/-+$/, '');
  }
  
  return clean || `template-${index + 1}`;
}

// ==================== MAIN ====================

async function main() {
  console.log('='.repeat(60));
  console.log('Template Cleaner - Removing Branding References');
  console.log('='.repeat(60));
  console.log('');
  
  // Get all templates
  const templates = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.docx'))
    .map(f => path.join(TEMPLATES_DIR, f));
  
  console.log(`Found ${templates.length} templates\n`);
  
  // Phase 1: Scan all templates
  console.log('PHASE 1: Scanning for branding references...\n');
  
  const scanResults = [];
  for (const templatePath of templates) {
    const name = path.basename(templatePath);
    const findings = scanTemplate(templatePath);
    scanResults.push({ name, path: templatePath, findings });
    
    if (findings.length > 0) {
      console.log(`📄 ${name}`);
      for (const finding of findings) {
        console.log(`   └─ ${finding.file}: ${finding.matches.join(', ')}`);
      }
    } else {
      console.log(`✅ ${name} - Clean`);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  
  // Phase 2: Clean templates
  console.log('\nPHASE 2: Cleaning templates...\n');
  
  // Create cleaned directory
  const cleanedDir = path.join(TEMPLATES_DIR, 'cleaned');
  if (!fs.existsSync(cleanedDir)) {
    fs.mkdirSync(cleanedDir, { recursive: true });
  }
  
  const cleanedFiles = [];
  
  for (let i = 0; i < scanResults.length; i++) {
    const { name, path: templatePath } = scanResults[i];
    const cleanName = generateCleanName(name, i) + '.docx';
    const outputPath = path.join(cleanedDir, cleanName);
    
    const changes = cleanTemplate(templatePath, outputPath);
    cleanedFiles.push({ original: name, cleaned: cleanName, changes });
    
    console.log(`${changes > 0 ? '🧹' : '✅'} ${name}`);
    console.log(`   → ${cleanName} (${changes} replacements)`);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('\nCleaned templates saved to: backend/templates/cleaned/');
  console.log('\nTo use the cleaned templates, move them to backend/templates/');
  console.log('and delete the original files.');
  console.log('\n' + '='.repeat(60));
  
  // Output summary
  console.log('\nSUMMARY:');
  console.log('-'.repeat(40));
  for (const { original, cleaned, changes } of cleanedFiles) {
    console.log(`${cleaned.padEnd(45)} (from: ${original.substring(0, 30)}...)`);
  }
}

main().catch(console.error);
