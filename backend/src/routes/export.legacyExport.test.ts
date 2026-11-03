// routes/export.legacyExport.test.ts - the F10 refusal on the two HTML conversion routes
// (T1030; FREEZE.md K-01, the HTML-template fallback kept indefinitely).
//
// THE SHAPE OF THE RULE HERE IS DIFFERENT, AND THE DIFFERENCE IS THE POINT. These routes
// take HTML, not a resume: there is no `Resume` row in the path and none in the body. So
// the refusal can only key on a resume the CALLER NAMES (`resumeId`). An unattributed
// conversion is not a V2 artifact - there is no V2 rendered HTML until the gated renderer
// exists (T1042) - and refusing it would break the documented HTML fallback for every
// user including the ones on V1 rows.
//
// So: named V2 -> refused with the machine-readable reason; named V1 -> unchanged; named
// nothing -> unchanged, and provably not even looked up. That is the residual, stated in
// the test rather than buried in a comment.
//
// `chromium` and `html-to-docx` are both mocked, so a test can never launch a browser or
// shell out. Reaching either mock is a failure of "the guard runs first".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockUserId, prismaMocks, chromiumMock, htmlToDocxMock } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  prismaMocks: {
    resume: { findUnique: vi.fn(), findMany: vi.fn() },
  },
  chromiumMock: { launch: vi.fn(), pdf: vi.fn() },
  htmlToDocxMock: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('playwright', () => ({ chromium: { launch: chromiumMock.launch } }));

vi.mock('html-to-docx', () => ({ default: htmlToDocxMock }));

import exportRouter from './export.js';
import { LEGACY_EXPORT_REFUSED_CODE } from '../resume/legacyExportGuard.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/export', exportRouter);
  return app;
}

const V2_ROW = { id: 'res-v2', userId: 'user-1', modelVersion: 2 };
const V1_ROW = { id: 'res-legacy', userId: 'user-1', modelVersion: 1 };
const HTML = '<h1>Grace Hopper</h1>';

beforeEach(() => {
  vi.clearAllMocks();
  mockUserId.value = 'user-1';
  prismaMocks.resume.findUnique.mockResolvedValue(V2_ROW);
  chromiumMock.launch.mockResolvedValue({
    newPage: async () => ({ setContent: async () => {}, pdf: chromiumMock.pdf }),
    close: async () => {},
  });
  chromiumMock.pdf.mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
  htmlToDocxMock.mockResolvedValue(Buffer.from('fake-docx'));
});

describe('F10: html-to-pdf and html-to-docx refuse a V2 resume', () => {
  it('POST /export/html-to-pdf refuses it, before Chromium is launched', async () => {
    const res = await request(makeApp())
      .post('/export/html-to-pdf')
      .send({ resumeId: 'res-v2', html: HTML, documentName: 'resume' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(res.body.reason).toBe('V2_RESUME_NOT_EXPORTABLE_THROUGH_LEGACY_PATH');
    expect(res.body.gatedPath).toBe('POST /resumes/:id/render');
    expect(chromiumMock.launch).not.toHaveBeenCalled();
  });

  it('POST /export/html-to-docx refuses it, before html-to-docx is called', async () => {
    const res = await request(makeApp())
      .post('/export/html-to-docx')
      .send({ resumeId: 'res-v2', html: HTML, documentName: 'resume' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(htmlToDocxMock).not.toHaveBeenCalled();
  });

  it('the refusal runs BEFORE body validation, so a malformed body cannot slip past it', async () => {
    // No `html` at all: without the guard this is a 400 ("html is required"). The V2
    // refusal is not conditional on the rest of the request being well-formed.
    const res = await request(makeApp())
      .post('/export/html-to-pdf')
      .send({ resumeId: 'res-v2' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
  });

  it('ownership is still enforced, so the refusal is not a cross-tenant probe', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue({ ...V2_ROW, userId: 'user-2' });
    const res = await request(makeApp())
      .post('/export/html-to-pdf')
      .send({ resumeId: 'res-v2', html: HTML });
    expect(res.status).toBe(403);
    // N7: the refusal body carries `modelVersion`, and it must never reach a non-owner -
    // otherwise a 403 vs 409 tells them the row exists and which version it is. These
    // two routes already had the check; the assertion is here so the guarantee is stated
    // on BOTH twins rather than assumed from the other one.
    expect(res.body.code).not.toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(res.body.modelVersion).toBeUndefined();
    expect(chromiumMock.launch).not.toHaveBeenCalled();
  });

  it('html-to-docx 403s another tenant too, with no modelVersion in the body', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue({ ...V2_ROW, userId: 'user-2' });
    const res = await request(makeApp())
      .post('/export/html-to-docx')
      .send({ resumeId: 'res-v2', html: HTML });
    expect(res.status).toBe(403);
    expect(res.body.modelVersion).toBeUndefined();
    expect(htmlToDocxMock).not.toHaveBeenCalled();
  });
});

describe('F10 positive control: unattributed and V1 conversions are unchanged', () => {
  it('html-to-pdf with NO resumeId still converts (the documented HTML fallback)', async () => {
    // Without this, a guard that refused everything would pass the refusals above.
    const res = await request(makeApp())
      .post('/export/html-to-pdf')
      .send({ html: HTML, documentName: 'resume' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    // The guard did not even look anything up.
    expect(prismaMocks.resume.findUnique).not.toHaveBeenCalled();
  });

  it('html-to-docx with NO resumeId still converts', async () => {
    const res = await request(makeApp())
      .post('/export/html-to-docx')
      .send({ html: HTML, documentName: 'resume' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/wordprocessingml/);
    expect(prismaMocks.resume.findUnique).not.toHaveBeenCalled();
  });

  it('a V1 resumeId is looked up and allowed through', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue(V1_ROW);
    const res = await request(makeApp())
      .post('/export/html-to-pdf')
      .send({ resumeId: 'res-legacy', html: HTML, documentName: 'resume' });
    expect(res.status).toBe(200);
    // It WAS looked up - the guard checked, found V1, and let it through.
    expect(prismaMocks.resume.findUnique).toHaveBeenCalled();
  });

  it('an UNKNOWN resumeId is not a refusal - the legacy builder never named one', async () => {
    // Stated residual: an unrecognised id is treated as "not using the V2 attribution",
    // not as a 404. Inventing a 404 here would be a behaviour change to a kept-forever
    // route rather than a safety refusal.
    prismaMocks.resume.findUnique.mockResolvedValue(null);
    const res = await request(makeApp())
      .post('/export/html-to-pdf')
      .send({ resumeId: 'never-heard-of-it', html: HTML });
    expect(res.status).toBe(200);
  });
});
