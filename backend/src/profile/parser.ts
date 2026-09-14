// Career-profile extraction from resume text via LLM (BYOK).
// Extracted from routes/profile.ts to remove duplication and ease reuse.
import { leaseNextLlmKey, markKeySuccess, markKeyFailure, isRateLimitError } from '../ai/keyManager.js';
import { getProviderModel, runLlmCompletion, createLlmClient } from '../ai/providerModels.js';

const PROFILE_SYSTEM = `Extract career profile facts from this resume. Return JSON: { "targetRoles": string[], "seniority": "junior"|"mid"|"senior"|"staff"|"lead"|"principal"|null, "topSkills": string[], "industries": string[], "summary": string, "inferredMinSalary": number|null }. Only include facts present in the resume; use null for unknowns.`;

export interface ParsedProfileSuggestion {
  suggested: {
    targetRoles: string[];
    seniority: string | null;
    topSkills: string[];
    industries: string[];
    summary: string;
  };
  missing: string[];
}

// Parse a resume's structured text into suggested CareerProfile field values.
// LLM is leased via keyManager (BYOK). Salary/location/redFlags are intentionally
// NOT present in a resume, so they are returned in `missing` for the UI to flag.
export async function parseProfileFromResume(
  resumeText: string,
  userId?: string
): Promise<ParsedProfileSuggestion> {
  const key = await leaseNextLlmKey(userId);
  const model = await getProviderModel(key.provider, { envOverride: process.env.PROFILE_PARSE_MODEL });
  const client = createLlmClient(key);
  try {
    const resp = await runLlmCompletion(key.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 1200,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PROFILE_SYSTEM },
          { role: 'user', content: resumeText },
        ],
      })
    );
    await markKeySuccess(key);
    const content = resp.choices[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    return {
      suggested: {
        targetRoles: parsed.targetRoles || [],
        seniority: parsed.seniority || null,
        topSkills: parsed.topSkills || [],
        industries: parsed.industries || [],
        summary: parsed.summary || '',
      },
      missing: ['minSalary', 'maxSalary', 'locationPref', 'remoteOnly', 'redFlags'],
    };
  } catch (e) {
    await markKeyFailure(key, isRateLimitError(e));
    throw e;
  }
}
