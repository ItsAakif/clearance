/**
 * SAFE Template Converter
 * 
 * This script ONLY replaces text content inside <w:t> tags.
 * It does NOT touch XML structure, namespaces, or attributes.
 * 
 * Usage: node scripts/safe-convert-templates.js
 * 
 * The script will:
 * 1. Create a backup in templates/backup/
 * 2. Convert templates in-place
 * 3. Validate output files can be opened
 */

const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATES_DIR = path.join(__dirname, '../templates');
const BACKUP_DIR = path.join(TEMPLATES_DIR, 'backup');

// Only replace text INSIDE <w:t> tags, never touch XML structure
// These patterns match common resume placeholder text
const TEXT_REPLACEMENTS = [
  // Full names - be very specific to avoid false matches
  { find: /\bJohn Smith\b/gi, replace: '{{fullName}}' },
  { find: /\bJane Doe\b/gi, replace: '{{fullName}}' },
  { find: /\bJohn Doe\b/gi, replace: '{{fullName}}' },
  { find: /\bFirst Last\b/gi, replace: '{{fullName}}' },
  { find: /\bFIRST LAST\b/g, replace: '{{fullName}}' },
  { find: /\bYOUR NAME\b/g, replace: '{{fullName}}' },
  { find: /\bYour Name\b/g, replace: '{{fullName}}' },
  { find: /\bFULL NAME\b/g, replace: '{{fullName}}' },
  { find: /\bADAM GREGORY\b/g, replace: '{{fullName}}' },
  { find: /\bAdam Gregory\b/g, replace: '{{fullName}}' },
  
  // Emails - specific patterns only
  { find: /\bjohn\.smith@email\.com\b/gi, replace: '{{email}}' },
  { find: /\bjane\.doe@email\.com\b/gi, replace: '{{email}}' },
  { find: /\byour\.email@example\.com\b/gi, replace: '{{email}}' },
  { find: /\bemail@example\.com\b/gi, replace: '{{email}}' },
  { find: /\bname@email\.com\b/gi, replace: '{{email}}' },
  { find: /\bfirst\.last@email\.com\b/gi, replace: '{{email}}' },
  { find: /\bfirstname\.lastname@email\.com\b/gi, replace: '{{email}}' },
  
  // Phone numbers - specific formats
  { find: /\(555\) 555-5555/g, replace: '{{phone}}' },
  { find: /555-555-5555/g, replace: '{{phone}}' },
  { find: /\+1 555 555 5555/g, replace: '{{phone}}' },
  { find: /\(123\) 456-7890/g, replace: '{{phone}}' },
  { find: /123-456-7890/g, replace: '{{phone}}' },
  
  // LinkedIn - specific patterns
  { find: /linkedin\.com\/in\/yourname/gi, replace: '{{linkedin}}' },
  { find: /linkedin\.com\/in\/johnsmith/gi, replace: '{{linkedin}}' },
  { find: /linkedin\.com\/in\/your-name/gi, replace: '{{linkedin}}' },
  { find: /linkedin\.com\/in\/username/gi, replace: '{{linkedin}}' },
  
  // Locations - specific cities used as placeholders
  { find: /\bNew York, NY\b/g, replace: '{{location}}' },
  { find: /\bSan Francisco, CA\b/g, replace: '{{location}}' },
  { find: /\bCity, State\b/g, replace: '{{location}}' },
  { find: /\bCITY, STATE\b/g, replace: '{{location}}' },
  { find: /\bYour City, ST\b/g, replace: '{{location}}' },
];

/**
 * Safely replace text only within <w:t> tags
 * This preserves all XML structure
 */
function safeReplaceInTextTags(xml) {
  let modified = false;
  
  // Match <w:t> or <w:t xml:space="preserve"> tags and their content
  const result = xml.replace(
    /(<w:t[^>]*>)([^<]*)(<\/w:t>)/g,
    (match, openTag, content, closeTag) => {
      let newContent = content;
      
      for (const { find, replace } of TEXT_REPLACEMENTS) {
        if (find.test(newContent)) {
          newContent = newContent.replace(find, replace);
          modified = true;
        }
        // Reset regex lastIndex for global patterns
        find.lastIndex = 0;
      }
      
      return openTag + newContent + closeTag;
    }
  );
  
  return { xml: result, modified };
}

/**
 * Validate that a buffer is a valid DOCX file
 */
function validateDocx(buffer) {
  try {
    const zip = new PizZip(buffer);
    const docXml = zip.file('word/document.xml');
    if (!docXml) return false;
    
    const content = docXml.asText();
    // Check for valid XML structure
    if (!content.includes('<w:document')) return false;
    if (!content.includes('<w:body>')) return false;
    if (!content.includes('</w:document>')) return false;
    
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Convert a single template file
 */
function convertTemplate(filePath) {
  const fileName = path.basename(filePath);
  
  try {
    // Read file
    const content = fs.readFileSync(filePath);
    
    // Validate it's a valid DOCX
    if (!validateDocx(content)) {
      return { success: false, error: 'Invalid or corrupted DOCX file' };
    }
    
    // Open as zip
    const zip = new PizZip(content);
    const docFile = zip.file('word/document.xml');
    
    if (!docFile) {
      return { success: false, error: 'No document.xml found' };
    }
    
    const xml = docFile.asText();
    
    // Apply safe replacements
    const { xml: newXml, modified } = safeReplaceInTextTags(xml);
    
    if (!modified) {
      return { success: true, modified: false, message: 'No replacements needed' };
    }
    
    // Update the zip
    zip.file('word/document.xml', newXml);
    
    // Generate output
    const outputBuffer = zip.generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 }
    });
    
    // Validate output
    if (!validateDocx(outputBuffer)) {
      return { success: false, error: 'Output validation failed - conversion corrupted the file' };
    }
    
    // Save
    fs.writeFileSync(filePath, outputBuffer);
    
    return { success: true, modified: true };
    
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Create backup of all templates
 */
function backupTemplates() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.docx'));
  
  for (const file of files) {
    const src = path.join(TEMPLATES_DIR, file);
    const dest = path.join(BACKUP_DIR, file);
    fs.copyFileSync(src, dest);
  }
  
  console.log(`✅ Backed up ${files.length} files to templates/backup/`);
  return files.length;
}

// ==================== MAIN ====================

async function main() {
  console.log('='.repeat(60));
  console.log('SAFE Template Converter');
  console.log('='.repeat(60));
  console.log('');
  
  // Check for templates
  const templates = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.docx') && !f.startsWith('~'));
  
  if (templates.length === 0) {
    console.log('❌ No .docx templates found in', TEMPLATES_DIR);
    return;
  }
  
  console.log(`Found ${templates.length} templates\n`);
  
  // Create backup first
  console.log('Creating backup...');
  backupTemplates();
  console.log('');
  
  // Convert each template
  let successCount = 0;
  let modifiedCount = 0;
  let errorCount = 0;
  
  for (const file of templates) {
    const filePath = path.join(TEMPLATES_DIR, file);
    const result = convertTemplate(filePath);
    
    if (result.success) {
      if (result.modified) {
        console.log(`✅ ${file} - Converted`);
        modifiedCount++;
      } else {
        console.log(`⏭️  ${file} - No changes needed`);
      }
      successCount++;
    } else {
      console.log(`❌ ${file} - ${result.error}`);
      errorCount++;
    }
  }
  
  console.log('');
  console.log('='.repeat(60));
  console.log(`Results: ${successCount} success, ${modifiedCount} modified, ${errorCount} errors`);
  console.log('='.repeat(60));
  
  if (errorCount > 0) {
    console.log('\n⚠️  Some files had errors. Check the backup folder to restore them.');
  }
}

main().catch(console.error);
