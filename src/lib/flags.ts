// V2 feature flags - frontend reader (Phase 0.2, task T1002).
//
// The counterpart of backend/src/config/flags.ts. Both readers use the SAME env
// key names so an operator sets the variable once in the root `.env` and the
// server and the browser agree:
//   V2_RESUME_STUDIO               - the V2 Resume Studio UI
//   V2_DISABLE_FREE_AI_GENERATION  - retire the fabricating free-generation endpoints
//   V2_TYPST_RENDER                - the Typst/A4 render tier
// src/lib/flags.test.ts is the contract test that asserts the two key lists (and
// the two truthy tables) are identical, so the lists below must not drift.
//
// EVERY flag defaults to OFF. The values are baked in at build time by Vite
// (see `envPrefix` in vite.config.ts), so flipping a flag for a deployed
// frontend means a rebuild - that is why the backend is the enforcement point
// for the flags that gate behaviour (T1003).
//
// Truthy parsing is the backend's rule verbatim: ONLY the exact, case-sensitive
// strings 'true' and 'on' - the spellings backend/src/config/env.ts already
// accepts for CAMOUFOX_ENABLED and SEARCH_ATTRIBUTION - turn a flag ON. Any
// other value, including 'TRUE', 'ON', 'yes', '1' or the empty string, leaves
// it OFF, so an operator typo can never silently enable a V2 surface.

/** Env key names. MUST match backend/src/config/flags.ts exactly. */
export const V2_FLAG_ENV_KEYS = [
  'V2_RESUME_STUDIO',
  'V2_DISABLE_FREE_AI_GENERATION',
  'V2_TYPST_RENDER',
] as const;

export type V2FlagEnvKey = (typeof V2_FLAG_ENV_KEYS)[number];

/** The only values that turn a flag ON. Mirrors the backend reader. */
export const V2_FLAG_TRUTHY_VALUES = ['true', 'on'] as const;

const TRUTHY: ReadonlySet<string> = new Set<string>(V2_FLAG_TRUTHY_VALUES);

/** Pure parse of one raw env value; exported so the truthy table is testable. */
export function parseV2Flag(raw: string | undefined): boolean {
  return typeof raw === 'string' && TRUTHY.has(raw);
}

export interface FeatureFlags {
  v2ResumeStudio: boolean;
  v2DisableFreeAiGeneration: boolean;
  v2TypstRender: boolean;
}

// Typed as a Record over the key list and read with literal member expressions
// (Vite replaces those statically): a key added to the list above without a
// matching read here is a compile error, not a silently-always-off flag.
const rawEnv: Record<V2FlagEnvKey, string | undefined> = {
  V2_RESUME_STUDIO: import.meta.env.V2_RESUME_STUDIO,
  V2_DISABLE_FREE_AI_GENERATION: import.meta.env.V2_DISABLE_FREE_AI_GENERATION,
  V2_TYPST_RENDER: import.meta.env.V2_TYPST_RENDER,
};

/** Resolved V2 flags. Read-only by convention: nothing mutates them at runtime. */
export const flags: FeatureFlags = {
  v2ResumeStudio: parseV2Flag(rawEnv.V2_RESUME_STUDIO),
  v2DisableFreeAiGeneration: parseV2Flag(rawEnv.V2_DISABLE_FREE_AI_GENERATION),
  v2TypstRender: parseV2Flag(rawEnv.V2_TYPST_RENDER),
};
