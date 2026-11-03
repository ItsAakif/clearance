// Canonical verifyStatus vocabulary tests (T903).
import { describe, it, expect } from 'vitest';
import {
  REGISTRY_FAILURE_STATUSES,
  VERIFY_STATUSES,
  isFailureStatus,
  isSuccessStatus,
  isVerifyStatus,
  type VerifyStatus,
} from './verifyStatus.js';

describe('VERIFY_STATUSES tuple', () => {
  it('contains exactly the eight documented values in the documented order', () => {
    expect(VERIFY_STATUSES).toEqual([
      'unverified',
      'ok',
      'empty',
      'blocked',
      'http_error',
      'timeout',
      'invalid',
      'skipped',
    ]);
  });

  it('matches the documented order without duplicates', () => {
    expect(new Set(VERIFY_STATUSES).size).toBe(VERIFY_STATUSES.length);
  });
});

describe('REGISTRY_FAILURE_STATUSES tuple', () => {
  it('is the documented four-value, value-and-order-frozen array', () => {
    expect(REGISTRY_FAILURE_STATUSES).toEqual([
      'blocked',
      'http_error',
      'timeout',
      'invalid',
    ]);
  });

  it('contains only VerifyStatus members', () => {
    for (const value of REGISTRY_FAILURE_STATUSES) {
      expect(isVerifyStatus(value)).toBe(true);
    }
  });
});

describe('isFailureStatus', () => {
  it('accepts the four failure statuses', () => {
    expect(isFailureStatus('blocked')).toBe(true);
    expect(isFailureStatus('http_error')).toBe(true);
    expect(isFailureStatus('timeout')).toBe(true);
    expect(isFailureStatus('invalid')).toBe(true);
  });

  it('rejects the non-failure statuses', () => {
    expect(isFailureStatus('unverified')).toBe(false);
    expect(isFailureStatus('ok')).toBe(false);
    expect(isFailureStatus('empty')).toBe(false);
    expect(isFailureStatus('skipped')).toBe(false);
    expect(isFailureStatus('failed')).toBe(false);
    expect(isFailureStatus('')).toBe(false);
    expect(isFailureStatus('BLOCKED')).toBe(false);
  });
});

describe('isSuccessStatus', () => {
  it('accepts only the verified-success states', () => {
    expect(isSuccessStatus('ok')).toBe(true);
    expect(isSuccessStatus('empty')).toBe(true);
  });

  it('rejects everything else in the vocabulary', () => {
    const others: VerifyStatus[] = [
      'unverified',
      'blocked',
      'http_error',
      'timeout',
      'invalid',
      'skipped',
    ];
    for (const value of others) {
      expect(isSuccessStatus(value)).toBe(false);
    }
    expect(isSuccessStatus('failed')).toBe(false);
    expect(isSuccessStatus('')).toBe(false);
  });
});

describe('isVerifyStatus', () => {
  it('accepts every value in VERIFY_STATUSES', () => {
    for (const value of VERIFY_STATUSES) {
      expect(isVerifyStatus(value)).toBe(true);
    }
  });

  it('rejects the legacy sentinel and arbitrary strings', () => {
    expect(isVerifyStatus('failed')).toBe(false);
    expect(isVerifyStatus('OK')).toBe(false);
    expect(isVerifyStatus('')).toBe(false);
    expect(isVerifyStatus('garbage')).toBe(false);
  });
});

describe('type-level guard sanity', () => {
  it('isFailureStatus narrows to the failure tuple type', () => {
    const sample: string = 'blocked';
    if (isFailureStatus(sample)) {
      // The narrowed type is the union of REGISTRY_FAILURE_STATUSES.
      const union: 'blocked' | 'http_error' | 'timeout' | 'invalid' = sample;
      expect(union).toBe('blocked');
    }
  });
});