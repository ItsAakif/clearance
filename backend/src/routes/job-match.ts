// Job Match Routes - Resume to job description matching
// Per security.md: Validate input, enforce ownership
//
// Tailoring-first: this is an ATS keyword-match tool. It extracts requirements
// from a job description, compares them to the resume, and ranks missing
// keywords as CRITICAL (hard requirements) vs PREFERRED (nice-to-have), plus
// surfaces role-specific keyword suggestions from a curated bank.

import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError, BadRequestError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, jobMatchSchema } from '../shared/validation.js';
import {
  ROLE_KEYWORD_BANKS,
  JOB_MATCH_NOISE,
  detectRoleFromJobDescription,
  getRoleBank,
} from '../jobSources/roleKeywords.js';
import { enhanceMatchWithLLM } from '../ats/matchEnhancer.js';

const router = Router();

// ==================== TYPES ====================

interface PersonalInfo {
  fullName: string;
  email: string;
  phone: string;
  location: string;
}

interface ExperienceItem {
  title: string;
  company: string;
  bullets: string[];
}

interface ResumeData {
  personalInfo: PersonalInfo;
  summary: string;
  experience: ExperienceItem[];
  education: any[];
  skills: string[];
}

interface MatchResult {
  matchScore: number;
  matchedKeywords: string[];
  missingKeywords: string[];
  suggestions: string[];
  // Tailoring enhancements
  detectedRole: string | null;
  criticalMissing: string[];
  preferredMissing: string[];
  roleSuggestions: string[];
  tailoringTips?: string[];
}

// ==================== KEYWORD EXTRACTION ====================

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
  'it', 'its', 'we', 'our', 'you', 'your', 'they', 'their', 'he', 'she',
  'job', 'work', 'working', 'experience', 'required', 'requirements',
  'responsibilities', 'looking', 'seeking', 'ideal', 'candidate', 'ability',
  'able', 'strong', 'excellent', 'good', 'great', 'etc', 'including'
]);

const SKILL_SYNONYMS: Record<string, string[]> = {
  'javascript': ['js', 'ecmascript', 'es6'],
  'typescript': ['ts'],
  'react': ['reactjs', 'react.js'],
  'node': ['nodejs', 'node.js'],
  'postgresql': ['postgres', 'psql'],
  'kubernetes': ['k8s'],
  'amazon web services': ['aws'],
  'google cloud platform': ['gcp', 'google cloud'],
  'machine learning': ['ml'],
  'artificial intelligence': ['ai'],
};

// Curated multi-word + single-word skills used to extract *meaningful* phrases
// from a job description instead of treating every word as a keyword. Order
// matters: longer phrases are matched first so "machine learning" isn't split
// into "machine" + "learning".
const KNOWN_SKILLS: string[] = [
  // data / ai
  'machine learning', 'deep learning', 'natural language processing', 'nlp',
  'computer vision', 'data science', 'data analysis', 'data visualization',
  'feature engineering', 'prompt engineering', 'large language models', 'llms',
  'artificial intelligence', 'ai', 'ml', 'statistics', 'experimentation',
  'a/b testing', 'etl', 'data structures', 'algorithms',
  // languages
  'python', 'javascript', 'typescript', 'java', 'go', 'rust', 'c++', 'c#',
  'sql', 'r', 'scala', 'swift', 'kotlin', 'php', 'ruby',
  // frameworks / libs
  'react', 'vue', 'angular', 'next.js', 'node.js', 'nodejs', 'express',
  'tensorflow', 'pytorch', 'scikit-learn', 'pandas', 'numpy', 'spark',
  'tailwind', 'redux', 'graphql', 'grpc', 'django', 'flask', 'fastapi',
  // cloud / infra
  'aws', 'gcp', 'azure', 'docker', 'kubernetes', 'terraform', 'linux', 'bash',
  'ci/cd', 'cicd', 'ansible', 'helm', 'lambda', 'monitoring', 'prometheus',
  'grafana', 'observability', 'iac', 'redis', 'elasticsearch', 'kafka',
  'rabbitmq', 'mongodb', 'postgresql', 'mysql', 'caching',
  // web / product
  'rest', 'api', 'rest api', 'html', 'css', 'responsive design', 'accessibility',
  'microservices', 'system design', 'testing', 'jest', 'playwright', 'webpack',
  'sass', 'storybook', 'performance optimization',
  'product management', 'roadmap', 'user research', 'agile', 'scrum',
  'stakeholder management', 'analytics', 'okrs', 'kpis', 'jira', 'figma',
  'seo', 'content marketing', 'social media', 'google analytics', 'campaigns',
  'email marketing', 'copywriting', 'brand', 'crm', 'tableau', 'power bi',
  'looker', 'snowflake', 'excel', 'reporting', 'git', 'github', 'github actions',
  'jenkins', 'cross-functional',
];

// Sort longest-first so multi-word phrases take precedence over their parts.
const KNOWN_SKILLS_SORTED = [...KNOWN_SKILLS].sort((a, b) => b.length - a.length);

function normalizeText(text: string): string {
  return text.toLowerCase()
    .replace(/[^\w\s\-\.\/\+\#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKeyword(keyword: string): string {
  return keyword.toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '');
}

function keywordsMatch(keyword1: string, keyword2: string): boolean {
  const norm1 = normalizeKeyword(keyword1);
  const norm2 = normalizeKeyword(keyword2);

  if (norm1 === norm2) return true;
  if (norm1.includes(norm2) || norm2.includes(norm1)) return true;

  for (const [canonical, synonyms] of Object.entries(SKILL_SYNONYMS)) {
    const allVariants = [canonical, ...synonyms].map(normalizeKeyword);
    if (allVariants.includes(norm1) && allVariants.includes(norm2)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract meaningful requirement *phrases* from a job description instead of a
 * bag of single words. For every known skill (and its synonyms), check if the JD
 * mentions it (substring + synonym aware). This keeps the match denominator
 * honest: only real skills count, not filler words like "about" or "assist".
 */
function extractJobRequirements(jobDescription: string): string[] {
  const text = normalizeText(jobDescription);
  const requirements: string[] = [];

  const candidates: { canonical: string; variants: string[] }[] = [];
  for (const skill of KNOWN_SKILLS_SORTED) {
    const variants = [skill, ...(SKILL_SYNONYMS[skill] || [])];
    candidates.push({ canonical: skill, variants });
  }
  // Also treat role-bank terms as candidates so role-specific skills are caught
  // even when not in the global list.
  for (const bank of Object.values(ROLE_KEYWORD_BANKS)) {
    for (const term of [...bank.critical, ...bank.preferred]) {
      if (!KNOWN_SKILLS.includes(term)) {
        candidates.push({ canonical: term, variants: [term, ...(bank.aliases?.[term] ? [bank.aliases[term]] : [])] });
      }
    }
  }

  const seen = new Set<string>();
  for (const { canonical, variants } of candidates) {
    const normCanon = normalizeKeyword(canonical);
    if (seen.has(normCanon)) continue;
    const matched = variants.some((v) => text.includes(v.toLowerCase()));
    if (matched) {
      requirements.push(canonical);
      seen.add(normCanon);
    }
  }

  return requirements;
}

function extractKeywords(text: string): string[] {
  if (!text) return [];

  const normalized = text.toLowerCase()
    .replace(/[^\w\s\-\.\/\+\#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = normalized.split(' ');

  return words.filter(word =>
    word.length > 2 &&
    !STOP_WORDS.has(word) &&
    !/^\d+$/.test(word)
  );
}

/**
 * Does the resume contain the requirement phrase? Uses substring + synonym
 * matching on the normalized resume text so "ml" matches "machine learning"
 * and "ai" matches "artificial intelligence". Multi-word requirements are
 * matched as a whole phrase to avoid false positives on individual words.
 */
function resumeMentions(resumeText: string, requirement: string): boolean {
  const text = normalizeText(resumeText);
  const variants = [requirement, ...(SKILL_SYNONYMS[requirement.toLowerCase()] || [])];
  return variants.some((v) => {
    const norm = normalizeKeyword(v);
    if (text.includes(norm)) return true;
    // loose word-set match for multi-word requirements (e.g. "data science")
    const parts = norm.split(' ').filter(Boolean);
    if (parts.length > 1) {
      return parts.every((p) => {
        if (STOP_WORDS.has(p)) return true;
        return text.split(' ').some((w) => keywordsMatch(p, w));
      });
    }
    return false;
  });
}

function getResumeText(resume: ResumeData): string {
  const parts: string[] = [resume.summary || ''];
  
  for (const exp of resume.experience || []) {
    parts.push(exp.title || '', exp.company || '', ...(exp.bullets || []));
  }
  
  for (const edu of resume.education || []) {
    parts.push(edu.degree || '', edu.field || '', edu.institution || '');
  }
  
  return parts.join(' ');
}

function matchResumeToJob(resume: ResumeData, jobDescription: string): MatchResult {
  const requirements = extractJobRequirements(jobDescription);
  const resumeText = getResumeText(resume);

  const resumeKeywords = new Set(extractKeywords(resumeText));
  for (const skill of resume.skills || []) {
    resumeKeywords.add(skill.toLowerCase());
  }

  const matchedKeywords: string[] = [];
  const missingKeywords: string[] = [];

  for (const requirement of requirements) {
    if (resumeMentions(resumeText, requirement)) {
      if (!matchedKeywords.includes(requirement)) matchedKeywords.push(requirement);
    } else if (!missingKeywords.includes(requirement)) {
      missingKeywords.push(requirement);
    }
  }

  const totalRequirements = requirements.length || 1;
  const matchScore = Math.round((matchedKeywords.length / totalRequirements) * 100);

  // ---- Role-aware tailoring ----
  const detectedRole = detectRoleFromJobDescription(jobDescription);
  const bank = getRoleBank(detectedRole);

  const criticalMissing: string[] = [];
  const preferredMissing: string[] = [];
  const roleSuggestions: string[] = [];

  if (bank) {
    const resumeHas = (term: string): boolean => {
      const norm = term.toLowerCase();
      for (const rk of resumeKeywords) {
        if (keywordsMatch(norm, rk)) return true;
      }
      return false;
    };

    for (const term of bank.critical) {
      if (jobMentions(jobDescription, term) && !resumeHas(term)) {
        if (!criticalMissing.includes(term)) criticalMissing.push(term);
      }
    }
    for (const term of bank.preferred) {
      if (jobMentions(jobDescription, term) && !resumeHas(term)) {
        if (!preferredMissing.includes(term)) preferredMissing.push(term);
      }
    }
    // Suggest role keywords the candidate likely has but didn't list, when the
    // job doesn't even mention them (helps broaden ATS match rate).
    for (const term of [...bank.critical, ...bank.preferred]) {
      if (resumeHas(term) && !jobMentions(jobDescription, term) && roleSuggestions.length < 6) {
        roleSuggestions.push(term);
      }
    }
  }

  const suggestions = generateSuggestions(
    matchedKeywords,
    missingKeywords,
    criticalMissing,
    preferredMissing,
    matchScore,
    detectedRole
  );

  return {
    matchScore: Math.min(100, matchScore),
    matchedKeywords: matchedKeywords.slice(0, 30),
    missingKeywords: missingKeywords.slice(0, 15),
    suggestions,
    detectedRole,
    criticalMissing: criticalMissing.slice(0, 12),
    preferredMissing: preferredMissing.slice(0, 12),
    roleSuggestions: roleSuggestions.slice(0, 8),
  };
}

/**
 * Does the job description actually mention a (possibly multi-word) term?
 * Uses substring + synonym awareness so "ml" matches "machine learning".
 */
function jobMentions(jobDescription: string, term: string): boolean {
  const text = jobDescription.toLowerCase();
  if (text.includes(term.toLowerCase())) return true;
  const aliases = SKILL_SYNONYMS[term.toLowerCase()];
  if (aliases) return aliases.some((a) => text.includes(a));
  return false;
}

function generateSuggestions(
  matched: string[],
  missing: string[],
  criticalMissing: string[],
  preferredMissing: string[],
  score: number,
  detectedRole: string | null
): string[] {
  const suggestions: string[] = [];

  if (score >= 80) {
    suggestions.push('Your resume is well-aligned with this job description.');
  } else if (score >= 60) {
    suggestions.push('Good match! Add a few more critical keywords to strengthen your application.');
  } else if (score >= 40) {
    suggestions.push('Moderate match. Tailor your resume to better fit this role before applying.');
  } else {
    suggestions.push('This role likely needs significant resume customization to pass ATS screening.');
  }

  if (criticalMissing.length > 0) {
    suggestions.push(`Critical missing skills: ${criticalMissing.slice(0, 6).join(', ')}`);
  } else if (detectedRole) {
    suggestions.push(`No critical gaps detected for the ${labelRole(detectedRole)} role.`);
  }

  if (preferredMissing.length > 0) {
    suggestions.push(`Preferred (nice-to-have) skills to consider: ${preferredMissing.slice(0, 5).join(', ')}`);
  }

  return suggestions;
}

function labelRole(roleKey: string): string {
  return roleKey
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function extractJobTitle(jobDescription: string): string | null {
  const lines = jobDescription.split('\n').filter(l => l.trim());
  
  const titlePatterns = [
    /^(senior|junior|lead|principal|staff)?\s*(software|frontend|backend|fullstack)?\s*(engineer|developer|architect)/i,
    /^(product|project|engineering)\s*(manager|lead|director)/i,
  ];
  
  for (const line of lines.slice(0, 5)) {
    for (const pattern of titlePatterns) {
      const match = line.match(pattern);
      if (match) return match[0].trim();
    }
  }
  
  return null;
}

// ==================== ROUTES ====================

router.post('/', requireAuth, async (req, res) => {
  try {
    const { resumeId, uploadedFileId, jobDescription } = validateInput(jobMatchSchema, req.body);

    if (!resumeId && !uploadedFileId) {
      throw new BadRequestError('Either resumeId or uploadedFileId is required');
    }

    let resumeData: ResumeData | null = null;
    let resumeIdForMatch: string | null = null;
    let uploadedFileIdForMatch: string | null = null;

    if (resumeId) {
      const resume = await prisma.resume.findUnique({
        where: { id: resumeId }
      });
      if (!resume) {
        throw new NotFoundError('Resume');
      }
      await ensureOwnership(req.user!.id, resume.userId, 'Resume');

      resumeData = {
        personalInfo: resume.personalInfo as any,
        summary: resume.summary,
        experience: resume.experience as any[] || [],
        education: resume.education as any[] || [],
        skills: resume.skills as string[] || []
      };
      resumeIdForMatch = resume.id;
    } else if (uploadedFileId) {
      // Raw uploaded file: match its deterministic extracted text against the JD.
      // Never parsed into a structured builder resume.
      const file = await prisma.uploadedFile.findUnique({ where: { id: uploadedFileId } });
      if (!file) {
        throw new NotFoundError('Uploaded file');
      }
      await ensureOwnership(req.user!.id, file.userId, 'Uploaded file');

      resumeData = {
        personalInfo: { fullName: '', email: '', phone: '', location: '' },
        summary: file.extractedText || '',
        experience: [],
        education: [],
        skills: []
      };
      uploadedFileIdForMatch = file.id;
    }

    const matchResult = matchResumeToJob(resumeData!, jobDescription);
    const jobTitle = extractJobTitle(jobDescription);

    // Optional LLM tailoring tips (best-effort; never blocks the result).
    const resumeTextForLLM = getResumeText(resumeData!);
    const tailoringTips = await enhanceMatchWithLLM(
      resumeTextForLLM,
      jobDescription,
      [...matchResult.criticalMissing, ...matchResult.preferredMissing]
    ).catch(() => undefined);

    const jobMatch = await prisma.jobMatch.create({
      data: {
        resumeId: resumeIdForMatch,
        uploadedFileId: uploadedFileIdForMatch,
        userId: req.user!.id,
        jobDescription,
        jobTitle,
        matchScore: matchResult.matchScore,
        matchedKeywords: matchResult.matchedKeywords,
        missingKeywords: matchResult.missingKeywords,
        suggestions: matchResult.suggestions,
        detectedRole: matchResult.detectedRole,
        criticalMissing: matchResult.criticalMissing,
        preferredMissing: matchResult.preferredMissing,
        roleSuggestions: matchResult.roleSuggestions,
        tailoringTips: tailoringTips ?? []
      }
    });
    
    res.status(201).json({
      id: jobMatch.id,
      resumeId: jobMatch.resumeId,
      uploadedFileId: jobMatch.uploadedFileId,
      jobDescription: jobMatch.jobDescription.substring(0, 500) + '...',
      matchScore: matchResult.matchScore,
      matchedKeywords: matchResult.matchedKeywords,
      missingKeywords: matchResult.missingKeywords,
      suggestions: matchResult.suggestions,
      detectedRole: matchResult.detectedRole,
      criticalMissing: matchResult.criticalMissing,
      preferredMissing: matchResult.preferredMissing,
      roleSuggestions: matchResult.roleSuggestions,
      tailoringTips: tailoringTips ?? [],
      createdAt: jobMatch.createdAt
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// List all stored job match scans for the authenticated user (most recent first).
router.get('/', requireAuth, async (req, res) => {
  try {
    const matches = await prisma.jobMatch.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        resumeId: true,
        jobTitle: true,
        detectedRole: true,
        matchScore: true,
        createdAt: true,
      },
    });

    res.json({ matches });
  } catch (error) {
    handleApiError(error, res);
  }
});

router.get('/:matchId', requireAuth, async (req, res) => {
  try {
    const { matchId } = req.params;
    
    const jobMatch = await prisma.jobMatch.findUnique({
      where: { id: matchId }
    });
    
    if (!jobMatch) {
      throw new NotFoundError('Job Match');
    }
    
    await ensureOwnership(req.user!.id, jobMatch.userId, 'Job Match');
    
    res.json({
      id: jobMatch.id,
      resumeId: jobMatch.resumeId,
      jobDescription: jobMatch.jobDescription,
      jobTitle: jobMatch.jobTitle,
      matchScore: jobMatch.matchScore,
      matchedKeywords: jobMatch.matchedKeywords,
      missingKeywords: jobMatch.missingKeywords,
      suggestions: jobMatch.suggestions,
      detectedRole: jobMatch.detectedRole,
      criticalMissing: jobMatch.criticalMissing,
      preferredMissing: jobMatch.preferredMissing,
      roleSuggestions: jobMatch.roleSuggestions,
      tailoringTips: jobMatch.tailoringTips,
      createdAt: jobMatch.createdAt
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
