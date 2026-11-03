// Unit tests for the V2 feature-flag reader (T1002).
//
// Runner: vitest (`npm test`, backend/vitest.config.ts). Style mirrors
// config/env.test.ts: `config/flags.ts` parses process.env at import time, so
// each case re-imports a fresh module copy with vi.resetModules().
//
// The three things this file pins:
//   1. every flag is OFF when its env var is unset (the byte-identical default),
//   2. only the two spellings the repo already accepts ('true' / 'on') turn a
//      flag ON - every typo stays OFF, and the parser never throws at startup,
//   3. the env key list is exported for the cross-runtime contract test
//      (src/lib/flags.test.ts asserts the frontend reads the same names) and
//      .env.example documents every flag with its default.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { V2_FLAG_ENV_KEYS, V2_FLAG_TRUTHY_VALUES, type FeatureFlags } from './flags.js';

const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '../../..');

/** Every key, mapped to the property name on the exported `flags` object. */
const FLAG_PROPERTIES = {
  V2_RESUME_STUDIO: 'v2ResumeStudio',
  V2_DISABLE_FREE_AI_GENERATION: 'v2DisableFreeAiGeneration',
  V2_TYPST_RENDER: 'v2TypstRender',
} as const satisfies Record<(typeof V2_FLAG_ENV_KEYS)[number], keyof FeatureFlags>;

type FlagEnvKey = keyof typeof FLAG_PROPERTIES;

const KEYS = Object.keys(FLAG_PROPERTIES) as FlagEnvKey[];

async function loadFlags() {
  vi.resetModules();
  const mod = await import('./flags.js');
  return mod.flags;
}

describe('config/flags - env key list', () => {
  it('exports exactly the three documented V2 keys, in order', () => {
    expect(V2_FLAG_ENV_KEYS).toEqual([
      'V2_RESUME_STUDIO',
      'V2_DISABLE_FREE_AI_GENERATION',
      'V2_TYPST_RENDER',
    ]);
  });

  it('accepts only the two truthy spellings this repo already uses', () => {
    expect(V2_FLAG_TRUTHY_VALUES).toEqual(['true', 'on']);
  });

  it('exposes exactly the three flag properties, one per key', async () => {
    const flags = await loadFlags();
    expect(Object.keys(flags).sort()).toEqual([
      'v2DisableFreeAiGeneration',
      'v2ResumeStudio',
      'v2TypstRender',
    ]);
  });
});

describe('config/flags - every flag defaults OFF', () => {
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('resolves all three flags to false when every env var is unset', async () => {
    for (const key of KEYS) delete process.env[key];
    const flags = await loadFlags();
    expect(flags).toEqual({
      v2ResumeStudio: false,
      v2DisableFreeAiGeneration: false,
      v2TypstRender: false,
    });
  });

  it('resolves each individual flag to false when only that one is unset', async () => {
    for (const key of KEYS) {
      for (const other of KEYS) delete process.env[other];
      const flags = await loadFlags();
      expect(flags[FLAG_PROPERTIES[key]], `${key} unset`).toBe(false);
    }
  });
});

describe('config/flags - truthy spellings', () => {
  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
    vi.resetModules();
    vi.restoreAllMocks();
  });

  for (const truthy of V2_FLAG_TRUTHY_VALUES) {
    it(`turns each flag ON for ${JSON.stringify(truthy)}`, async () => {
      for (const key of KEYS) {
        for (const other of KEYS) delete process.env[other];
        process.env[key] = truthy;
        const flags = await loadFlags();
        expect(flags[FLAG_PROPERTIES[key]], `${key}=${truthy}`).toBe(true);
        for (const other of KEYS) {
          if (other === key) continue;
          expect(flags[FLAG_PROPERTIES[other]], `${other} must stay OFF`).toBe(false);
        }
      }
    });
  }

  // Anything else - including case variants - must leave the flag OFF. An
  // operator typo can never silently enable a V2 surface, and the lenient
  // parser must never throw at startup (config/env.test.ts pins the same
  // behaviour for SEARCH_ATTRIBUTION).
  const NOT_TRUTHY = ['false', 'off', '', ' ', 'TRUE', 'True', 'ON', 'On', 'yes', 'y', '1', 'enabled', 'abc'];

  it('leaves every flag OFF for every other spelling, without throwing', async () => {
    for (const key of KEYS) {
      for (const value of NOT_TRUTHY) {
        for (const other of KEYS) delete process.env[other];
        process.env[key] = value;
        const flags = await loadFlags();
        expect(flags[FLAG_PROPERTIES[key]], `${key}=${JSON.stringify(value)}`).toBe(false);
      }
    }
  });
});

describe('config/flags - .env.example documents every flag', () => {
  const example = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  const lines = example.split(/\r?\n/).map((line) => line.trim());

  it.each(KEYS)('documents %s with its default (false)', (key) => {
    expect(lines).toContain(`${key}=false`);
  });

  it('documents both accepted truthy spellings', () => {
    for (const truthy of V2_FLAG_TRUTHY_VALUES) {
      expect(example, `truthy spelling ${truthy} must be documented`).toContain(`\`${truthy}\``);
    }
  });
});
