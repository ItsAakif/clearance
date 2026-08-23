// AES encryption for BYOK API keys at rest
// Keys are encrypted with AES-256-GCM using a key derived from KEY_ENCRYPTION_SECRET.
// Per security.md: never log plaintext keys.

import crypto from 'crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;

function getSecret(): Buffer {
  const secret = process.env.KEY_ENCRYPTION_SECRET || env.JWT_SECRET;
  // Derive a stable 32-byte key from the secret
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, getSecret(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as iv.authTag.encrypted (base64)
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return payload; // legacy plaintext fallback
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, getSecret(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

// Masks a key for display: keeps prefix + last 4 chars
export function maskKey(key: string): string {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
