import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks } = vi.hoisted(() => ({
  authState: { enabled: true, userId: 'user-1' },
  prismaMocks: {
    uploadedFile: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.enabled) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { id: authState.userId, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: prismaMocks,
  default: prismaMocks,
}));

vi.mock('../resume/parser.js', () => ({
  extractRawText: vi.fn(),
  validateUploadedFile: vi.fn(),
}));

import uploadedFilesRouter, { MAX_EXTRACTED_TEXT_CAP } from './uploaded-files.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', uploadedFilesRouter);
  return app;
}

const BYTES = Buffer.from('%PDF-1.4 fake');

function ownedFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    userId: 'user-1',
    fileName: 'resume.pdf',
    fileType: 'application/pdf',
    fileBytes: BYTES,
    extractedText: 'hello world',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('uploaded-files view/text endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.enabled = true;
    authState.userId = 'user-1';
  });

  it('exports the 200000-char text cap', () => {
    expect(MAX_EXTRACTED_TEXT_CAP).toBe(200_000);
  });

  it('returns 401 unauthenticated for /view and /text', async () => {
    authState.enabled = false;
    expect((await request(makeApp()).get('/file-1/view')).status).toBe(401);
    expect((await request(makeApp()).get('/file-1/text')).status).toBe(401);
    expect(prismaMocks.uploadedFile.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown id on /view and /text', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(null);
    const view = await request(makeApp()).get('/missing/view');
    expect(view.status).toBe(404);
    expect(view.body).toEqual({ error: 'Uploaded file not found' });
    const text = await request(makeApp()).get('/missing/text');
    expect(text.status).toBe(404);
    expect(text.body).toEqual({ error: 'Uploaded file not found' });
  });

  it('returns 403 for another user file and never sends bytes', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(ownedFile({ userId: 'user-2' }));
    const view = await request(makeApp()).get('/file-1/view');
    expect(view.status).toBe(403);
    expect(view.body).toEqual({ error: 'Access denied' });
    expect(view.headers['content-disposition']).toBeUndefined();
    const text = await request(makeApp()).get('/file-1/text');
    expect(text.status).toBe(403);
    expect(text.body).toEqual({ error: 'Access denied' });
  });

  it('GET /:fileId/view returns inline bytes with the stored Content-Type', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(ownedFile());
    const res = await request(makeApp()).get('/file-1/view');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline; filename="resume.pdf"');
    expect(prismaMocks.uploadedFile.findUnique).toHaveBeenCalledWith({ where: { id: 'file-1' } });
  });

  it('GET /:fileId/view falls back to octet-stream when fileType is null', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(ownedFile({ fileType: null }));
    const res = await request(makeApp()).get('/file-1/view');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
  });

  it('GET /:fileId/view sanitizes quotes and newlines in the filename', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(
      ownedFile({ fileName: 'my "resume"\n.pdf' }),
    );
    const res = await request(makeApp()).get('/file-1/view');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('inline; filename="my resume.pdf"');
    expect(res.headers['content-disposition']).not.toContain('"resume"');
  });

  it('GET /:fileId/text returns stored text uncapped', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(ownedFile());
    const res = await request(makeApp()).get('/file-1/text');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'hello world', truncated: false });
  });

  it('GET /:fileId/text caps long text and sets truncated', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(
      ownedFile({ extractedText: 'a'.repeat(MAX_EXTRACTED_TEXT_CAP + 5) }),
    );
    const res = await request(makeApp()).get('/file-1/text');
    expect(res.status).toBe(200);
    expect(res.body.text).toHaveLength(MAX_EXTRACTED_TEXT_CAP);
    expect(res.body.truncated).toBe(true);
  });

  it('GET /:fileId/text returns empty text as 200, not 404', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(ownedFile({ extractedText: '' }));
    const res = await request(makeApp()).get('/file-1/text');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: '', truncated: false });
  });

  it('GET /:fileId still downloads as an attachment with unchanged body', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(ownedFile());
    const res = await request(makeApp()).get('/file-1');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="resume.pdf"');
  });

  it('route order: /:fileId/view is handled by the view route, not the download route', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(ownedFile());
    const res = await request(makeApp()).get('/file-1/view');
    // If /:fileId were registered first and shadowed /view, this would 404
    // instead of returning the inline bytes.
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('inline');
  });
});
