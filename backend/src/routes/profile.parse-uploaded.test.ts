import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks, parseMock } = vi.hoisted(() => ({
  authState: { enabled: true },
  prismaMocks: {
    uploadedFile: { findUnique: vi.fn() },
  },
  parseMock: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.enabled) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({
  default: prismaMocks,
  prisma: prismaMocks,
}));

vi.mock('../profile/parser.js', () => ({
  parseProfileFromResume: (...args: any[]) => parseMock(...args),
}));

import profileRouter from './profile.js';
import { MAX_PROFILE_PARSE_CHARS } from '../shared/validation.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', profileRouter);
  return app;
}

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const SUGGESTION = {
  suggested: {
    targetRoles: ['Backend Engineer'],
    seniority: 'senior',
    topSkills: ['TypeScript'],
    industries: ['SaaS'],
    summary: 'Senior backend engineer',
  },
  missing: ['minSalary', 'maxSalary', 'locationPref', 'remoteOnly', 'redFlags'],
};

describe('POST /parse-from-uploaded-file/:fileId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.enabled = true;
    parseMock.mockResolvedValue(SUGGESTION);
  });

  it('requires authentication', async () => {
    authState.enabled = false;
    const res = await request(makeApp()).post(`/parse-from-uploaded-file/${FILE_ID}`).send({});
    expect(res.status).toBe(401);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the file does not exist', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).post(`/parse-from-uploaded-file/${FILE_ID}`).send({});
    expect(res.status).toBe(404);
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('returns 403 for another user file without calling the parser', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue({
      id: FILE_ID,
      userId: 'user-2',
      extractedText: 'some text',
    });
    const res = await request(makeApp()).post(`/parse-from-uploaded-file/${FILE_ID}`).send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Not your file' });
    expect(parseMock).not.toHaveBeenCalled();
  });

  it.each([['empty', ''], ['whitespace', '   ']])(
    'returns 400 for %s extractedText without calling the parser',
    async (_label, extractedText) => {
      prismaMocks.uploadedFile.findUnique.mockResolvedValue({
        id: FILE_ID,
        userId: 'user-1',
        extractedText,
      });
      const res = await request(makeApp()).post(`/parse-from-uploaded-file/${FILE_ID}`).send({});
      expect(res.status).toBe(400);
      expect(parseMock).not.toHaveBeenCalled();
    }
  );

  it('returns 400 for a non-uuid fileId', async () => {
    const res = await request(makeApp()).post('/parse-from-uploaded-file/not-a-uuid').send({});
    expect(res.status).toBe(400);
    expect(parseMock).not.toHaveBeenCalled();
    expect(prismaMocks.uploadedFile.findUnique).not.toHaveBeenCalled();
  });

  it('returns the parser result verbatim on the happy path', async () => {
    const stored = 'Senior backend engineer with TypeScript experience.';
    prismaMocks.uploadedFile.findUnique.mockResolvedValue({
      id: FILE_ID,
      userId: 'user-1',
      extractedText: stored,
    });
    const res = await request(makeApp()).post(`/parse-from-uploaded-file/${FILE_ID}`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUGGESTION);
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(parseMock.mock.calls[0][0]).toBe(stored);
    expect(parseMock.mock.calls[0][1]).toBe('user-1');
  });

  it('truncates text longer than MAX_PROFILE_PARSE_CHARS before the parser', async () => {
    const stored = 'a'.repeat(MAX_PROFILE_PARSE_CHARS + 1000);
    prismaMocks.uploadedFile.findUnique.mockResolvedValue({
      id: FILE_ID,
      userId: 'user-1',
      extractedText: stored,
    });
    const res = await request(makeApp()).post(`/parse-from-uploaded-file/${FILE_ID}`).send({});
    expect(res.status).toBe(200);
    expect(parseMock).toHaveBeenCalledTimes(1);
    const sent = parseMock.mock.calls[0][0] as string;
    expect(sent).toHaveLength(MAX_PROFILE_PARSE_CHARS);
    expect(sent).toBe(stored.slice(0, MAX_PROFILE_PARSE_CHARS));
  });
});
