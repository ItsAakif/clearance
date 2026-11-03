/// <reference types="vite/client" />

// V2 feature-flag env keys (Phase 0.2, task T1002).
//
// Declared explicitly (rather than relying on `ImportMetaEnv`'s `[key: string]:
// any` index signature) so a typo in a flag read is a compile error, and so the
// `Record<V2FlagEnvKey, ...>` map in src/lib/flags.ts type-checks against this
// list. The key NAMES are the contract with the backend: they must be identical
// to the keys exported by backend/src/config/flags.ts, which src/lib/flags.test.ts
// asserts. All default to unset (=> flag OFF); see .env.example.
interface ImportMetaEnv {
  readonly VITE_APP_URL?: string;
  readonly V2_RESUME_STUDIO?: string;
  readonly V2_DISABLE_FREE_AI_GENERATION?: string;
  readonly V2_TYPST_RENDER?: string;
}
