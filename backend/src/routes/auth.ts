import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { env } from '../config/env.js';
import {
  requireAuth,
  setSessionCookie,
  clearAuthCookie,
  createSessionToken,
  hashSessionToken,
  isAccessPasswordValid,
} from '../middleware/auth.js';
import { handleApiError, NotFoundError, logSecurityEvent } from '../shared/errors.js';
import { validateInput, accessPasswordSchema, updateProfileSchema } from '../shared/validation.js';
import { sanitizeUser } from '../shared/auth.js';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { password } = validateInput(accessPasswordSchema, req.body);

    if (!isAccessPasswordValid(password)) {
      logSecurityEvent('login_failed', { reason: 'invalid_password' });
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    let user = await prisma.user.findFirst({
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      try {
        user = await prisma.user.create({
          data: {
            email: 'local@clearance.invalid',
            name: 'Clearance User',
          },
          select: {
            id: true,
            email: true,
            name: true,
            avatarUrl: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        console.log('[Auth] Provisioned canonical application user');
      } catch {
        user = null;
      }
    }

    if (!user) {
      res.status(500).json({ error: 'Application user is not configured' });
      return;
    }

    const rawToken = createSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.session.create({
      data: {
        tokenHash,
        userId: user.id,
        expiresAt,
      },
    });

    setSessionCookie(res, rawToken);
    res.status(200).json({ user: sanitizeUser(user, true) });
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/logout', (req, res) => {
  try {
    const token = req.cookies?.clearance_session;
    if (token) {
      const tokenHash = hashSessionToken(token);
      prisma.session
        .deleteMany({ where: { tokenHash } })
        .catch(() => {});
    }
  } catch {
    // ignore
  }
  clearAuthCookie(res);
  res.json({ success: true });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    res.json(sanitizeUser(user, true));
  } catch (error) {
    handleApiError(error, res);
  }
});

router.put('/profile', requireAuth, async (req, res) => {
  try {
    const data = validateInput(updateProfileSchema, req.body);

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
      },
    });

    res.json(sanitizeUser(user, true));
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
