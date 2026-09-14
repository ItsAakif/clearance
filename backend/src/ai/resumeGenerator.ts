// AI Resume Generator Service
// Uses provider-agnostic LLM keys (keyManager.leaseNextLlmKey) with a dynamic
// baseURL selected from the leased key's provider.
// Per security.md: Never log API keys

import {
  isRateLimitError,
  leaseNextLlmKey,
  markKeyFailure,
  markKeySuccess,
  type KeyRecord,
} from './keyManager.js';
import { getProviderModel, runLlmCompletion, createLlmClient, type LlmChatClient } from './providerModels.js';

// ==================== TYPES ====================

export interface AIGuidedInput {
  targetRole: string;
  experienceLevel: string;
  currentRole: string;
  yearsExperience: string;
  industry: string;
  highestDegree: string;
  fieldOfStudy: string;
  institution: string;
  technicalSkills: string;
  softSkills: string;
  tools: string;
  achievements: string;
  projectHighlights: string;
}

export interface GeneratedResume {
  name: string;
  personalInfo: {
    fullName: string;
    email: string;
    phone: string;
    location: string;
  };
  summary: string;
  experience: Array<{
    id: string;
    title: string;
    company: string;
    location: string;
    startDate: string;
    endDate: string;
    description: string;
    bullets: string[];
  }>;
  education: Array<{
    id: string;
    degree: string;
    field: string;
    institution: string;
    graduationYear: string;
  }>;
  skills: string[];
}

/**
 * Normalize raw LLM JSON into the shape the frontend builder expects.
 * The editor keys entries by `id` (update/remove) and renders
 * `description`, so entries without ids break per-item editing.
 */
function normalizeGeneratedResume(raw: Partial<GeneratedResume> & Record<string, any>): GeneratedResume {
  const experience = (Array.isArray(raw.experience) ? raw.experience : []).map((e: any, i: number) => ({
    id: typeof e?.id === 'string' && e.id ? e.id : `exp-${i + 1}`,
    title: String(e?.title || ''),
    company: String(e?.company || ''),
    location: String(e?.location || ''),
    startDate: String(e?.startDate || ''),
    endDate: String(e?.endDate || ''),
    description: String(e?.description || ''),
    bullets: Array.isArray(e?.bullets) ? e.bullets.map((b: unknown) => String(b)) : [],
  }));
  const education = (Array.isArray(raw.education) ? raw.education : []).map((e: any, i: number) => ({
    id: typeof e?.id === 'string' && e.id ? e.id : `edu-${i + 1}`,
    degree: String(e?.degree || ''),
    field: String(e?.field || ''),
    institution: String(e?.institution || ''),
    // Older tailor prompt used `year`; accept both.
    graduationYear: String(e?.graduationYear ?? e?.year ?? ''),
  }));
  return {
    name: String(raw.name || ''),
    personalInfo: {
      fullName: String(raw.personalInfo?.fullName || ''),
      email: String(raw.personalInfo?.email || ''),
      phone: String(raw.personalInfo?.phone || ''),
      location: String(raw.personalInfo?.location || ''),
    },
    summary: String((raw as any).summary || ''),
    experience,
    education,
    skills: Array.isArray(raw.skills) ? raw.skills.map((s: unknown) => String(s)) : [],
  };
}

// ==================== LLM CLIENT ====================

async function withLlmClient<T>(callback: (client: LlmChatClient, key: KeyRecord) => Promise<T>): Promise<T> {
  const leasedKey = await leaseNextLlmKey();
  const client = createLlmClient(leasedKey);

  try {
    const result = await callback(client, leasedKey);
    await markKeySuccess(leasedKey);
    return result;
  } catch (error) {
    await markKeyFailure(leasedKey, isRateLimitError(error));
    throw error;
  }
}

// ==================== SYSTEM PROMPTS ====================

const RESUME_GENERATION_SYSTEM_PROMPT = `You are an expert resume writer and career coach with 20+ years of experience. 
You create ATS-optimized resumes that get candidates interviews at top companies.

Your resumes follow these best practices:
1. Use strong action verbs (Led, Developed, Implemented, Achieved, etc.)
2. Include quantifiable achievements with metrics whenever possible
3. Tailor content to the target role
4. Use industry-standard keywords for ATS optimization
5. Keep bullet points concise (1-2 lines each)
6. Professional summary should be 2-3 impactful sentences
7. Focus on accomplishments, not just responsibilities

You MUST respond with valid JSON only. No markdown, no explanations, just the JSON object.`;

// ==================== RESUME GENERATION ====================

export async function generateResumeFromInput(input: AIGuidedInput): Promise<GeneratedResume> {
  const prompt = `Generate a professional resume based on the following information:

TARGET ROLE: ${input.targetRole}
EXPERIENCE LEVEL: ${input.experienceLevel}
CURRENT/RECENT ROLE: ${input.currentRole}
YEARS OF EXPERIENCE: ${input.yearsExperience}
INDUSTRY: ${input.industry}

EDUCATION:
- Degree: ${input.highestDegree}
- Field of Study: ${input.fieldOfStudy}
- Institution: ${input.institution}

SKILLS:
- Technical: ${input.technicalSkills}
- Soft Skills: ${input.softSkills}
- Tools: ${input.tools}

ACHIEVEMENTS: ${input.achievements}

PROJECT HIGHLIGHTS: ${input.projectHighlights}

Generate a complete professional resume with the following JSON structure:
{
  "name": "Resume for [Target Role]",
  "personalInfo": {
    "fullName": "[Generate a professional placeholder name]",
    "email": "professional@email.com",
    "phone": "(555) 123-4567",
    "location": "City, State"
  },
  "summary": "[2-3 sentence professional summary tailored to the target role]",
  "experience": [
    {
      "title": "[Job Title]",
      "company": "[Company Name]",
      "location": "[City, State]",
      "startDate": "[Month Year]",
      "endDate": "[Month Year or Present]",
      "bullets": [
        "[Achievement-focused bullet point with metrics]",
        "[Another achievement]",
        "[Another achievement]"
      ]
    }
  ],
  "education": [
    {
      "degree": "[Degree Type]",
      "field": "[Field of Study]",
      "institution": "[Institution Name]",
      "graduationYear": "[Year]"
    }
  ],
  "skills": ["skill1", "skill2", "skill3"]
}

Create 2-3 realistic experience entries based on the provided background and achievements.
Each experience should have 3-5 bullet points with quantifiable achievements.
Include all relevant skills from the provided information.
Make the resume optimized for ATS systems and the target role.

RESPOND WITH ONLY THE JSON OBJECT, NO OTHER TEXT.`;

  let lastError: Error | null = null;
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const content = await withLlmClient(async (client, key) => {
        const model = await getProviderModel(key.provider);
        const response = await runLlmCompletion(key.provider, model, () =>
          client.chat.completions.create({
            model,
            max_tokens: 2000,
            temperature: 0.7,
            messages: [
              { role: 'system', content: RESUME_GENERATION_SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
          })
        );

        return response.choices[0]?.message?.content || '';
      });

      // Parse JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('AI response did not contain valid JSON');
      }
      
      const resume = normalizeGeneratedResume(JSON.parse(jsonMatch[0]));
      
      // Validate required fields
      if (!resume.summary || !resume.experience || !resume.skills) {
        throw new Error('Generated resume is missing required fields');
      }
      
      return resume;
    } catch (error) {
      lastError = error as Error;
      console.error(`[ResumeGenerator] Attempt ${attempt + 1} failed:`, (error as Error).message);
      
      // Try next API key on rate limit
      if (isRateLimitError(error)) {
        continue;
      }

      break;
    }
  }
  
  throw lastError || new Error('Failed to generate resume after all retries');
}

// ==================== RESUME IMPROVEMENT ====================

export async function improveResumeBullet(
  originalBullet: string,
  jobTitle: string,
  targetRole?: string
): Promise<string> {
  const prompt = `Improve this resume bullet point for a ${jobTitle} role${targetRole ? ` targeting a ${targetRole} position` : ''}:

Original: "${originalBullet}"

Make it:
1. Start with a strong action verb
2. Include quantifiable metrics if possible
3. Focus on impact and achievements
4. Keep it concise (1-2 lines)
5. ATS-friendly with relevant keywords

Return ONLY the improved bullet point, no explanation.`;

  const content = await withLlmClient(async (client, key) => {
    const model = await getProviderModel(key.provider);
    const response = await runLlmCompletion(key.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 200,
        temperature: 0.7,
        messages: [
          { role: 'system', content: 'You are an expert resume writer. Respond with only the improved bullet point.' },
          { role: 'user', content: prompt },
        ],
      })
    );

    return response.choices[0]?.message?.content?.trim() || originalBullet;
  });

  return content;
}

// ==================== JD-DRIVEN BUILD ====================

export interface JDBuildInput {
  jobDescription: string;
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  // When provided, the draft is based on the user's real resume content,
  // reshaped toward the JD (truthful tailoring) instead of generated from scratch.
  existingResume?: {
    personalInfo?: { fullName?: string; email?: string; phone?: string; location?: string };
    summary?: string;
    experience?: Array<{ title?: string; company?: string; bullets?: string[] }>;
    education?: Array<{ degree?: string; field?: string; institution?: string }>;
    skills?: string[];
  };
}

const JD_EXTRACTION_SYSTEM_PROMPT = `You are a precise resume intake assistant. Given a job description, extract ONLY:
1. "targetRole": the most likely job title being hired for (short, e.g. "Senior Software Engineer")
2. "experienceLevel": one of "entry" | "mid" | "senior" | "executive" (infer from seniority signals, default "mid")
3. "industry": the broad industry (e.g. "Technology", "Finance", "Healthcare")
4. "technicalSkills": comma-separated technical skills/tools the role requires
5. "softSkills": comma-separated soft skills the role requires
6. "tools": comma-separated specific tools/technologies/platforms named
7. "keyAchievementHints": 1-3 phrases describing what success looks like in this role (for resume bullets)

Respond with ONLY valid JSON. No markdown, no explanation.`;

/**
 * Build a resume from a pasted job description. Extracts role/skills from the JD
 * (truthfully, from the JD text only) and feeds them into the existing resume
 * generator. Personal info is only filled from what the user explicitly provides.
 */
export async function buildResumeFromJobDescription(
  input: JDBuildInput
): Promise<{ extracted: Record<string, string>; resume: GeneratedResume }> {
  const extraction = await extractFromJobDescription(input.jobDescription);

  // When the user has a real resume, tailor it toward the JD (truthful: only
  // reshape/reframe existing experience, never invent roles, companies, or metrics).
  if (input.existingResume) {
    const tailored = await tailorResumeToJobDescription({
      jobDescription: input.jobDescription,
      extraction,
      base: input.existingResume,
    });

    tailored.personalInfo = {
      fullName: input.existingResume.personalInfo?.fullName || input.fullName?.trim() || '',
      email: input.existingResume.personalInfo?.email || input.email?.trim() || '',
      phone: input.existingResume.personalInfo?.phone || input.phone?.trim() || '',
      location: input.existingResume.personalInfo?.location || input.location?.trim() || '',
    };

    return { extracted: { ...extraction }, resume: tailored };
  }

  const aiInput: AIGuidedInput = {
    targetRole: extraction.targetRole,
    experienceLevel: extraction.experienceLevel,
    currentRole: extraction.targetRole,
    yearsExperience: '',
    industry: extraction.industry,
    highestDegree: '',
    fieldOfStudy: '',
    institution: '',
    technicalSkills: extraction.technicalSkills,
    softSkills: extraction.softSkills,
    tools: extraction.tools,
    achievements: extraction.keyAchievementHints,
    projectHighlights: '',
  };

  const resume = await generateResumeFromInput(aiInput);

  // Prefill personal info only from explicit user input; keep placeholders otherwise.
  resume.personalInfo = {
    fullName: input.fullName?.trim() || resume.personalInfo.fullName,
    email: input.email?.trim() || resume.personalInfo.email,
    phone: input.phone?.trim() || resume.personalInfo.phone,
    location: input.location?.trim() || resume.personalInfo.location,
  };

  return { extracted: { ...extraction }, resume };
}

/**
 * Reshape a user's existing resume toward a job description. Strictly truthful:
 * reframes and reorders the candidate's real experience to emphasize JD-relevant
 * skills, but does NOT fabricate employers, titles, dates, or metrics.
 */
async function tailorResumeToJobDescription(params: {
  jobDescription: string;
  extraction: {
    targetRole: string;
    experienceLevel: string;
    industry: string;
    technicalSkills: string;
    softSkills: string;
    tools: string;
    keyAchievementHints: string;
  };
  base: NonNullable<JDBuildInput['existingResume']>;
}): Promise<GeneratedResume> {
  const { jobDescription, extraction, base } = params;

  const baseJson = JSON.stringify(
    {
      personalInfo: base.personalInfo,
      summary: base.summary,
      experience: base.experience,
      education: base.education,
      skills: base.skills,
    },
    null,
    2
  );

  const prompt = `You are an expert resume editor. Given a candidate's EXISTING resume and a target job description, produce a tailored resume.

RULES (critical - never violate):
1. Use ONLY the candidate's real experience, employers, titles, dates, and metrics from the existing resume. DO NOT invent companies, roles, dates, or achievements.
2. Reframe and reorder bullets to emphasize the skills/tools/keywords from the job description.
3. Reorder skills so the most JD-relevant ones appear first.
4. If the existing summary exists, refine it toward the target role; otherwise write a short one from real experience only.
5. Keep the same number of experience entries (do not add or drop roles).

TARGET ROLE: ${extraction.targetRole}
EXTRACTED JD SKILLS: ${extraction.technicalSkills}
EXTRACTED JD TOOLS: ${extraction.tools}
EXTRACTED JD SOFT SKILLS: ${extraction.softSkills}

EXISTING RESUME:
${baseJson}

JOB DESCRIPTION (first 4000 chars):
${jobDescription.slice(0, 4000)}

Return ONLY valid JSON matching this schema:
{
  "summary": string,
  "experience": [{ "title": string, "company": string, "startDate": string, "endDate": string, "bullets": string[] }],
  "education": [{ "degree": string, "field": string, "institution": string, "graduationYear": string }],
  "skills": string[]
}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await withLlmClient(async (client, key) => {
        const model = await getProviderModel(key.provider);
        const response = await runLlmCompletion(key.provider, model, () =>
          client.chat.completions.create({
            model,
            max_tokens: 2000,
            temperature: 0.4,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: 'You are a precise, truthful resume editor. Return only valid JSON.' },
              { role: 'user', content: prompt },
            ],
          })
        );
        return response.choices[0]?.message?.content?.trim() || '';
      });

      const parsed = JSON.parse(content) as Partial<GeneratedResume>;
      const normalized = normalizeGeneratedResume(parsed);
      return {
        name: '',
        personalInfo: {
          fullName: base.personalInfo?.fullName || '',
          email: base.personalInfo?.email || '',
          phone: base.personalInfo?.phone || '',
          location: base.personalInfo?.location || '',
        },
        summary: normalized.summary || base.summary || '',
        experience: normalized.experience.length ? normalized.experience : (base.experience as any) || [],
        education: normalized.education.length ? normalized.education : (base.education as any) || [],
        skills: normalized.skills.length ? normalized.skills : (base.skills || []),
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (isRateLimitError(error)) {
        continue;
      }
      break;
    }
  }

  // Graceful fallback: return the base resume with JD-relevant skills reordered.
  const baseSkills = base.skills || [];
  const jdSkills = (extraction.technicalSkills + ',' + extraction.tools)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const reordered = baseSkills
    .map((s) => ({ s, score: jdSkills.filter((j) => s.toLowerCase().includes(j)).length }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);

  return {
    name: '',
    personalInfo: {
      fullName: base.personalInfo?.fullName || '',
      email: base.personalInfo?.email || '',
      phone: base.personalInfo?.phone || '',
      location: base.personalInfo?.location || '',
    },
    summary: base.summary || '',
    experience: (base.experience as any) || [],
    education: (base.education as any) || [],
    skills: reordered.length ? reordered : baseSkills,
  };
}

async function extractFromJobDescription(
  jobDescription: string
): Promise<{
  targetRole: string;
  experienceLevel: string;
  industry: string;
  technicalSkills: string;
  softSkills: string;
  tools: string;
  keyAchievementHints: string;
}> {
  const prompt = `JOB DESCRIPTION:\n${jobDescription.slice(0, 4000)}\n\nExtract the requested fields as JSON.`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const content = await withLlmClient(async (client, key) => {
        const model = await getProviderModel(key.provider);
        const response = await runLlmCompletion(key.provider, model, () =>
          client.chat.completions.create({
            model,
            max_tokens: 800,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: JD_EXTRACTION_SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
          })
        );
        return response.choices[0]?.message?.content || '';
      });

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('JD extraction returned no JSON');
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        targetRole: String(parsed.targetRole || 'Professional').slice(0, 100),
        experienceLevel: ['entry', 'mid', 'senior', 'executive'].includes(parsed.experienceLevel)
          ? parsed.experienceLevel
          : 'mid',
        industry: String(parsed.industry || 'General').slice(0, 100),
        technicalSkills: String(parsed.technicalSkills || ''),
        softSkills: String(parsed.softSkills || ''),
        tools: String(parsed.tools || ''),
        keyAchievementHints: String(parsed.keyAchievementHints || ''),
      };
    } catch (error) {
      lastError = error as Error;
      if (isRateLimitError(error)) continue;
      break;
    }
  }

  // Graceful fallback: never block the build on extraction failure.
  return {
    targetRole: 'Professional',
    experienceLevel: 'mid',
    industry: 'General',
    technicalSkills: '',
    softSkills: '',
    tools: '',
    keyAchievementHints: '',
  };
}

// ==================== PROFESSIONAL SUMMARY ====================

export async function generateProfessionalSummary(
  currentRole: string,
  targetRole: string,
  yearsExperience: string,
  keySkills: string[],
  achievements: string
): Promise<string> {
  const prompt = `Generate a professional summary for a resume with the following details:

Current Role: ${currentRole}
Target Role: ${targetRole}
Years of Experience: ${yearsExperience}
Key Skills: ${keySkills.join(', ')}
Key Achievements: ${achievements}

Write a 2-3 sentence professional summary that:
1. Highlights years of experience and expertise
2. Mentions key skills relevant to the target role
3. Includes a notable achievement or impact
4. Is ATS-optimized with relevant keywords

Return ONLY the summary paragraph, no explanation.`;

  const content = await withLlmClient(async (client, key) => {
    const model = await getProviderModel(key.provider);
    const response = await runLlmCompletion(key.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 300,
        temperature: 0.7,
        messages: [
          { role: 'system', content: 'You are an expert resume writer. Respond with only the professional summary.' },
          { role: 'user', content: prompt },
        ],
      })
    );

    return response.choices[0]?.message?.content?.trim() || '';
  });

  return content;
}
