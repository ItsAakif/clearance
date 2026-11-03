// Unit tests for the V2 feature-flag reader + the backend/frontend contract
// (Phase 0.2, task T1002).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests).
// `describe`/`it` come from vitest; assertions use `node:assert/strict`,
// matching the existing frontend test style (ProfileMatch.test.ts,
// provenanceLabel.test.ts).
//
// What this file pins:
//   1. every flag is OFF when its env var is unset - the byte-identical default,
//   2. only the two spellings the repo already accepts ('true' / 'on') turn a
//      flag ON; every other spelling leaves it OFF,
//   3. THE CONTRACT: the frontend key list and truthy table are byte-identical
//      to backend/src/config/flags.ts, so one env var drives both runtimes.

import { describe, it, afterEach, vi } from 'vitest';
import assert from 'node:assert/strict';
import {
  flags,
  parseV2Flag,
  V2_FLAG_ENV_KEYS,
  V2_FLAG_TRUTHY_VALUES,
  type FeatureFlags,
} from './flags';
import {
  V2_FLAG_ENV_KEYS as BACKEND_FLAG_ENV_KEYS,
  V2_FLAG_TRUTHY_VALUES as BACKEND_FLAG_TRUTHY_VALUES,
} from '../../backend/src/config/flags';

/** Every key, mapped to the property name on the exported `flags` object. */
const FLAG_PROPERTIES = {
  V2_RESUME_STUDIO: 'v2ResumeStudio',
  V2_DISABLE_FREE_AI_GENERATION: 'v2DisableFreeAiGeneration',
  V2_TYPST_RENDER: 'v2TypstRender',
} as const satisfies Record<(typeof V2_FLAG_ENV_KEYS)[number], keyof FeatureFlags>;

const KEYS = Object.keys(FLAG_PROPERTIES) as (keyof typeof FLAG_PROPERTIES)[];

describe('V2 feature flags - every flag defaults OFF', () => {
  it('exposes exactly the three flag properties, one per key', () => {
    assert.deepEqual(Object.keys(flags).sort(), [
      'v2DisableFreeAiGeneration',
      'v2ResumeStudio',
      'v2TypstRender',
    ]);
  });

  it('resolves all three flags to false when every env var is unset', () => {
    // The test runner defines no V2_* vars, so import.meta.env reads `undefined`
    // and each flag must fall back to its OFF default.
    assert.deepEqual(flags, {
      v2ResumeStudio: false,
      v2DisableFreeAiGeneration: false,
      v2TypstRender: false,
    });
  });
});

describe('V2 feature flags - truthy spellings', () => {
  for (const truthy of V2_FLAG_TRUTHY_VALUES) {
    it(`turns a flag ON for ${JSON.stringify(truthy)}`, () => {
      assert.equal(parseV2Flag(truthy), true);
    });
  }

  // Anything else - including case variants - must stay OFF, so an operator
  // typo can never silently enable a V2 surface.
  const NOT_TRUTHY = [
    undefined,
    'false',
    'off',
    '',
    ' ',
    'TRUE',
    'True',
    'ON',
    'On',
    'yes',
    'y',
    '1',
    'enabled',
    'abc',
  ];

  for (const value of NOT_TRUTHY) {
    it(`leaves a flag OFF for ${JSON.stringify(value)}`, () => {
      assert.equal(parseV2Flag(value), false);
    });
  }
});

describe('V2 feature flags - the reader re-reads import.meta.env on re-import', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('flips the resolved flags when the env vars are stubbed, and back when unset', async () => {
    vi.stubEnv('V2_RESUME_STUDIO', 'true');
    vi.stubEnv('V2_TYPST_RENDER', 'on');
    vi.stubEnv('V2_DISABLE_FREE_AI_GENERATION', 'TRUE'); // typo - stays OFF
    vi.resetModules();

    const on = await import('./flags');
    assert.deepEqual(on.flags, {
      v2ResumeStudio: true,
      v2DisableFreeAiGeneration: false,
      v2TypstRender: true,
    });

    vi.unstubAllEnvs();
    vi.resetModules();
    const off = await import('./flags');
    assert.deepEqual(off.flags, {
      v2ResumeStudio: false,
      v2DisableFreeAiGeneration: false,
      v2TypstRender: false,
    });
  });
});

describe('V2 feature flags - backend/frontend contract', () => {
  it('reads the identical env key names as backend/src/config/flags.ts', () => {
    assert.deepEqual([...V2_FLAG_ENV_KEYS], [...BACKEND_FLAG_ENV_KEYS]);
  });

  it('names exactly the three documented keys, in order', () => {
    assert.deepEqual([...V2_FLAG_ENV_KEYS], [
      'V2_RESUME_STUDIO',
      'V2_DISABLE_FREE_AI_GENERATION',
      'V2_TYPST_RENDER',
    ]);
    assert.equal(KEYS.length, V2_FLAG_ENV_KEYS.length);
  });

  it('accepts the identical truthy spellings as the backend reader', () => {
    assert.deepEqual([...V2_FLAG_TRUTHY_VALUES], [...BACKEND_FLAG_TRUTHY_VALUES]);
    assert.deepEqual([...V2_FLAG_TRUTHY_VALUES], ['true', 'on']);
  });

  it('maps each key to a distinct property on the flags object', () => {
    assert.equal(new Set(Object.values(FLAG_PROPERTIES)).size, KEYS.length);
  });
});
