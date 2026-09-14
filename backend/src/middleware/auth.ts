import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { env, getAdminEmails } from '../config/env.js';

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function getSessionToken(req: Request): string | undefined {
  return req.cookies?.clearance_session;
}

export function isAccessPasswordValid(password: string): boolean {
  const expected = env.CLEARANCE_ACCESS_PASSWORD;
  if (!expected) return false;
  const submittedHash = crypto.createHash('sha256').update(password).digest('hex');
  const expectedHash = crypto.createHash('sha256').update(expected).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(submittedHash), Buffer.from(expectedHash));
}

export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return getAdminEmails().has(email.trim().toLowerCase());
}

export function setSessionCookie(res: Response, rawToken: string): void {
  res.cookie('clearance_session', rawToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie('clearance_session', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getSessionToken(req);
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const tokenHash = hashSessionToken(token);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!session || session.expiresAt < new Date()) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    req.user = {
      id: session.user.id,
      email: session.user.email,
      isAdmin: isAdminEmail(session.user.email),
    };
    next();
  } catch (error) {
    console.error('[Auth] Middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = getSessionToken(req);
    if (!token) {
      next();
      return;
    }

    const tokenHash = hashSessionToken(token);
    const session = await prisma.session.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (session && session.expiresAt >= new Date()) {
      req.user = {
        id: session.user.id,
        email: session.user.email,
        isAdmin: isAdminEmail(session.user.email),
      };
    }

    next();
  } catch {
    next();
  }
}
