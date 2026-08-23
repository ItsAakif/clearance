import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3001'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters long'),
  EMAIL_FROM: z.string().email().default('noreply@clearance.app'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  ADMIN_EMAILS: z.string().optional(),
  // Self-hosted open-registration toggle. Defaults to false so a fresh instance
  // is locked down: the first person to sign up becomes the admin, and further
  // open signups are blocked unless re-enabled. Set to "true" for community instances.
  ALLOW_REGISTRATION: z
    .string()
    .toLowerCase()
    .transform((v) => v === 'true' || v === '1' || v === 'yes')
    .default('false'),
});

const parsed = envSchema.safeParse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  CLIENT_URL: process.env.CLIENT_URL,
  API_URL: process.env.API_URL,
  JWT_SECRET: process.env.JWT_SECRET,
  EMAIL_FROM: process.env.EMAIL_FROM,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  ALLOW_REGISTRATION: process.env.ALLOW_REGISTRATION,
});

if (!parsed.success) {
  const formatted = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${formatted}`);
}

export const env = parsed.data;

export function assertRequiredRuntimeConfig(): void {
  if (!env.JWT_SECRET || env.JWT_SECRET === 'development-secret-change-in-production') {
    throw new Error('JWT_SECRET is required. Set it in backend/.env before starting the server.');
  }
}

export function getBaseUrl(): string {
  return env.API_URL || `http://localhost:${env.PORT}`;
}

export function getAdminEmails(): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Whether open registration is allowed. When false (default), only the very
 * first account may be created (becomes admin); all subsequent signups are
 * rejected. Set ALLOW_REGISTRATION=true for open community instances.
 */
export function getAllowRegistration(): boolean {
  return env.ALLOW_REGISTRATION;
}

export function hasSmtpConfig(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.EMAIL_FROM);
}
