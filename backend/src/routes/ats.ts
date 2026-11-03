// ATS Routes - the DETERMINISTIC SCANNER, now an INTERNAL signal only.
//
// T1110 / T1101. 06 sec. E.6 forbids a universal score, a single number, a letter grade and an
// "ATS 87/100" ANYWHERE, and FREEZE B-17/B-18 keep `ats/scanner.ts` and `ats/atsScorer.ts` as
// deterministic internal signals - "may be computed, never rendered as a verdict". So what changed
// here is ONE thing, applied in every response below:
//
//   THE DERIVED VERDICT IS NOT IN THE RESPONSE. `overallScore` and `status`
//   (`excellent` | `good` | `needs-work` | `poor`) were the 0-100 number and the letter grade.
//   Neither is returned any more. The honest output that remains is what the scanner actually
//   measured and can name: the keywords it FOUND, the keywords it did NOT find, the formatting
//   issues it can point at, and the per-category issue lists. Counts and named items; no number.
//
// WHAT DID NOT CHANGE, and why it matters:
//   - THE SCANNER STILL RUNS, in full, including the `overallScore` computation. It is still
//     persisted to `ATSReport.overallScore` (FREEZE T1101 acceptance: "ATSReport rows are not
//     deleted (historical only)") and to `Resume.lastATSScore`. Storing an internal signal and
//     presenting it are different acts; only the second one is forbidden.
//   - THE SCORER STILL RUNS on `POST /score-job`, in full, and `atsScorer.test.ts` still guards
//     the formula and stays green. What it returns is the rule's HITS - the JD terms the resume
//     carries, the ones it does not, the resume skills the JD asks for, and each factor's own
//     `detail` sentence. It is NOT the weighted total, and it is not the per-factor 0-100 numbers
//     either: a three-factor breakdown is the SAME verdict as the 0-100 average it was folded
//     into, so shipping it was the one place the score was still in an API response.
//   - THE LLM EVALUATION still runs and is still stored on the row exactly as before. Its PROSE is
//     still served - the strengths, the areas for improvement, the reasoning, the per-category
//     evidence - with its numbers stripped by `withoutNumbers`, because a stored `overallScore`
//     nested inside `evaluationJson` is the same verdict at a finer grain, and "it is only a
//     sub-score" is not a distinction E.6 makes.
//
// WHY THE UPLOAD-FREE READ PATHS STAY. These are published routes on a live deployment. Retiring a
// published path is a contract change with a deprecation window; removing a number from a response
// is not. The two are separable, and only the second one is what E.6 forbids.

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
import { scoreResumeAgainstJob, extractJdKeywords } from '../ats/atsScorer.js';

const router = Router();

/**
 * The wire shape of a scan: what was FOUND and what was MISSING, never how good it is.
 *
 * Exported so `routes/ats.retired.test.ts` can assert the members by name rather than by
 * re-typing the object, and so a future response cannot quietly grow a `score` back without the
 * type changing.
 */
export interface AtsScanResponse {
  id: string;
  resumeId: string | null;
  createdAt: Date;
  categories: unknown;
  keywords: { found: string[]; missing: string[] };
  formatting: { isAtsCompatible: boolean; issues: string[] };
  evaluationJson?: LLMEvaluation | null;
  /**
   * How the row was produced. NOT a grade - it says which evaluator ran, nothing about quality.
   *
   * Typed `string | null` rather than a literal union because that is what the column has always
   * carried: `null` on a HISTORICAL row written before it was constrained, and the server has
   * always passed it through rather than defaulting it. Narrowing it here would be an unrelated
   * behaviour change wearing the costume of a score removal.
   */
  scoredBy: string | null;
}

/**
 * The wire shape of `POST /ats/score-job`: the 3-factor rule as NAMES and PROSE.
 *
 * There is deliberately no `score` member and no `overall`. A per-factor 0-100 and the weighted
 * average of three per-factor 0-100s are the same verdict, so shipping the breakdown shipped the
 * score - T1101's acceptance forbids that in an API response, and `cutover-runbook.md` sec. 3 now
 * says so about `/ats/*` as a whole rather than about most of it.
 *
 * What replaced them is the rule's HITS: the JD terms the resume carries and the ones it does not,
 * the candidate's own skills the JD asks for and the ones it does not, and each factor's `detail`
 * sentence - which is the scorer's own count of NAMED things in prose ("3/4 key terms found"), not
 * a grade. A caller gets strictly more to act on and no number to quote.
 */
export interface AtsScoreJobResponse {
  keywordMatch: { detail: string; found: string[]; missing: string[] };
  skillsCoverage: { detail: string; evidenced: string[]; notEvidenced: string[] };
  sectionCompleteness: { detail: string };
  weighting: string;
}

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

/**
 * The INTERNAL result of a scan.
 *
 * `overallScore` and `status` are still computed and still stored - they are the scanner's own
 * output and the historical `ATSReport` columns - but they are NOT members of `AtsScanResponse`,
 * which is what the routes below actually send. Keeping the two types apart is the mechanism: a
 * response cannot leak the verdict because the response type has no field to leak it through, and
 * `routes/ats.retired.test.ts` asserts that by member.
 */
interface ScanResult {
  overallScore: number;
  status: string;
  categories: unknown;
  keywords: unknown;
  formatting: unknown;
  evaluationJson?: LLMEvaluation | null;
  scoredBy: 'llm' | 'rules';
}

/**
 * Drop every NUMBER from a subtree, recursively.
 *
 * This is the mechanical form of the rule, and it is deliberately blunt rather than a list of
 * member names to maintain: the scanner's output contains exactly two kinds of leaf - NAMES (a
 * category label, a keyword, an issue description, a sentence of evaluator reasoning) and NUMBERS
 * (a 0-100 total, a `9/10` sub-score, a `+3 bonus`, a `weight: 55`). Only the numbers are
 * verdicts, so only the numbers go, and a NEW numeric rubric member cannot slip past a list that
 * nobody remembered to extend.
 *
 * What a caller keeps is the part that can be acted on: "Parseability - no contact details were
 * found", "Kubernetes", "Your section headings are not standard". That is the honest output.
 */
function withoutNumbers(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutNumbers);
  if (node && typeof node === 'object') {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === 'number') continue;
      kept[key] = withoutNumbers(value);
    }
    return kept;
  }
  return node;
}

/**
 * Project the internal result onto the wire shape. The ONLY place a scan becomes a response, so a
 * handler cannot assemble one by hand and forget the projection.
 *
 * `categories` and `evaluationJson` both go through `withoutNumbers`: the per-category rubric and
 * the stored LLM evaluation are the SAME verdict at a finer grain (`overallScore`,
 * `score`/`max`, `bonusPoints.total`), and "it is only a sub-score" is not a distinction E.6 makes.
 * Their prose survives - `evidence`, `keyStrengths`, `areasForImprovement`, `reasoning` and every
 * `issues` entry are strings and are returned untouched.
 */
function toWire(result: {
  id: string;
  resumeId?: string | null;
  createdAt: Date;
  categories: unknown;
  keywords: unknown;
  formatting: unknown;
  evaluationJson?: LLMEvaluation | null;
  scoredBy: string | null;
}): AtsScanResponse {
  return {
    id: result.id,
    resumeId: result.resumeId ?? null,
    createdAt: result.createdAt,
    categories: withoutNumbers(result.categories),
    keywords: result.keywords as { found: string[]; missing: string[] },
    formatting: result.formatting as { isAtsCompatible: boolean; issues: string[] },
    evaluationJson: result.evaluationJson ? (withoutNumbers(result.evaluationJson) as LLMEvaluation) : null,
    scoredBy: result.scoredBy,
  };
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

    // No `overallScore`, no `status`: the scan is reported as what it found and what it did not.
    res.status(201).json(toWire({ id: report.id, resumeId: resume.id, createdAt: report.createdAt, ...result }));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== SCORE RESUME AGAINST JOB (3-FACTOR, RM-01) ====================
//
// WHY THE RESPONSE HAS NO NUMBER IN IT. T1101's acceptance is "no UI OR API RESPONSE exposes a
// single score/grade/percentage for resume quality", and this route used to hand the whole
// `ThreeFactorScore` back - `overall` plus three 0-100 factors - which is the verdict at two
// grains. The deterministic scorer is NOT removed (FREEZE B-17: it is an internal signal, and
// `ats/atsScorer.test.ts` still pins the formula); what is removed is its OUTPUT being presented.
// A caller that asks "how does this resume read against this job" is owed the things it can act
// on, and those are all names: which JD terms the resume carries, which it is missing, which of the
// candidate's own skills the JD actually asks for. Counts of named things are what E.6 sanctions;
// a 0-100 is what it forbids.

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

    // The SAME predicates the scorer used, restated so the caller learns WHICH things and not how
    // many: `extractJdKeywords` is the scorer's own tokenizer/dedupe (imported, not re-implemented)
    // and the skills predicate is the scorer's one `jdLower.includes(skill)`.
    const jdKeywords = extractJdKeywords(jobDescription);
    const resumeSkills = (resume.skills as string[]) || [];
    const resumeHaystack = resumeText.toLowerCase();
    const jdHaystack = jobDescription.toLowerCase();
    const presentKeywords = jdKeywords.filter((keyword) => resumeHaystack.includes(keyword));

    const response: AtsScoreJobResponse = {
      keywordMatch: {
        detail: score.keywordMatch.detail,
        found: presentKeywords,
        missing: jdKeywords.filter((keyword) => !presentKeywords.includes(keyword)),
      },
      skillsCoverage: {
        detail: score.skillsCoverage.detail,
        evidenced: resumeSkills.filter((skill) => jdHaystack.includes(skill.toLowerCase())),
        notEvidenced: resumeSkills.filter((skill) => !jdHaystack.includes(skill.toLowerCase())),
      },
      // The scorer's own sentence already NAMES the sections it found (`sections: education,
      // skills`), so there is nothing to add here without re-implementing its presence rules.
      sectionCompleteness: { detail: score.sectionCompleteness.detail },
      weighting: 'keyword match dominates, then skills coverage, then section completeness',
    };

    res.status(200).json(response);
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

    // No `overallScore`, no `status`, same reason.
    res.status(201).json(toWire({ id: report.id, resumeId: null, createdAt: report.createdAt, ...result }));
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

    // A stored row is read back through the same projection, so a HISTORICAL report (which does have
    // an `overallScore` on disk) is served without it.
    res.json(
      toWire({
        id: report.id,
        resumeId: report.resumeId,
        createdAt: report.createdAt,
        categories: report.categories,
        keywords: report.keywords,
        formatting: report.formatting,
        evaluationJson: report.evaluationJson as LLMEvaluation | null,
        scoredBy: report.scoredBy,
      }),
    );
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
    // The SELECT stops at the measured facts: `overallScore` and `status` are not even read off the
    // row, which is stronger than reading them and then dropping them.
    const reports = await prisma.aTSReport.findMany({
      where: { resumeId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        categories: true,
        keywords: true,
        formatting: true,
        evaluationJson: true,
        scoredBy: true
      }
    });

    res.json(
      reports.map((report) =>
        toWire({
          id: report.id,
          resumeId,
          createdAt: report.createdAt,
          categories: report.categories,
          keywords: report.keywords,
          formatting: report.formatting,
          evaluationJson: report.evaluationJson as LLMEvaluation | null,
          scoredBy: report.scoredBy,
        }),
      ),
    );
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== LIST USER'S SAVED SCANS (HISTORY) ====================
router.get('/scans', requireAuth, async (req, res) => {
  try {
    // The history list is a list of SCANS, not a leaderboard: each row is when it ran, what it was and
    // how it was scored - with no number to sort by and no grade to colour it. The rows stay on
    // disk (T1101: "ATSReport rows are not deleted"); they are simply not a scoreboard any more.
    const reports = await prisma.aTSReport.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        resumeId: true,
        createdAt: true,
        scoredBy: true,
        isPublicScan: true,
        fileName: true
      }
    });

    res.json(reports.map((report) => ({
      id: report.id,
      resumeId: report.resumeId,
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