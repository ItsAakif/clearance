// AI Interview Answer Generator Service
// Uses provider-agnostic LLM key management (keyManager.leaseNextLlmKey) with a
// dynamic baseURL selected from the leased key's provider.
// Per security.md: never log API keys.

import OpenAI from 'openai';
import {
  isRateLimitError,
  leaseNextLlmKey,
  markKeyFailure,
  markKeySuccess,
} from './keyManager.js';

export interface GenerateInterviewAnswerInput {
  question: string;
  category?: 'behavioral' | 'technical' | 'situational' | 'general';
  jobTitle?: string;
  jobDescription?: string;
}

export async function generateInterviewAnswer(input: GenerateInterviewAnswerInput): Promise<string> {
  const categoryLabel = input.category || 'general';
  const trimmedQuestion = input.question.trim().slice(0, 500);

  const contextBlock = [
    input.jobTitle ? `JOB TITLE: ${input.jobTitle}` : null,
    input.jobDescription ? `JOB DESCRIPTION (excerpt):\n${input.jobDescription.slice(0, 2000)}` : null,
  ].filter(Boolean).join('\n\n');

  const prompt = `You are an expert interview coach. Prepare a truthful, concise answer for a ${categoryLabel} interview question.

${contextBlock ? `${contextBlock}\n\n` : ''}QUESTION: ${trimmedQuestion}

RULES:
1. Be concise (3-6 sentences).
2. Never invent candidate experience not present in the prompt.
3. Use a STAR-style structure for behavioral/situational questions when applicable.
4. If no job context is provided, give a strong generic answer.

Return ONLY the answer text, no explanations.`;

  async function callLlm(client: OpenAI): Promise<string> {
    const response = await client.chat.completions.create({
      model: 'llama-3.1-70b-versatile',
      max_tokens: 600,
      temperature: 0.6,
      messages: [
        { role: 'system', content: 'You are an expert interview coach. Return only the answer text.' },
        { role: 'user', content: prompt },
      ],
    });
    return response.choices[0]?.message?.content?.trim() || '';
  }

  const leasedKey = await leaseNextLlmKey();
  const baseURL = leasedKey.provider === 'groq'
    ? 'https://api.groq.com/openai/v1'
    : leasedKey.provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1'
    : leasedKey.provider === 'gemini'
    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : 'https://api.openai.com/v1';
  const client = new OpenAI({ apiKey: leasedKey.apiKey, baseURL });

  try {
    const answer = await callLlm(client);
    await markKeySuccess(leasedKey);
    if (!answer) throw new Error('Empty answer from model');
    return answer;
  } catch (error) {
    await markKeyFailure(leasedKey, isRateLimitError(error));
    throw error;
  }
}
