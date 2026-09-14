// RM-01 — Improver (pass 1 of the multi-pass refinement pipeline).
// Produces the INITIAL tailored draft from a master resume + job description.
import OpenAI from 'openai';
import { leaseNextLlmKey, markKeySuccess, markKeyFailure, isRateLimitError } from '../ai/keyManager.js';
import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';

const IMPROVER_SYSTEM = `You are an expert resume writer. Given a master resume and a target job description, produce an INITIAL tailored draft.
RULES:
- Mirror the JD's language and keywords where the candidate genuinely has the experience.
- NEVER invent skills, jobs, or achievements the candidate does not have.
- Keep the structure: summary, experience (with bullets), education, skills.
- Improve bullet phrasing with strong action verbs and quantifiable impact where truthful.
Return STRICT JSON: { "summary": string, "experience": [{ "title": string, "company": string, "startDate": string, "endDate": string, "bullets": string[] }], "education": [{ "degree": string, "institution": string }], "skills": string[] }`;

function getBaseUrl(provider: string): string {
  switch (provider) {
    case 'groq': return 'https://api.groq.com/openai/v1';
    case 'openrouter': return 'https://openrouter.ai/api/v1';
    case 'gemini': return 'https://generativelanguage.googleapis.com/v1beta/openai';
    default: return 'https://api.openai.com/v1';
  }
}

export interface TailoredDraft {
  summary: string;
  experience: Array<{ title: string; company: string; startDate: string; endDate: string; bullets: string[] }>;
  education: Array<{ degree: string; institution: string }>;
  skills: string[];
}

export async function improveResumeForJob(input: {
  resume: { summary?: string; experience?: any[]; education?: any[]; skills?: string[] };
  jd: string;
  profile?: { summary?: string; topSkills?: string[] } | null;
}): Promise<TailoredDraft> {
  const profileSection = input.profile
    ? `\nCANDIDATE CAREER PROFILE (calibrate tone/emphasis, do NOT invent facts):\n- Summary: ${input.profile.summary || 'n/a'}\n- Top skills: ${input.profile.topSkills?.join(', ') || 'n/a'}`
    : '';

  const key = await leaseNextLlmKey();
  const model = await getProviderModel(key.provider, { envOverride: process.env.RESUME_TAILOR_MODEL });
  const client = new OpenAI({ apiKey: key.apiKey, baseURL: getBaseUrl(key.provider) });
  try {
    const resp = await runLlmCompletion(key.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 2000,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
        { role: 'system', content: IMPROVER_SYSTEM },
        {
          role: 'user',
          content:
            `MASTER RESUME:\n${JSON.stringify(
              {
                summary: input.resume.summary,
                experience: input.resume.experience,
                education: input.resume.education,
                skills: input.resume.skills,
              },
              null,
              2
            )}${profileSection}\n\nJOB DESCRIPTION:\n${input.jd}\n\nReturn the tailored resume JSON only.`,
        },
      ],
      })
    );
    await markKeySuccess(key);
    const match = (resp.choices[0]?.message?.content || '{}').match(/\{[\s\S]*\}/);
    const json = JSON.parse(match ? match[0] : '{}');
    return {
      summary: json.summary || input.resume.summary || '',
      experience: json.experience || input.resume.experience || [],
      education: json.education || input.resume.education || [],
      skills: json.skills || input.resume.skills || [],
    };
  } catch (e) {
    await markKeyFailure(key, isRateLimitError(e));
    throw e;
  }
}
