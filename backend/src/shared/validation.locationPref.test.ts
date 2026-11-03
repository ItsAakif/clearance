import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  careerProfileSchema,
  normalizeLocationPref,
  serializeLocationPref,
} from './validation.js';

const { prismaMocks } = vi.hoisted(() => ({
  prismaMocks: {
    careerProfile: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({
  default: prismaMocks,
  prisma: prismaMocks,
}));

import profileRouter from '../routes/profile.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', profileRouter);
  return app;
}

describe('careerProfileSchema.locationPref (T405)', () => {
  it('accepts a single legacy string', () => {
    const parsed = careerProfileSchema.safeParse({ locationPref: 'Remote' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.locationPref).toBe('Remote');
  });

  it('accepts an array of locations', () => {
    const parsed = careerProfileSchema.safeParse({ locationPref: ['Remote', 'Berlin'] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.locationPref).toEqual(['Remote', 'Berlin']);
  });

  it('accepts null and undefined', () => {
    expect(careerProfileSchema.safeParse({ locationPref: null }).success).toBe(true);
    expect(careerProfileSchema.safeParse({}).success).toBe(true);
  });

  it('rejects more than 10 entries', () => {
    const locations = Array.from({ length: 11 }, (_, i) => `City ${i}`);
    expect(careerProfileSchema.safeParse({ locationPref: locations }).success).toBe(false);
  });

  it('rejects an element longer than 80 chars', () => {
    expect(careerProfileSchema.safeParse({ locationPref: ['a'.repeat(81)] }).success).toBe(false);
  });

  it('still rejects a single string longer than 100 chars', () => {
    expect(careerProfileSchema.safeParse({ locationPref: 'a'.repeat(101) }).success).toBe(false);
  });
});

describe('normalizeLocationPref (T405)', () => {
  it('returns [] for null and undefined', () => {
    expect(normalizeLocationPref(null)).toEqual([]);
    expect(normalizeLocationPref(undefined)).toEqual([]);
  });

  it('wraps a plain string literally', () => {
    expect(normalizeLocationPref('Remote')).toEqual(['Remote']);
    expect(normalizeLocationPref('  Berlin  ')).toEqual(['Berlin']);
  });

  it('returns [] for blank strings', () => {
    expect(normalizeLocationPref('')).toEqual([]);
    expect(normalizeLocationPref('   ')).toEqual([]);
  });

  it('uses a bare non-JSON "[a,b" literally', () => {
    expect(normalizeLocationPref('[a,b')).toEqual(['[a,b']);
  });

  it('decodes a JSON array string', () => {
    expect(normalizeLocationPref('["Remote","Berlin"]')).toEqual(['Remote', 'Berlin']);
  });

  it('drops only non-string members of a JSON array', () => {
    expect(normalizeLocationPref('["Remote",42,null,{"x":1},"Berlin"]')).toEqual([
      'Remote',
      'Berlin',
    ]);
  });

  it('drops non-string members of a raw array', () => {
    expect(normalizeLocationPref(['Remote', 42, null, 'Berlin'])).toEqual(['Remote', 'Berlin']);
  });

  it('dedupes case-insensitively, keeping the first occurrence', () => {
    expect(normalizeLocationPref(['Remote', 'remote', 'REMOTE', 'Berlin'])).toEqual([
      'Remote',
      'Berlin',
    ]);
    expect(normalizeLocationPref('["Berlin","berlin","Remote"]')).toEqual(['Berlin', 'Remote']);
  });

  it('trims entries and drops empties', () => {
    expect(normalizeLocationPref(['  Remote  ', '   ', 'Berlin'])).toEqual(['Remote', 'Berlin']);
  });

  it('returns [] for JSON arrays with no usable strings and never throws', () => {
    // Only bracketed values go through JSON decoding (ADR-008 rule); other
    // strings are used literally.
    expect(normalizeLocationPref('{"a":1}')).toEqual(['{"a":1}']);
    expect(normalizeLocationPref('[1,2]')).toEqual([]);
    expect(normalizeLocationPref('123')).toEqual(['123']);
    expect(() => normalizeLocationPref(42)).not.toThrow();
    expect(normalizeLocationPref(42)).toEqual([]);
    expect(normalizeLocationPref({ city: 'Berlin' })).toEqual([]);
    expect(normalizeLocationPref(true)).toEqual([]);
  });
});

describe('serializeLocationPref (T405)', () => {
  it('serializes an array to a JSON string', () => {
    expect(serializeLocationPref(['Remote', 'Berlin'])).toBe('["Remote","Berlin"]');
  });

  it('passes a plain string through trimmed', () => {
    expect(serializeLocationPref('Remote')).toBe('Remote');
    expect(serializeLocationPref('  Berlin  ')).toBe('Berlin');
  });

  it('maps empty values to null', () => {
    expect(serializeLocationPref([])).toBeNull();
    expect(serializeLocationPref('')).toBeNull();
    expect(serializeLocationPref('   ')).toBeNull();
    expect(serializeLocationPref(null)).toBeNull();
    expect(serializeLocationPref(undefined)).toBeNull();
  });
});

describe('PUT /profile locationPref persistence (T405)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists an array as a JSON array string', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null);
    prismaMocks.careerProfile.create.mockImplementation(async ({ data }: any) => data);
    const res = await request(makeApp())
      .put('/')
      .send({ locationPref: ['Remote', 'Berlin'] });
    expect(res.status).toBe(200);
    expect(prismaMocks.careerProfile.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.careerProfile.create.mock.calls[0][0].data.locationPref).toBe(
      '["Remote","Berlin"]',
    );
  });

  it('persists a legacy single string verbatim', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue({ userId: 'user-1' });
    prismaMocks.careerProfile.update.mockImplementation(async ({ data }: any) => data);
    const res = await request(makeApp()).put('/').send({ locationPref: 'Remote' });
    expect(res.status).toBe(200);
    expect(prismaMocks.careerProfile.update.mock.calls[0][0].data.locationPref).toBe('Remote');
  });

  it('persists an empty array as null', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue({ userId: 'user-1' });
    prismaMocks.careerProfile.update.mockImplementation(async ({ data }: any) => data);
    const res = await request(makeApp()).put('/').send({ locationPref: [] });
    expect(res.status).toBe(200);
    expect(prismaMocks.careerProfile.update.mock.calls[0][0].data.locationPref).toBeNull();
  });

  it('returns 400 for more than 10 entries', async () => {
    const locations = Array.from({ length: 11 }, (_, i) => `City ${i}`);
    const res = await request(makeApp()).put('/').send({ locationPref: locations });
    expect(res.status).toBe(400);
    expect(prismaMocks.careerProfile.update).not.toHaveBeenCalled();
    expect(prismaMocks.careerProfile.create).not.toHaveBeenCalled();
  });

  it('returns 400 for an element longer than 80 chars', async () => {
    const res = await request(makeApp()).put('/').send({ locationPref: ['a'.repeat(81)] });
    expect(res.status).toBe(400);
    expect(prismaMocks.careerProfile.update).not.toHaveBeenCalled();
    expect(prismaMocks.careerProfile.create).not.toHaveBeenCalled();
  });
});
