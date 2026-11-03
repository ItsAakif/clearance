// Job Match Routes - keyword matching, now reported as NAMED GAPS rather than a percentage.
//
// T1110 / T1101. 06 sec. E.6 forbids presenting a single derived number; FREEZE B-16 keeps
// `evaluation/matcher.ts` "as deterministic internal signals" and says `matcher.matchScore` "becomes
// an internal keyword signal, never a user-facing number". That is exactly what this file now
// does:
//
//   `matchScore` IS STILL COMPUTED AND STILL STORED. `evaluation/matcher.ts` is C-11 "DO NOT TOUCH"
//   and its formula, its clamping and its whole test suite are untouched. The row keeps its
//   `matchScore` column (prisma is out of scope for this task and T1101 says rows are historical
//   only). What changed is that it is no longer in any RESPONSE.
//
//   THE RESPONSE IS THE HONEST ONE: which keywords MATCHED, which are CRITICAL-missing, which are
//   PREFERRED-missing, plus the role the description looks like and the suggestions for it. Every
//   one of those is a NAME. A caller can read "Kubernetes is a required skill you have not shown"
//   and act on it; it cannot read "68%" and act on nothing.
//
//   The V2 evidence-level report at `POST /jobs/:id/match` (T1070) is the successor for a user who
//   wants the requirement-by-requirement view with Confirm/Reject. This surface stays because it
//   takes a raw pasted description and a raw uploaded file, which the V2 route does not.

import { Router } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError, BadRequestError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, jobMatchSchema } from '../shared/validation.js';
import { enhanceMatchWithLLM } from '../ats/matchEnhancer.js';
import {
  extractJobTitle,
  getResumeText,
  matchResumeToJob,
} from '../evaluation/matcher.js';
import type { ResumeData } from '../evaluation/matcher.js';

// Re-export the extracted scoring surface so any existing deep importer of
// this route module keeps working. The single `matchScore` computation lives
// in `../evaluation/matcher.ts`.
export {
  extractJobRequirements,
  extractJobTitle,
  extractKeywords,
  generateSuggestions,
  getResumeText,
  jobMentions,
  keywordsMatch,
  labelRole,
  matchResumeToJob,
  normalizeKeyword,
  normalizeText,
  resumeMentions,
} from '../evaluation/matcher.js';
export type { MatchResult, ResumeData } from '../evaluation/matcher.js';

const router = Router();

// ==================== ROUTES ====================

router.post('/', requireAuth, async (req, res) => {
  try {
    const { resumeId, uploadedFileId, jobDescription } = validateInput(jobMatchSchema, req.body);

    if (!resumeId && !uploadedFileId) {
      throw new BadRequestError('Either resumeId or uploadedFileId is required');
    }

    let resumeData: ResumeData | null = null;
    let resumeIdForMatch: string | null = null;
    let uploadedFileIdForMatch: string | null = null;

    if (resumeId) {
      const resume = await prisma.resume.findUnique({
        where: { id: resumeId }
      });
      if (!resume) {
        throw new NotFoundError('Resume');
      }
      await ensureOwnership(req.user!.id, resume.userId, 'Resume');

      resumeData = {
        personalInfo: resume.personalInfo as any,
        summary: resume.summary,
        experience: resume.experience as any[] || [],
        education: resume.education as any[] || [],
        skills: resume.skills as string[] || []
      };
      resumeIdForMatch = resume.id;
    } else if (uploadedFileId) {
      // Raw uploaded file: match its deterministic extracted text against the JD.
      // Never parsed into a structured builder resume.
      const file = await prisma.uploadedFile.findUnique({ where: { id: uploadedFileId } });
      if (!file) {
        throw new NotFoundError('Uploaded file');
      }
      await ensureOwnership(req.user!.id, file.userId, 'Uploaded file');

      resumeData = {
        personalInfo: { fullName: '', email: '', phone: '', location: '' },
        summary: file.extractedText || '',
        experience: [],
        education: [],
        skills: []
      };
      uploadedFileIdForMatch = file.id;
    }

    const matchResult = matchResumeToJob(resumeData!, jobDescription);
    const jobTitle = extractJobTitle(jobDescription);

    // Optional LLM tailoring tips (best-effort; never blocks the result).
    const resumeTextForLLM = getResumeText(resumeData!);
    const tailoringTips = await enhanceMatchWithLLM(
      resumeTextForLLM,
      jobDescription,
      [...matchResult.criticalMissing, ...matchResult.preferredMissing]
    ).catch(() => undefined);

    const jobMatch = await prisma.jobMatch.create({
      data: {
        resumeId: resumeIdForMatch,
        uploadedFileId: uploadedFileIdForMatch,
        userId: req.user!.id,
        jobDescription,
        jobTitle,
        matchScore: matchResult.matchScore,
        matchedKeywords: matchResult.matchedKeywords,
        missingKeywords: matchResult.missingKeywords,
        suggestions: matchResult.suggestions,
        detectedRole: matchResult.detectedRole,
        criticalMissing: matchResult.criticalMissing,
        preferredMissing: matchResult.preferredMissing,
        roleSuggestions: matchResult.roleSuggestions,
        tailoringTips: tailoringTips ?? []
      }
    });

    res.status(201).json({
      id: jobMatch.id,
      resumeId: jobMatch.resumeId,
      uploadedFileId: jobMatch.uploadedFileId,
      jobDescription: jobMatch.jobDescription.substring(0, 500) + '...',
      // No `matchScore`. Everything below is a name or a list of names.
      matchedKeywords: matchResult.matchedKeywords,
      missingKeywords: matchResult.missingKeywords,
      suggestions: matchResult.suggestions,
      detectedRole: matchResult.detectedRole,
      criticalMissing: matchResult.criticalMissing,
      preferredMissing: matchResult.preferredMissing,
      roleSuggestions: matchResult.roleSuggestions,
      tailoringTips: tailoringTips ?? [],
      createdAt: jobMatch.createdAt
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// List all stored job match scans for the authenticated user (most recent first).
// The SELECT stops at the names: `matchScore` is not read off the row at all, which is stronger
// than reading it and dropping it from the payload.
router.get('/', requireAuth, async (req, res) => {
  try {
    const matches = await prisma.jobMatch.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        resumeId: true,
        jobTitle: true,
        detectedRole: true,
        createdAt: true,
      },
    });

    res.json({ matches });
  } catch (error) {
    handleApiError(error, res);
  }
});

router.get('/:matchId', requireAuth, async (req, res) => {
  try {
    const { matchId } = req.params;

    const jobMatch = await prisma.jobMatch.findUnique({
      where: { id: matchId }
    });

    if (!jobMatch) {
      throw new NotFoundError('Job Match');
    }

    await ensureOwnership(req.user!.id, jobMatch.userId, 'Job Match');

    res.json({
      id: jobMatch.id,
      resumeId: jobMatch.resumeId,
      jobDescription: jobMatch.jobDescription,
      jobTitle: jobMatch.jobTitle,
      // No `matchScore`, on a stored row either: a historical match is read back as names.
      matchedKeywords: jobMatch.matchedKeywords,
      missingKeywords: jobMatch.missingKeywords,
      suggestions: jobMatch.suggestions,
      detectedRole: jobMatch.detectedRole,
      criticalMissing: jobMatch.criticalMissing,
      preferredMissing: jobMatch.preferredMissing,
      roleSuggestions: jobMatch.roleSuggestions,
      tailoringTips: jobMatch.tailoringTips,
      createdAt: jobMatch.createdAt
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
