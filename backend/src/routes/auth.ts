// Auth Routes - Signup, Login, Logout, Profile, Google OAuth
// Per security.md: Never log passwords, use bcrypt, validate all input

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import prisma from '../lib/prisma.js';
import { env, getAdminEmails, getAllowRegistration } from '../config/env.js';
import { createOpaqueToken, createTokenExpiry, hashToken, sendPasswordResetEmail, sendVerificationEmail } from '../auth/email.js';
import { 
  requireAuth, 
  generateToken, 
  setAuthCookie, 
  clearAuthCookie 
} from '../middleware/auth.js';
import { handleApiError, BadRequestError, NotFoundError, ConflictError, logSecurityEvent } from '../shared/errors.js';
import { validateInput, loginSchema, signupSchema, updateProfileSchema, resetPasswordSchema } from '../shared/validation.js';
import { sanitizeUser } from '../shared/auth.js';
import { seedDefaultBoardsForUser } from '../jobSources/defaultBoards.js';

const router = Router();
const adminEmails = getAdminEmails();
// Google OAuth client
const googleClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${env.API_URL || 'http://localhost:3001'}/api/auth/google/callback`
);

// ==================== SIGNUP ====================
router.post('/signup', async (req, res) => {
  try {
    // Validate input
    const { email, password, name } = validateInput(signupSchema, req.body);

    // Registration gating (self-hosted open-registration toggle).
    // Default (ALLOW_REGISTRATION=false): only the first account may be created.
    // After that, open signups are blocked to keep single-user instances locked down.
    const userCount = await prisma.user.count();
    const isFirstUser = userCount === 0;
    if (!getAllowRegistration() && !isFirstUser) {
      throw new BadRequestError(
        'Registration is disabled on this instance. Ask the instance admin for an invite, or set ALLOW_REGISTRATION=true to allow open signups.'
      );
    }

    // Check if email already exists
    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });

    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }
    
    // Hash password (bcrypt with cost factor 12)
    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = createOpaqueToken();
    const verificationTokenHash = hashToken(verificationToken);
    const verificationExpires = createTokenExpiry(24);
    
    // Create user
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        passwordHash,
        name: name || null,
        emailVerifyToken: verificationTokenHash,
        emailVerifyExpires: verificationExpires
      }
    });

    // First user on a locked-down instance becomes the admin automatically.
    if (isFirstUser) adminEmails.add(user.email.toLowerCase());

    let verificationEmailSent = false;
    try {
      await sendVerificationEmail(user.email, verificationToken);
      verificationEmailSent = true;
    } catch (mailError) {
      logSecurityEvent('suspicious_activity', {
        event: 'verification_email_failed',
        userId: user.id,
        reason: mailError instanceof Error ? mailError.message : 'unknown_error',
      });
    }
    
    // Generate token
    const token = generateToken(user.id, user.email);
    
    // Set cookie
    setAuthCookie(res, token);

    // Seed default job boards for the new user (best-effort, non-blocking)
    seedDefaultBoardsForUser(user.id).catch(() => {});
    
    // Return sanitized user
    res.status(201).json({
      user: sanitizeUser(user, adminEmails.has(user.email.toLowerCase())),
      token,
      verificationEmailSent
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== LOGIN ====================
router.post('/login', async (req, res) => {
  try {
    // Validate input
    const { email, password } = validateInput(loginSchema, req.body);
    
    // Find user
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });
    
    if (!user) {
      logSecurityEvent('login_failed', { email: email.toLowerCase(), reason: 'user_not_found' });
      throw new BadRequestError('Invalid email or password');
    }
    
    // Verify password
    const isValid = await bcrypt.compare(password, user.passwordHash);
    
    if (!isValid) {
      logSecurityEvent('login_failed', { email: email.toLowerCase(), reason: 'invalid_password' });
      throw new BadRequestError('Invalid email or password');
    }
    
    // Generate token
    const token = generateToken(user.id, user.email);
    
    // Set cookie
    setAuthCookie(res, token);
    
    // Return sanitized user
    res.json({
      user: sanitizeUser(user, adminEmails.has(user.email.toLowerCase())),
      token
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== LOGOUT ====================
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// ==================== GET CURRENT USER ====================
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id }
    });
    
    if (!user) {
      throw new NotFoundError('User');
    }
    
    res.json(sanitizeUser(user, req.user?.isAdmin ?? false));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== UPDATE PROFILE ====================
router.put('/profile', requireAuth, async (req, res) => {
  try {
    // Validate input
    const data = validateInput(updateProfileSchema, req.body);
    
    // Update user
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl })
      }
    });
    
    res.json(sanitizeUser(user, req.user?.isAdmin ?? false));
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== DELETE ACCOUNT ====================
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { id: true }
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    await prisma.user.delete({
      where: { id: user.id }
    });

    clearAuthCookie(res);
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== FORGOT PASSWORD ====================
router.post('/forgot-password', async (req, res) => {
  try {
    // Validate input
    const { email } = validateInput(resetPasswordSchema, req.body);
    
    // Find user
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });
    
    // Always return success (don't reveal if email exists)
    if (!user) {
      res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
      return;
    }
    
    // Generate reset token
    const resetToken = createOpaqueToken();
    const resetTokenHash = hashToken(resetToken);
    const resetExpires = createTokenExpiry(1);
    
    // Save token to database
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: resetTokenHash,
        passwordResetExpires: resetExpires
      }
    });
    
    await sendPasswordResetEmail(user.email, resetToken);
    
    res.json({ success: true, message: 'If an account exists, a reset link has been sent.' });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== RESET PASSWORD ====================
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    
    if (!token || !password) {
      throw new BadRequestError('Token and password are required');
    }
    
    // Validate password
    const validated = validateInput(signupSchema.pick({ password: true }), { password });
    
    // Hash the token to compare
    const tokenHash = hashToken(token);
    
    // Find user with valid token
    const user = await prisma.user.findFirst({
      where: {
        passwordResetToken: tokenHash,
        passwordResetExpires: { gt: new Date() }
      }
    });
    
    if (!user) {
      throw new BadRequestError('Invalid or expired reset token');
    }
    
    // Hash new password
    const passwordHash = await bcrypt.hash(validated.password, 12);
    
    // Update password and clear reset token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpires: null
      }
    });
    
    res.json({ success: true, message: 'Password reset successful. Please login.' });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== VERIFY EMAIL ====================
router.post('/verify-email', async (req, res) => {
  try {
    const { token } = req.body as { token?: string };

    if (!token) {
      throw new BadRequestError('Verification token is required');
    }

    const tokenHash = hashToken(token);

    const user = await prisma.user.findFirst({
      where: {
        emailVerifyToken: tokenHash,
        emailVerifyExpires: { gt: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestError('Invalid or expired verification token');
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifyToken: null,
        emailVerifyExpires: null,
      },
    });

    res.json({ success: true, user: sanitizeUser(updatedUser, adminEmails.has(updatedUser.email.toLowerCase())) });
  } catch (error) {
    handleApiError(error, res);
  }
});

router.get('/verify-email', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const clientUrl = env.CLIENT_URL || 'http://localhost:5173';

  if (!token) {
    res.redirect(`${clientUrl}/verify-email?status=missing-token`);
    return;
  }

  res.redirect(`${clientUrl}/verify-email?token=${encodeURIComponent(token)}`);
});

router.post('/resend-verification', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    if (user.emailVerified) {
      res.json({ success: true, message: 'Email address is already verified.' });
      return;
    }

    const verificationToken = createOpaqueToken();
    const verificationTokenHash = hashToken(verificationToken);
    const verificationExpires = createTokenExpiry(24);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifyToken: verificationTokenHash,
        emailVerifyExpires: verificationExpires,
      },
    });

    await sendVerificationEmail(user.email, verificationToken);

    res.json({ success: true, message: 'Verification email sent.' });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== GOOGLE OAUTH - REDIRECT ====================
router.get('/google', (req, res) => {
  const authorizeUrl = googleClient.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ],
    prompt: 'consent'
  });
  
  res.redirect(authorizeUrl);
});

// ==================== GOOGLE OAUTH - CALLBACK ====================
router.get('/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    
    if (!code || typeof code !== 'string') {
      throw new BadRequestError('Authorization code missing');
    }
    
    // Exchange code for tokens
    const { tokens } = await googleClient.getToken(code);
    googleClient.setCredentials(tokens);
    
    // Get user info
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token!,
      audience: process.env.GOOGLE_CLIENT_ID!
    });
    
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      throw new BadRequestError('Could not get user info from Google');
    }
    
    const { email, name, picture, sub: googleId } = payload;
    
    // Find or create user
    let user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() }
    });
    
    if (!user) {
      // Create new user with Google OAuth
      // Generate a random password hash (user won't need it for OAuth)
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const passwordHash = await bcrypt.hash(randomPassword, 12);
      
      user = await prisma.user.create({
        data: {
          email: email.toLowerCase(),
          passwordHash,
          name: name || null,
          avatarUrl: picture || null,
          googleId,
          emailVerified: Boolean(payload.email_verified)
        }
      });
    } else if (!user.googleId) {
      // Link Google account to existing user
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          googleId,
          avatarUrl: user.avatarUrl || picture || null,
          emailVerified: user.emailVerified || Boolean(payload.email_verified),
        }
      });
    }
    
    // Generate token
    const token = generateToken(user.id, user.email);
    
    // Set cookie
    setAuthCookie(res, token);
    
    // Redirect to frontend app
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}/app/resumes`);
  } catch (error) {
    logSecurityEvent('oauth_failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    res.redirect(`${clientUrl}/auth?error=oauth_failed`);
  }
});

export default router;
