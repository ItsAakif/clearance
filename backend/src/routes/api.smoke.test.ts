import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../app.js';

describe('API smoke checks', () => {
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
});
