// Career Profile Routes - full career profile + resume-parse prefill.
import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { validateInput, careerProfileSchema, parseProfileSchema, computeProfileComplete } from '../shared/validation.js';
import { parseProfileFromResume } from '../profile/parser.js';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const profile = await prisma.careerProfile.findUnique({ where: { userId: req.user!.id } });
    res.json(profile || null);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.put('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = validateInput(careerProfileSchema, req.body) as any;
    const existing = await prisma.careerProfile.findUnique({ where: { userId: req.user!.id } });
    const profile = existing
      ? await prisma.careerProfile.update({ where: { userId: req.user!.id }, data })
      : await prisma.careerProfile.create({ data: { userId: req.user!.id, ...data } });
    res.json(profile);
  } catch (error) {
    handleApiError(error, res);
  }
});

// Parse an existing resume into suggested profile field values (LLM, BYOK).
router.post('/parse-from-resume/:resumeId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { resumeId } = validateInput(parseProfileSchema, { resumeId: req.params.resumeId });
    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (!resume) throw new NotFoundError('Resume');
    if (resume.userId !== req.user!.id) return res.status(403).json({ error: 'Not your resume' });

    const resumeText = JSON.stringify({
      summary: resume.summary,
      experience: resume.experience,
      education: resume.education,
      skills: resume.skills,
    });

    const result = await parseProfileFromResume(resumeText, req.user!.id);
    res.json(result);
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
