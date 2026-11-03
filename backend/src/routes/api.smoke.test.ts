import request from 'supertest';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import app from '../app.js';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    session: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    user: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

describe('API smoke checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.session.findUnique.mockResolvedValue(null);
  });
  it('returns health status', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('rejects login with missing password', async () => {
    const response = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send({});
    expect(response.status).toBe(400);
  });

  it('returns 404 for removed signup route', async () => {
    const response = await request(app)
      .post('/api/auth/signup')
      .set('Content-Type', 'application/json')
      .send({});
    expect(response.status).toBe(404);
  });

  it('returns 404 for removed forgot-password route', async () => {
    const response = await request(app)
      .post('/api/auth/forgot-password')
      .set('Content-Type', 'application/json')
      .send({});
    expect(response.status).toBe(404);
  });

  it('returns 404 for removed reset-password route', async () => {
    const response = await request(app)
      .post('/api/auth/reset-password')
      .set('Content-Type', 'application/json')
      .send({});
    expect(response.status).toBe(404);
  });

  it('returns 404 for removed verify-email route', async () => {
    const response = await request(app)
      .post('/api/auth/verify-email')
      .set('Content-Type', 'application/json')
      .send({});
    expect(response.status).toBe(404);
  });

  it('returns 404 for removed resend-verification route', async () => {
    const response = await request(app)
      .post('/api/auth/resend-verification')
      .set('Content-Type', 'application/json')
      .send({});
    expect(response.status).toBe(404);
  });

  it('returns 404 for removed google route', async () => {
    const response = await request(app).get('/api/auth/google');
    expect(response.status).toBe(404);
  });

  it('blocks resume list when unauthenticated', async () => {
    const response = await request(app).get('/api/resumes');
    expect(response.status).toBe(401);
  });

  it('returns 404 for removed payment endpoint', async () => {
    const response = await request(app)
      .post('/api/payment/webhook')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(response.status).toBe(404);
  });

  it('blocks export when unauthenticated', async () => {
    const response = await request(app)
      .post('/api/export/html-to-docx')
      .set('Content-Type', 'application/json')
      .send({});

    expect(response.status).toBe(401);
  });

  it('returns isAdmin:true on /api/admin/status with a valid session (ADR-030)', async () => {
    prismaMocks.session.findUnique.mockResolvedValue({
      tokenHash: 'mock-hash',
      user: { id: 'user-1', email: 'local@clearance.invalid' },
      expiresAt: new Date(Date.now() + 86400000),
    });

    const response = await request(app)
      .get('/api/admin/status')
      .set('Cookie', ['clearance_session=valid-token']);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      email: 'local@clearance.invalid',
      isAdmin: true,
    });
  });

  it('blocks /api/admin/status without a session (admin gate stays enforced)', async () => {
    const response = await request(app).get('/api/admin/status');
    expect(response.status).toBe(401);
  });
});
