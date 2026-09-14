import { describe, expect, it, vi, afterEach } from 'vitest';

// NOTE: config/env.ts parses process.env at import time, so these tests
// re-import a fresh module copy with vi.resetModules(). This is safe to test:
// assertRequiredRuntimeConfig() only throws or warns — no process.exit.

describe('config/env', () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origPw = process.env.CLEARANCE_ACCESS_PASSWORD;
  const origAdmins = process.env.ADMIN_EMAILS;

  afterEach(() => {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (origPw === undefined) delete process.env.CLEARANCE_ACCESS_PASSWORD;
    else process.env.CLEARANCE_ACCESS_PASSWORD = origPw;
    if (origAdmins === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = origAdmins;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('assertRequiredRuntimeConfig throws in production with the default password', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'CHANGEME';
    const mod = await import('./env.js');
    expect(() => mod.assertRequiredRuntimeConfig()).toThrow(/CLEARANCE_ACCESS_PASSWORD/);
  });

  it('warns without throwing or leaking the password in development', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'development';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'CHANGEME';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('./env.js');
    expect(() => mod.assertRequiredRuntimeConfig()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(' ')).not.toContain('CHANGEME');
  });

  it('does not throw in production when a real password is set', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'a-strong-secret-value';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('./env.js');
    expect(() => mod.assertRequiredRuntimeConfig()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('getAdminEmails parses comma-separated addresses case-insensitively', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    process.env.ADMIN_EMAILS = 'Admin@Example.com , ops@example.com,,';
    const mod = await import('./env.js');
    expect(mod.getAdminEmails()).toEqual(new Set(['admin@example.com', 'ops@example.com']));
  });

  it('getAdminEmails is empty when ADMIN_EMAILS is unset', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    delete process.env.ADMIN_EMAILS;
    const mod = await import('./env.js');
    expect(mod.getAdminEmails()).toEqual(new Set());
  });
});
