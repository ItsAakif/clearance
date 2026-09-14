// Tailor Resume to Selected Template Routes
// Takes a job evaluation/description + source resume + selected Clearance template,
// rewrites the resume content (truthfully) to mirror the JD, and exports via the
// existing HTML->DOCX/PDF pipeline (export.ts). Human-in-the-loop: never auto-submits.

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, tailorResumeSchema } from '../shared/validation.js';
import { improveResumeForJob } from '../ats/improver.js';
import { refineResume } from '../ats/refiner.js';
import { scoreResumeAgainstJob } from '../ats/atsScorer.js';
import OpenAI from 'openai';
import {
  leaseNextLlmKey, markKeySuccess, markKeyFailure, isRateLimitError, type KeyRecord,
} from '../ai/keyManager.js';
import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';
import { chromium } from 'playwright';
import HTMLtoDOCX from 'html-to-docx';

const router = Router();

const TAILOR_PROMPT = `You are an expert resume writer. Rewrite the candidate's resume to better match the target job description.
RULES:
- Mirror the JD's language and keywords where the candidate genuinely has the experience.
- NEVER invent skills, jobs, or achievements the candidate does not have.
- Keep the same structure: summary, experience (with bullets), education, skills.
- Improve bullet phrasing with strong action verbs and quantifiable impact where truthful.
- Return STRICT JSON: { "summary": string, "experience": [{ "title": string, "company": string, "bullets": string[] }], "skills": string[], "education": [{ "degree": string, "institution": string }] }`;

function buildTailorUser(resume: any, jd: string, profile?: { summary?: string; topSkills?: string[] } | null): string {
  const profileSection = profile ? `
CANDIDATE CAREER PROFILE (calibrate tone/emphasis, do NOT invent facts):
- Professional summary: ${profile.summary || 'n/a'}
- Top skills to emphasize: ${profile.topSkills?.join(', ') || 'n/a'}
` : '';
  return `CANDIDATE RESUME:\n${JSON.stringify({
    summary: resume.summary, experience: resume.experience, education: resume.education, skills: resume.skills,
  }, null, 2)}${profileSection}\n\nJOB DESCRIPTION:\n${jd}\n\nReturn the tailored resume JSON only.`;
}

async function withLlmClient<T>(userId: string | undefined, cb: (client: OpenAI, key: KeyRecord) => Promise<T>): Promise<T> {
  const key = await leaseNextLlmKey(userId);
  const baseURL = key.provider === 'groq' ? 'https://api.groq.com/openai/v1'
    : key.provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
    : key.provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : 'https://api.openai.com/v1';
  const client = new OpenAI({ apiKey: key.apiKey, baseURL });
  try {
    const r = await cb(client, key);
    await markKeySuccess(key);
    return r;
  } catch (e) {
    await markKeyFailure(key, isRateLimitError(e));
    throw e;
  }
}

function renderResumeHtml(data: any, templateId: string): string {
  const exp = (data.experience || []).map((e: any) => `
    <div style="margin-bottom:10px">
      <strong>${e.title || ''}</strong> - ${e.company || ''}
      <ul>${((e.bullets) || []).map((b: string) => `<li>${b}</li>`).join('')}</ul>
    </div>`).join('');
  const skills = (data.skills || []).join(' · ');
  const edu = (data.education || []).map((e: any) => `<div>${e.degree || ''} - ${e.institution || ''}</div>`).join('');
  return `<div style="font-family: 'Segoe UI', Arial, sans-serif; padding:48px; color:#111; max-width:780px; margin:auto">
    <h1 style="margin:0 0 4px">${(data.personalInfo?.fullName) || 'Candidate'}</h1>
    <div style="color:#555; font-size:13px">${(data.personalInfo?.email) || ''} ${data.personalInfo?.phone ? '· ' + data.personalInfo.phone : ''} ${data.personalInfo?.location ? '· ' + data.personalInfo.location : ''}</div>
    <h2 style="border-bottom:2px solid #222; font-size:15px; margin-top:18px">Summary</h2>
    <p style="font-size:13px">${data.summary || ''}</p>
    <h2 style="border-bottom:2px solid #222; font-size:15px; margin-top:14px">Experience</h2>
    ${exp}
    <h2 style="border-bottom:2px solid #222; font-size:15px; margin-top:14px">Skills</h2>
    <p style="font-size:13px">${skills}</p>
    <h2 style="border-bottom:2px solid #222; font-size:15px; margin-top:14px">Education</h2>
    ${edu}
    <div style="margin-top:24px; font-size:10px; color:#999">Tailored with Clearance · template: ${templateId}</div>
  </div>`;
}

async function exportBuffer(html: string, format: 'pdf' | 'docx', documentName: string): Promise<Buffer> {
  if (format === 'docx') {
    const buf = await HTMLtoDOCX(html, null, { table: { row: { cantSplit: true } }, footer: false, pageNumber: false });
    return Buffer.from(buf);
  }
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  const pdf = await page.pdf({ format: 'Letter', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  await browser.close();
  return Buffer.from(pdf);
}

// ==================== MULTI-PASS REFINEMENT PIPELINE (RM-01) ====================
router.post('/pipeline', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(tailorResumeSchema, req.body);
    const resume = await prisma.resume.findUnique({ where: { id: body.resumeId } });
    if (!resume) throw new NotFoundError('Resume');
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    let jd = body.jobDescription;
    if (body.jobEvaluationId) {
      const ev = await prisma.jobEvaluation.findUnique({ where: { id: body.jobEvaluationId } });
      if (ev) {
        await ensureOwnership(req.user!.id, ev.userId, 'Job Evaluation');
        const listing = await prisma.jobListing.findUnique({ where: { id: ev.jobListingId } });
        jd = jd || listing?.description;
      }
    }
    if (!jd) throw new NotFoundError('Job description');

    const profile = await prisma.careerProfile.findUnique({ where: { userId: req.user!.id } });
    const profileArg = profile
      ? { summary: profile.summary || undefined, topSkills: (profile.topSkills as string[]) || undefined }
      : null;

    // Pass 1: improver — initial tailored draft
    const draft = await improveResumeForJob({ resume: resume as any, jd, profile: profileArg });
    // Pass 2: refiner — keyword injection + phrasing + alignment validation
    const { refined, alignment } = await refineResume({ draft, jd, masterResume: resume as any });

    // 3-factor score of the refined draft against the JD
    const experienceArr = (resume.experience as any[]) || [];
    const educationArr = (resume.education as any[]) || [];
    const resumeText = [
      resume.summary,
      ...experienceArr.flatMap((e: any) => [e.title, e.company, ...(e.bullets || [])]),
      ...educationArr.flatMap((e: any) => [e.degree, e.institution]),
      ...(resume.skills as string[] || []),
    ].filter(Boolean).join(' ');
    const threeFactor = scoreResumeAgainstJob({
      resumeText,
      skills: (resume.skills as string[]) || [],
      jd,
    });

    res.status(200).json({ refined, alignment, threeFactor });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== CREATE TAILORED RESUME ====================
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(tailorResumeSchema, req.body);
    const resume = await prisma.resume.findUnique({ where: { id: body.resumeId } });
    if (!resume) throw new NotFoundError('Resume');
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    let jd = body.jobDescription;
    if (body.jobEvaluationId) {
      const ev = await prisma.jobEvaluation.findUnique({ where: { id: body.jobEvaluationId } });
      if (ev) {
        await ensureOwnership(req.user!.id, ev.userId, 'Job Evaluation');
        const listing = await prisma.jobListing.findUnique({ where: { id: ev.jobListingId } });
        jd = jd || listing?.description;
      }
    }
    if (!jd) throw new NotFoundError('Job description');

    const profile = await prisma.careerProfile.findUnique({ where: { userId: req.user!.id } });

    const tailored = await withLlmClient(req.user!.id, async (client, key) => {
      const model = await getProviderModel(key.provider, { envOverride: process.env.RESUME_TAILOR_MODEL });
      const resp = await runLlmCompletion(key.provider, model, () =>
        client.chat.completions.create({
          model,
          max_tokens: 1800,
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: TAILOR_PROMPT },
            { role: 'user', content: buildTailorUser(resume, jd, profile ? {
              summary: profile.summary || undefined,
              topSkills: (profile.topSkills as string[]) || undefined,
            } : null) },
          ],
        })
      );
      return resp.choices[0]?.message?.content || '';
    });

    const jsonMatch = tailored.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Tailoring did not return valid JSON');
    const parsed = JSON.parse(jsonMatch[0]);

    const content = {
      personalInfo: resume.personalInfo,
      summary: parsed.summary || resume.summary,
      experience: parsed.experience || resume.experience,
      education: parsed.education || resume.education,
      skills: parsed.skills || resume.skills,
    };
    const html = renderResumeHtml(content, body.templateId);

    const record = await prisma.tailoredResume.create({
      data: {
        userId: req.user!.id,
        jobEvaluationId: body.jobEvaluationId,
        sourceResumeId: body.resumeId,
        templateId: body.templateId,
        jobListingId: body.jobListingId,
        title: `Tailored - ${(resume as any).name || 'Resume'}`,
        content,
        html,
      },
    });

    res.status(201).json({ id: record.id, title: record.title, templateId: record.templateId, content, html });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== EXPORT TAILORED RESUME ====================
router.get('/:id/export', requireAuth, async (req: Request, res: Response) => {
  try {
    const format = (req.query.format === 'pdf' ? 'pdf' : 'docx') as 'pdf' | 'docx';
    const record = await prisma.tailoredResume.findUnique({ where: { id: req.params.id } });
    if (!record) throw new NotFoundError('Tailored Resume');
    await ensureOwnership(req.user!.id, record.userId, 'Tailored Resume');

    const html = record.html || renderResumeHtml(record.content, record.templateId);
    const buffer = await exportBuffer(html, format, record.title);

    const mime = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${record.title}.${format}"`);
    res.send(buffer);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== LIST TAILORED RESUMES ====================
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const items = await prisma.tailoredResume.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, templateId: true, createdAt: true },
    });
    res.json(items);
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
