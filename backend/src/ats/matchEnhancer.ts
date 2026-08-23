// Optional LLM enhancer for Job Match tailoring.
// Produces natural-language tailoring tips (where to add missing keywords,
// how to phrase them) on top of the deterministic keyword match. BYOK Groq,
// json_object mode. Never throws into the caller - returns undefined on failure
// so the deterministic result is always returned.

import { z } from 'zod';
import { leaseNextLlmKey, markKeySuccess, markKeyFailure, isRateLimitError, type KeyRecord } from '../ai/keyManager.js';
import OpenAI from 'openai';

const MODEL = process.env.ATS_MODEL || 'llama-3.3-70b-versatile';

const EnhancerSchema = z.object({
  tailoringTips: z.array(z.string()).max(6),
});

type EnhancerResult = z.infer<typeof EnhancerSchema>;

async function callWithRetry(client: OpenAI, prompt: string, key: KeyRecord, attempt = 1): Promise<string> {
  const res = await client.chat.completions.create({
    model: attempt === 1 ? MODEL : MODEL,
    max_tokens: 800,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are an ATS tailoring coach. Given a candidate resume summary + a job description, ' +
          'return ONLY JSON: { "tailoringTips": string[] } with 2-5 concise, actionable tips on ' +
          'where/how to add missing keywords naturally (summary, skills section, experience bullets). ' +
          'Do not invent facts. Be specific.',
      },
      { role: 'user', content: prompt },
    ],
  });
  return res.choices[0]?.message?.content || '';
}

export async function enhanceMatchWithLLM(
  resumeText: string,
  jobDescription: string,
  missing: string[]
): Promise<string[] | undefined> {
  let key: KeyRecord;
  try {
    key = await leaseNextLlmKey();
  } catch {
    return undefined;
  }

  const baseURL =
    key.provider === 'groq'
      ? 'https://api.groq.com/openai/v1'
      : key.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : key.provider === 'gemini'
      ? 'https://generativelanguage.googleapis.com/v1beta/openai'
      : 'https://api.openai.com/v1';

  const client = new OpenAI({ apiKey: key.apiKey, baseURL });

  const prompt =
    `RESUME (abridged):\n${resumeText.slice(0, 1500)}\n\n` +
    `JOB DESCRIPTION:\n${jobDescription.slice(0, 2000)}\n\n` +
    `MISSING KEYWORDS TO CONSIDER WEAVING IN: ${missing.slice(0, 12).join(', ') || 'none'}\n\n` +
    `Return tailoring tips as JSON.`;

  try {
    const content = await callWithRetry(client, prompt, key);
    const json = content.match(/\{[\s\S]*\}/);
    if (!json) return undefined;
    const parsed = EnhancerSchema.safeParse(JSON.parse(json[0]));
    if (!parsed.success) return undefined;
    await markKeySuccess(key);
    return parsed.data.tailoringTips;
  } catch (error) {
    await markKeyFailure(key, isRateLimitError(error)).catch(() => {});
    return undefined;
  }
}
