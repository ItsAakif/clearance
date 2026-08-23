// Deterministic 3-factor ATS scorer (Resume-Matcher style).
// Factors & weights (per RM-01):
//   Keyword Match        55%
//   Skills Coverage      25%
//   Section Completeness 20%
// Pure & deterministic so it is unit-testable without an LLM.

export interface FactorScore {
  score: number; // 0-100
  detail: string;
}

export interface ThreeFactorScore {
  keywordMatch: FactorScore;
  skillsCoverage: FactorScore;
  sectionCompleteness: FactorScore;
  overall: number; // 0-100 weighted
  weights: { keywordMatch: number; skillsCoverage: number; sectionCompleteness: number };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'our', 'are', 'will', 'have', 'this', 'that',
  'from', 'your', 'who', 'all', 'can', 'into', 'more', 'than', 'when', 'work', 'team',
  'role', 'job', 'ability', 'experience', 'skills', 'strong', 'well', 'must', 'etc',
  'including', 'such', 'able', 'their', 'they', 'we', 'a', 'an', 'to', 'of', 'in', 'on',
  'is', 'be', 'as', 'at', 'by', 'or', 'we', 'us', 'need', 'required', 'preferred'
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9+#.]+/g) || [];
}

// Extract the most salient keywords from a job description (top by frequency,
// minus stop-words and very short tokens).
export function extractJdKeywords(jd: string, limit = 40): string[] {
  const freq = new Map<string, number>();
  for (const t of tokenize(jd)) {
    if (t.length < 3) continue;
    if (STOP_WORDS.has(t)) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((e) => e[0]);
}

export function scoreResumeAgainstJob(input: {
  resumeText: string;
  skills?: string[];
  jd: string;
}): ThreeFactorScore {
  const resumeText = (input.resumeText || '').toLowerCase();
  const jdKeywords = extractJdKeywords(input.jd);
  const resumeSkills = (input.skills || []).map((s) => s.toLowerCase());
  const jdLower = (input.jd || '').toLowerCase();

  // --- Keyword Match (55%) ---
  const presentKw = jdKeywords.filter((k) => resumeText.includes(k));
  const keywordMatchScore = jdKeywords.length
    ? Math.round((presentKw.length / jdKeywords.length) * 100)
    : 0;

  // --- Skills Coverage (25%) ---
  // Fraction of the candidate's resume skills that the JD actually calls for.
  const coveredSkills = resumeSkills.filter((s) => jdLower.includes(s));
  const skillsCoverageScore = resumeSkills.length
    ? Math.round((coveredSkills.length / resumeSkills.length) * 100)
    : 0;

  // --- Section Completeness (20%) ---
  const hasSummary = /summary|profile|objective|about/i.test(resumeText);
  const hasExperience = /experience|employment|work history/i.test(resumeText);
  const hasEducation = /education|degree|university|college|b\.?s\.?|m\.?s\.?/i.test(resumeText);
  const hasSkills = resumeSkills.length > 0 || /skills|technologies|competencies/i.test(resumeText);
  const bullets = (resumeText.match(/[•\-\*]/g) || []).length;
  const baseSection = ((hasSummary ? 1 : 0) + (hasExperience ? 1 : 0) + (hasEducation ? 1 : 0) + (hasSkills ? 1 : 0)) / 4;
  const sectionCompletenessScore = Math.min(100, Math.round(baseSection * 100) + Math.min(20, bullets));

  const overall = Math.round(
    0.55 * keywordMatchScore + 0.25 * skillsCoverageScore + 0.2 * sectionCompletenessScore
  );

  const sectionParts: string[] = [];
  if (hasSummary) sectionParts.push('summary');
  if (hasExperience) sectionParts.push('experience');
  if (hasEducation) sectionParts.push('education');
  if (hasSkills) sectionParts.push('skills');

  return {
    keywordMatch: {
      score: keywordMatchScore,
      detail: `${presentKw.length}/${jdKeywords.length} key terms found in resume`,
    },
    skillsCoverage: {
      score: skillsCoverageScore,
      detail: `${coveredSkills.length}/${resumeSkills.length} resume skills evidenced in JD`,
    },
    sectionCompleteness: {
      score: sectionCompletenessScore,
      detail: `sections: ${sectionParts.join(', ') || 'none'}; ${bullets} bullet(s)`,
    },
    overall,
    weights: { keywordMatch: 0.55, skillsCoverage: 0.25, sectionCompleteness: 0.2 },
  };
}
