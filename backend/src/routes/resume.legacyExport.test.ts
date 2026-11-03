// routes/resume.legacyExport.test.ts - the F10 refusal, as installed on the frozen
// legacy export routes (T1030).
//
// WHY A SEPARATE FILE. `routes/resume.ts` is FROZEN (FREEZE.md sec. 5.1) and carries a
// multer + playwright + docxtemplater import graph, so mounting it in the V2 route suite
// would couple two unrelated concerns. This file mounts the REAL router and asserts only
// the guard's behaviour, which is the part this task changed.
//
// WHAT IS PROVEN:
//   1. BOTH resume-addressed export routes refuse a V2 row with the machine-readable
//      reason - `GET /:id/export/pdf` and `GET /:id/export/docx`;
//   2. BOTH preview routes refuse a preview that NAMES a V2 resume
//      (`POST /export/pdf-preview`, `POST /export/docx-preview`);
//   3. a V1 row still reaches the generator (positive control - "exports exactly as
//      before" is asserted, not assumed);
//   4. a preview that names nothing is unchanged (the legacy builder's previews have
//      never named a resume).
//
// Playwright is mocked so a test can never launch a browser: the guard runs BEFORE the
// generator, so reaching the mock at all would be a failure of the guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockUserId, prismaMocks, chromiumMock } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  prismaMocks: {
    resume: { findUnique: vi.fn(), findMany: vi.fn() },
  },
  chromiumMock: { launch: vi.fn(), pdf: vi.fn() },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('playwright', () => ({
  chromium: {
    launch: chromiumMock.launch,
  },
}));

import legacyResumeRouter from './resume.js';
import { LEGACY_EXPORT_REFUSED_CODE } from '../resume/legacyExportGuard.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/resumes', legacyResumeRouter);
  return app;
}

const V1_ROW = {
  id: 'res-legacy',
  userId: 'user-1',
  modelVersion: 1,
  name: 'Old Resume',
  personalInfo: { fullName: 'Grace Hopper', email: 'g@example.com' },
  summary: 'Invented the compiler.',
  experience: [{ title: 'Rear Admiral', company: 'US Navy', bullets: ['Designed the COBOL compiler'], startDate: '1944', endDate: '1986' }],
  education: [],
  skills: ['COBOL'],
  templateId: 'professional-standard',
  templateSettings: {},
};

const V2_ROW = { ...V1_ROW, id: 'res-v2', modelVersion: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  mockUserId.value = 'user-1';
  prismaMocks.resume.findUnique.mockResolvedValue(V2_ROW);
  chromiumMock.launch.mockResolvedValue({
    newPage: async () => ({ setContent: async () => {}, pdf: chromiumMock.pdf }),
    close: async () => {},
  });
  chromiumMock.pdf.mockResolvedValue(Buffer.from('%PDF-1.4 fake'));
});

describe('F10: a V2 resume is refused by every legacy export route', () => {
  it('GET /:id/export/pdf refuses it, with the reason and the gated path', async () => {
    const res = await request(makeApp()).get('/resumes/res-v2/export/pdf');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(res.body.reason).toBe('V2_RESUME_NOT_EXPORTABLE_THROUGH_LEGACY_PATH');
    expect(res.body.gatedPath).toBe('POST /resumes/:id/render');
    expect(res.body.modelVersion).toBe(2);
    // The guard runs BEFORE the generator: no browser was launched.
    expect(chromiumMock.launch).not.toHaveBeenCalled();
  });

  it('GET /:id/export/docx refuses it, before any template is read', async () => {
    const res = await request(makeApp()).get('/resumes/res-v2/export/docx');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(res.body.gatedPath).toBe('POST /resumes/:id/render');
    expect(chromiumMock.launch).not.toHaveBeenCalled();
  });

  it('POST /export/pdf-preview refuses a preview that NAMES a V2 resume', async () => {
    const res = await request(makeApp())
      .post('/resumes/export/pdf-preview')
      .send({ resumeId: 'res-v2', sections: { header: { entries: [{ fullName: 'Ada' }] } } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(res.body.reason).toBe('V2_RESUME_NOT_EXPORTABLE_THROUGH_LEGACY_PATH');
    expect(chromiumMock.launch).not.toHaveBeenCalled();
  });

  it('POST /export/docx-preview refuses a preview that NAMES a V2 resume', async () => {
    const res = await request(makeApp())
      .post('/resumes/export/docx-preview')
      // An unknown templateId would be a 404 if the guard did not run first, so the
      // template lookup is part of what "the guard runs first" means.
      .send({ resumeId: 'res-v2', templateId: 'does-not-exist', sections: {} });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
  });
});

describe('F10 positive control: a legacy (v1) resume exports EXACTLY as before', () => {
  it('GET /:id/export/pdf still reaches the generator and returns a PDF', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue(V1_ROW);
    const res = await request(makeApp()).get('/resumes/res-legacy/export/pdf');
    // The control that makes every refusal above meaningful: without it, a guard that
    // refused EVERYTHING would pass this suite.
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toContain('Old Resume.pdf');
    expect(chromiumMock.launch).toHaveBeenCalledTimes(1);
  });

  it('a preview that names NO resume is unchanged (the legacy builder never named one)', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue(V1_ROW);
    const res = await request(makeApp())
      .post('/resumes/export/pdf-preview')
      .send({ sections: { header: { entries: [{ fullName: 'Grace' }] } } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    // The guard did not even need to look anything up: an unattributed preview is not a
    // V2 document.
    expect(prismaMocks.resume.findUnique).not.toHaveBeenCalled();
  });

  it('a preview naming a V1 resume is unchanged', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue(V1_ROW);
    const res = await request(makeApp())
      .post('/resumes/export/pdf-preview')
      .send({ resumeId: 'res-legacy', sections: { header: { entries: [{ fullName: 'Grace' }] } } });
    expect(res.status).toBe(200);
    // It WAS looked up - the guard checks, finds V1, and lets it through.
    expect(prismaMocks.resume.findUnique).toHaveBeenCalled();
  });

  it('ownership is still enforced, and an unknown resume is still a 404', async () => {
    // The guard must not have displaced the existing 404/403 behaviour on the same routes.
    prismaMocks.resume.findUnique.mockResolvedValue(null);
    expect((await request(makeApp()).get('/resumes/nope/export/pdf')).status).toBe(404);

    prismaMocks.resume.findUnique.mockResolvedValue({ ...V2_ROW, userId: 'user-2' });
    expect((await request(makeApp()).get('/resumes/res-v2/export/pdf')).status).toBe(403);
    // ...and the refusal is NOT reached before the ownership check, so it cannot be used
    // to probe another tenant's `modelVersion`.
    expect(chromiumMock.launch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// N7: the PREVIEW routes must do the ownership check their twin does
// ---------------------------------------------------------------------------

describe('N7: the preview routes are not a cross-tenant probe', () => {
  // `routes/export.ts`'s `refuseIfV2ResumeNamed` has always called `ensureOwnership`
  // before writing the refusal. `routes/resume.ts`'s `legacyPreviewGuard` did not, so on
  // the two preview routes a caller could name another tenant's resume and read a 409
  // body carrying that row's `modelVersion` - learning exactly the fact the guard exists
  // to protect. Both now check ownership first.

  it('POST /export/pdf-preview 403s another tenant resumeId and echoes no modelVersion', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue({ ...V2_ROW, userId: 'user-2' });
    const res = await request(makeApp())
      .post('/resumes/export/pdf-preview')
      .send({ resumeId: 'res-v2', sections: { header: { entries: [{ fullName: 'Ada' }] } } });
    expect(res.status).toBe(403);
    // The refusal body is never reached, so the one field it carries is never disclosed.
    expect(res.body.code).not.toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(res.body.modelVersion).toBeUndefined();
    expect(chromiumMock.launch).not.toHaveBeenCalled();
  });

  it('POST /export/docx-preview 403s another tenant resumeId and echoes no modelVersion', async () => {
    prismaMocks.resume.findUnique.mockResolvedValue({ ...V2_ROW, userId: 'user-2' });
    const res = await request(makeApp())
      .post('/resumes/export/docx-preview')
      .send({ resumeId: 'res-v2', templateId: 'does-not-exist', sections: {} });
    expect(res.status).toBe(403);
    expect(res.body.code).not.toBe(LEGACY_EXPORT_REFUSED_CODE);
    expect(res.body.modelVersion).toBeUndefined();
  });

  it('the OWNER of a V2 resume still gets the full refusal on the preview routes', async () => {
    // The positive control that makes the two 403s above meaningful: a guard that refused
    // every preview would pass them, and would break the legacy builder.
    prismaMocks.resume.findUnique.mockResolvedValue(V2_ROW);
    const res = await request(makeApp())
      .post('/resumes/export/pdf-preview')
      .send({ resumeId: 'res-v2', sections: { header: { entries: [{ fullName: 'Ada' }] } } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LEGACY_EXPORT_REFUSED_CODE);
    // ...and the OWNER does get the modelVersion, because the refusal is a policy message
    // to a party who is entitled to the fact.
    expect(res.body.modelVersion).toBe(2);
  });

  it('an UNAUTHORISED V1 resume also 403s, before the version is even consulted', async () => {
    // The check is ownership, not "is it V2": a V1 row belongs to its owner just as much,
    // and answering 409 for one and 403 for the other is exactly the oracle.
    prismaMocks.resume.findUnique.mockResolvedValue({ ...V1_ROW, userId: 'user-2' });
    const res = await request(makeApp())
      .post('/resumes/export/pdf-preview')
      .send({ resumeId: 'res-legacy', sections: { header: { entries: [{ fullName: 'Ada' }] } } });
    expect(res.status).toBe(403);
    expect(chromiumMock.launch).not.toHaveBeenCalled();
  });
});
