// AI Routes - Resume Generation, Improvement, etc.
// Per security.md: Validate input

import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, ForbiddenError, BadRequestError } from '../shared/errors.js';
import { generateResumeFromInput, improveResumeBullet, generateProfessionalSummary, buildResumeFromJobDescription, AIGuidedInput } from '../ai/resumeGenerator.js';
import { generateInterviewAnswer } from '../ai/interviewGenerator.js';

const router = Router();

/**
 * AI routes surface actionable, secret-free errors instead of a generic 500:
 * - no LLM key configured -> 503 with setup hint (message contains no secrets)
 * - invalid/retired model -> 502 naming provider + model
 * Everything else keeps the default minimal-error handling.
 */
function handleAiRouteError(error: unknown, res: Parameters<typeof handleApiError>[1]): void {
  if (error instanceof Error) {
    if (/api keys? configured/i.test(error.message)) {
      console.error(`[${new Date().toISOString()}] [503] ${error.message}`);
      res.status(503).json({ error: error.message });
      return;
    }
    if (error.name === 'LlmModelError') {
      console.error(`[${new Date().toISOString()}] [502] ${error.message}`);
      res.status(502).json({ error: error.message });
      return;
    }
  }
  handleApiError(error, res);
}

// ==================== AI RESUME GENERATION ====================

router.post('/generate-resume', requireAuth, async (req, res) => {
  try {
    const input = req.body as AIGuidedInput;
    
    // Validate required fields
    if (!input.targetRole || !input.experienceLevel) {
      throw new BadRequestError('Target role and experience level are required');
    }
    
    // Generate resume using AI
    const generatedResume = await generateResumeFromInput(input);
    
    // Create the resume in database
    const resume = await prisma.resume.create({
      data: {
        userId: req.user!.id,
        name: generatedResume.name || `Resume for ${input.targetRole}`,
        personalInfo: generatedResume.personalInfo,
        summary: generatedResume.summary,
        experience: generatedResume.experience,
        education: generatedResume.education,
        skills: generatedResume.skills,
        sections: [
          { id: 'personal', type: 'personal', title: 'Personal Information', order: 0, visible: true },
          { id: 'summary', type: 'summary', title: 'Professional Summary', order: 1, visible: true },
          { id: 'experience', type: 'experience', title: 'Work Experience', order: 2, visible: true },
          { id: 'education', type: 'education', title: 'Education', order: 3, visible: true },
          { id: 'skills', type: 'skills', title: 'Skills', order: 4, visible: true },
        ]
      }
    });
    
    res.status(201).json({
      id: resume.id,
      name: resume.name,
      personalInfo: resume.personalInfo,
      summary: resume.summary,
      experience: resume.experience,
      education: resume.education,
      skills: resume.skills,
      createdAt: resume.createdAt
    });
  } catch (error) {
    handleAiRouteError(error, res);
  }
});

// ==================== JD-DRIVEN AI BUILD ====================

router.post('/build-from-jd', requireAuth, async (req, res) => {
  try {
    const { jobDescription, fullName, email, phone, location, resumeId, name } = req.body as {
      jobDescription?: string;
      fullName?: string;
      email?: string;
      phone?: string;
      location?: string;
      resumeId?: string;
      name?: string;
    };

    if (!jobDescription || jobDescription.trim().length < 50) {
      throw new BadRequestError('A job description of at least 50 characters is required');
    }

    // When a base resume is provided, tailor it toward the JD (truthful reshaping).
    let existingResume: Parameters<typeof buildResumeFromJobDescription>[0]['existingResume'];
    if (resumeId) {
      const base = await prisma.resume.findFirst({
        where: { id: resumeId, userId: req.user!.id },
        select: {
          personalInfo: true,
          summary: true,
          experience: true,
          education: true,
          skills: true,
        },
      });
      if (base) {
        existingResume = {
          personalInfo: base.personalInfo as any,
          summary: base.summary as any,
          experience: base.experience as any,
          education: base.education as any,
          skills: (base.skills as any) || [],
        };
      }
    }

    const { extracted, resume: generated } = await buildResumeFromJobDescription({
      jobDescription: jobDescription.trim(),
      fullName,
      email,
      phone,
      location,
      existingResume,
    });

    const created = await prisma.resume.create({
      data: {
        userId: req.user!.id,
        name: name?.trim() || `Resume for ${extracted.targetRole || 'New Role'}`,
        personalInfo: generated.personalInfo,
        summary: generated.summary,
        experience: generated.experience,
        education: generated.education,
        skills: generated.skills,
        sections: [
          { id: 'personal', type: 'personal', title: 'Personal Information', order: 0, visible: true },
          { id: 'summary', type: 'summary', title: 'Professional Summary', order: 1, visible: true },
          { id: 'experience', type: 'experience', title: 'Work Experience', order: 2, visible: true },
          { id: 'education', type: 'education', title: 'Education', order: 3, visible: true },
          { id: 'skills', type: 'skills', title: 'Skills', order: 4, visible: true },
        ],
      },
    });

    res.status(201).json({
      id: created.id,
      name: created.name,
      extracted,
      personalInfo: created.personalInfo,
      summary: created.summary,
      experience: created.experience,
      education: created.education,
      skills: created.skills,
      createdAt: created.createdAt,
    });
  } catch (error) {
    handleAiRouteError(error, res);
  }
});

// ==================== IMPROVE BULLET POINT ====================

router.post('/improve-bullet', requireAuth, async (req, res) => {
  try {
    const { bullet, jobTitle, targetRole } = req.body;
    
    if (!bullet || !jobTitle) {
      throw new BadRequestError('Bullet point and job title are required');
    }
    
    const improved = await improveResumeBullet(bullet, jobTitle, targetRole);
    
    res.json({ improved });
  } catch (error) {
    handleAiRouteError(error, res);
  }
});

// ==================== GENERATE PROFESSIONAL SUMMARY ====================

router.post('/generate-summary', requireAuth, async (req, res) => {
  try {
    const { currentRole, targetRole, yearsExperience, keySkills, achievements } = req.body;
    
    if (!currentRole || !targetRole) {
      throw new BadRequestError('Current role and target role are required');
    }
    
    const summary = await generateProfessionalSummary(
      currentRole,
      targetRole,
      yearsExperience || '',
      keySkills || [],
      achievements || ''
    );
    
    res.json({ summary });
  } catch (error) {
    handleAiRouteError(error, res);
  }
});

// ==================== INTERVIEW ANSWER ====================
// Frontend Q&A dialog (aiApi.generateInterviewAnswer) posts here; the
// service existed but no route was wired, so generation 404'd.

router.post('/generate-interview-answer', requireAuth, async (req, res) => {
  try {
    const { question, category, jobTitle, jobDescription, jobListingId } = req.body as {
      question?: string;
      category?: string;
      jobTitle?: string;
      jobDescription?: string;
      jobListingId?: string;
    };

    if (!question || !question.trim()) {
      throw new BadRequestError('An interview question is required');
    }

    const validCategories = ['behavioral', 'technical', 'situational', 'general'] as const;
    const safeCategory = validCategories.includes(category as (typeof validCategories)[number])
      ? (category as (typeof validCategories)[number])
      : undefined;

    // The Q&A dialog passes an Application id as jobListingId; resolve the
    // linked job listing for answer context. Unknown ids fall back to generic.
    let title = jobTitle;
    let description = jobDescription;
    if ((!title || !description) && jobListingId) {
      const app = await prisma.application.findFirst({
        where: { id: String(jobListingId), userId: req.user!.id },
        include: { jobListing: true },
      });
      title = title || app?.jobListing?.title;
      description = description || app?.jobListing?.description;
    }

    const answer = await generateInterviewAnswer({
      question,
      category: safeCategory,
      jobTitle: title,
      jobDescription: description,
    });

    res.json({ answer });
  } catch (error) {
    handleAiRouteError(error, res);
  }
});

export default router;
