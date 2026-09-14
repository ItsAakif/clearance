import { describe, expect, it, vi, afterEach } from 'vitest';

// NOTE: lib/crypto.ts derives its key from config/env.ts, which parses
// process.env at import time — so these tests re-import a fresh module copy
// with vi.resetModules(). Never log plaintext keys.

describe('lib/crypto', () => {
  const origSecret = process.env.KEY_ENCRYPTION_SECRET;
  const origPw = process.env.CLEARANCE_ACCESS_PASSWORD;

  afterEach(() => {
    if (origSecret === undefined) delete process.env.KEY_ENCRYPTION_SECRET;
    else process.env.KEY_ENCRYPTION_SECRET = origSecret;
    if (origPw === undefined) delete process.env.CLEARANCE_ACCESS_PASSWORD;
    else process.env.CLEARANCE_ACCESS_PASSWORD = origPw;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('encrypt→decrypt round-trips via the fallback path with no env var set', async () => {
    vi.resetModules();
    delete process.env.KEY_ENCRYPTION_SECRET;
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./crypto.js');
    const ciphertext = mod.encryptSecret('test-key-value-123');
    expect(ciphertext).not.toContain('test-key-value-123');
    expect(mod.decryptSecret(ciphertext)).toBe('test-key-value-123');
  });

  it('fallback key is stable across re-imports (same access password)', async () => {
    vi.resetModules();
    delete process.env.KEY_ENCRYPTION_SECRET;
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const first = await import('./crypto.js');
    const ciphertext = first.encryptSecret('stable-fallback-key-456');

    vi.resetModules();
    const second = await import('./crypto.js');
    expect(second.decryptSecret(ciphertext)).toBe('stable-fallback-key-456');
  });

  it('encrypt→decrypt round-trips with KEY_ENCRYPTION_SECRET set', async () => {
    vi.resetModules();
    process.env.KEY_ENCRYPTION_SECRET = 'explicit-test-secret-value';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./crypto.js');
    const ciphertext = mod.encryptSecret('another-test-key-789');
    expect(ciphertext).not.toContain('another-test-key-789');
    expect(mod.decryptSecret(ciphertext)).toBe('another-test-key-789');
  });
});
