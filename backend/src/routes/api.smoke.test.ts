import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../app.js';

describe('API smoke checks', () => {
  it('returns health status', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  it('rejects invalid auth signup payload', async () => {
    const response = await request(app).post('/api/auth/signup').send({});
    expect(response.status).toBe(400);
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

  it('validates export payload before conversion', async () => {
    const response = await request(app)
      .post('/api/export/html-to-docx')
      .set('Content-Type', 'application/json')
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('html is required');
  });
});
