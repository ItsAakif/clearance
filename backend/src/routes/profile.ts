// Career Profile Routes - full career profile + resume-parse prefill.
import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError, BadRequestError } from '../shared/errors.js';
import { validateInput, careerProfileSchema, parseProfileSchema, parseProfileFromUploadedFileSchema, MAX_PROFILE_PARSE_CHARS, computeProfileComplete, serializeLocationPref } from '../shared/validation.js';
import { parseProfileFromResume } from '../profile/parser.js';

const router = Router();

// Only these keys may be written through PUT /profile. Anything else in the
// body (id, userId, createdAt, updatedAt, isComplete, …) is ignored so a
// round-tripped GET response always validates. Unknown keys are stripped by
// the schema as well; this pick is the Prisma-level guarantee.
const EDITABLE_PROFILE_FIELDS = [
  'targetRoles',
  'seniority',
  'minSalary',
  'maxSalary',
  'currency',
  'locationPref',
  'remoteOnly',
  'topSkills',
  'industries',
  'redFlags',
  'proofPoints',
  'summary',
  'parsedFromResumeId',
] as const;

function pickEditableProfileFields(validated: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_PROFILE_FIELDS) {
    const value = validated[key];
    // undefined = absent (leave unchanged on update); null and values pass
    // through — all columns are nullable/optional so no migration needed.
    if (value !== undefined) out[key] = value;
  }
  return out;
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    // The account's person fields live on `User`, not on `CareerProfile`. The Studio's
    // "Sync from profile" action needs the NAME as well as the headline, so the response
    // carries them as additive members; existing clients read the profile fields unchanged.
    const profile = await prisma.careerProfile.findUnique({
      where: { userId: req.user!.id },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!profile) {
      res.json(null);
      return;
    }
    const { user, ...rest } = profile;
    res.json({ ...rest, name: user?.name ?? null, email: user?.email ?? null });
  } catch (error) {
    handleApiError(error, res);
  }
});

router.put('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const validated = validateInput(careerProfileSchema, req.body) as Record<string, unknown>;
    const data = pickEditableProfileFields(validated);
    // ADR-019: the column stays String?. Arrays are stored as a JSON string,
    // blank values become null, plain strings pass through trimmed.
    if ('locationPref' in data) {
      data.locationPref = serializeLocationPref(data.locationPref);
    }
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

// Parse an uploaded file's stored extracted text into suggested profile values (LLM, BYOK).
// Reuses parseProfileFromResume unchanged; no builder resume is created.
router.post('/parse-from-uploaded-file/:fileId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { fileId } = validateInput(parseProfileFromUploadedFileSchema, { fileId: req.params.fileId });
    const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } });
    if (!file) throw new NotFoundError('Uploaded file');
    if (file.userId !== req.user!.id) return res.status(403).json({ error: 'Not your file' });

    const text = file.extractedText ?? '';
    if (!text.trim()) throw new BadRequestError('No text could be extracted from this file');

    const result = await parseProfileFromResume(text.slice(0, MAX_PROFILE_PARSE_CHARS), req.user!.id);
    res.json(result);
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
