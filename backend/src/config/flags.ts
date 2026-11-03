// V2 feature flags (Phase 0.2, task T1002; spec
// .planning/specs/clearance-v2/07-migration-and-phases.md sec. F.2 item 0.2).
//
// One reader per runtime, ONE set of env key names, identical in both:
//   V2_RESUME_STUDIO               - the V2 Resume Studio UI (new UI/new API groups)
//   V2_DISABLE_FREE_AI_GENERATION  - retire the fabricating free-generation endpoints
//   V2_TYPST_RENDER                - the Typst/A4 render tier
// The frontend reader is src/lib/flags.ts; its contract test asserts the two key
// lists are the same, so an operator sets the var once and both runtimes see it.
//
// EVERY flag defaults to OFF, and nothing reads them yet (T1003 owns the first
// guard), so a build with none of them set is byte-identical to the pre-flag build.
//
// Truthy parsing deliberately REUSES the spellings this package's config/env.ts
// already accepts instead of inventing a third convention:
//   'true'  - the CAMOUFOX_ENABLED convention (backend/src/browser/client.ts:816
//             reads `env.CAMOUFOX_ENABLED !== 'true'`)
//   'on'    - the SEARCH_ATTRIBUTION / SEARCH_FULL_* convention
// The comparison is EXACT and CASE-SENSITIVE, so an operator typo ('TRUE', 'ON',
// 'On', 'yes', '1', '', garbage) leaves the flag OFF - the same leniency
// config/env.test.ts pins for SEARCH_ATTRIBUTION ('ON' resolves to 'off'). The
// parser is LENIENT: it can never throw at startup on operator-typed input.

import { z } from 'zod';

/** The only values that turn a flag ON. Exported for the cross-runtime contract test. */
export const V2_FLAG_TRUTHY_VALUES = ['true', 'on'] as const;

const TRUTHY: ReadonlySet<string> = new Set<string>(V2_FLAG_TRUTHY_VALUES);

const flagValue = z
  .union([z.enum(V2_FLAG_TRUTHY_VALUES), z.string()])
  .default('false')
  .transform((value) => TRUTHY.has(value));

const flagsSchema = z.object({
  V2_RESUME_STUDIO: flagValue,
  V2_DISABLE_FREE_AI_GENERATION: flagValue,
  V2_TYPST_RENDER: flagValue,
});

export type V2FlagEnvKey = keyof typeof flagsSchema.shape;

/** Env key names, derived from the schema so there is exactly one source of truth. */
export const V2_FLAG_ENV_KEYS: V2FlagEnvKey[] = Object.keys(flagsSchema.shape) as V2FlagEnvKey[];

export interface FeatureFlags {
  v2ResumeStudio: boolean;
  v2DisableFreeAiGeneration: boolean;
  v2TypstRender: boolean;
}

// Typed as a Record over the schema keys: adding a key to the schema without
// reading it here is a compile error, so no flag can be documented-but-dead.
const raw: Record<V2FlagEnvKey, string | undefined> = {
  V2_RESUME_STUDIO: process.env.V2_RESUME_STUDIO,
  V2_DISABLE_FREE_AI_GENERATION: process.env.V2_DISABLE_FREE_AI_GENERATION,
  V2_TYPST_RENDER: process.env.V2_TYPST_RENDER,
};

const parsed = flagsSchema.safeParse(raw);

if (!parsed.success) {
  const formatted = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid feature-flag configuration: ${formatted}`);
}

/** Resolved V2 flags. Read-only by convention: nothing mutates them at runtime. */
export const flags: FeatureFlags = {
  v2ResumeStudio: parsed.data.V2_RESUME_STUDIO,
  v2DisableFreeAiGeneration: parsed.data.V2_DISABLE_FREE_AI_GENERATION,
  v2TypstRender: parsed.data.V2_TYPST_RENDER,
};
