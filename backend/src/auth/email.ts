import crypto from 'crypto';
import { sendTransactionalEmail } from '../lib/mailer.js';
import { getBaseUrl } from '../config/env.js';

export function createOpaqueToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createTokenExpiry(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const verifyUrl = `${getBaseUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
  const appVerifyUrl = `${getBaseUrl().replace('/api', '')}/verify-email?token=${encodeURIComponent(token)}`;

  await sendTransactionalEmail({
    to: email,
    subject: 'Verify your Clearance email address',
    text: `Verify your Clearance account by opening this link: ${appVerifyUrl}\n\nAPI fallback: ${verifyUrl}`,
    html: `
      <p>Welcome to Clearance.</p>
      <p>Please verify your email address to complete setup.</p>
      <p><a href="${appVerifyUrl}">Verify your email</a></p>
      <p>If that does not work, use this direct link:</p>
      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
    `,
  });
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = `${getBaseUrl().replace('/api', '')}/reset-password?token=${encodeURIComponent(token)}`;

  await sendTransactionalEmail({
    to: email,
    subject: 'Reset your Clearance password',
    text: `Reset your password by opening this link: ${resetUrl}`,
    html: `
      <p>We received a request to reset your Clearance password.</p>
      <p><a href="${resetUrl}">Reset your password</a></p>
      <p>This link expires in 1 hour.</p>
    `,
  });
}
