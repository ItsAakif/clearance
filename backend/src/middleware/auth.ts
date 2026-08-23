// JWT Authentication Middleware
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
import { env, getAdminEmails } from '../config/env.js';

const JWT_SECRET = env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';
const adminEmails = getAdminEmails();

export interface JwtPayload {
  userId: string;
  email: string;
}

/**
 * Generate JWT token for user
 */
export function generateToken(userId: string, email: string): string {
  return jwt.sign(
    { userId, email } as JwtPayload,
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

/**
 * Verify JWT token
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Auth middleware - requires valid JWT
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Get token from cookie or Authorization header
    let token = req.cookies?.token;
    
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }
    
    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    
    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
    
    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, emailVerified: true }
    });
    
    if (!user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }
    
    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      isAdmin: adminEmails.has(user.email.toLowerCase()),
    };
    next();
  } catch (error) {
    console.error('[Auth] Middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

/**
 * Optional auth middleware - populates user if token present
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let token = req.cookies?.token;
    
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }
    
    if (token) {
      const payload = verifyToken(token);
      if (payload) {
        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: { id: true, email: true, emailVerified: true }
        });
        
        if (user) {
          req.user = {
            id: user.id,
            email: user.email,
            emailVerified: user.emailVerified,
            isAdmin: adminEmails.has(user.email.toLowerCase()),
          };
        }
      }
    }
    
    next();
  } catch {
    // Ignore errors - optional auth
    next();
  }
}

/**
 * Set auth cookie
 */
export function setAuthCookie(res: Response, token: string): void {
  res.cookie('token', token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

/**
 * Clear auth cookie
 */
export function clearAuthCookie(res: Response): void {
  res.clearCookie('token', {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
  });
}
