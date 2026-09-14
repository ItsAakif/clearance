import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Shared mutable mock state (vi.hoisted so vi.mock factories can use it).
const { mockUserId, prismaMocks } = vi.hoisted(() => ({
  mockUserId: { value: 'user-1' },
  prismaMocks: {
    application: { findUnique: vi.fn(), update: vi.fn() },
    applicationEvent: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import applicationsRouter from './applications.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', applicationsRouter);
  return app;
}

const ownerApp = { id: 'app-1', userId: 'user-1', status: 'applied', appliedAt: null };

describe('application events routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId.value = 'user-1';
    prismaMocks.application.findUnique.mockResolvedValue(ownerApp);
    prismaMocks.applicationEvent.findMany.mockResolvedValue([]);
  });

  it('lists events for the owner', async () => {
    prismaMocks.applicationEvent.findMany.mockResolvedValue([
      { id: 'ev-1', applicationId: 'app-1', type: 'note_added', title: 'Hi', createdAt: new Date().toISOString() },
    ]);
    const res = await request(makeApp()).get('/app-1/events');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(prismaMocks.applicationEvent.findMany).toHaveBeenCalledWith({
      where: { applicationId: 'app-1' },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('denies event listing for another user', async () => {
    mockUserId.value = 'user-2';
    const res = await request(makeApp()).get('/app-1/events');
    expect(res.status).toBe(403);
  });

  it('returns 404 when the application does not exist', async () => {
    prismaMocks.application.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).get('/missing/events');
    expect(res.status).toBe(404);
  });

  it('creates an event for the owner', async () => {
    prismaMocks.applicationEvent.create.mockImplementation(async ({ data }: any) => ({ id: 'ev-1', ...data }));
    const res = await request(makeApp()).post('/app-1/events').send({ type: 'follow_up', title: 'Ping them' });
    expect(res.status).toBe(201);
    expect(prismaMocks.applicationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ applicationId: 'app-1', type: 'follow_up', title: 'Ping them' }),
    });
  });

  it('rejects an invalid event type', async () => {
    const res = await request(makeApp()).post('/app-1/events').send({ type: 'bogus' });
    expect(res.status).toBe(400);
    expect(prismaMocks.applicationEvent.create).not.toHaveBeenCalled();
  });

  it('denies event creation for another user', async () => {
    mockUserId.value = 'user-2';
    const res = await request(makeApp()).post('/app-1/events').send({ type: 'note_added' });
    expect(res.status).toBe(403);
    expect(prismaMocks.applicationEvent.create).not.toHaveBeenCalled();
  });

  it('updates an event for the owner', async () => {
    prismaMocks.applicationEvent.findUnique.mockResolvedValue({ id: 'ev-1', applicationId: 'app-1', type: 'note_added' });
    prismaMocks.applicationEvent.update.mockImplementation(async ({ data }: any) => ({ id: 'ev-1', ...data }));
    const res = await request(makeApp())
      .patch('/app-1/events/ev-1')
      .send({ completedAt: new Date().toISOString() });
    expect(res.status).toBe(200);
    expect(prismaMocks.applicationEvent.update).toHaveBeenCalledWith({
      where: { id: 'ev-1' },
      data: expect.objectContaining({ completedAt: expect.any(Date) }),
    });
  });

  it('returns 404 when the event belongs to a different application', async () => {
    prismaMocks.applicationEvent.findUnique.mockResolvedValue({ id: 'ev-1', applicationId: 'app-2', type: 'note_added' });
    const res = await request(makeApp()).patch('/app-1/events/ev-1').send({ title: 'x' });
    expect(res.status).toBe(404);
    expect(prismaMocks.applicationEvent.update).not.toHaveBeenCalled();
  });

  it('denies event update for another user', async () => {
    mockUserId.value = 'user-2';
    prismaMocks.applicationEvent.findUnique.mockResolvedValue({ id: 'ev-1', applicationId: 'app-1', type: 'note_added' });
    const res = await request(makeApp()).patch('/app-1/events/ev-1').send({ title: 'x' });
    expect(res.status).toBe(403);
    expect(prismaMocks.applicationEvent.update).not.toHaveBeenCalled();
  });
});

describe('application withdrawn/ghosted transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserId.value = 'user-1';
    prismaMocks.application.findUnique.mockResolvedValue(ownerApp);
    prismaMocks.application.update.mockImplementation(async ({ data }: any) => ({ ...ownerApp, ...data }));
  });

  it('accepts withdrawn and ghosted statuses', async () => {
    for (const status of ['withdrawn', 'ghosted']) {
      const res = await request(makeApp()).patch('/app-1').send({ status });
      expect(res.status).toBe(200);
      expect(prismaMocks.application.update).toHaveBeenCalledWith({
        where: { id: 'app-1' },
        data: expect.objectContaining({ status }),
      });
    }
  });

  it('sets withdrawnAt/ghostedAt/followUpAt timestamps', async () => {
    const iso = new Date().toISOString();
    const res = await request(makeApp())
      .patch('/app-1')
      .send({ status: 'withdrawn', withdrawnAt: iso, ghostedAt: iso, followUpAt: iso });
    expect(res.status).toBe(200);
    expect(prismaMocks.application.update).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      data: expect.objectContaining({
        status: 'withdrawn',
        withdrawnAt: new Date(iso),
        ghostedAt: new Date(iso),
        followUpAt: new Date(iso),
      }),
    });
  });

  it('clears timestamps when null is sent', async () => {
    const res = await request(makeApp())
      .patch('/app-1')
      .send({ withdrawnAt: null, ghostedAt: null, followUpAt: null });
    expect(res.status).toBe(200);
    expect(prismaMocks.application.update).toHaveBeenCalledWith({
      where: { id: 'app-1' },
      data: expect.objectContaining({ withdrawnAt: null, ghostedAt: null, followUpAt: null }),
    });
  });

  it('rejects unknown statuses', async () => {
    const res = await request(makeApp()).patch('/app-1').send({ status: 'hired' });
    expect(res.status).toBe(400);
    expect(prismaMocks.application.update).not.toHaveBeenCalled();
  });
});
