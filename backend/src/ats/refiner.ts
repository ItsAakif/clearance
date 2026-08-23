// RM-01 — Refiner (pass 2 of the multi-pass refinement pipeline).
// Multi-pass refinement of the initial draft:
//   1. Keyword injection from the JD (strengthen JD-aligned phrasing)
//   2. Phrase simplification (action verbs, concision)
//   3. Alignment validation vs. the MASTER resume (truthfulness guard)
import OpenAI from 'openai';
import { leaseNextLlmKey, markKeySuccess, markKeyFailure, isRateLimitError } from '../ai/keyManager.js';
import type { TailoredDraft } from './improver.js';

const REFINER_MODEL = process.env.RESUME_TAILOR_MODEL || 'llama-3.1-70b-versatile';

const REFINER_SYSTEM = `You are a resume refiner. Given an initial tailored draft, a job description, and the candidate's MASTER resume, produce a refined, final tailored resume.
RULES:
- Inject relevant JD keywords naturally into the draft where the candidate genuinely qualifies.
- Simplify phrasing: strong action verbs, concise bullets, quantifiable impact where truthful.
- You MUST stay truthful to the MASTER resume — do not add skills/experiences absent from it.
Return STRICT JSON: { "summary": string, "experience": [{ "title": string, "company": string, "startDate": string, "endDate": string, "bullets": string[] }], "education": [{ "degree": string, "institution": string }], "skills": string[] }`;

function getBaseUrl(provider: string): string {
  switch (provider) {
    case 'groq': return 'https://api.groq.com/openai/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta/openai';
    default: return 'https://api.openai.com/v1';
  }
}

export interface RefineResult {
  refined: TailoredDraft;
  alignment: { aligned: boolean; notes: string[] };
}

export async function refineResume(input: {
  draft: TailoredDraft;
  jd: string;
  masterResume: { summary?: string; experience?: any[]; education?: any[]; skills?: string[] };
}): Promise<RefineResult> {
  const key = await leaseNextLlmKey();
  const client = new OpenAI({ apiKey: key.apiKey, baseURL: getBaseUrl(key.provider) });
  try {
    const resp = await client.chat.completions.create({
      model: REFINER_MODEL,
      max_tokens: 2000,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: REFINER_SYSTEM },
        {
          role: 'user',
          content:
            `INITIAL DRAFT:\n${JSON.stringify(input.draft, null, 2)}\n\nMASTER RESUME (truth source):\n${JSON.stringify(
              {
                summary: input.masterResume.summary,
                experience: input.masterResume.experience,
                education: input.masterResume.education,
                skills: input.masterResume.skills,
              },
              null,
              2
            )}\n\nJOB DESCRIPTION:\n${input.jd}\n\nReturn the refined resume JSON only.`,
        },
      ],
    });
    await markKeySuccess(key);
    const match = (resp.choices[0]?.message?.content || '{}').match(/\{[\s\S]*\}/);
    const json = JSON.parse(match ? match[0] : '{}');
    const refined: TailoredDraft = {
      summary: json.summary || input.draft.summary,
      experience: json.experience || input.draft.experience,
      education: json.education || input.draft.education,
      skills: json.skills || input.draft.skills,
    };

    return { refined, alignment: validateAlignment(refined, input.masterResume) };
  } catch (e) {
    await markKeyFailure(key, isRateLimitError(e));
    throw e;
  }
}

// Deterministic truthfulness guard: flag any refined skill not present in the master resume.
export function validateAlignment(
  refined: TailoredDraft,
  masterResume: { skills?: string[] }
): { aligned: boolean; notes: string[] } {
  const masterSkills = new Set((masterResume.skills || []).map((s) => s.toLowerCase()));
  const notes: string[] = [];
  const fabricated = (refined.skills || []).filter((s) => !masterSkills.has(s.toLowerCase()));
  if (fabricated.length) {
    notes.push(`Potential unverified skills vs. master resume: ${fabricated.join(', ')}`);
  }
  return { aligned: fabricated.length === 0, notes };
}
