import { describe, expect, it, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import {
  requireAuth,
  optionalAuth,
  setSessionCookie,
  clearAuthCookie,
  isAccessPasswordValid,
  createSessionToken,
  hashSessionToken,
  getSessionToken,
} from '../middleware/auth.js';

// Mock prisma
const mockFindUnique = vi.fn();
const mockCreate = vi.fn();
const mockDeleteMany = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  default: {
    session: {
      findUnique: (...args: any[]) => mockFindUnique(...args),
      create: (...args: any[]) => mockCreate(...args),
      deleteMany: (...args: any[]) => mockDeleteMany(...args),
    },
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

// Mock env (ADR-030: no admin allowlist; every valid session is admin)
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    CLEARANCE_ACCESS_PASSWORD: 'test-access-password',
  },
}));

function createMockReq(cookies: Record<string, string> = {}): Partial<Request> {
  return { cookies } as Partial<Request>;
}

function createMockRes(): { res: Partial<Response>; setStatus: (s: number) => void; jsonCalls: any[] } {
  const jsonCalls: any[] = [];
  let statusCode = 200;
  const res: any = {
    status: (s: number) => {
      statusCode = s;
      return res;
    },
    json: (data: any) => {
      jsonCalls.push({ status: statusCode, data });
      return res;
    },
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  };
  return { res, setStatus: (s: number) => { statusCode = s; }, jsonCalls };
}

describe('middleware/auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hashSessionToken', () => {
    it('returns a sha256 hex digest', () => {
      const hash = hashSessionToken('test-token');
      expect(hash).toBe(crypto.createHash('sha256').update('test-token').digest('hex'));
      expect(hash.length).toBe(64);
    });
  });

  describe('createSessionToken', () => {
    it('returns a 64-character hex string', () => {
      const token = createSessionToken();
      expect(token).toHaveLength(64);
    });
  });

  describe('getSessionToken', () => {
    it('returns the clearance_session cookie value', () => {
      const req = createMockReq({ clearance_session: 'abc123' });
      expect(getSessionToken(req as Request)).toBe('abc123');
    });

    it('returns undefined when cookie is absent', () => {
      const req = createMockReq({});
      expect(getSessionToken(req as Request)).toBeUndefined();
    });
  });

  describe('isAccessPasswordValid', () => {
    it('returns true for the correct password', async () => {
      // The function uses the mocked env which has CLEARANCE_ACCESS_PASSWORD = 'test-access-password'
      const result = isAccessPasswordValid('test-access-password');
      expect(result).toBe(true);
    });

    it('returns false for the wrong password', () => {
      const result = isAccessPasswordValid('wrong-password');
      expect(result).toBe(false);
    });
  });

  describe('requireAuth', () => {
    it('returns 401 when no session cookie is present', async () => {
      const req = createMockReq({}) as Request;
      const { res, jsonCalls } = createMockRes();
      const next = vi.fn() as NextFunction;

      await requireAuth(req, res as Response, next);
      expect(jsonCalls[0]).toEqual({ status: 401, data: { error: 'Authentication required' } });
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 401 for unknown/expired session', async () => {
      mockFindUnique.mockResolvedValue(null);
      const req = createMockReq({ clearance_session: 'some-token' }) as Request;
      const { res, jsonCalls } = createMockRes();
      const next = vi.fn() as NextFunction;

      await requireAuth(req, res as Response, next);
      expect(jsonCalls[0]).toEqual({ status: 401, data: { error: 'Authentication required' } });
      expect(next).not.toHaveBeenCalled();
    });

    it('populates req.user with isAdmin:true for any valid session (ADR-030 singleton is admin)', async () => {
      const tokenHash = hashSessionToken('valid-token');
      mockFindUnique.mockResolvedValue({
        tokenHash,
        user: { id: 'user-1', email: 'test@example.com' },
        expiresAt: new Date(Date.now() + 86400000),
      });
      const req = createMockReq({ clearance_session: 'valid-token' }) as Request;
      const { res } = createMockRes();
      const next = vi.fn() as NextFunction;

      await requireAuth(req, res as Response, next);
      expect(req.user).toEqual({ id: 'user-1', email: 'test@example.com', isAdmin: true });
      expect(next).toHaveBeenCalled();
    });

    it('populates req.user with isAdmin:true regardless of email (no allowlist)', async () => {
      mockFindUnique.mockResolvedValue({
        user: { id: 'user-1', email: 'anyone@example.com' },
        expiresAt: new Date(Date.now() + 86400000),
      });
      const req = createMockReq({ clearance_session: 'some-token' }) as Request;
      const { res } = createMockRes();
      const next = vi.fn() as NextFunction;

      await requireAuth(req, res as Response, next);
      expect(req.user).toEqual({ id: 'user-1', email: 'anyone@example.com', isAdmin: true });
      expect(next).toHaveBeenCalled();
    });

    it('returns 500 on database error', async () => {
      mockFindUnique.mockRejectedValue(new Error('db error'));
      const req = createMockReq({ clearance_session: 'token' }) as Request;
      const { res, jsonCalls } = createMockRes();
      const next = vi.fn() as NextFunction;

      await requireAuth(req, res as Response, next);
      expect(jsonCalls[0].status).toBe(500);
      expect(jsonCalls[0].data).toEqual({ error: 'Authentication error' });
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuth', () => {
    it('calls next when no cookie is present', async () => {
      const req = createMockReq({}) as Request;
      const { res } = createMockRes();
      const next = vi.fn() as NextFunction;

      await optionalAuth(req, res as Response, next);
      expect(next).toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it('populates the singleton admin user for a valid session', async () => {
      mockFindUnique.mockResolvedValue({
        user: { id: 'user-1', email: 'test@example.com' },
        expiresAt: new Date(Date.now() + 86400000),
      });
      const req = createMockReq({ clearance_session: 'valid-token' }) as Request;
      const { res } = createMockRes();
      const next = vi.fn() as NextFunction;

      await optionalAuth(req, res as Response, next);
      expect(req.user).toEqual({ id: 'user-1', email: 'test@example.com', isAdmin: true });
      expect(next).toHaveBeenCalled();
    });

    it('populates isAdmin:true regardless of email (no allowlist)', async () => {
      mockFindUnique.mockResolvedValue({
        user: { id: 'user-1', email: 'anyone@example.com' },
        expiresAt: new Date(Date.now() + 86400000),
      });
      const req = createMockReq({ clearance_session: 'some-token' }) as Request;
      const { res } = createMockRes();
      const next = vi.fn() as NextFunction;

      await optionalAuth(req, res as Response, next);
      expect(req.user).toEqual({ id: 'user-1', email: 'anyone@example.com', isAdmin: true });
      expect(next).toHaveBeenCalled();
    });

    it('calls next even on database error', async () => {
      mockFindUnique.mockRejectedValue(new Error('db error'));
      const req = createMockReq({ clearance_session: 'token' }) as Request;
      const { res } = createMockRes();
      const next = vi.fn() as NextFunction;

      await optionalAuth(req, res as Response, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('setSessionCookie / clearAuthCookie', () => {
    it('sets the clearance_session cookie', () => {
      const { res } = createMockRes();
      setSessionCookie(res as Response, 'raw-token-value');
      expect((res as any).cookie).toHaveBeenCalledWith(
        'clearance_session',
        'raw-token-value',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: 7 * 24 * 60 * 60 * 1000,
        })
      );
    });

    it('clears the clearance_session cookie', () => {
      const { res } = createMockRes();
      clearAuthCookie(res as Response);
      expect((res as any).clearCookie).toHaveBeenCalledWith(
        'clearance_session',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
        })
      );
    });
  });
});
