// LLM-based ATS Evaluator (hiring-agent style)
// Uses BYOK Groq (or other providers) with json_object mode + Zod validation

import { z } from 'zod';
import { leaseNextLlmKey, markKeySuccess, markKeyFailure, isRateLimitError, type KeyRecord } from '../ai/keyManager.js';
import OpenAI from 'openai';
import type { ResumeData } from './scanner.js';
import { loadAndRender } from './promptLoader.js';

// ==================== SCHEMAS ====================
// ATS-native categories. These mirror the dimensions a real Applicant Tracking
// System (e.g. Textkernel, RChilli, Affinda) and ATS-scanner research weigh when
// shortlisting: parseability, keyword tailoring, action verbs, contact-info
// presence, section completeness, and experience signals. Open-source is NOT a
// scored category - it is at most an optional bonus, never a penalty.

export const CategoryScoreSchema = z.object({
  score: z.number().int().min(0),
  max: z.number().int().positive(),
  evidence: z.string().min(1, 'Evidence is required'),
});

export const BonusPointsSchema = z.object({
  total: z.number().int().min(0).max(20),
  breakdown: z.string(),
});

export const DeductionsSchema = z.object({
  total: z.number().int().min(0),
  reasons: z.string(),
});

export const LLMEvaluationSchema = z.object({
  categories: z.object({
    parseability: CategoryScoreSchema,
    keywords: CategoryScoreSchema,
    actionVerbs: CategoryScoreSchema,
    contactInfo: CategoryScoreSchema,
    sectionCompleteness: CategoryScoreSchema,
    experienceSignals: CategoryScoreSchema,
  }),
  bonusPoints: BonusPointsSchema,
  deductions: DeductionsSchema,
  overallScore: z.number().int().min(0).max(100),
  // Tolerant: the LLM occasionally emits values outside our enum (e.g. "fair").
  // normalizeEvaluation() re-derives the canonical status from the score.
  status: z.string(),
  keyStrengths: z.array(z.string()).max(5),
  areasForImprovement: z.array(z.string()).max(3),
  reasoning: z.string().min(1),
});

export type LLMEvaluation = z.infer<typeof LLMEvaluationSchema>;

// ==================== PROMPTS ====================
// Prompts live in version-controlled .jinja templates under ./prompts so they can be
// audited and edited without touching code. The system prompt encodes fairness + evidence
// constraints; the criteria template holds the rubric and JSON output contract.

function getSystemPrompt(): string {
  return loadAndRender('evaluation_system.jinja');
}

function buildUserPrompt(resume: ResumeData | { rawText: string }): string {
  if ('rawText' in resume) {
    return loadAndRender('evaluation_criteria.jinja', { resume_text: resume.rawText });
  }
  const { personalInfo, summary, experience, education, skills } = resume;
  const expLines = experience.map(e => 
    `- ${e.title} at ${e.company} (${e.startDate} – ${e.endDate}): ${e.bullets.join('; ')}`
  ).join('\n');
  const eduLines = education.map(e => `- ${e.degree}, ${e.institution} (${e.graduationYear})`).join('\n');
  const resumeText = `RESUME DATA:
Name: ${personalInfo.fullName || 'N/A'}
Email: ${personalInfo.email || 'N/A'}
Location: ${personalInfo.location || 'N/A'}
LinkedIn: ${personalInfo.linkedin || 'N/A'}
Website: ${personalInfo.website || 'N/A'}

SUMMARY:
${summary || 'N/A'}

EXPERIENCE:
${expLines || 'N/A'}

EDUCATION:
${eduLines || 'N/A'}

SKILLS:
${skills.join(', ') || 'N/A'}`;
  return loadAndRender('evaluation_criteria.jinja', { resume_text: resumeText });
}

// ==================== UTILITIES ====================

function extractJson(text: string): string {
  // Extract first {...} block (handles markdown code fences)
  const match = text.match(/\{[\s\S]*\}/);
  return match ? match[0] : '';
}

function normalizeEvaluation(obj: unknown): LLMEvaluation {
  // Ensure category scores don't exceed max
  const cats = obj as LLMEvaluation;
  for (const [catName, cat] of Object.entries(cats.categories)) {
    if (cat.score > cat.max) cat.score = cat.max;
  }

  // ATS-native scoring: the six categories already sum to 100, so the weighted
  // sum IS the base score. Open-source (and similar extras) come through as an
  // optional bonus that can nudge the score up, while deductions pull it down.
  // Resumes without open-source work are never penalized.
  const categorySum = Object.values(cats.categories).reduce((sum, cat) => sum + (cat.score ?? 0), 0);
  const base = Math.max(0, Math.min(100, categorySum));
  const bonus = Math.max(0, cats.bonusPoints?.total ?? 0);
  const deductions = Math.max(0, cats.deductions?.total ?? 0);

  let finalScore = base + bonus - deductions;
  finalScore = Math.max(0, Math.min(100, finalScore));

  cats.overallScore = finalScore; // 0-100 for UI compatibility
  // Derive status from the final score so non-enum LLM outputs (e.g. "fair")
  // never fail schema validation.
  cats.status = finalScore >= 85 ? 'excellent' : finalScore >= 70 ? 'good' : finalScore >= 50 ? 'needs-work' : 'poor';
  return cats;
}

// ==================== MAIN EVALUATOR ====================

const MODEL = process.env.ATS_MODEL || 'llama-3.3-70b-versatile';
// NOTE: the previous fallback `llama-3.1-70b-versatile` was decommissioned by Groq
// and returns a 400. Retry on the same live model family instead.
const FALLBACK_MODEL = process.env.ATS_FALLBACK_MODEL || 'llama-3.3-70b-versatile';

function getBaseUrl(provider: string): string {
  switch (provider) {
    case 'groq': return 'https://api.groq.com/openai/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta/openai';
    default: return 'https://api.openai.com/v1';
  }
}

async function callLLMWithRetry(
  client: OpenAI,
  prompt: string,
  key: KeyRecord,
  attempt = 1
): Promise<LLMEvaluation> {
  const response = await client.chat.completions.create({
    model: attempt === 1 ? MODEL : FALLBACK_MODEL,
    max_tokens: 1500,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: getSystemPrompt() },
      { role: 'user', content: prompt },
    ],
  });

  const content = response.choices[0]?.message?.content || '';
  const jsonStr = extractJson(content);
  if (!jsonStr) throw new Error('No JSON found in response');

  const parsed = JSON.parse(jsonStr);
  const result = LLMEvaluationSchema.safeParse(parsed);
  
  if (!result.success) {
    if (attempt === 1) {
      // Retry with stricter instruction
      return callLLMWithRetry(client, prompt + '\n\nIMPORTANT: Return ONLY valid JSON matching the exact schema. No extra fields, no markdown.', key, 2);
    }
    throw new Error(`Validation failed: ${result.error.errors.map(e => e.message).join(', ')}`);
  }

  return normalizeEvaluation(result.data);
}

export async function evaluateResumeWithLLM(
  resume: ResumeData | { rawText: string },
  userId?: string
): Promise<LLMEvaluation> {
  // Lease the next available LLM key (Groq first via leaseNextLlmKey)
  const key = await leaseNextLlmKey(userId);
  
  const baseURL = getBaseUrl(key.provider);
  const client = new OpenAI({ apiKey: key.apiKey, baseURL });

  const prompt = buildUserPrompt(resume);

  try {
    const evaluation = await callLLMWithRetry(client, prompt, key);
    await markKeySuccess(key);
    return evaluation;
  } catch (error) {
    await markKeyFailure(key, isRateLimitError(error));
    throw error;
  }
}

// ==================== FALLBACK: Check if any LLM key exists ====================

export async function hasLlmKey(userId?: string): Promise<boolean> {
  try {
    await leaseNextLlmKey(userId);
    return true;
  } catch {
    return false;
  }
}