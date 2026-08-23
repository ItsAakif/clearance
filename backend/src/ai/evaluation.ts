// Job Evaluation Engine - ports career-ops A-F rubric into a structured LLM call.
// Uses BYOK LLM keys (keyManager) + optional Tavily for comp/company research.
// Authenticity guard: never invent experience.

import OpenAI from 'openai';
import {
  leaseNextLlmKey,
  leaseNextSearchKey,
  markKeySuccess,
  markKeyFailure,
  isRateLimitError,
  type KeyRecord,
} from './keyManager.js';
import { checkLiveness } from '../jobSources/liveness.js';

export interface ResumeLikeData {
  personalInfo?: { fullName?: string; email?: string; phone?: string; location?: string };
  summary?: string;
  experience?: Array<{ title?: string; company?: string; bullets?: string[] }>;
  education?: Array<{ degree?: string; institution?: string }>;
  skills?: string[];
}

export interface CareerProfileLike {
  targetRoles?: string[];
  seniority?: string | null;
  topSkills?: string[];
  industries?: string[];
  redFlags?: string[];
  proofPoints?: string[];
  minSalary?: number;
  maxSalary?: number;
  currency?: string;
  locationPref?: string;
  remoteOnly?: boolean;
  summary?: string;
}

export interface EvaluationResult {
  roleSummary?: string;
  cvMatchScore: number; // A 1-5
  levelFitScore: number; // B 1-5
  compFitScore: number; // C 1-5
  personalizationScore: number; // D 1-5
  interviewPrepScore: number; // E 1-5
  legitimacyScore: number; // G 1-5
  overallScore: number; // weighted 1-5
  recommendation: 'apply' | 'maybe' | 'skip';
  isScam: boolean;
  reportJson: Record<string, unknown>;
}

const RUBRIC_SYSTEM_PROMPT = `You are an expert technical recruiter and career coach evaluating a job against a candidate's resume.
Score the job on SIX dimensions from 1.0 to 5.0:

A) CV Match - how well the candidate's experience/skills map to the role.
B) Level Fit - seniority/level alignment with the candidate's background.
C) Comp Fit - likely compensation alignment (use research when available; otherwise estimate).
D) Personalization - how tailored/easy it is to personalize a resume for this role.
E) Interview Prep - clarity of signals for STAR+R stories the candidate can use.
G) Posting Legitimacy - signs of scam, ghost job, or vague/missing specifics (LOW score = suspicious).

Return STRICT JSON:
{
  "roleSummary": "2-3 sentence objective summary of the role",
  "cvMatchScore": <1-5>,
  "levelFitScore": <1-5>,
  "compFitScore": <1-5>,
  "personalizationScore": <1-5>,
  "interviewPrepScore": <1-5>,
  "legitimacyScore": <1-5>,
  "overallScore": <weighted 1-5, weight A 0.3, B 0.15, C 0.15, D 0.15, E 0.1, G 0.15>,
  "recommendation": "apply" | "maybe" | "skip",
  "isScam": <true if legitimacyScore < 2 or clear scam signals>,
  "interviewPrepBullets": ["STAR+R story prompt 1", "..."],
  "compNotes": "brief compensation notes",
  "redFlags": ["..."]
}

CRITICAL RULES:
- Never invent or assume experience the candidate does not have.
- Be objective. Recommend "skip" if overallScore < 3.0 or isScam is true.
- Respond with ONLY the JSON object.`;

function buildUserPrompt(resume: ResumeLikeData, jobDescription: string, research?: string, profile?: CareerProfileLike): string {
  const profileSection = profile ? `
CANDIDATE CAREER PROFILE (use to calibrate scoring, do NOT invent):
- Target roles: ${profile.targetRoles?.join(', ') || 'n/a'}
- Seniority: ${profile.seniority || 'n/a'}
- Top skills: ${profile.topSkills?.join(', ') || 'n/a'}
- Preferred industries: ${profile.industries?.join(', ') || 'n/a'}
- Salary range: ${profile.minSalary || profile.maxSalary ? `${profile.minSalary ?? '?'}–${profile.maxSalary ?? '?'} ${profile.currency || ''}`.trim() : 'n/a'}
- Location preference: ${profile.locationPref || 'n/a'} ${profile.remoteOnly ? '(remote only)' : ''}
- Red flags (penalize roles that match these): ${profile.redFlags?.join(', ') || 'n/a'}
- Proof points (use for interview-prep STAR+R bullets): ${profile.proofPoints?.join(' | ') || 'n/a'}
- Summary: ${profile.summary || 'n/a'}
` : '';
  return `CANDIDATE RESUME:
${JSON.stringify(resume, null, 2)}
${profileSection}
JOB DESCRIPTION:
${jobDescription}

${research ? `RESEARCH (comp/company, from web):\n${research}\n` : ''}
Evaluate the job using the rubric and return JSON only.`;
}

async function withLlmClient<T>(userId: string | undefined, callback: (client: OpenAI, key: KeyRecord) => Promise<T>): Promise<T> {
  const key = await leaseNextLlmKey(userId);
  const baseURL = key.provider === 'groq'
    ? 'https://api.groq.com/openai/v1'
    : key.provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1'
    : key.provider === 'gemini'
    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : 'https://api.openai.com/v1';

  const client = new OpenAI({ apiKey: key.apiKey, baseURL });
  try {
    const result = await callback(client, key);
    await markKeySuccess(key);
    return result;
  } catch (error) {
    await markKeyFailure(key, isRateLimitError(error));
    throw error;
  }
}

async function researchWithTavily(userId: string | undefined, query: string): Promise<string | undefined> {
  try {
    const key = await leaseNextSearchKey(userId);
    const url = `https://api.tavily.com/search?api_key=${encodeURIComponent(key.apiKey)}&query=${encodeURIComponent(query)}&max_results=3&search_depth=basic`;
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const data: any = await res.json();
    return (data.results || []).map((r: any) => `${r.title}: ${r.content}`).join('\n\n');
  } catch {
    return undefined;
  }
}

export async function evaluateJob(
  userId: string | undefined,
  resume: ResumeLikeData,
  jobDescription: string,
  opts: { useTavily?: boolean; companyName?: string; profile?: CareerProfileLike } = {}
): Promise<EvaluationResult> {
  let research: string | undefined;
  if (opts.useTavily) {
    const q = `compensation and company research for ${opts.companyName || 'this employer'} ${jobDescription.slice(0, 200)}`;
    research = await researchWithTavily(userId, q);
  }

  const content = await withLlmClient(userId, async (client) => {
    const response = await client.chat.completions.create({
      model: 'llama-3.1-70b-versatile',
      max_tokens: 1500,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: RUBRIC_SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(resume, jobDescription, research, opts.profile) },
      ],
    });
    return response.choices[0]?.message?.content || '';
  });

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Evaluation did not return valid JSON');
  const parsed = JSON.parse(jsonMatch[0]);

  return {
    roleSummary: parsed.roleSummary,
    cvMatchScore: Number(parsed.cvMatchScore) || 0,
    levelFitScore: Number(parsed.levelFitScore) || 0,
    compFitScore: Number(parsed.compFitScore) || 0,
    personalizationScore: Number(parsed.personalizationScore) || 0,
    interviewPrepScore: Number(parsed.interviewPrepScore) || 0,
    legitimacyScore: Number(parsed.legitimacyScore) || 0,
    overallScore: Number(parsed.overallScore) || 0,
    recommendation: parsed.recommendation || 'maybe',
    isScam: Boolean(parsed.isScam),
    reportJson: parsed,
  };
}

export { checkLiveness };
