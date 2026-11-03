import { describe, expect, it, vi, afterEach } from 'vitest';

// NOTE: config/env.ts parses process.env at import time, so these tests
// re-import a fresh module copy with vi.resetModules(). This is safe to test:
// assertRequiredRuntimeConfig() only throws or warns — no process.exit.

describe('config/env', () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origPw = process.env.CLEARANCE_ACCESS_PASSWORD;
  const origFeed = process.env.CATALOGUE_FEED_URL;

  afterEach(() => {
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    if (origPw === undefined) delete process.env.CLEARANCE_ACCESS_PASSWORD;
    else process.env.CLEARANCE_ACCESS_PASSWORD = origPw;
    if (origFeed === undefined) delete process.env.CATALOGUE_FEED_URL;
    else process.env.CATALOGUE_FEED_URL = origFeed;
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

  it('exposes no admin-allowlist config (ADR-030 removed it)', async () => {
    vi.resetModules();
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./env.js');
    expect(Object.keys(mod.env).join(',')).not.toMatch(/admin/i);
    expect(Object.keys(mod).join(',')).not.toMatch(/admin/i);
  });

  // Wave 15 (T900): SEARCH_ATTRIBUTION must default to 'off' and must NOT
  // throw at startup on any operator-typed value (the route relies on a
  // lenient parser; a typo like `true` or `On` would otherwise crash boot).
  it('SEARCH_ATTRIBUTION defaults to off when missing', async () => {
    vi.resetModules();
    delete process.env.SEARCH_ATTRIBUTION;
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./env.js');
    expect(mod.env.SEARCH_ATTRIBUTION).toBe('off');
  });

  it('SEARCH_ATTRIBUTION=on is parsed when explicitly set', async () => {
    vi.resetModules();
    process.env.SEARCH_ATTRIBUTION = 'on';
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./env.js');
    expect(mod.env.SEARCH_ATTRIBUTION).toBe('on');
  });

  it('SEARCH_ATTRIBUTION coerces non-"on" values to off without throwing', async () => {
    for (const badValue of ['true', 'True', 'ON', 'enabled', 'yes', 'off', '']) {
      vi.resetModules();
      process.env.SEARCH_ATTRIBUTION = badValue;
      process.env.NODE_ENV = 'test';
      process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
      const mod = await import('./env.js');
      expect(mod.env.SEARCH_ATTRIBUTION).toBe(badValue === 'on' ? 'on' : 'off');
    }
  });

  // Wave 15 (T904): SEARCH_FULL_VERIFY_WRITEBACK mirrors the lenient pattern
  // - default 'on' - so a Full sweep is a verification unless an operator
  // disables it; a missing/invalid value must NOT crash startup.
  it('SEARCH_FULL_VERIFY_WRITEBACK defaults to on when missing', async () => {
    vi.resetModules();
    delete process.env.SEARCH_FULL_VERIFY_WRITEBACK;
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./env.js');
    expect(mod.env.SEARCH_FULL_VERIFY_WRITEBACK).toBe('on');
  });

  it('SEARCH_FULL_VERIFY_WRITEBACK=off is parsed when explicitly set', async () => {
    vi.resetModules();
    process.env.SEARCH_FULL_VERIFY_WRITEBACK = 'off';
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./env.js');
    expect(mod.env.SEARCH_FULL_VERIFY_WRITEBACK).toBe('off');
  });

  it('SEARCH_FULL_VERIFY_WRITEBACK coerces non-"on" values to off without throwing', async () => {
    for (const badValue of ['true', 'True', 'ON', 'enabled', 'yes', 'enabled', '']) {
      vi.resetModules();
      process.env.SEARCH_FULL_VERIFY_WRITEBACK = badValue;
      process.env.NODE_ENV = 'test';
      process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
      const mod = await import('./env.js');
      expect(mod.env.SEARCH_FULL_VERIFY_WRITEBACK).toBe(badValue === 'on' ? 'on' : 'off');
    }
  });

  // Wave 15 (T907): SEARCH_FULL_POLITENESS semantics (review-T907 D6 fix).
  // Default 'on' so a typo does NOT silently disable the per-bucket
  // admission gate. ONLY an explicit `'off'` disables; any other value
  // (including `'true'`, `'On'`, `'ON'`, empty string, garbage) keeps the
  // gate ON. The parser must never throw at startup on operator-typed
  // input. Mirrors the contract acceptance and the response-marker test
  // (the route adds `politeness: 'off'` to the batch response only when
  // the parser resolved to `'off'`).
  it('SEARCH_FULL_POLITENESS defaults to on when missing', async () => {
    vi.resetModules();
    delete process.env.SEARCH_FULL_POLITENESS;
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./env.js');
    expect(mod.env.SEARCH_FULL_POLITENESS).toBe('on');
  });

  it('SEARCH_FULL_POLITENESS=on is parsed when explicitly set', async () => {
    vi.resetModules();
    process.env.SEARCH_FULL_POLITENESS = 'on';
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./env.js');
    expect(mod.env.SEARCH_FULL_POLITENESS).toBe('on');
  });

  it('SEARCH_FULL_POLITENESS=off is parsed when explicitly set', async () => {
    vi.resetModules();
    process.env.SEARCH_FULL_POLITENESS = 'off';
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    const mod = await import('./env.js');
    expect(mod.env.SEARCH_FULL_POLITENESS).toBe('off');
  });

  it('SEARCH_FULL_POLITENESS coerces non-"off" values (typos) to on without throwing', async () => {
    // The lenient parser must NOT crash startup on operator typos. EVERY
    // non-'off' value (including empty string, garbage, casing variants)
    // resolves to 'on' - only an explicit 'off' disables the gate.
    for (const badValue of ['true', 'True', 'ON', 'On', 'enabled', 'yes', '1', 'abc', '']) {
      vi.resetModules();
      process.env.SEARCH_FULL_POLITENESS = badValue;
      process.env.NODE_ENV = 'test';
      process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
      const mod = await import('./env.js');
      expect(mod.env.SEARCH_FULL_POLITENESS, `badValue=${JSON.stringify(badValue)}`).toBe('on');
    }
  });

  it('CATALOGUE_FEED_URL defaults to the GitHub release and treats blank as unset', async () => {
    delete process.env.CATALOGUE_FEED_URL;
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    let mod = await import('./env.js');
    expect(mod.env.CATALOGUE_FEED_URL).toBe(
      'https://github.com/ItsAakif/clearance/releases/latest/download/catalogue.jsonl.gz',
    );

    vi.resetModules();
    process.env.CATALOGUE_FEED_URL = '';
    process.env.NODE_ENV = 'test';
    process.env.CLEARANCE_ACCESS_PASSWORD = 'test-access-password';
    mod = await import('./env.js');
    expect(mod.env.CATALOGUE_FEED_URL).toBe(
      'https://github.com/ItsAakif/clearance/releases/latest/download/catalogue.jsonl.gz',
    );
  });
});
