import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks } = vi.hoisted(() => ({
  authState: { enabled: true },
  prismaMocks: {
    careerProfile: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
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

import profileRouter from './profile.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', profileRouter);
  return app;
}

describe('PUT / (career profile save)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.enabled = true;
  });

  it('saves a partial profile with only roles filled', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null);
    prismaMocks.careerProfile.create.mockImplementation(async ({ data }: any) => ({
      id: 'profile-1',
      ...data,
    }));
    const res = await request(makeApp())
      .put('/')
      .send({ targetRoles: ['Backend Engineer'] });
    expect(res.status).toBe(200);
    expect(prismaMocks.careerProfile.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.careerProfile.create.mock.calls[0][0].data).toMatchObject({
      userId: 'user-1',
      targetRoles: ['Backend Engineer'],
    });
  });

  it('accepts null parsedFromResumeId plus unknown id/userId keys without 400', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null);
    prismaMocks.careerProfile.create.mockImplementation(async ({ data }: any) => ({
      id: 'profile-1',
      ...data,
    }));
    const res = await request(makeApp())
      .put('/')
      .send({
        id: 'round-tripped-id',
        userId: 'user-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        isComplete: true,
        targetRoles: ['Backend Engineer'],
        seniority: 'senior',
        topSkills: ['TypeScript'],
        currency: 'USD',
        parsedFromResumeId: null,
      });
    expect(res.status).toBe(200);
    const written = prismaMocks.careerProfile.create.mock.calls[0][0].data;
    expect(written.userId).toBe('user-1');
    expect(written.parsedFromResumeId).toBeNull();
    // Server-owned / unknown keys must never reach Prisma.
    expect(written).not.toHaveProperty('id');
    expect(written).not.toHaveProperty('createdAt');
    expect(written).not.toHaveProperty('updatedAt');
    expect(written).not.toHaveProperty('isComplete');
  });

  it('updates an existing profile passing only editable fields to Prisma', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue({ id: 'profile-1', userId: 'user-1' });
    prismaMocks.careerProfile.update.mockImplementation(async ({ data }: any) => ({
      id: 'profile-1',
      userId: 'user-1',
      ...data,
    }));
    const res = await request(makeApp())
      .put('/')
      .send({
        id: 'other-id',
        userId: 'user-2',
        minSalary: 100000,
        currency: 'AED',
      });
    expect(res.status).toBe(200);
    const written = prismaMocks.careerProfile.update.mock.calls[0][0].data;
    expect(written).toEqual({ minSalary: 100000, currency: 'AED' });
  });

  it('requires authentication', async () => {
    authState.enabled = false;
    const res = await request(makeApp()).put('/').send({ targetRoles: ['X'] });
    expect(res.status).toBe(401);
    expect(prismaMocks.careerProfile.findUnique).not.toHaveBeenCalled();
  });
});
