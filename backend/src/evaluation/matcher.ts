// Wave 9 Pass 2 - matcher bridge (T781, ADR-027, non-negotiable N7).
//
// EXTRACTION, not a rewrite: the scoring path below was moved VERBATIM from
// `backend/src/routes/job-match.ts` (`matchResumeToJob` plus every helper it
// transitively needs). Formula, clamping, keyword lists and suggestion logic
// are unchanged. Proof: `matcher.fixtures.ts` (captured from the PRE-MOVE
// code) + the byte-identical equivalence test in `matcher.test.ts`.
//
// There is exactly ONE `matchScore` computation in the codebase, and it lives
// here (`matchResumeToJob`). Do NOT add an embedding/LLM scorer (wave spec
// OUT); the optional LLM tailoring tips stay in the route layer.
//
// BRIDGE (`scoreJobs`): adapts the existing single-resume-vs-JD scorer to the
// pipeline shape (`ScoredJob[]`, ordered score DESC, postedAt DESC,
// provenanceRank DESC).
//
// NO-RESUME / NO-PROFILE POLICY (wave spec edge case): pass 2 degrades to an
// intent-only fallback. It does NOT invent a score of 0 and present it as a
// real match: every returned row carries `scored: false`,
// `scoreMode: 'unscored'` and the `UNSCORED_SCORE` (-1) sentinel, which is
// outside the real 0..100 range so it can never be mistaken for a genuine
// score. Input order is preserved (no fake ranking). Pass 3 must skip such
// rows (`no_resume`).

import type { RawJob } from '../jobSources/adapters/http.js';
import { provenanceRank } from '../discovery/provenance.js';
import {
  ROLE_KEYWORD_BANKS,
  detectRoleFromJobDescription,
  getRoleBank,
} from '../jobSources/roleKeywords.js';

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

export interface ResumeData {
  personalInfo: PersonalInfo;
  summary: string;
  experience: ExperienceItem[];
  education: any[];
  skills: string[];
}

export interface MatchResult {
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

// T1060: exported (behaviour unchanged) so `jobs/requirements.ts` can canonicalize a
// requirement's `normalizedKey` from THIS table instead of keeping a second synonym
// list that would drift. Nothing else in the tree imports it.
export const SKILL_SYNONYMS: Record<string, string[]> = {
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

export function normalizeText(text: string): string {
  return text.toLowerCase()
    .replace(/[^\w\s\-\.\/\+\#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeKeyword(keyword: string): string {
  return keyword.toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '');
}

export function keywordsMatch(keyword1: string, keyword2: string): boolean {
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
export function extractJobRequirements(jobDescription: string): string[] {
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

export function extractKeywords(text: string): string[] {
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
export function resumeMentions(resumeText: string, requirement: string): boolean {
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

export function getResumeText(resume: ResumeData): string {
  const parts: string[] = [resume.summary || ''];

  for (const exp of resume.experience || []) {
    parts.push(exp.title || '', exp.company || '', ...(exp.bullets || []));
  }

  for (const edu of resume.education || []) {
    parts.push(edu.degree || '', edu.field || '', edu.institution || '');
  }

  return parts.join(' ');
}

export function matchResumeToJob(resume: ResumeData, jobDescription: string): MatchResult {
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
export function jobMentions(jobDescription: string, term: string): boolean {
  const text = jobDescription.toLowerCase();
  if (text.includes(term.toLowerCase())) return true;
  const aliases = SKILL_SYNONYMS[term.toLowerCase()];
  if (aliases) return aliases.some((a) => text.includes(a));
  return false;
}

export function generateSuggestions(
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

export function labelRole(roleKey: string): string {
  return roleKey
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function extractJobTitle(jobDescription: string): string | null {
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

// ==================== PIPELINE BRIDGE (Pass 2) ====================

/** Sentinel for the no-resume/no-profile fallback: outside 0..100 on purpose. */
export const UNSCORED_SCORE = -1;

export interface MatcherProfile {
  skills?: string[];
  summary?: string;
  experienceText?: string;
}

export interface ScoreJobsOptions {
  resumeText?: string;
  profile?: MatcherProfile;
}

export interface ScoredJob {
  job: RawJob;
  deterministicScore: number;
  /** 'matched' = genuine `matchResumeToJob` score; 'unscored' = fallback, NOT a real match. */
  scoreMode: 'matched' | 'unscored';
  /** False exactly when `scoreMode` is 'unscored'. Never present such a row as scored. */
  scored: boolean;
}

/**
 * Fold free-text resume input + an optional skill profile into the structured
 * `ResumeData` shape the (verbatim) scorer consumes. The route layer keeps
 * building `ResumeData` from DB rows; this is only the pipeline convenience.
 */
export function buildResumeData(resumeText?: string, profile?: MatcherProfile): ResumeData {
  const summaryParts: string[] = [];
  if (resumeText && resumeText.trim()) summaryParts.push(resumeText);
  if (profile?.summary && profile.summary.trim()) summaryParts.push(profile.summary);
  if (profile?.experienceText && profile.experienceText.trim()) summaryParts.push(profile.experienceText);
  return {
    personalInfo: { fullName: '', email: '', phone: '', location: '' },
    summary: summaryParts.join('\n'),
    experience: [],
    education: [],
    skills: [...(profile?.skills ?? [])],
  };
}

function hasResumeSignal(opts: ScoreJobsOptions): boolean {
  if (opts.resumeText && opts.resumeText.trim()) return true;
  const profile = opts.profile;
  if (!profile) return false;
  if (profile.summary && profile.summary.trim()) return true;
  if (profile.experienceText && profile.experienceText.trim()) return true;
  if (profile.skills && profile.skills.some((s) => s && s.trim())) return true;
  return false;
}

function postedAtMs(job: RawJob): number {
  const postedAt = job.postedAt;
  if (!(postedAt instanceof Date)) return Number.NEGATIVE_INFINITY;
  const ms = postedAt.getTime();
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Score surviving jobs with the EXISTING deterministic scorer and return them
 * in stable descending order: score DESC, then `postedAt` DESC (jobs without
 * a usable date sort last), then wave-3 `provenanceRank` DESC (stronger
 * provenance first), then input index (full determinism).
 *
 * No resume AND no profile: every row is returned unscored
 * (`scored: false`, `scoreMode: 'unscored'`, `deterministicScore` -1) in
 * input order. This is the documented intent-only fallback.
 */
export function scoreJobs(jobs: RawJob[], opts: ScoreJobsOptions): ScoredJob[] {
  if (!hasResumeSignal(opts)) {
    return jobs.map((job) => ({
      job,
      deterministicScore: UNSCORED_SCORE,
      scoreMode: 'unscored' as const,
      scored: false,
    }));
  }

  const resume = buildResumeData(opts.resumeText, opts.profile);
  const scored: Array<ScoredJob & { index: number }> = jobs.map((job, index) => ({
    job,
    deterministicScore: matchResumeToJob(resume, job.description ?? '').matchScore,
    scoreMode: 'matched' as const,
    scored: true,
    index,
  }));

  scored.sort((a, b) => {
    if (b.deterministicScore !== a.deterministicScore) {
      return b.deterministicScore - a.deterministicScore;
    }
    const postedDiff = postedAtMs(b.job) - postedAtMs(a.job);
    if (postedDiff !== 0) return postedDiff;
    const rankDiff = provenanceRank(b.job) - provenanceRank(a.job);
    if (rankDiff !== 0) return rankDiff;
    return a.index - b.index;
  });

  return scored.map(({ job, deterministicScore, scoreMode, scored: s }) => ({
    job,
    deterministicScore,
    scoreMode,
    scored: s,
  }));
}
