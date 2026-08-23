// Deterministic ATS Scanner
// Per project requirements: NO random scores - all scoring is rule-based and deterministic
// Scoring breakdown:
//   - Formatting (25 points): special characters, email/phone format, length
//   - Structure (20 points): proper sections present
//   - Content Quality (25 points): action verbs, quantifiable achievements
//   - Keywords (20 points): skill matching, industry terms
//   - Completeness (10 points): all sections filled

// ==================== TYPES ====================

export interface PersonalInfo {
  fullName: string;
  email: string;
  phone: string;
  location: string;
  linkedin?: string;
  website?: string;
}

export interface ExperienceItem {
  id: string;
  title: string;
  company: string;
  startDate: string;
  endDate: string;
  description?: string;
  bullets: string[];
}

export interface EducationItem {
  id: string;
  degree: string;
  institution: string;
  field: string;
  graduationYear: string;
}

export interface ResumeData {
  personalInfo: PersonalInfo;
  summary: string;
  experience: ExperienceItem[];
  education: EducationItem[];
  skills: string[];
}

export type IssueLevel = 'good' | 'warning' | 'issue';

export interface ATSIssue {
  id: string;
  category: string;
  title: string;
  description: string;
  level: IssueLevel;
  suggestion?: string;
}

export interface ATSCategoryScore {
  category: string;
  score: number;
  maxScore: number;
  issues: ATSIssue[];
}

export interface ATSScanResult {
  overallScore: number;
  status: 'excellent' | 'good' | 'needs-work' | 'poor';
  categories: ATSCategoryScore[];
  keywords: {
    found: string[];
    missing: string[];
  };
  formatting: {
    isAtsCompatible: boolean;
    issues: string[];
  };
}

// ==================== CONSTANTS ====================

// Action verbs that ATS systems look for
const ACTION_VERBS = [
  'achieved', 'administered', 'analyzed', 'architected', 'automated',
  'built', 'collaborated', 'configured', 'created', 'decreased',
  'delivered', 'designed', 'developed', 'drove', 'eliminated',
  'engineered', 'established', 'executed', 'expanded', 'facilitated',
  'generated', 'grew', 'implemented', 'improved', 'increased',
  'initiated', 'integrated', 'launched', 'led', 'managed',
  'mentored', 'migrated', 'modernized', 'negotiated', 'optimized',
  'orchestrated', 'overhauled', 'pioneered', 'planned', 'produced',
  'programmed', 'proposed', 'reduced', 'refactored', 'resolved',
  'restructured', 'scaled', 'secured', 'shipped', 'simplified',
  'spearheaded', 'streamlined', 'strengthened', 'succeeded', 'supervised',
  'trained', 'transformed', 'upgraded'
];

// Common technical skills ATS systems look for
const COMMON_SKILLS = [
  // Programming languages
  'javascript', 'typescript', 'python', 'java', 'c++', 'c#', 'go', 'rust', 'ruby', 'php', 'swift', 'kotlin',
  // Frontend
  'react', 'vue', 'angular', 'nextjs', 'html', 'css', 'tailwind', 'sass', 'less',
  // Backend
  'nodejs', 'express', 'django', 'flask', 'spring', 'rails', 'fastapi', 'graphql', 'rest',
  // Databases
  'sql', 'postgresql', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'dynamodb', 'cassandra',
  // Cloud & DevOps
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'jenkins', 'ci/cd', 'github actions',
  // Other
  'git', 'agile', 'scrum', 'jira', 'linux', 'machine learning', 'ai', 'data analysis'
];

// Characters that can cause ATS parsing issues
const PROBLEMATIC_CHARS = /[^\x00-\x7F]|[\u2022\u2023\u25E6\u2043\u2219\u25CF\u25CB\u25AA\u25AB\u2013\u2014\u2018\u2019\u201C\u201D]/g;

// ==================== SCANNER FUNCTIONS ====================

/**
 * Main ATS scanning function - deterministic scoring
 */
export function scanResumeContent(resume: ResumeData): ATSScanResult {
  const categories: ATSCategoryScore[] = [];
  const allIssues: string[] = [];
  const foundKeywords: string[] = [];
  const missingKeywords: string[] = [];
  
  // 1. Formatting Analysis (25 points max)
  const formattingResult = analyzeFormatting(resume);
  categories.push(formattingResult.category);
  allIssues.push(...formattingResult.formattingIssues);
  
  // 2. Structure Analysis (20 points max)
  const structureResult = analyzeStructure(resume);
  categories.push(structureResult);
  
  // 3. Content Quality Analysis (25 points max)
  const contentResult = analyzeContent(resume);
  categories.push(contentResult);
  
  // 4. Keywords Analysis (20 points max)
  const keywordResult = analyzeKeywords(resume);
  categories.push(keywordResult.category);
  foundKeywords.push(...keywordResult.found);
  missingKeywords.push(...keywordResult.missing);
  
  // 5. Completeness Analysis (10 points max)
  const completenessResult = analyzeCompleteness(resume);
  categories.push(completenessResult);
  
  // Calculate overall score
  const totalScore = categories.reduce((sum, cat) => sum + cat.score, 0);
  const maxScore = categories.reduce((sum, cat) => sum + cat.maxScore, 0);
  const overallScore = Math.round((totalScore / maxScore) * 100);
  
  // Determine status
  const status = getScoreStatus(overallScore);
  
  return {
    overallScore,
    status,
    categories,
    keywords: {
      found: foundKeywords,
      missing: missingKeywords.slice(0, 10) // Limit to top 10 missing
    },
    formatting: {
      isAtsCompatible: allIssues.length === 0,
      issues: allIssues
    }
  };
}

/**
 * Analyze formatting (25 points max)
 */
function analyzeFormatting(resume: ResumeData): { category: ATSCategoryScore; formattingIssues: string[] } {
  const issues: ATSIssue[] = [];
  const formattingIssues: string[] = [];
  let score = 25;
  let issueId = 0;
  
  const { personalInfo, summary, experience } = resume;
  
  // Check email format (5 points)
  if (personalInfo.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(personalInfo.email)) {
      score -= 5;
      issues.push({
        id: `fmt-${++issueId}`,
        category: 'Formatting',
        title: 'Invalid email format',
        description: 'Email address format may not be parsed correctly by ATS',
        level: 'issue',
        suggestion: 'Use a standard email format (e.g., john.doe@email.com)'
      });
      formattingIssues.push('Invalid email format');
    }
  } else {
    score -= 5;
    issues.push({
      id: `fmt-${++issueId}`,
      category: 'Formatting',
      title: 'Missing email',
      description: 'No email address found',
      level: 'issue',
      suggestion: 'Add your professional email address'
    });
  }
  
  // Check phone format (5 points)
  if (personalInfo.phone) {
    // Allow various phone formats but flag if contains letters
    if (/[a-zA-Z]/.test(personalInfo.phone)) {
      score -= 3;
      issues.push({
        id: `fmt-${++issueId}`,
        category: 'Formatting',
        title: 'Phone number contains letters',
        description: 'Phone number should only contain numbers and standard separators',
        level: 'warning',
        suggestion: 'Use format: +1 (555) 123-4567 or 555-123-4567'
      });
      formattingIssues.push('Phone format contains letters');
    }
  } else {
    score -= 3;
    issues.push({
      id: `fmt-${++issueId}`,
      category: 'Formatting',
      title: 'Missing phone number',
      description: 'No phone number provided',
      level: 'warning',
      suggestion: 'Add your phone number for recruiter contact'
    });
  }
  
  // Check for problematic characters (5 points)
  const allText = getAllText(resume);
  const problematicMatches = allText.match(PROBLEMATIC_CHARS);
  if (problematicMatches && problematicMatches.length > 0) {
    const uniqueChars = [...new Set(problematicMatches)].slice(0, 5);
    score -= Math.min(5, problematicMatches.length);
    issues.push({
      id: `fmt-${++issueId}`,
      category: 'Formatting',
      title: 'Special characters detected',
      description: `Found ${problematicMatches.length} special character(s) that may cause parsing issues: ${uniqueChars.join(', ')}`,
      level: 'warning',
      suggestion: 'Replace special characters with standard ASCII equivalents (e.g., use "-" instead of "–")'
    });
    formattingIssues.push('Special characters may cause ATS parsing issues');
  }
  
  // Check summary length (5 points)
  if (summary) {
    const wordCount = summary.split(/\s+/).length;
    if (wordCount < 20) {
      score -= 2;
      issues.push({
        id: `fmt-${++issueId}`,
        category: 'Formatting',
        title: 'Summary too short',
        description: `Summary has only ${wordCount} words`,
        level: 'warning',
        suggestion: 'Expand summary to 50-150 words for optimal impact'
      });
    } else if (wordCount > 200) {
      score -= 2;
      issues.push({
        id: `fmt-${++issueId}`,
        category: 'Formatting',
        title: 'Summary too long',
        description: `Summary has ${wordCount} words`,
        level: 'warning',
        suggestion: 'Condense summary to 50-150 words for better readability'
      });
    }
  }
  
  // Check bullet point length (5 points)
  let longBullets = 0;
  let shortBullets = 0;
  for (const exp of experience) {
    for (const bullet of exp.bullets) {
      const words = bullet.split(/\s+/).length;
      if (words > 30) longBullets++;
      if (words < 5) shortBullets++;
    }
  }
  
  if (longBullets > 2) {
    score -= 2;
    issues.push({
      id: `fmt-${++issueId}`,
      category: 'Formatting',
      title: 'Some bullet points too long',
      description: `${longBullets} bullet point(s) exceed recommended length`,
      level: 'warning',
      suggestion: 'Keep bullet points to 1-2 lines (10-25 words)'
    });
  }
  
  if (shortBullets > 2) {
    score -= 1;
    issues.push({
      id: `fmt-${++issueId}`,
      category: 'Formatting',
      title: 'Some bullet points too short',
      description: `${shortBullets} bullet point(s) lack detail`,
      level: 'warning',
      suggestion: 'Expand bullet points to include impact and metrics'
    });
  }
  
  // Add positive feedback if score is high
  if (score >= 22) {
    issues.push({
      id: `fmt-${++issueId}`,
      category: 'Formatting',
      title: 'Well-formatted content',
      description: 'Your resume formatting is ATS-friendly',
      level: 'good'
    });
  }
  
  return {
    category: {
      category: 'Formatting',
      score: Math.max(0, score),
      maxScore: 25,
      issues
    },
    formattingIssues
  };
}

/**
 * Analyze structure (20 points max)
 */
function analyzeStructure(resume: ResumeData): ATSCategoryScore {
  const issues: ATSIssue[] = [];
  let score = 20;
  let issueId = 0;
  
  const { personalInfo, summary, experience, education, skills } = resume;
  
  // Check for essential sections
  const hasSummary = summary && summary.trim().length > 0;
  const hasExperience = experience && experience.length > 0;
  const hasEducation = education && education.length > 0;
  const hasSkills = skills && skills.length > 0;
  const hasContact = personalInfo && (personalInfo.email || personalInfo.phone);
  
  if (!hasContact) {
    score -= 5;
    issues.push({
      id: `str-${++issueId}`,
      category: 'Structure',
      title: 'Missing contact information',
      description: 'Contact section is incomplete or missing',
      level: 'issue',
      suggestion: 'Add email and phone number'
    });
  }
  
  if (!hasSummary) {
    score -= 3;
    issues.push({
      id: `str-${++issueId}`,
      category: 'Structure',
      title: 'Missing professional summary',
      description: 'No summary or objective statement found',
      level: 'warning',
      suggestion: 'Add a 2-3 sentence professional summary highlighting your value'
    });
  }
  
  if (!hasExperience) {
    score -= 5;
    issues.push({
      id: `str-${++issueId}`,
      category: 'Structure',
      title: 'Missing work experience',
      description: 'No work experience entries found',
      level: 'issue',
      suggestion: 'Add your relevant work experience'
    });
  }
  
  if (!hasEducation) {
    score -= 3;
    issues.push({
      id: `str-${++issueId}`,
      category: 'Structure',
      title: 'Missing education',
      description: 'No education entries found',
      level: 'warning',
      suggestion: 'Add your educational background'
    });
  }
  
  if (!hasSkills) {
    score -= 4;
    issues.push({
      id: `str-${++issueId}`,
      category: 'Structure',
      title: 'Missing skills section',
      description: 'No skills listed',
      level: 'issue',
      suggestion: 'Add a skills section with relevant technical and soft skills'
    });
  }
  
  // Check experience has bullet points
  if (hasExperience) {
    const experienceWithoutBullets = experience.filter(e => !e.bullets || e.bullets.length === 0);
    if (experienceWithoutBullets.length > 0) {
      score -= 2;
      issues.push({
        id: `str-${++issueId}`,
        category: 'Structure',
        title: 'Experience entries lack bullet points',
        description: `${experienceWithoutBullets.length} experience entry(ies) have no bullet points`,
        level: 'warning',
        suggestion: 'Add 3-5 bullet points per role describing achievements'
      });
    }
  }
  
  // Positive feedback
  if (score >= 17) {
    issues.push({
      id: `str-${++issueId}`,
      category: 'Structure',
      title: 'Well-structured resume',
      description: 'All essential sections are present',
      level: 'good'
    });
  }
  
  return {
    category: 'Structure',
    score: Math.max(0, score),
    maxScore: 20,
    issues
  };
}

/**
 * Analyze content quality (25 points max)
 */
function analyzeContent(resume: ResumeData): ATSCategoryScore {
  const issues: ATSIssue[] = [];
  let score = 25;
  let issueId = 0;
  
  const { experience, summary } = resume;
  
  // Collect all bullet points
  const allBullets: string[] = [];
  for (const exp of experience) {
    allBullets.push(...exp.bullets);
  }
  
  if (allBullets.length === 0) {
    return {
      category: 'Content Quality',
      score: 0,
      maxScore: 25,
      issues: [{
        id: `cnt-${++issueId}`,
        category: 'Content Quality',
        title: 'No content to analyze',
        description: 'No bullet points found in experience section',
        level: 'issue',
        suggestion: 'Add bullet points describing your achievements'
      }]
    };
  }
  
  // Check for action verbs (10 points)
  const bulletsWithActionVerbs = allBullets.filter(bullet => {
    const firstWord = bullet.trim().split(/\s+/)[0]?.toLowerCase() || '';
    return ACTION_VERBS.includes(firstWord) || 
           ACTION_VERBS.some(verb => bullet.toLowerCase().startsWith(verb));
  });
  
  const actionVerbPercentage = (bulletsWithActionVerbs.length / allBullets.length) * 100;
  
  if (actionVerbPercentage < 30) {
    score -= 8;
    issues.push({
      id: `cnt-${++issueId}`,
      category: 'Content Quality',
      title: 'Few action verbs',
      description: `Only ${Math.round(actionVerbPercentage)}% of bullet points start with action verbs`,
      level: 'issue',
      suggestion: 'Start bullet points with strong action verbs like "Led", "Developed", "Increased"'
    });
  } else if (actionVerbPercentage < 60) {
    score -= 4;
    issues.push({
      id: `cnt-${++issueId}`,
      category: 'Content Quality',
      title: 'More action verbs recommended',
      description: `${Math.round(actionVerbPercentage)}% of bullet points use action verbs`,
      level: 'warning',
      suggestion: 'Aim for 70%+ bullet points starting with action verbs'
    });
  } else {
    issues.push({
      id: `cnt-${++issueId}`,
      category: 'Content Quality',
      title: 'Strong action verbs',
      description: 'Good use of action verbs in bullet points',
      level: 'good'
    });
  }
  
  // Check for quantifiable achievements (10 points)
  const quantifiablePattern = /\d+[\.\,]?\d*\s*(%|percent|\$|dollars|k\b|m\b|users|customers|clients|employees|team|members|projects|x\b|times|hours|days|weeks|months|years)/i;
  const bulletsWithMetrics = allBullets.filter(bullet => quantifiablePattern.test(bullet));
  
  const metricsPercentage = (bulletsWithMetrics.length / allBullets.length) * 100;
  
  if (metricsPercentage < 20) {
    score -= 8;
    issues.push({
      id: `cnt-${++issueId}`,
      category: 'Content Quality',
      title: 'Lack of quantifiable results',
      description: `Only ${Math.round(metricsPercentage)}% of bullet points include metrics`,
      level: 'issue',
      suggestion: 'Add numbers and percentages to demonstrate impact (e.g., "Increased sales by 25%")'
    });
  } else if (metricsPercentage < 40) {
    score -= 4;
    issues.push({
      id: `cnt-${++issueId}`,
      category: 'Content Quality',
      title: 'More metrics recommended',
      description: `${Math.round(metricsPercentage)}% of bullet points include metrics`,
      level: 'warning',
      suggestion: 'Aim for 40%+ bullet points with quantifiable achievements'
    });
  } else {
    issues.push({
      id: `cnt-${++issueId}`,
      category: 'Content Quality',
      title: 'Good use of metrics',
      description: 'Strong quantifiable achievements throughout',
      level: 'good'
    });
  }
  
  // Check summary quality (5 points)
  if (summary) {
    const summaryWords = summary.split(/\s+/);
    const hasYearsExperience = /\d+\+?\s*(years?|yrs?)/i.test(summary);
    const hasKeyAchievement = quantifiablePattern.test(summary);
    
    if (!hasYearsExperience && summaryWords.length >= 10) {
      score -= 2;
      issues.push({
        id: `cnt-${++issueId}`,
        category: 'Content Quality',
        title: 'Summary lacks experience context',
        description: 'Consider mentioning years of experience in summary',
        level: 'warning',
        suggestion: 'Start with "X+ years of experience in..."'
      });
    }
    
    if (hasKeyAchievement) {
      issues.push({
        id: `cnt-${++issueId}`,
        category: 'Content Quality',
        title: 'Strong summary',
        description: 'Summary includes quantifiable achievement',
        level: 'good'
      });
    }
  }
  
  return {
    category: 'Content Quality',
    score: Math.max(0, score),
    maxScore: 25,
    issues
  };
}

/**
 * Analyze keywords (20 points max)
 */
function analyzeKeywords(resume: ResumeData): { category: ATSCategoryScore; found: string[]; missing: string[] } {
  const issues: ATSIssue[] = [];
  let score = 20;
  let issueId = 0;
  
  const { skills } = resume;
  const allText = getAllText(resume).toLowerCase();
  
  // Check skills against common skills database
  const normalizedSkills = skills.map(s => s.toLowerCase().trim());
  const foundSkills: string[] = [];
  const missingCommonSkills: string[] = [];
  
  for (const skill of COMMON_SKILLS) {
    if (normalizedSkills.includes(skill) || allText.includes(skill)) {
      foundSkills.push(skill);
    }
  }
  
  // Check for skill density
  if (skills.length < 5) {
    score -= 6;
    issues.push({
      id: `kwd-${++issueId}`,
      category: 'Keywords',
      title: 'Too few skills listed',
      description: `Only ${skills.length} skills listed`,
      level: 'issue',
      suggestion: 'List 8-15 relevant skills that match your target roles'
    });
  } else if (skills.length < 8) {
    score -= 3;
    issues.push({
      id: `kwd-${++issueId}`,
      category: 'Keywords',
      title: 'Consider adding more skills',
      description: `${skills.length} skills listed`,
      level: 'warning',
      suggestion: 'Consider adding a few more relevant skills'
    });
  } else {
    issues.push({
      id: `kwd-${++issueId}`,
      category: 'Keywords',
      title: 'Good skill coverage',
      description: `${skills.length} skills listed`,
      level: 'good'
    });
  }
  
  // Check if skills appear in experience bullets (keyword reinforcement)
  let skillsInExperience = 0;
  for (const skill of normalizedSkills) {
    for (const exp of resume.experience) {
      for (const bullet of exp.bullets) {
        if (bullet.toLowerCase().includes(skill)) {
          skillsInExperience++;
          break;
        }
      }
    }
  }
  
  const reinforcementRate = skills.length > 0 ? (skillsInExperience / skills.length) * 100 : 0;
  
  if (reinforcementRate < 20) {
    score -= 6;
    issues.push({
      id: `kwd-${++issueId}`,
      category: 'Keywords',
      title: 'Skills not reinforced in experience',
      description: 'Skills listed are not demonstrated in work experience',
      level: 'issue',
      suggestion: 'Use your listed skills in bullet points to show practical application'
    });
  } else if (reinforcementRate < 40) {
    score -= 3;
    issues.push({
      id: `kwd-${++issueId}`,
      category: 'Keywords',
      title: 'Reinforce skills in experience',
      description: 'Some skills could be better demonstrated in bullet points',
      level: 'warning',
      suggestion: 'Reference your skills when describing achievements'
    });
  }
  
  // Suggest missing common skills based on resume content
  const contentSkillHints = extractSkillHintsFromContent(allText);
  for (const hint of contentSkillHints) {
    if (!normalizedSkills.includes(hint) && !foundSkills.includes(hint)) {
      missingCommonSkills.push(hint);
    }
  }
  
  if (missingCommonSkills.length > 5) {
    score -= 3;
    issues.push({
      id: `kwd-${++issueId}`,
      category: 'Keywords',
      title: 'Consider adding industry keywords',
      description: 'Some relevant skills may be missing from your skills list',
      level: 'warning',
      suggestion: `Consider adding: ${missingCommonSkills.slice(0, 5).join(', ')}`
    });
  }
  
  return {
    category: {
      category: 'Keywords',
      score: Math.max(0, score),
      maxScore: 20,
      issues
    },
    found: foundSkills,
    missing: missingCommonSkills.slice(0, 10)
  };
}

/**
 * Analyze completeness (10 points max)
 */
function analyzeCompleteness(resume: ResumeData): ATSCategoryScore {
  const issues: ATSIssue[] = [];
  let score = 10;
  let issueId = 0;
  
  const { personalInfo, summary, experience, education, skills } = resume;
  
  // Check each section for completeness
  
  // Personal info completeness (2 points)
  const personalComplete = Boolean(
    personalInfo.fullName?.trim() &&
    personalInfo.email?.trim() &&
    personalInfo.phone?.trim() &&
    personalInfo.location?.trim()
  );
  
  if (!personalComplete) {
    score -= 2;
    const missing: string[] = [];
    if (!personalInfo.fullName?.trim()) missing.push('name');
    if (!personalInfo.email?.trim()) missing.push('email');
    if (!personalInfo.phone?.trim()) missing.push('phone');
    if (!personalInfo.location?.trim()) missing.push('location');
    
    issues.push({
      id: `cmp-${++issueId}`,
      category: 'Completeness',
      title: 'Incomplete contact information',
      description: `Missing: ${missing.join(', ')}`,
      level: 'warning',
      suggestion: 'Complete all contact fields'
    });
  }
  
  // Summary completeness (2 points)
  const summaryWords = summary?.split(/\s+/).length || 0;
  if (summaryWords < 20) {
    score -= 2;
    issues.push({
      id: `cmp-${++issueId}`,
      category: 'Completeness',
      title: 'Summary needs expansion',
      description: summaryWords === 0 ? 'No summary provided' : `Summary only has ${summaryWords} words`,
      level: 'warning',
      suggestion: 'Write a comprehensive 50-150 word summary'
    });
  }
  
  // Experience completeness (3 points)
  if (experience.length === 0) {
    score -= 3;
  } else {
    let incompleteExperience = 0;
    for (const exp of experience) {
      if (!exp.title || !exp.company || exp.bullets.length < 2) {
        incompleteExperience++;
      }
    }
    
    if (incompleteExperience > 0) {
      score -= Math.min(2, incompleteExperience);
      issues.push({
        id: `cmp-${++issueId}`,
        category: 'Completeness',
        title: 'Experience entries incomplete',
        description: `${incompleteExperience} experience entry(ies) need more detail`,
        level: 'warning',
        suggestion: 'Add 3-5 bullet points per role'
      });
    }
  }
  
  // Education completeness (1 point)
  if (education.length === 0) {
    score -= 1;
  } else {
    const incompleteEdu = education.filter(e => !e.degree || !e.institution);
    if (incompleteEdu.length > 0) {
      score -= 1;
      issues.push({
        id: `cmp-${++issueId}`,
        category: 'Completeness',
        title: 'Education entries incomplete',
        description: 'Some education entries lack degree or institution',
        level: 'warning',
        suggestion: 'Complete all education fields'
      });
    }
  }
  
  // Skills completeness (2 points)
  if (skills.length < 5) {
    score -= 2;
    issues.push({
      id: `cmp-${++issueId}`,
      category: 'Completeness',
      title: 'Skills section sparse',
      description: `Only ${skills.length} skill(s) listed`,
      level: 'warning',
      suggestion: 'Add 8-15 relevant skills'
    });
  }
  
  // Positive feedback
  if (score >= 8) {
    issues.push({
      id: `cmp-${++issueId}`,
      category: 'Completeness',
      title: 'Comprehensive resume',
      description: 'All sections are well-filled',
      level: 'good'
    });
  }
  
  return {
    category: 'Completeness',
    score: Math.max(0, score),
    maxScore: 10,
    issues
  };
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Get all text content from resume for analysis
 */
function getAllText(resume: ResumeData): string {
  const parts: string[] = [];
  
  if (resume.personalInfo) {
    parts.push(
      resume.personalInfo.fullName || '',
      resume.personalInfo.email || '',
      resume.personalInfo.location || ''
    );
  }
  
  parts.push(resume.summary || '');
  
  for (const exp of resume.experience || []) {
    parts.push(exp.title || '', exp.company || '', exp.description || '');
    parts.push(...(exp.bullets || []));
  }
  
  for (const edu of resume.education || []) {
    parts.push(edu.degree || '', edu.institution || '', edu.field || '');
  }
  
  parts.push(...(resume.skills || []));
  
  return parts.join(' ');
}

/**
 * Extract potential skill suggestions from resume content
 */
function extractSkillHintsFromContent(text: string): string[] {
  const hints: string[] = [];
  
  for (const skill of COMMON_SKILLS) {
    // Check if skill is mentioned in content but not in skills section
    if (text.includes(skill)) {
      hints.push(skill);
    }
  }
  
  return hints;
}

/**
 * Get status label based on score
 */
function getScoreStatus(score: number): 'excellent' | 'good' | 'needs-work' | 'poor' {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'needs-work';
  return 'poor';
}

/**
 * Scan raw text content (for uploaded files without structure)
 */
export function scanRawText(text: string): ATSScanResult {
  // Create a minimal resume structure from raw text
  const lines = text.split('\n').filter(l => l.trim());
  
  // Try to extract email and phone
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phoneMatch = text.match(/[\+\d][\d\s\-\(\)\.]{8,}/);
  
  // Create pseudo-resume for scanning
  const resume: ResumeData = {
    personalInfo: {
      fullName: lines[0] || '',
      email: emailMatch?.[0] || '',
      phone: phoneMatch?.[0] || '',
      location: ''
    },
    summary: '',
    experience: [{
      id: 'raw-1',
      title: '',
      company: '',
      startDate: '',
      endDate: '',
      bullets: lines.slice(1, 20) // Use first 20 lines as content
    }],
    education: [],
    skills: []
  };
  
  // Extract potential skills from text
  for (const skill of COMMON_SKILLS) {
    if (text.toLowerCase().includes(skill)) {
      resume.skills.push(skill);
    }
  }
  
  return scanResumeContent(resume);
}
