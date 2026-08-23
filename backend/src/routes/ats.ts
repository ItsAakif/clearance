// ATS Routes - Resume scanning endpoints
// Per security.md: Rate limit public endpoints, validate ownership

import { Router } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError, BadRequestError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import { validateInput, scanResumeSchema, scoreJobSchema } from '../shared/validation.js';
import { scanResumeContent, scanRawText, type ResumeData, type ATSScanResult } from '../ats/scanner.js';
import { parseUploadedResume, extractRawText } from '../resume/parser.js';
import { evaluateResumeWithLLM, hasLlmKey, type LLMEvaluation } from '../ats/llmEvaluator.js';
import { scoreResumeAgainstJob } from '../ats/atsScorer.js';

const router = Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a PDF or DOCX file.'));
    }
  }
});

// ==================== HELPERS ====================

interface ScanResult {
  overallScore: number;
  status: string;
  categories: unknown;
  keywords: unknown;
  formatting: unknown;
  evaluationJson?: LLMEvaluation | null;
  scoredBy: 'llm' | 'rules';
}

function buildScanResultFromRules(scanResult: ATSScanResult): ScanResult {
  return {
    overallScore: scanResult.overallScore,
    status: scanResult.status,
    categories: JSON.parse(JSON.stringify(scanResult.categories)),
    keywords: scanResult.keywords,
    formatting: scanResult.formatting,
    evaluationJson: null,
    scoredBy: 'rules',
  };
}

async function scanWithLLM(resumeData: ResumeData | { rawText: string }, userId?: string): Promise<ScanResult | null> {
  // Guard: don't waste an LLM call on effectively-empty input (e.g. a PDF the
  // parser couldn't extract text from). The deterministic rules scan handles that.
  const isEmpty = 'rawText' in resumeData
    ? resumeData.rawText.trim().length === 0
    : (
        !resumeData.personalInfo?.email &&
        !resumeData.personalInfo?.phone &&
        resumeData.experience.length === 0 &&
        resumeData.skills.length === 0 &&
        (!resumeData.summary || resumeData.summary.trim().length === 0)
      );
  if (isEmpty) return null;

  try {
    const hasKey = await hasLlmKey(userId);
    if (!hasKey) return null;
    const evaluation = await evaluateResumeWithLLM(resumeData, userId);

    // Always compute the deterministic rules scan so real ATS signals
    // (parseability, action verbs, keywords, contact info, completeness)
    // are available to the frontend even when the LLM scores the resume.
    let rulesResult: ATSScanResult | null = null;
    if (!('rawText' in resumeData)) {
      rulesResult = scanResumeContent(resumeData);
    }

    return {
      overallScore: evaluation.overallScore,
      status: evaluation.status,
      categories: JSON.parse(JSON.stringify(evaluation.categories)),
      keywords: rulesResult
        ? { found: rulesResult.keywords.found, missing: rulesResult.keywords.missing }
        : { found: [], missing: [] },
      formatting: rulesResult
        ? { isAtsCompatible: rulesResult.formatting.isAtsCompatible, issues: rulesResult.formatting.issues }
        : { isAtsCompatible: true, issues: [] },
      evaluationJson: evaluation,
      scoredBy: 'llm',
    };
  } catch {
    return null;
  }
}

// ==================== SCAN EXISTING RESUME ====================
router.post('/scan/:resumeId', requireAuth, async (req, res) => {
  try {
    const { resumeId } = req.params;

    // Validate input
    validateInput(scanResumeSchema, { resumeId });

    // Fetch resume
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId }
    });

    if (!resume) {
      throw new NotFoundError('Resume');
    }

    // Enforce ownership
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    // Prepare resume data for scanning
    const resumeData: ResumeData = {
      personalInfo: resume.personalInfo as any,
      summary: resume.summary,
      experience: resume.experience as any[] || [],
      education: resume.education as any[] || [],
      skills: resume.skills as string[] || []
    };

    // Try LLM evaluation first; fallback to rules
    const llmResult = await scanWithLLM(resumeData, req.user!.id);
    const result = llmResult || buildScanResultFromRules(scanResumeContent(resumeData));

    // Save report to database
    const report = await prisma.aTSReport.create({
      data: {
        resumeId: resume.id,
        userId: req.user!.id,
        overallScore: result.overallScore,
        status: result.status,
        categories: result.categories as any,
        keywords: result.keywords as any,
        formatting: result.formatting as any,
        evaluationJson: result.evaluationJson as any,
        scoredBy: result.scoredBy,
        isPublicScan: false
      }
    });

    // Update resume with latest ATS score
    await prisma.resume.update({
      where: { id: resume.id },
      data: { lastATSScore: result.overallScore }
    });

    res.status(201).json({
      id: report.id,
      resumeId: resume.id,
      overallScore: result.overallScore,
      status: result.status,
      createdAt: report.createdAt,
      categories: result.categories,
      keywords: result.keywords,
      formatting: result.formatting,
      evaluationJson: result.evaluationJson,
      scoredBy: result.scoredBy
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== SCORE RESUME AGAINST JOB (3-FACTOR, RM-01) ====================
router.post('/score-job', requireAuth, async (req, res) => {
  try {
    const { resumeId, jobDescription } = validateInput(scoreJobSchema, req.body);
    const resume = await prisma.resume.findUnique({ where: { id: resumeId } });
    if (!resume) throw new NotFoundError('Resume');
    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    const resumeText = [
      resume.summary,
      ...((resume.experience as any[]) || []).flatMap((e: any) => [e.title, e.company, ...(e.bullets || [])]),
      ...((resume.education as any[]) || []).flatMap((e: any) => [e.degree, e.institution]),
      ...(resume.skills as string[] || []),
    ].filter(Boolean).join(' ');

    const score = scoreResumeAgainstJob({
      resumeText,
      skills: (resume.skills as string[]) || [],
      jd: jobDescription,
    });
    res.status(200).json(score);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== PUBLIC SCAN (OPTIONAL AUTH) ====================
router.post('/scan-public', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      throw new BadRequestError('No file uploaded');
    }

    // Validate file size
    const MAX_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      throw new BadRequestError('File too large. Maximum size is 5MB.');
    }

    // Create hash of file for tracking (no PII stored)
    const fileHash = crypto
      .createHash('sha256')
      .update(file.buffer)
      .digest('hex')
      .substring(0, 32);

    // Parse the uploaded file (always get raw text for fallback)
    const parsedData = await parseUploadedResume(file.buffer, file.mimetype);

    const resumeData: ResumeData = {
      personalInfo: parsedData.personalInfo || {
        fullName: '',
        email: '',
        phone: '',
        location: ''
      },
      summary: parsedData.summary || '',
      experience: parsedData.experience || [],
      education: parsedData.education || [],
      skills: parsedData.skills || []
    };

    // Try LLM evaluation with full raw text (best for PDFs that parse poorly)
    let result: ScanResult | null = null;
    if (parsedData.rawText && parsedData.rawText.trim().length > 0) {
      result = await scanWithLLM({ rawText: parsedData.rawText });
    }

    if (!result) {
      result = await scanWithLLM(resumeData);
    }

    if (!result) {
      result = buildScanResultFromRules(
        parsedData.rawText
          ? scanRawText(parsedData.rawText)
          : scanResumeContent(resumeData)
      );
    }

    // Save report (associate with user when logged in so it appears in their history)
    const report = await prisma.aTSReport.create({
      data: {
        resumeId: null,
        userId: req.user!.id,
        overallScore: result.overallScore,
        status: result.status,
        categories: result.categories as any,
        keywords: result.keywords as any,
        formatting: result.formatting as any,
        evaluationJson: result.evaluationJson as any,
        scoredBy: result.scoredBy,
        isPublicScan: false,
        uploadedFileHash: fileHash,
        fileName: file.originalname
      }
    });

    res.status(201).json({
      id: report.id,
      overallScore: result.overallScore,
      status: result.status,
      createdAt: report.createdAt,
      categories: result.categories,
      keywords: result.keywords,
      formatting: result.formatting,
      evaluationJson: result.evaluationJson,
      scoredBy: result.scoredBy
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET ATS REPORT ====================
router.get('/reports/:reportId', requireAuth, async (req, res) => {
  try {
    const { reportId } = req.params;

    const report = await prisma.aTSReport.findUnique({
      where: { id: reportId }
    });

    if (!report) {
      throw new NotFoundError('ATS Report');
    }

    // For non-public scans, enforce ownership
    if (!report.isPublicScan && report.userId) {
      await ensureOwnership(req.user!.id, report.userId, 'ATS Report');
    }

    res.json({
      id: report.id,
      resumeId: report.resumeId,
      overallScore: report.overallScore,
      status: report.status,
      createdAt: report.createdAt,
      categories: report.categories,
      keywords: report.keywords,
      formatting: report.formatting,
      evaluationJson: report.evaluationJson,
      scoredBy: report.scoredBy
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GET RESUME'S ATS REPORTS ====================
router.get('/resume/:resumeId/reports', requireAuth, async (req, res) => {
  try {
    const { resumeId } = req.params;

    // Verify resume exists and user owns it
    const resume = await prisma.resume.findUnique({
      where: { id: resumeId },
      select: { userId: true }
    });

    if (!resume) {
      throw new NotFoundError('Resume');
    }

    await ensureOwnership(req.user!.id, resume.userId, 'Resume');

    // Get all reports for this resume
    const reports = await prisma.aTSReport.findMany({
      where: { resumeId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        overallScore: true,
        status: true,
        createdAt: true,
        categories: true,
        keywords: true,
        formatting: true,
        evaluationJson: true,
        scoredBy: true
      }
    });

    res.json(reports.map(report => ({
      id: report.id,
      resumeId,
      overallScore: report.overallScore,
      status: report.status,
      createdAt: report.createdAt,
      categories: report.categories,
      keywords: report.keywords,
      formatting: report.formatting,
      evaluationJson: report.evaluationJson,
      scoredBy: report.scoredBy
    })));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== LIST USER'S SAVED SCANS (HISTORY) ====================
router.get('/scans', requireAuth, async (req, res) => {
  try {
    const reports = await prisma.aTSReport.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        resumeId: true,
        overallScore: true,
        status: true,
        createdAt: true,
        scoredBy: true,
        isPublicScan: true,
        fileName: true
      }
    });

    res.json(reports.map((report) => ({
      id: report.id,
      resumeId: report.resumeId,
      overallScore: report.overallScore,
      status: report.status,
      createdAt: report.createdAt,
      scoredBy: report.scoredBy,
      isPublicScan: report.isPublicScan,
      fileName: report.fileName
    })));
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;