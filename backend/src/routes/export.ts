import { Router, Request, Response } from 'express';
import { chromium } from 'playwright';
import { BadRequestError, handleApiError } from '../shared/errors.js';
import { requireAuth } from '../middleware/auth.js';
import { ensureOwnership } from '../shared/auth.js';
import prisma from '../lib/prisma.js';
// T1030 F10: the V2 cutover guard. Frozen file, see resume/legacyExportGuard.ts.
import {
  LEGACY_EXPORT_REFUSED_STATUS,
  isClearanceControlled,
  legacyExportRefusal,
} from '../resume/legacyExportGuard.js';
import HTMLtoDOCX from 'html-to-docx';

const router = Router();

type ExportRequestBody = {
  html?: string;
  documentName?: string;
  /**
   * The resume this HTML was rendered FROM, when the caller knows it.
   *
   * Added by T1030 F10, not as a feature: it is the attribution the V2 refusal needs.
   * A V2 resume is under clearance control, so its HTML may only be produced by the
   * gated renderer; if a caller names a V2 resume here, the conversion is refused with
   * the gated path in the body. Omitting it is not an escape hatch for a V2 document -
   * there is no V2 HTML to convert until the gated renderer exists (T1042) - and the
   * legacy HTML-template fallback is explicitly kept (FREEZE.md K-01) for V1 rows.
   */
  resumeId?: string;
};

/**
 * T1030 F10. Refuses a conversion of a V2 resume's rendered HTML, before Chromium is
 * launched and before `html-to-docx` is called.
 *
 * Same ATTRIBUTION rule as the `*-preview` routes and for the same reason: these
 * endpoints take HTML, not a resume, so a refusal can only key on a resume the caller
 * names. Unattributed HTML is not a V2 artifact - the gated renderer does not exist yet
 * and this is the documented HTML fallback - so it is left working.
 */
async function refuseIfV2ResumeNamed(req: Request, res: Response): Promise<boolean> {
  const resumeId = (req.body as ExportRequestBody | undefined)?.resumeId;
  if (typeof resumeId !== 'string' || resumeId.length === 0) return false;
  const resume = await prisma.resume.findUnique({
    where: { id: resumeId },
    select: { id: true, userId: true, modelVersion: true },
  });
  if (!resume || !isClearanceControlled(resume)) return false;
  await ensureOwnership(req.user!.id, resume.userId, 'Resume');
  res.status(LEGACY_EXPORT_REFUSED_STATUS).json(legacyExportRefusal(resume));
  return true;
}

function ensureHtmlDocument(html: string): string {
  if (/<html[\s>]/i.test(html)) {
    return html;
  }

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        @page { size: Letter; margin: 0; }
        html, body { margin: 0; padding: 0; background: #ffffff; }
        body { font-family: "Segoe UI", Arial, sans-serif; }
      </style>
    </head>
    <body>${html}</body>
  </html>`;
}

function sanitizeDocumentName(documentName?: string, fallback = 'resume'): string {
  return (documentName || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
}

function parseExportRequest(req: Request): { html: string; documentName: string } {
  const { html, documentName } = req.body as ExportRequestBody;

  if (!html || typeof html !== 'string' || html.trim().length === 0) {
    throw new BadRequestError('html is required');
  }

  return {
    html: ensureHtmlDocument(html),
    documentName: sanitizeDocumentName(documentName),
  };
}

router.post('/html-to-pdf', requireAuth, async (req: Request, res: Response) => {
  try {
    // T1030 F10: the refusal runs before `parseExportRequest`, so a V2 resume is refused
    // even if its body is otherwise malformed - the gate does not depend on the rest of
    // the request being well-formed.
    if (await refuseIfV2ResumeNamed(req, res)) return;
    const { html, documentName } = parseExportRequest(req);

    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${documentName}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/html-to-docx', requireAuth, async (req: Request, res: Response) => {
  try {
    if (await refuseIfV2ResumeNamed(req, res)) return; // T1030 F10
    const { html, documentName } = parseExportRequest(req);
    const buffer = await HTMLtoDOCX(html, null, {
      table: { row: { cantSplit: true } },
      footer: false,
      pageNumber: false,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${documentName}.docx"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
