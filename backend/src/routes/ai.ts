// AI Routes - Resume Generation, Improvement, etc.
// Per security.md: Validate input

import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, ForbiddenError, BadRequestError } from '../shared/errors.js';
import { generateResumeFromInput, improveResumeBullet, generateProfessionalSummary, buildResumeFromJobDescription, AIGuidedInput } from '../ai/resumeGenerator.js';

const router = Router();

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
    handleApiError(error, res);
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
    handleApiError(error, res);
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
    handleApiError(error, res);
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
    handleApiError(error, res);
  }
});

export default router;
