import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.string().default('3001'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  API_URL: z.string().url().optional(),
  CLEARANCE_ACCESS_PASSWORD: z.string().default('CHANGEME'),
  ADMIN_EMAILS: z.string().default(''),
  EMAIL_FROM: z.string().email().default('noreply@clearance.app'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

const parsed = envSchema.safeParse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  CLIENT_URL: process.env.CLIENT_URL,
  API_URL: process.env.API_URL,
  CLEARANCE_ACCESS_PASSWORD: process.env.CLEARANCE_ACCESS_PASSWORD,
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  EMAIL_FROM: process.env.EMAIL_FROM,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
});

if (!parsed.success) {
  const formatted = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${formatted}`);
}

export const env = parsed.data;

export function assertRequiredRuntimeConfig(): void {
  if (env.CLEARANCE_ACCESS_PASSWORD === 'CHANGEME') {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'CLEARANCE_ACCESS_PASSWORD is still the default value. Set a strong secret before starting in production.'
      );
    }
    console.warn('[WARN] CLEARANCE_ACCESS_PASSWORD is still the default value. Set a strong secret.');
  }
}

export function getAdminEmails(): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS || '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function getBaseUrl(): string {
  return env.API_URL || `http://localhost:${env.PORT}`;
}

export function hasSmtpConfig(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.EMAIL_FROM);
}
