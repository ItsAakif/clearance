import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks, evaluateJobMock, checkLivenessMock } = vi.hoisted(() => ({
  authState: { enabled: true },
  prismaMocks: {
    jobBoard: { findMany: vi.fn() },
    jobListing: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn(), groupBy: vi.fn() },
    resume: { findUnique: vi.fn() },
    aIProviderKey: { findFirst: vi.fn() },
    careerProfile: { findUnique: vi.fn() },
    jobEvaluation: { create: vi.fn() },
  },
  evaluateJobMock: vi.fn(),
  checkLivenessMock: vi.fn(),
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

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('../ai/evaluation.js', () => ({
  evaluateJob: (...args: any[]) => evaluateJobMock(...args),
}));

vi.mock('../jobSources/liveness.js', () => ({
  checkLiveness: (...args: any[]) => checkLivenessMock(...args),
}));

// Health writes must never fail the request; stub them to no-ops.
vi.mock('../jobSources/sourceHealth.js', () => ({
  recordSourceSuccess: vi.fn(),
  recordSourceFailure: vi.fn(),
}));

import jobsRouter, {
  mapEvaluateErrorToResponse,
  isUsableEvaluateDescription,
} from './jobs.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/jobs', jobsRouter);
  return app;
}

const RESUME_ID = '123e4567-e89b-12d3-a456-426614174000';
const LONG_DESCRIPTION = 'Senior backend engineer role. '.repeat(10); // 290 chars

function listingRow(overrides: Record<string, any> = {}) {
  return {
    id: 'listing-1',
    source: 'greenhouse',
    title: 'Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    description: LONG_DESCRIPTION,
    applyUrl: 'https://example.com/jobs/1',
    sourceUrl: 'https://example.com/jobs/1',
    isActive: true,
    ...overrides,
  };
}

function resumeRow(overrides: Record<string, any> = {}) {
  return { id: RESUME_ID, userId: 'user-1', name: 'My Resume', ...overrides };
}

const evalResult = {
  roleSummary: 'Backend role',
  cvMatchScore: 80,
  levelFitScore: 70,
  compFitScore: 60,
  personalizationScore: 50,
  interviewPrepScore: 40,
  legitimacyScore: 90,
  overallScore: 75,
  recommendation: 'apply',
  isScam: false,
  reportJson: { ok: true },
};

describe('mapEvaluateErrorToResponse', () => {
  it('maps a missing-key error to 409 llm_key_missing', () => {
    const mapped = mapEvaluateErrorToResponse(
      new Error('No LLM API keys configured. Add a key in Settings (BYOK) or set GROQ_API_KEY.'),
    );
    expect(mapped).toEqual({
      status: 409,
      body: {
        error: 'No LLM key configured. Add an LLM provider key in Settings (BYOK) to evaluate jobs.',
        code: 'llm_key_missing',
      },
    });
  });

  it('maps an error containing 429 to 429 rate_limited', () => {
    const err = new Error('LLM request failed with 429 Too Many Requests');
    expect(mapEvaluateErrorToResponse(err)).toEqual({
      status: 429,
      body: {
        error: 'The LLM provider rate-limited this evaluation. Try again shortly.',
        code: 'rate_limited',
      },
    });
  });

  it('maps a status-429 provider error to 429 rate_limited', () => {
    const err = Object.assign(new Error('rate limit exceeded'), { status: 429 });
    const mapped = mapEvaluateErrorToResponse(err);
    expect(mapped?.status).toBe(429);
    expect(mapped?.body.code).toBe('rate_limited');
  });

  it('returns null for a generic error so the caller rethrows', () => {
    expect(mapEvaluateErrorToResponse(new Error('Something exploded'))).toBeNull();
  });

  it('never echoes key material in mapped messages', () => {
    const mapped = mapEvaluateErrorToResponse(new Error('No LLM API keys configured, secret=sk-abc123'));
    expect(JSON.stringify(mapped)).not.toContain('sk-abc123');
  });
});

describe('isUsableEvaluateDescription', () => {
  it('rejects absent/short descriptions', () => {
    expect(isUsableEvaluateDescription(undefined)).toBe(false);
    expect(isUsableEvaluateDescription(null)).toBe(false);
    expect(isUsableEvaluateDescription('')).toBe(false);
    expect(isUsableEvaluateDescription('too short')).toBe(false);
  });

  it('accepts descriptions of 50+ chars', () => {
    expect(isUsableEvaluateDescription('x'.repeat(49))).toBe(false);
    expect(isUsableEvaluateDescription('x'.repeat(50))).toBe(true);
    expect(isUsableEvaluateDescription(LONG_DESCRIPTION)).toBe(true);
  });
});

describe('POST /jobs/:id/evaluate error mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.enabled = true;
    prismaMocks.jobListing.findUnique.mockResolvedValue(listingRow());
    prismaMocks.jobListing.update.mockImplementation(async ({ data }: any) => listingRow(data));
    prismaMocks.resume.findUnique.mockResolvedValue(resumeRow());
    prismaMocks.aIProviderKey.findFirst.mockResolvedValue(null);
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null);
    prismaMocks.jobEvaluation.create.mockImplementation(async ({ data }: any) => ({
      id: 'eval-1',
      overallScore: 75,
      recommendation: 'apply',
      isScam: false,
      cvMatchScore: 80,
      levelFitScore: 70,
      compFitScore: 60,
      personalizationScore: 50,
      interviewPrepScore: 40,
      legitimacyScore: 90,
      roleSummary: 'Backend role',
      reportJson: { ok: true },
      ...data,
    }));
    checkLivenessMock.mockResolvedValue(true);
    evaluateJobMock.mockResolvedValue({ ...evalResult });
  });

  it('returns 400 no_description when the body is absent and the listing text is too short', async () => {
    prismaMocks.jobListing.findUnique.mockResolvedValue(listingRow({ description: 'short' }));
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'This listing has no usable description to evaluate.',
      code: 'no_description',
    });
    expect(evaluateJobMock).not.toHaveBeenCalled();
  });

  it('returns 400 no_description when the listing has no description at all', async () => {
    prismaMocks.jobListing.findUnique.mockResolvedValue(listingRow({ description: null }));
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('no_description');
    expect(evaluateJobMock).not.toHaveBeenCalled();
  });

  it('falls back to the stored listing description when the body omits it', async () => {
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID });
    expect(res.status).toBe(201);
    expect(evaluateJobMock).toHaveBeenCalledTimes(1);
    expect(evaluateJobMock.mock.calls[0][2]).toBe(LONG_DESCRIPTION);
  });

  it('returns 409 posting_closed and deactivates on a dead link', async () => {
    checkLivenessMock.mockResolvedValue(false);
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID, jobDescription: LONG_DESCRIPTION });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'This job posting appears to be closed (dead link).',
      code: 'posting_closed',
    });
    expect(prismaMocks.jobListing.update).toHaveBeenCalledWith({
      where: { id: 'listing-1' },
      data: { isActive: false },
    });
    expect(evaluateJobMock).not.toHaveBeenCalled();
  });

  it('does not deactivate when the listing has no URL', async () => {
    prismaMocks.jobListing.findUnique.mockResolvedValue(
      listingRow({ applyUrl: null, sourceUrl: null }),
    );
    // checkLiveness treats a missing URL as alive, so evaluation proceeds.
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID, jobDescription: LONG_DESCRIPTION });
    expect(res.status).toBe(201);
    expect(checkLivenessMock).toHaveBeenCalledWith(null);
    expect(prismaMocks.jobListing.update).not.toHaveBeenCalled();
  });

  it('returns 409 llm_key_missing when no LLM key is configured', async () => {
    evaluateJobMock.mockRejectedValue(
      new Error('No LLM API keys configured. Add a key in Settings (BYOK) or set GROQ_API_KEY.'),
    );
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID, jobDescription: LONG_DESCRIPTION });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('llm_key_missing');
    expect(res.body.error).toContain('Settings (BYOK)');
  });

  it('returns 429 rate_limited when the provider rate-limits', async () => {
    evaluateJobMock.mockRejectedValue(new Error('LLM request failed with 429 Too Many Requests'));
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID, jobDescription: LONG_DESCRIPTION });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('still returns the generic 500 path for unknown errors', async () => {
    evaluateJobMock.mockRejectedValue(new Error('Something exploded'));
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID, jobDescription: LONG_DESCRIPTION });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'An unexpected error occurred' });
  });

  it('keeps the 201 success shape honest - the verdict and the prose, no derived number', async () => {
    const res = await request(makeApp())
      .post('/jobs/listing-1/evaluate')
      .send({ resumeId: RESUME_ID, jobDescription: LONG_DESCRIPTION });
    expect(res.status).toBe(201);
    // T1101 changed this shape on purpose: `overallScore` and the six-member `scores` object are
    // gone from the RESPONSE. What a caller gets is the decision, the scam fact and the prose.
    expect(Object.keys(res.body).sort()).toEqual([
      'id',
      'isScam',
      'recommendation',
      'reportJson',
      'roleSummary',
    ]);
    expect(res.body).toMatchObject({
      id: 'eval-1',
      recommendation: 'apply',
      isScam: false,
      roleSummary: 'Backend role',
      reportJson: { ok: true },
    });
  });
});
