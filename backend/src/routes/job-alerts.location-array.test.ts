import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { mockUserId, prismaMocks } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  prismaMocks: {
    jobAlert: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    savedSearch: { findUnique: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

// Keep job-source side effects out of the location tests.
vi.mock('../jobSources/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../jobSources/index.js')>();
  return { ...orig, runSource: async () => [] };
});

import jobAlertsRouter from './job-alerts.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', jobAlertsRouter);
  return app;
}

const ownerAlert = { id: 'alert-1', userId: 'user-1', name: 'Old', query: 'frontend' };

describe('job-alert location arrays (T413, ADR-008)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId.value = 'user-1';
    prismaMocks.jobAlert.findUnique.mockResolvedValue(ownerAlert);
    prismaMocks.jobAlert.create.mockImplementation(async ({ data }: any) => ({ id: 'alert-new', ...data }));
    prismaMocks.jobAlert.update.mockImplementation(async ({ data }: any) => ({ ...ownerAlert, ...data }));
  });

  it('POST stores an array location as a JSON string', async () => {
    const res = await request(makeApp()).post('/').send({
      name: 'A', query: 'frontend', location: ['Remote', 'Berlin'],
    });
    expect(res.status).toBe(201);
    expect(prismaMocks.jobAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ location: '["Remote","Berlin"]' }),
    });
    expect(res.body.location).toBe('["Remote","Berlin"]');
  });

  it('POST stores a plain string location unchanged', async () => {
    const res = await request(makeApp()).post('/').send({
      name: 'A', query: 'frontend', location: 'Remote',
    });
    expect(res.status).toBe(201);
    expect(prismaMocks.jobAlert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ location: 'Remote' }),
    });
  });

  it('POST rejects an array element over 80 chars or more than 10 entries', async () => {
    const long = await request(makeApp()).post('/').send({
      name: 'A', query: 'frontend', location: ['x'.repeat(81)],
    });
    expect(long.status).toBe(400);
    const many = await request(makeApp()).post('/').send({
      name: 'A', query: 'frontend', location: Array(11).fill('Berlin'),
    });
    expect(many.status).toBe(400);
    expect(prismaMocks.jobAlert.create).not.toHaveBeenCalled();
  });

  it('PATCH stores an array location as a JSON string', async () => {
    const res = await request(makeApp()).patch('/alert-1').send({ location: ['Remote', 'Berlin'] });
    expect(res.status).toBe(200);
    expect(prismaMocks.jobAlert.update).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: expect.objectContaining({ location: '["Remote","Berlin"]' }),
    });
  });

  it('PATCH keeps a plain string location working', async () => {
    const res = await request(makeApp()).patch('/alert-1').send({ location: 'Remote' });
    expect(res.status).toBe(200);
    expect(prismaMocks.jobAlert.update).toHaveBeenCalledWith({
      where: { id: 'alert-1' },
      data: expect.objectContaining({ location: 'Remote' }),
    });
  });
});
