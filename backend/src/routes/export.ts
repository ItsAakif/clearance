import { Router, Request, Response } from 'express';
import { chromium } from 'playwright';
import { BadRequestError, handleApiError } from '../shared/errors.js';
import { requireAuth } from '../middleware/auth.js';
import HTMLtoDOCX from 'html-to-docx';

const router = Router();

type ExportRequestBody = {
  html?: string;
  documentName?: string;
};

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
