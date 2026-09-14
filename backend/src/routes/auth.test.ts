import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    user: { findFirst: vi.fn(), create: vi.fn() },
    session: { create: vi.fn() },
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    CLEARANCE_ACCESS_PASSWORD: 'test-access-password',
  },
  getAdminEmails: () => new Set<string>(),
}));

import authRouter from './auth.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', authRouter);
  return app;
}

const canonicalUser = {
  id: 'user-1',
  email: 'local@clearance.invalid',
  name: 'Clearance User',
  avatarUrl: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('auth login provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('provisions the canonical user on empty DB and sets a session cookie', async () => {
    prismaMocks.user.findFirst.mockResolvedValue(null);
    prismaMocks.user.create.mockResolvedValue(canonicalUser);
    prismaMocks.session.create.mockResolvedValue({});

    const res = await request(makeApp())
      .post('/login')
      .set('Content-Type', 'application/json')
      .send({ password: 'test-access-password' });

    expect(res.status).toBe(200);
    expect(prismaMocks.user.create).toHaveBeenCalledWith({
      data: { email: 'local@clearance.invalid', name: 'Clearance User' },
      select: expect.objectContaining({ id: true, email: true }),
    });
    expect(prismaMocks.session.create).toHaveBeenCalled();
    expect(res.body.user.email).toBe('local@clearance.invalid');
    const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(cookies?.join(';')).toContain('clearance_session=');
  });

  it('reuses the same user on second login (exactly 1 User row)', async () => {
    const store: { user: typeof canonicalUser | null } = { user: null };
    prismaMocks.user.findFirst.mockImplementation(async () => store.user);
    prismaMocks.user.create.mockImplementation(async ({ data }: any) => {
      store.user = { ...canonicalUser, ...data };
      return store.user;
    });
    prismaMocks.session.create.mockResolvedValue({});

    const app = makeApp();
    const first = await request(app)
      .post('/login')
      .set('Content-Type', 'application/json')
      .send({ password: 'test-access-password' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/login')
      .set('Content-Type', 'application/json')
      .send({ password: 'test-access-password' });
    expect(second.status).toBe(200);

    expect(prismaMocks.user.create).toHaveBeenCalledTimes(1);
    expect(second.body.user.id).toBe(first.body.user.id);
  });
});
