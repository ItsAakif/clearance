# Feature Spec: Per-Provider LLM Model Selection (Settings UI + DB)

**Project:** Clearance (AI Resume Builder) - `E:\Projects\Webd+AI\Clearance`
**Status:** Implementation-ready spec v1.0
**Date:** 2026-09-14
**Author:** Architect (Fusion plan role)

---

## 0. OBJECTIVE

Replace every hardcoded LLM model name in the backend with a runtime resolver so the
owner can change the model for each LLM provider (`groq`, `openai`, `openrouter`,
`gemini`) from the Settings UI, persisted in the database. When a provider retires a
model, the owner edits Settings instead of editing code. The dead Groq model
`llama-3.1-70b-versatile` (and the `llama-3.3-70b-versatile` defaults) are removed as
hardcoded literals and replaced by a live, per-provider default table.

**Non-goals:** per-user model settings, per-key model overrides, per-feature UI model
selection, model validation against provider `/models` endpoints (out of scope; see Risks).

---

## 1. ARCHITECTURE DECISIONS

### D1 - Storage: new `AppSetting` key-value model (CHOSEN)

Add a global key-value table:

```prisma
model AppSetting {
  id        String   @id @default(uuid())
  key       String   @unique
  value     String
  updatedAt DateTime @updatedAt
}
```

Keys use the format `model:<provider>`, e.g. `model:groq`, `model:openai`,
`model:openrouter`, `model:gemini`.

**Why:**
- A dedicated table is extensible: future non-model settings reuse the same store.
- Per-key atomic `upsert` (no read-modify-write race that a single JSON blob has).
- `key @unique` gives an indexed lookup used on every LLM call.
- Absence of a row is a meaningful state = "use env override / provider default"
  (seed nothing; see D2).

**Rejected alternatives:**
- *Columns on `AIProviderKey`*: keys are per-user and multiple keys can exist per
  provider; model choice is per-provider and global. Wrong cardinality; would also
  require every lease to join a specific key row.
- *Reuse `AIProviderKey.label`*: `label` already carries Crawl4AI host URLs
  (`keyManager.ts:198`) and user-facing labels. Overloading it is unsafe.
- *Single `AppSetting` row holding a JSON blob*: requires read-modify-write; concurrent
  saves can lose updates; harder to reason about per-provider cache invalidation.
- *Env vars only*: does not solve the stated problem (still requires a redeploy/edit).
- *Per-user settings table*: task explicitly specifies the global `AppSetting`
  (`key @unique`, no `userId`), and `getProviderModel(provider)` has no user scope.
  Clearance is self-hosted / single-owner (see `backend/src/middleware/auth.ts`
  and the "remove multi-user auth" migration), so a global setting is correct.

### D2 - Resolution order (CHOSEN)

For a leased key with provider `P`, resolve the model in this exact order:

1. **DB `AppSetting` row `model:<P>`** - non-empty after `.trim()`.
2. **Legacy per-feature env override** passed by the call site
   (`ATS_MODEL`, `ATS_FALLBACK_MODEL`, `RESUME_TAILOR_MODEL`, `RESUME_PARSE_MODEL`,
   `PROFILE_PARSE_MODEL`) - non-empty after `.trim()`.
3. **Provider default** from the central `DEFAULT_MODELS` table.

**Why DB first:** the Settings UI must be authoritative. If env overrode the DB, an
operator with `ATS_MODEL` set would see the UI do nothing, which is exactly the
"silently broken" failure mode this feature removes. Env vars remain a coarse,
per-feature, provider-agnostic escape hatch and are only consulted when no DB value
exists. Env is read at call time (`process.env.X`) so tests and existing deployments
keep working.

**Trade-off (documented):** because env is per-feature and provider-agnostic, it can
still be applied to a provider it was not intended for (pre-existing behaviour). This
is not made worse by this change. The DB setting is per-provider and therefore the
recommended control.

### D3 - Resolve model AFTER leasing the key

The provider is only known after `leaseNextLlmKey`/`leaseNextKey` returns a
`KeyRecord`. Every call site must lease first, then call
`getProviderModel(key.provider, ...)`. This is why the model cannot stay a
module-level constant.

### D4 - Caching: short TTL on the raw DB value + explicit invalidation

Cache **only the DB value per provider** (never the fully-resolved model, which
depends on per-feature options). This avoids cross-feature cache collisions.
- TTL: 5000 ms.
- `setProviderModel`/`clearProviderModel` delete the provider's cache entry
  immediately, so a Settings save is reflected on the next LLM call in the same
  process.
- Multi-process deployments converge within the TTL (<= 5 s).
- On DB read error the helper logs a warning and returns `null` (falls through to
  env/default) **without caching**, so the app still works if the table is missing.

### D5 - Invalid model errors: wrap with provider + model, preserve status/code

`runLlmCompletion(provider, model, run)` wraps the OpenAI call and rethrows an
`LlmModelError` whose message contains `provider=<p> model=<m>` plus the upstream
message. It copies `status` and `code` from the cause so `isRateLimitError`
(`keyManager.ts:151`) keeps working. Model IDs are **not secrets** - logging them is
fine. API keys are never included (the OpenAI SDK error message does not contain the
key, and we only embed provider/model/message).

---

## 2. FILE / COMPONENT MAP

### New files

| Path | Purpose |
|---|---|
| `backend/src/ai/providerModels.ts` | Resolver, cache, writer, `LlmModelError`, `runLlmCompletion` |
| `backend/src/routes/settings.ts` | `GET/PUT /api/settings/models` |
| `backend/src/ai/providerModels.test.ts` | Resolution precedence + cache + error-wrap tests |
| `backend/src/routes/settings.test.ts` | Route auth + validation + contract tests |
| `backend/prisma/migrations/20260914000000_add_app_settings/migration.sql` | Additive migration |
| `src/services/api/settings.ts` | `settingsApi` + `ModelSettings` types |
| `src/hooks/useSettings.ts` | React Query hooks |

### Modified files

| Path | Change |
|---|---|
| `backend/prisma/schema.prisma` | Add `AppSetting` model |
| `backend/src/shared/validation.ts` | Add model-settings zod schemas |
| `backend/src/routes/index.ts` | Mount `/settings` |
| `backend/src/ai/resumeGenerator.ts` | 5 model literals -> resolver |
| `backend/src/ai/interviewGenerator.ts` | 1 literal + restructure |
| `backend/src/ai/evaluation.ts` | 1 literal -> resolver |
| `backend/src/ats/improver.ts` | const -> resolver |
| `backend/src/ats/refiner.ts` | const -> resolver |
| `backend/src/ats/matchEnhancer.ts` | const -> resolver |
| `backend/src/ats/llmEvaluator.ts` | 2 consts -> resolver |
| `backend/src/resume/parser.ts` | 2 consts -> resolver |
| `backend/src/profile/parser.ts` | const -> resolver |
| `backend/src/routes/tailor.ts` | 1 literal -> resolver |
| `backend/src/ai/providerBaseUrl.test.ts` | Mock `./providerModels.js`; assert model passed |
| `src/services/api/index.ts` | Export `settingsApi`, `ModelSettings`, `LlmModelProvider`, `LLM_MODEL_PROVIDERS` |
| `src/pages/Settings.tsx` | New "AI Models" card |
| `package.json` (root, optional) | Add `typecheck` script |
| `.env.example` (optional) | Document legacy `*_MODEL` env vars |

---

## 3. BACKEND: STORAGE + MIGRATION

### 3.1 `backend/prisma/schema.prisma`

Append after the `QuestionAnswer` model (end of file, line ~444):

```prisma
// ==================== APP SETTINGS ====================
model AppSetting {
  id        String   @id @default(uuid())
  key       String   @unique
  value     String
  updatedAt DateTime @updatedAt
}
```

No relation to `User` (global setting). No seed.

### 3.2 Migration

Create `backend/prisma/migrations/20260914000000_add_app_settings/migration.sql`
with exactly:

```sql
-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_key_key" ON "AppSetting"("key");
```

Apply + regenerate the client (run in `backend`):

```
npm run db:migrate -- --name add_app_settings
npm run db:generate
```

If the database is unreachable in the implementor environment, create the migration
folder/sql above manually and run `npm run db:generate` so `prisma.appSetting` exists.
Do **not** seed any rows (absence = fallback chain).

---

## 4. BACKEND: SHARED HELPER `backend/src/ai/providerModels.ts` (NEW)

Create the file with exactly this content (comments included):

```ts
// Per-provider LLM model resolution.
// Precedence: DB AppSetting `model:<provider>` -> legacy env override -> provider default.
// Model IDs are NOT secrets: logging them is fine. Never log API keys.
import prisma from '../lib/prisma.js';

export const LLM_MODEL_PROVIDERS = ['groq', 'openai', 'openrouter', 'gemini'] as const;
export type LlmModelProvider = (typeof LLM_MODEL_PROVIDERS)[number];

// Live-model defaults. Groq value is verified from the in-repo comment at
// `ats/llmEvaluator.ts:131-133` (the old `llama-3.1-70b-versatile` was
// decommissioned by Groq and returns HTTP 400). The other providers are
// best-effort defaults and are meant to be overridden from Settings.
export const DEFAULT_MODELS: Record<LlmModelProvider, string> = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  openrouter: 'meta-llama/llama-3.3-70b-instruct',
  gemini: 'gemini-2.0-flash',
};

export const MODEL_SETTING_PREFIX = 'model:';

export interface ModelResolutionOptions {
  /** Value of a legacy per-feature env override, e.g. process.env.ATS_MODEL. */
  envOverride?: string | undefined;
  /** Optional feature-specific fallback used before the provider default. */
  fallback?: string | undefined;
}

const CACHE_TTL_MS = 5000;
const dbModelCache = new Map<string, { value: string | null; expiresAt: number }>();

function normalizeProvider(provider: string): LlmModelProvider {
  return (LLM_MODEL_PROVIDERS as readonly string[]).includes(provider)
    ? (provider as LlmModelProvider)
    : 'groq';
}

async function readDbModel(provider: LlmModelProvider): Promise<string | null> {
  const now = Date.now();
  const cached = dbModelCache.get(provider);
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: `${MODEL_SETTING_PREFIX}${provider}` },
    });
    const value = row?.value?.trim() || null;
    dbModelCache.set(provider, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch (error) {
    // Table missing / DB down: fall through to env/default without caching.
    console.warn(
      `[providerModels] Failed to read ${MODEL_SETTING_PREFIX}${provider}; using fallback.`,
      (error as Error).message
    );
    return null;
  }
}

/**
 * Resolve the model for a leased key's provider.
 * Order: DB `model:<provider>` -> options.envOverride -> options.fallback -> DEFAULT_MODELS.
 */
export async function getProviderModel(
  provider: string,
  options: ModelResolutionOptions = {}
): Promise<string> {
  const normalized = normalizeProvider(provider);
  const dbModel = await readDbModel(normalized);
  if (dbModel) return dbModel;

  const envModel = options.envOverride?.trim();
  if (envModel) return envModel;

  const explicitFallback = options.fallback?.trim();
  if (explicitFallback) return explicitFallback;

  return DEFAULT_MODELS[normalized];
}

export async function setProviderModel(provider: string, model: string): Promise<void> {
  const normalized = normalizeProvider(provider);
  const value = model.trim();
  if (!value) {
    await clearProviderModel(normalized);
    return;
  }
  await prisma.appSetting.upsert({
    where: { key: `${MODEL_SETTING_PREFIX}${normalized}` },
    create: { key: `${MODEL_SETTING_PREFIX}${normalized}`, value },
    update: { value },
  });
  dbModelCache.delete(normalized);
}

export async function clearProviderModel(provider: string): Promise<void> {
  const normalized = normalizeProvider(provider);
  await prisma.appSetting.deleteMany({
    where: { key: `${MODEL_SETTING_PREFIX}${normalized}` },
  });
  dbModelCache.delete(normalized);
}

export async function getAllProviderModelSettings(): Promise<{
  models: Record<LlmModelProvider, string>;
  overrides: Partial<Record<LlmModelProvider, string>>;
  defaults: Record<LlmModelProvider, string>;
}> {
  const models = {} as Record<LlmModelProvider, string>;
  const overrides: Partial<Record<LlmModelProvider, string>> = {};
  for (const provider of LLM_MODEL_PROVIDERS) {
    const dbModel = await readDbModel(provider);
    if (dbModel) overrides[provider] = dbModel;
    models[provider] = dbModel || DEFAULT_MODELS[provider];
  }
  return { models, overrides, defaults: { ...DEFAULT_MODELS } };
}

/** Test helper / manual cache bust. */
export function invalidateProviderModelCache(provider?: string): void {
  if (provider) dbModelCache.delete(normalizeProvider(provider));
  else dbModelCache.clear();
}

export class LlmModelError extends Error {
  readonly provider: string;
  readonly model: string;
  status?: number;
  code?: string;

  constructor(provider: string, model: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`LLM call failed (provider=${provider}, model=${model}): ${causeMessage}`);
    this.name = 'LlmModelError';
    this.provider = provider;
    this.model = model;
    const c = cause as { status?: unknown; code?: unknown };
    if (typeof c?.status === 'number') this.status = c.status;
    if (typeof c?.code === 'string') this.code = c.code;
  }
}

/**
 * Run an OpenAI completion and annotate any failure with provider + model so an
 * invalid model string is obvious. Copies status/code so isRateLimitError works.
 */
export async function runLlmCompletion<T>(
  provider: string,
  model: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new LlmModelError(provider, model, error);
  }
}
```

**Import-order / cycle note:** `providerModels.ts` imports only `../lib/prisma.js`.
It deliberately does **not** import `./keyManager.js`, so there is no cycle
(`keyManager` -> prisma/crypto; call sites -> both `keyManager` and `providerModels`).
It defines its own provider list; keep it in sync with `keyManager.ts:22`
(`LLM_PROVIDERS`) and `validation.ts:108`. Do not import `keyManager` here.

---

## 5. BACKEND: VALIDATION `backend/src/shared/validation.ts`

Append after the API key schemas (after line 113, before `JOB DISCOVERY`):

```ts
// ==================== AI MODEL SETTINGS SCHEMAS ====================
export const llmModelProviderSchema = z.enum(['groq', 'openai', 'openrouter', 'gemini']);

// Model IDs look like `llama-3.3-70b-versatile`, `openai/gpt-4o`, `gemini-2.0-flash`.
// Allow letters, digits, dot, underscore, colon, slash, hyphen; must start alphanumeric.
export const llmModelIdSchema = z
  .string()
  .max(200, 'Model ID too long')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/, 'Invalid model ID (letters, digits, . _ : / - only)');

// Empty string = "clear override, use fallback chain".
export const llmModelInputSchema = z.union([z.literal(''), llmModelIdSchema]);

export const updateModelSettingsSchema = z
  .object({
    models: z
      .object({
        groq: llmModelInputSchema.optional(),
        openai: llmModelInputSchema.optional(),
        openrouter: llmModelInputSchema.optional(),
        gemini: llmModelInputSchema.optional(),
      })
      .strict()
      .refine((m) => Object.keys(m).length > 0, { message: 'At least one model is required' }),
  })
  .strict();
```

Notes:
- Do not use `z.record(z.enum(...), ...)`; explicit optional keys are unambiguous across
  zod versions.
- `validateInput` (`validation.ts:265`) already throws `ValidationError` -> 400.

---

## 6. BACKEND: ROUTE `backend/src/routes/settings.ts` (NEW)

```ts
// App Settings routes - per-provider LLM model selection.
// Auth: requireAuth (single-owner self-hosted app; model selection is global).
// Model IDs are not secrets: logging them is fine. Never log API keys.
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError } from '../shared/errors.js';
import { validateInput, updateModelSettingsSchema } from '../shared/validation.js';
import {
  getAllProviderModelSettings,
  setProviderModel,
  clearProviderModel,
  type LlmModelProvider,
} from '../ai/providerModels.js';

const router = Router();

// ==================== GET MODELS ====================
router.get('/models', requireAuth, async (_req: Request, res: Response) => {
  try {
    const settings = await getAllProviderModelSettings();
    res.json(settings);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== UPDATE MODELS ====================
router.put('/models', requireAuth, async (req: Request, res: Response) => {
  try {
    const { models } = validateInput(updateModelSettingsSchema, req.body);
    for (const [provider, value] of Object.entries(models)) {
      const model = (value ?? '').trim();
      if (!model) await clearProviderModel(provider as LlmModelProvider);
      else await setProviderModel(provider as LlmModelProvider, model);
    }
    const settings = await getAllProviderModelSettings();
    res.json(settings);
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
```

**Auth decision:** `requireAuth` for both verbs (not `requireAdmin`). `isAdmin` is
derived from `ADMIN_EMAILS`, which defaults to empty (`config/env.ts:10`,
`getAdminEmails()`), so `requireAdmin` would lock the owner out of Settings by default.
If this app ever becomes multi-tenant, change PUT to `requireAdmin` - noted as a risk.

**Logging decision:** model IDs are not secrets and are safe to log; API keys are
never touched by this route and never logged.

---

## 7. BACKEND: MOUNT ROUTE `backend/src/routes/index.ts`

Add the import after `questionAnswersRoutes` (line 21):

```ts
import settingsRoutes from './settings.js';
```

Add the mount after the `/question-answers` line (line 42):

```ts
router.use('/settings', settingsRoutes);
```

Resulting endpoints: `GET /api/settings/models`, `PUT /api/settings/models`.

---

## 8. BACKEND: CALL-SITE MIGRATION (EXACT)

For every site below: add the import
`import { getProviderModel, runLlmCompletion } from './providerModels.js';`
(or `'../ai/providerModels.js'` from `ats/`, `resume/`, `profile/`, `routes/`),
remove the old module-level model constant, and resolve the model **after** the key
is leased. All line numbers refer to the current file state.

### 8.1 `backend/src/ai/resumeGenerator.ts` (NO env override today)

Import: extend the keyManager import to also bring the `KeyRecord` type and add the
providerModels import:

```ts
import {
  isRateLimitError,
  leaseNextLlmKey,
  markKeyFailure,
  markKeySuccess,
  type KeyRecord,
} from './keyManager.js';
import { getProviderModel, runLlmCompletion } from './providerModels.js';
```

`withLlmClient` (lines 60-82): change the callback signature and pass the key:

```ts
async function withLlmClient<T>(callback: (client: OpenAI, key: KeyRecord) => Promise<T>): Promise<T> {
  const leasedKey = await leaseNextLlmKey();
  const baseURL = leasedKey.provider === 'groq'
    ? 'https://api.groq.com/openai/v1'
    : leasedKey.provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1'
    : leasedKey.provider === 'gemini'
    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : 'https://api.openai.com/v1';
  const client = new OpenAI({ apiKey: leasedKey.apiKey, baseURL });

  try {
    const result = await callback(client, leasedKey);
    await markKeySuccess(leasedKey);
    return result;
  } catch (error) {
    await markKeyFailure(leasedKey, isRateLimitError(error));
    throw error;
  }
}
```

Then each of the five call sites:

**Line 172-184 (`generateResumeFromInput`)** - replace `model: 'llama-3.1-70b-versatile'`:

```ts
const content = await withLlmClient(async (client, key) => {
  const model = await getProviderModel(key.provider);
  const response = await runLlmCompletion(key.provider, model, () =>
    client.chat.completions.create({
      model,
      max_tokens: 2000,
      temperature: 0.7,
      messages: [
        { role: 'system', content: RESUME_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    })
  );
  return response.choices[0]?.message?.content || '';
});
```

**Line 236-248 (`improveResumeBullet`)**:

```ts
const content = await withLlmClient(async (client, key) => {
  const model = await getProviderModel(key.provider);
  const response = await runLlmCompletion(key.provider, model, () =>
    client.chat.completions.create({
      model,
      max_tokens: 200,
      temperature: 0.7,
      messages: [
        { role: 'system', content: 'You are an expert resume writer. Respond with only the improved bullet point.' },
        { role: 'user', content: prompt },
      ],
    })
  );
  return response.choices[0]?.message?.content?.trim() || originalBullet;
});
```

**Line 404-416 (`tailorResumeToJobDescription`)**:

```ts
const content = await withLlmClient(async (client, key) => {
  const model = await getProviderModel(key.provider);
  const response = await runLlmCompletion(key.provider, model, () =>
    client.chat.completions.create({
      model,
      max_tokens: 2000,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a precise, truthful resume editor. Return only valid JSON.' },
        { role: 'user', content: prompt },
      ],
    })
  );
  return response.choices[0]?.message?.content?.trim() || '';
});
```

**Line 483-495 (`extractFromJobDescription`)**:

```ts
const content = await withLlmClient(async (client, key) => {
  const model = await getProviderModel(key.provider);
  const response = await runLlmCompletion(key.provider, model, () =>
    client.chat.completions.create({
      model,
      max_tokens: 800,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: JD_EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    })
  );
  return response.choices[0]?.message?.content || '';
});
```

**Line 555-567 (`generateProfessionalSummary`)**:

```ts
const content = await withLlmClient(async (client, key) => {
  const model = await getProviderModel(key.provider);
  const response = await runLlmCompletion(key.provider, model, () =>
    client.chat.completions.create({
      model,
      max_tokens: 300,
      temperature: 0.7,
      messages: [
        { role: 'system', content: 'You are an expert resume writer. Respond with only the professional summary.' },
        { role: 'user', content: prompt },
      ],
    })
  );
  return response.choices[0]?.message?.content?.trim() || '';
});
```

Do **not** change the retry loops, JSON parsing, or fallbacks in this file.

### 8.2 `backend/src/ai/interviewGenerator.ts` (NO env override today)

Add import: `import { getProviderModel, runLlmCompletion } from './providerModels.js';`

Replace the whole body from the nested `callLlm` (line 42) through the end so the key
is leased **before** the model is resolved and the nested function is removed:

```ts
  const leasedKey = await leaseNextLlmKey();
  const model = await getProviderModel(leasedKey.provider);
  const baseURL = leasedKey.provider === 'groq'
    ? 'https://api.groq.com/openai/v1'
    : leasedKey.provider === 'openrouter'
    ? 'https://openrouter.ai/api/v1'
    : leasedKey.provider === 'gemini'
    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : 'https://api.openai.com/v1';
  const client = new OpenAI({ apiKey: leasedKey.apiKey, baseURL });

  try {
    const response = await runLlmCompletion(leasedKey.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 600,
        temperature: 0.6,
        messages: [
          { role: 'system', content: 'You are an expert interview coach. Return only the answer text.' },
          { role: 'user', content: prompt },
        ],
      })
    );
    const answer = response.choices[0]?.message?.content?.trim() || '';
    await markKeySuccess(leasedKey);
    if (!answer) throw new Error('Empty answer from model');
    return answer;
  } catch (error) {
    await markKeyFailure(leasedKey, isRateLimitError(error));
    throw error;
  }
}
```

(The `callLlm` inner function is deleted entirely.)

### 8.3 `backend/src/ai/evaluation.ts` (NO env override today)

Add import: `import { getProviderModel, runLlmCompletion } from './providerModels.js';`

Replace lines 154-166 (inside `evaluateJob`); `withLlmClient` already passes `key`:

```ts
  const content = await withLlmClient(userId, async (client, key) => {
    const model = await getProviderModel(key.provider);
    const response = await runLlmCompletion(key.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 1500,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: RUBRIC_SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(resume, jobDescription, research, opts.profile) },
        ],
      })
    );
    return response.choices[0]?.message?.content || '';
  });
```

### 8.4 `backend/src/ats/improver.ts`

- Delete line 6: `const IMPROVER_MODEL = process.env.RESUME_TAILOR_MODEL || 'llama-3.1-70b-versatile';`
- Add import: `import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';`
- After `const key = await leaseNextLlmKey();` (line 41) add:

```ts
  const model = await getProviderModel(key.provider, { envOverride: process.env.RESUME_TAILOR_MODEL });
```

- Replace the create call (lines 44-66) header:

```ts
    const resp = await runLlmCompletion(key.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 2000,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [ /* unchanged */ ],
      })
    );
```

Keep the existing `messages` array and the `.match(...)`/JSON parsing unchanged.

### 8.5 `backend/src/ats/refiner.ts`

Same pattern as 8.4:
- Delete line 10: `const REFINER_MODEL = process.env.RESUME_TAILOR_MODEL || 'llama-3.1-70b-versatile';`
- Add `import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';`
- After `const key = await leaseNextLlmKey();` (line 38):

```ts
  const model = await getProviderModel(key.provider, { envOverride: process.env.RESUME_TAILOR_MODEL });
```

- Wrap the create call (lines 41-63) with `runLlmCompletion(key.provider, model, () => ...)` and `model,`.

### 8.6 `backend/src/ats/matchEnhancer.ts`

- Delete line 11: `const MODEL = process.env.ATS_MODEL || 'llama-3.3-70b-versatile';`
- Add `import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';`
- Change `callWithRetry` to accept the model (replace lines 19-38):

```ts
async function callWithRetry(
  client: OpenAI,
  prompt: string,
  key: KeyRecord,
  model: string,
  attempt = 1
): Promise<string> {
  const res = await runLlmCompletion(key.provider, model, () =>
    client.chat.completions.create({
      model,
      max_tokens: 800,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [ /* unchanged */ ],
    })
  );
  return res.choices[0]?.message?.content || '';
}
```

- In `enhanceMatchWithLLM`, place the model resolution **after** the
  `try { key = await leaseNextLlmKey(); } catch { return undefined; }` block (line 50)
  and before the `baseURL` const (line 52), so the no-key -> `undefined` contract is
  preserved:

```ts
  const model = await getProviderModel(key.provider, { envOverride: process.env.ATS_MODEL });
```

- Update the call at line 70 to `await callWithRetry(client, prompt, key, model);`
- Leave the `try/catch` that returns `undefined` on failure unchanged.
- `getProviderModel` is intentionally non-throwing (DB errors are caught in
  `readDbModel`), so adding it here does not break `enhanceMatchWithLLM`'s
  "never throws into the caller" contract. Do not move it above the key lease.

### 8.7 `backend/src/ats/llmEvaluator.ts`

- Delete lines 130-133 (`MODEL`, `FALLBACK_MODEL` constants and the NOTE comment;
  preserve the note's meaning in `DEFAULT_MODELS`'s comment).
- Add `import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';`
- Change `callLLMWithRetry` signature (line 144) to accept `model` and `fallbackModel`:

```ts
async function callLLMWithRetry(
  client: OpenAI,
  prompt: string,
  key: KeyRecord,
  model: string,
  fallbackModel: string,
  attempt = 1
): Promise<LLMEvaluation> {
  const activeModel = attempt === 1 ? model : fallbackModel;
  const response = await runLlmCompletion(key.provider, activeModel, () =>
    client.chat.completions.create({
      model: activeModel,
      max_tokens: 1500,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: prompt },
      ],
    })
  );
  // ... unchanged parsing ...
  if (attempt === 1) {
    return callLLMWithRetry(client, prompt + '\n\nIMPORTANT: Return ONLY valid JSON matching the exact schema. No extra fields, no markdown.', key, model, fallbackModel, 2);
  }
  // ... unchanged ...
}
```

- In `evaluateResumeWithLLM`, after `const key = await leaseNextLlmKey(userId);` (line 184):

```ts
  const model = await getProviderModel(key.provider, { envOverride: process.env.ATS_MODEL });
  const fallbackModel = await getProviderModel(key.provider, { envOverride: process.env.ATS_FALLBACK_MODEL });
```

- Update the call (line 192): `await callLLMWithRetry(client, prompt, key, model, fallbackModel);`

Note: when a DB override exists, `model` and `fallbackModel` resolve to the same value
(consistent with the current default where both are `llama-3.3-70b-versatile`). The
retry still adds a stricter prompt instruction, so it remains useful.

### 8.8 `backend/src/resume/parser.ts`

- Delete lines 163-164 (`RESUME_PARSE_MODEL`, `RESUME_PARSE_FALLBACK`; the fallback
  constant was declared but never used - confirmed by grep, only lines 163/164/221).
- Add `import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';`
- In `parseResumeWithLLM`, after `key = await leaseNextLlmKey(userId);` (line 212):

```ts
  const model = await getProviderModel(key.provider, { envOverride: process.env.RESUME_PARSE_MODEL });
```

- Wrap the create call (lines 220-229):

```ts
    const response = await runLlmCompletion(key.provider, model, () =>
      client.chat.completions.create({
        model,
        max_tokens: 2000,
        temperature: 0.0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: RESUME_PARSE_SYSTEM },
          { role: 'user', content: `RESUME TEXT:\n${rawText}` },
        ],
      })
    );
```

### 8.9 `backend/src/profile/parser.ts`

- Delete line 6: `const PROFILE_PARSE_MODEL = process.env.PROFILE_PARSE_MODEL || 'llama-3.1-70b-versatile';`
- Add `import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';`
- After `const key = await leaseNextLlmKey(userId);` (line 37):

```ts
  const model = await getProviderModel(key.provider, { envOverride: process.env.PROFILE_PARSE_MODEL });
```

- Wrap the create call (lines 40-49) with `runLlmCompletion(key.provider, model, () => ...)` and `model,`.

### 8.10 `backend/src/routes/tailor.ts`

- Add `import { getProviderModel, runLlmCompletion } from '../ai/providerModels.js';`
- `withLlmClient` (line 43) already passes `(client, key)`; change the callback at
  line 167 to `async (client, key) =>` and replace lines 168-180:

```ts
      const model = await getProviderModel(key.provider, { envOverride: process.env.RESUME_TAILOR_MODEL });
      const resp = await runLlmCompletion(key.provider, model, () =>
        client.chat.completions.create({
          model,
          max_tokens: 1800,
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: TAILOR_PROMPT },
            { role: 'user', content: buildTailorUser(resume, jd, profile ? {
              summary: profile.summary || undefined,
              topSkills: (profile.topSkills as string[]) || undefined,
            } : null) },
          ],
        })
      );
      return resp.choices[0]?.message?.content || '';
```

### 8.11 Call-site summary table

| File | Old model literal | Env override | New call |
|---|---|---|---|
| `ai/evaluation.ts:156` | `llama-3.1-70b-versatile` | - | `getProviderModel(key.provider)` |
| `ai/resumeGenerator.ts:174` | `llama-3.1-70b-versatile` | - | `getProviderModel(key.provider)` |
| `ai/resumeGenerator.ts:238` | `llama-3.1-70b-versatile` | - | `getProviderModel(key.provider)` |
| `ai/resumeGenerator.ts:406` | `llama-3.3-70b-versatile` | - | `getProviderModel(key.provider)` |
| `ai/resumeGenerator.ts:485` | `llama-3.3-70b-versatile` | - | `getProviderModel(key.provider)` |
| `ai/resumeGenerator.ts:557` | `llama-3.1-70b-versatile` | - | `getProviderModel(key.provider)` |
| `ai/interviewGenerator.ts:44` | `llama-3.1-70b-versatile` | - | `getProviderModel(key.provider)` |
| `ats/improver.ts:6,45` | `llama-3.1-70b-versatile` | `RESUME_TAILOR_MODEL` | `getProviderModel(key.provider, { envOverride })` |
| `ats/refiner.ts:10,42` | `llama-3.1-70b-versatile` | `RESUME_TAILOR_MODEL` | same |
| `ats/matchEnhancer.ts:11,21` | `llama-3.3-70b-versatile` | `ATS_MODEL` | same |
| `ats/llmEvaluator.ts:130,133,151` | `llama-3.3-70b-versatile` | `ATS_MODEL`, `ATS_FALLBACK_MODEL` | same (x2) |
| `resume/parser.ts:163,164,221` | `llama-3.3-70b-versatile` | `RESUME_PARSE_MODEL` | same |
| `profile/parser.ts:6,41` | `llama-3.1-70b-versatile` | `PROFILE_PARSE_MODEL` | same |
| `routes/tailor.ts:169` | `llama-3.1-70b-versatile` | `RESUME_TAILOR_MODEL` | same |

After migration, run `grep -rn "llama-3.1-70b-versatile\|llama-3.3-70b-versatile" backend/src`
and confirm the only remaining occurrences are inside `providerModels.ts`
(`DEFAULT_MODELS.groq`) and test files.

---

## 9. BACKEND: TEST-COMPATIBILITY FIX `backend/src/ai/providerBaseUrl.test.ts`

This existing test calls `generateInterviewAnswer` and `improveResumeBullet`, which now
call `getProviderModel` -> real DB. Without a mock, the test will hang/fail. Add a mock
for `./providerModels.js` alongside the existing `./keyManager.js` mock (after line 30):

```ts
vi.mock('./providerModels.js', () => ({
  getProviderModel: vi.fn(async () => 'test-model'),
  runLlmCompletion: async (_provider: string, _model: string, run: () => Promise<unknown>) => run(),
  DEFAULT_MODELS: {
    groq: 'llama-3.3-70b-versatile',
    openai: 'gpt-4o-mini',
    openrouter: 'meta-llama/llama-3.3-70b-instruct',
    gemini: 'gemini-2.0-flash',
  },
}));
```

Also add one assertion to prove the resolved model reaches the SDK. In the first test
(after line 54) add:

```ts
    expect(completionHandler).toHaveBeenCalled();
    expect((completionHandler.mock.calls[0][0] as { model?: string }).model).toBe('test-model');
```

Do not change the baseURL assertions.

---

## 10. BACKEND: TESTS

### 10.1 `backend/src/ai/providerModels.test.ts` (NEW)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockAppSetting } = vi.hoisted(() => ({
  mockAppSetting: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: { appSetting: mockAppSetting } }));

import {
  getProviderModel,
  setProviderModel,
  clearProviderModel,
  getAllProviderModelSettings,
  invalidateProviderModelCache,
  runLlmCompletion,
  LlmModelError,
  DEFAULT_MODELS,
} from './providerModels.js';

describe('providerModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateProviderModelCache();
    mockAppSetting.findUnique.mockResolvedValue(null);
  });

  it('returns the DB override even when an env override is supplied', async () => {
    mockAppSetting.findUnique.mockResolvedValue({ key: 'model:groq', value: 'custom-groq' });
    await expect(getProviderModel('groq', { envOverride: 'env-model' })).resolves.toBe('custom-groq');
  });

  it('falls back to env override when no DB row exists', async () => {
    await expect(getProviderModel('groq', { envOverride: 'env-model' })).resolves.toBe('env-model');
  });

  it('falls back to the provider default when nothing is set', async () => {
    await expect(getProviderModel('openai')).resolves.toBe(DEFAULT_MODELS.openai);
  });

  it('trims blank DB/env values and falls through', async () => {
    mockAppSetting.findUnique.mockResolvedValue({ key: 'model:groq', value: '   ' });
    await expect(getProviderModel('groq', { envOverride: '  ' })).resolves.toBe(DEFAULT_MODELS.groq);
  });

  it('normalizes unknown providers to groq', async () => {
    await expect(getProviderModel('anthropic')).resolves.toBe(DEFAULT_MODELS.groq);
  });

  it('caches DB reads within the TTL', async () => {
    await getProviderModel('groq');
    await getProviderModel('groq');
    expect(mockAppSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('re-reads after invalidateProviderModelCache', async () => {
    await getProviderModel('groq');
    invalidateProviderModelCache('groq');
    await getProviderModel('groq');
    expect(mockAppSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('setProviderModel upserts model:<provider> and invalidates the cache', async () => {
    await setProviderModel('groq', '  new-model  ');
    expect(mockAppSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'model:groq' },
      create: { key: 'model:groq', value: 'new-model' },
      update: { value: 'new-model' },
    });
    await getProviderModel('groq');
    expect(mockAppSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it('clearProviderModel deletes model:<provider>', async () => {
    await clearProviderModel('openai');
    expect(mockAppSetting.deleteMany).toHaveBeenCalledWith({ where: { key: 'model:openai' } });
  });

  it('swallows DB errors and returns the default without caching', async () => {
    mockAppSetting.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(getProviderModel('gemini')).resolves.toBe(DEFAULT_MODELS.gemini);
    await getProviderModel('gemini');
    expect(mockAppSetting.findUnique).toHaveBeenCalledTimes(2);
  });

  it('getAllProviderModelSettings returns effective, overrides and defaults', async () => {
    mockAppSetting.findUnique.mockImplementation(async ({ where }: any) =>
      where.key === 'model:groq' ? { key: where.key, value: 'custom-groq' } : null
    );
    const settings = await getAllProviderModelSettings();
    expect(settings.models.groq).toBe('custom-groq');
    expect(settings.overrides).toEqual({ groq: 'custom-groq' });
    expect(settings.defaults).toEqual(DEFAULT_MODELS);
    expect(Object.keys(settings.models).sort()).toEqual(['gemini', 'groq', 'openai', 'openrouter']);
  });

  it('runLlmCompletion wraps errors with provider+model and preserves status/code', async () => {
    const cause = Object.assign(new Error('rate limit exceeded'), { status: 429, code: 'rate_limit_exceeded' });
    try {
      await runLlmCompletion('groq', 'dead-model', async () => { throw cause; });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(LlmModelError);
      const e = error as LlmModelError;
      expect(e.message).toContain('provider=groq');
      expect(e.message).toContain('model=dead-model');
      expect(e.message).toContain('rate limit exceeded');
      expect(e.status).toBe(429);
      expect(e.code).toBe('rate_limit_exceeded');
    }
  });
});
```

### 10.2 `backend/src/routes/settings.test.ts` (NEW)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { authState, prismaMocks } = vi.hoisted(() => ({
  authState: { enabled: true },
  prismaMocks: {
    appSetting: { findUnique: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!authState.enabled) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = { id: 'user-1', email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

import settingsRouter from './settings.js';
import { invalidateProviderModelCache } from '../ai/providerModels.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', settingsRouter);
  return app;
}

describe('settings models route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.enabled = true;
    invalidateProviderModelCache();
    prismaMocks.appSetting.findUnique.mockResolvedValue(null);
    prismaMocks.appSetting.upsert.mockResolvedValue({});
    prismaMocks.appSetting.deleteMany.mockResolvedValue({ count: 0 });
  });

  it('GET returns effective models, overrides and defaults (contract shape)', async () => {
    const res = await request(makeApp()).get('/models');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['defaults', 'models', 'overrides']);
    expect(Object.keys(res.body.models).sort()).toEqual(['gemini', 'groq', 'openai', 'openrouter']);
    expect(Object.keys(res.body.defaults).sort()).toEqual(['gemini', 'groq', 'openai', 'openrouter']);
    expect(res.body.models.groq).toBe('llama-3.3-70b-versatile');
  });

  it('GET reflects a stored override', async () => {
    prismaMocks.appSetting.findUnique.mockImplementation(async ({ where }: any) =>
      where.key === 'model:groq' ? { key: where.key, value: 'custom' } : null
    );
    const res = await request(makeApp()).get('/models');
    expect(res.body.models.groq).toBe('custom');
    expect(res.body.overrides).toEqual({ groq: 'custom' });
  });

  it('PUT persists a valid model', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { groq: 'llama-3.3-70b-versatile' } });
    expect(res.status).toBe(200);
    expect(prismaMocks.appSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'model:groq' },
      create: { key: 'model:groq', value: 'llama-3.3-70b-versatile' },
      update: { value: 'llama-3.3-70b-versatile' },
    });
  });

  it('PUT with an empty string clears the override', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { groq: '' } });
    expect(res.status).toBe(200);
    expect(prismaMocks.appSetting.deleteMany).toHaveBeenCalledWith({ where: { key: 'model:groq' } });
    expect(prismaMocks.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('rejects model IDs with spaces', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { groq: 'bad model' } });
    expect(res.status).toBe(400);
    expect(prismaMocks.appSetting.upsert).not.toHaveBeenCalled();
  });

  it('rejects model IDs longer than 200 chars', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { openai: 'a'.repeat(201) } });
    expect(res.status).toBe(400);
  });

  it('rejects unknown providers', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { anthropic: 'claude-3' } });
    expect(res.status).toBe(400);
  });

  it('rejects an empty models object', async () => {
    const res = await request(makeApp()).put('/models').send({ models: {} });
    expect(res.status).toBe(400);
  });

  it('rejects unknown top-level fields', async () => {
    const res = await request(makeApp()).put('/models').send({ models: { groq: 'x' }, evil: true });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    authState.enabled = false;
    expect((await request(makeApp()).get('/models')).status).toBe(401);
    expect((await request(makeApp()).put('/models').send({ models: { groq: 'x' } })).status).toBe(401);
  });
});
```

### 10.3 Commands

From `backend`:

```
npm test
```

From repo root (frontend build/lint; see 12.3 for the optional typecheck):

```
npm run build
npm run lint
```

---

## 11. FRONTEND

### 11.1 `src/services/api/settings.ts` (NEW)

```ts
// Per-provider LLM model settings API.
import { apiClient } from './client';

export type LlmModelProvider = 'groq' | 'openai' | 'openrouter' | 'gemini';

export const LLM_MODEL_PROVIDERS: LlmModelProvider[] = ['groq', 'openai', 'openrouter', 'gemini'];

// Mirrors the backend GET/PUT /api/settings/models response.
export interface ModelSettings {
  models: Record<LlmModelProvider, string>;
  overrides: Partial<Record<LlmModelProvider, string>>;
  defaults: Record<LlmModelProvider, string>;
}

export const settingsApi = {
  getModels: () => apiClient.get<ModelSettings>('/settings/models'),
  updateModels: (models: Partial<Record<LlmModelProvider, string>>) =>
    apiClient.put<ModelSettings>('/settings/models', { models }),
};
```

### 11.2 `src/services/api/index.ts`

Add to the value export block (after the jobs line 7):

```ts
export { settingsApi, LLM_MODEL_PROVIDERS } from "./settings";
```

Add to the type export block (after line 14):

```ts
export type { ModelSettings, LlmModelProvider } from "./settings";
```

### 11.3 `src/hooks/useSettings.ts` (NEW)

```ts
// React Query hooks for per-provider LLM model settings.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@/services/api';
import type { LlmModelProvider, ModelSettings } from '@/services/api';
import { toast } from './use-toast';

export const modelSettingsQueryKey = ['settings', 'models'] as const;

export function useModelSettings() {
  return useQuery({ queryKey: modelSettingsQueryKey, queryFn: () => settingsApi.getModels() });
}

export function useUpdateModelSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (models: Partial<Record<LlmModelProvider, string>>) => settingsApi.updateModels(models),
    onSuccess: (data: ModelSettings) => {
      qc.setQueryData(modelSettingsQueryKey, data);
      toast({ title: 'Models saved', description: 'Per-provider model selection updated.' });
    },
    onError: (e: Error) => toast({ title: 'Failed to save models', description: e.message, variant: 'destructive' }),
  });
}
```

### 11.4 `src/pages/Settings.tsx`

**Imports** - add `useEffect` to the React import (line 1):

```tsx
import { useEffect, useState } from "react";
```

Add `Cpu` to the lucide-react import list (line 4-16).

Add after the existing hook imports (after line 46):

```tsx
import { useModelSettings, useUpdateModelSettings } from "@/hooks/useSettings";
import { LLM_MODEL_PROVIDERS } from "@/services/api";
import type { LlmModelProvider } from "@/services/api";
```

Add a label map near `KEY_PROVIDERS` (after line 204):

```tsx
const MODEL_PROVIDER_LABELS: Record<LlmModelProvider, string> = {
  groq: "Groq",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  gemini: "Gemini",
};
```

**State + handler** - inside `SettingsPage`, after the BYOK state (after line 224):

```tsx
  // AI Models (per-provider)
  const { data: modelSettings } = useModelSettings();
  const updateModels = useUpdateModelSettings();
  const [modelInputs, setModelInputs] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!modelSettings) return;
    setModelInputs({ ...modelSettings.overrides });
  }, [modelSettings]);

  const handleSaveModels = async () => {
    const payload: Partial<Record<LlmModelProvider, string>> = {};
    for (const provider of LLM_MODEL_PROVIDERS) {
      payload[provider] = (modelInputs[provider] ?? "").trim();
    }
    try {
      await updateModels.mutateAsync(payload);
    } catch {
      // toast handled by useUpdateModelSettings.onError
    }
  };
```

**JSX card** - insert directly after the API Keys `</motion.div>` (after line 451)
and before the Setup Guide card:

```tsx
            {/* AI Models (per-provider) */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.27 }}
            >
              <Card className="p-6">
                <div className="mb-4 flex items-center gap-2">
                  <Cpu className="h-5 w-5 text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">AI Models</h2>
                </div>
                <p className="mb-4 text-sm text-muted-foreground">
                  Choose which model each LLM provider uses. Leave a field empty to use the
                  built-in default. If a provider retires a model, update it here without a
                  redeploy. Legacy <code>ATS_MODEL</code>, <code>RESUME_TAILOR_MODEL</code> and{" "}
                  <code>RESUME_PARSE_MODEL</code> env vars are still honored when no value is set here.
                </p>
                <div className="space-y-3">
                  {LLM_MODEL_PROVIDERS.map((provider) => (
                    <div key={provider} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                      <div className="min-w-0">
                        <label className="text-sm font-medium text-foreground">
                          {MODEL_PROVIDER_LABELS[provider]}
                        </label>
                        <Input
                          autoComplete="off"
                          spellCheck={false}
                          value={modelInputs[provider] ?? ""}
                          onChange={(e) => setModelInputs((prev) => ({ ...prev, [provider]: e.target.value }))}
                          placeholder={`Default: ${modelSettings?.defaults[provider] ?? ""}`}
                          className="mt-1 font-mono text-sm"
                        />
                      </div>
                      {modelSettings?.overrides?.[provider] ? (
                        <Badge variant="secondary" className="text-[10px]">Custom</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">Default</Badge>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-5 flex justify-end">
                  <Button onClick={handleSaveModels} disabled={updateModels.isPending || !modelSettings}>
                    {updateModels.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                      </>
                    ) : (
                      "Save Models"
                    )}
                  </Button>
                </div>
              </Card>
            </motion.div>
```

`Badge`, `Card`, `Button`, `Input`, `Loader2` are already imported in this file.

---

## 12. TESTING STRATEGY

### 12.1 Unit - resolution precedence (`backend/src/ai/providerModels.test.ts`)
Covers: DB > env > default; trim/blank handling; unknown-provider normalization; TTL
cache; explicit invalidation; upsert/delete; DB-error resilience without caching; error
wrapping with provider+model and preserved `status`/`code`.

### 12.2 Route - auth + validation + contract (`backend/src/routes/settings.test.ts`)
Covers: 401 when unauthenticated; GET response contract (`models`/`overrides`/`defaults`
and exactly four provider keys); PUT persistence; empty-string reset; invalid charset;
over-length; unknown provider; empty `models`; unknown top-level field.

### 12.3 Frontend type round-trip
There is **no frontend test runner** in this repo (root `package.json` has no `test`
script and no `src/**/*.test.*` files). The round-trip guarantee is therefore:
1. The backend contract test asserts the exact JSON shape
   (`{ models, overrides, defaults }`, four provider keys) that
   `src/services/api/settings.ts#ModelSettings` mirrors.
2. Add an optional root `typecheck` script to make the TS contract verifiable:

   In root `package.json` `scripts`, add:
   ```json
   "typecheck": "tsc --noEmit -p tsconfig.app.json"
   ```
   Then run `npm run typecheck`. **Caveat:** this repo has never run `tsc` on the
   frontend, so pre-existing errors may surface. Fix only errors caused by this change;
   do not refactor unrelated files. If the script reveals many unrelated errors, drop
   the script and rely on `npm run lint` + the backend contract test.

### 12.4 Regression
- `backend/src/ai/providerBaseUrl.test.ts` (updated per section 9) proves the resolved
  model reaches the OpenAI SDK and baseURL selection still works.
- `backend/src/resume/parser.test.ts` must keep passing: it imports `parser.ts`
  (which now imports `providerModels.ts` -> `prisma`), but only calls deterministic
  functions, so no DB query occurs. PrismaClient is instantiated lazily.

### 12.5 Exact commands
```
# from backend/
npm test

# from repo root
npm run build
npm run lint
npm run typecheck   # only if the script from 12.3 was added
```

Expected: all backend tests pass; `npm run build` and `npm run lint` succeed.

---

## 13. ACCEPTANCE CRITERIA

1. `GET /api/settings/models` (authenticated) returns
   `{ models, overrides, defaults }` with exactly `groq|openai|openrouter|gemini`.
2. `PUT /api/settings/models` persists `model:<provider>` rows via `AppSetting.upsert`
   and returns the updated settings; empty string removes the row.
3. Invalid model IDs (whitespace, >200 chars, bad charset), unknown providers, empty
   `models`, and unknown top-level fields all return 400.
4. Both endpoints return 401 without a session.
5. No hardcoded LLM model literal remains in any backend AI service; all 14 call sites
   resolve via `getProviderModel`.
6. `ATS_MODEL`, `ATS_FALLBACK_MODEL`, `RESUME_TAILOR_MODEL`, `RESUME_PARSE_MODEL`,
   `PROFILE_PARSE_MODEL` still take effect when no DB override is set.
7. Changing a model in Settings affects the next LLM call (cache invalidated on write;
   TTL <= 5 s across processes).
8. An invalid/retired model surfaces an error containing `provider=<p>` and
   `model=<m>`; no API key is present in the error/log.
9. Settings UI shows one input per LLM provider, prefilled with overrides and a
   "Default: <model>" placeholder, plus a working Save.
10. `AppSetting` migration is additive; no rows are seeded; absence = fallback chain.

---

## 14. CONSTRAINTS - WHAT NOT TO TOUCH

- Do **not** change `keyManager.ts` (no provider-list export needed; `providerModels.ts`
  is self-contained). `leaseNextLlmKey` signature stays `(userId?, preferred?)`.
- Do **not** change baseURL selection logic in any service.
- Do **not** change prompts, JSON parsing, retry counts, or graceful fallbacks.
- Do **not** change `AIProviderKey` schema or the `/keys` routes/UI.
- Do **not** add per-user or per-key model settings.
- Do **not** log API keys; `runLlmCompletion` must only embed provider, model, and the
  upstream error message.
- Do **not** seed `AppSetting` rows.
- Do **not** rename/remove the legacy `*_MODEL` env vars.
- `backend/src/ai/llmEvaluator.ts` does not exist - the ATS evaluator is
  `backend/src/ats/llmEvaluator.ts`. Do not create a duplicate.
- Leave the unused `generateInterviewAnswer` HTTP route gap alone (no
  `/ai/generate-interview-answer` route exists today); it is out of scope.

---

## 15. VERIFIED (what was confirmed by reading the repo)

- No `AppSetting`/KV table exists (`prisma/schema.prisma`; grep for `appSetting` = 0).
- Exact hardcoded model literals and line numbers (grep results in sections 8.11).
- `evaluation.ts`, `resumeGenerator.ts`, `interviewGenerator.ts`, `tailor.ts:169`,
  `profile/parser.ts` have **no** per-feature env override today; `improver.ts`/
  `refiner.ts` use `RESUME_TAILOR_MODEL`; `matchEnhancer.ts`/`llmEvaluator.ts` use
  `ATS_MODEL`; `resume/parser.ts` uses `RESUME_PARSE_MODEL`; `profile/parser.ts` uses
  `PROFILE_PARSE_MODEL`.
- `resume/parser.ts:164` `RESUME_PARSE_FALLBACK` is declared but never used.
- `ats/llmEvaluator.ts:131-133` comment states `llama-3.1-70b-versatile` was
  decommissioned by Groq and returns HTTP 400; the live family in code is
  `llama-3.3-70b-versatile`. This is the only in-repo evidence for a live model.
- `withLlmClient` in `evaluation.ts` and `tailor.ts` already passes `(client, key)`;
  `resumeGenerator.ts`/`interviewGenerator.ts` do not pass the key.
- `providerBaseUrl.test.ts` mocks `./keyManager.js` and `openai`, and calls the
  now-migrating functions - it **must** gain a `./providerModels.js` mock.
- `requireAdmin` depends on `req.user.isAdmin`, derived from `ADMIN_EMAILS`, which
  defaults to empty (`config/env.ts`), so `requireAuth` is the correct route guard.
- Test infra: backend = vitest (`backend/vitest.config.ts`, `npm test`); frontend has
  **no** test runner and no `test` script in root `package.json`.
- Backend `tsconfig.json` has no `noUnusedLocals`, so removing the old constants is
  safe even if a stray reference were missed (but none should remain).
- `routes/index.ts` is the single mount point; `app.ts` mounts it at `/api`.

---

## 16. RISKS / OPEN QUESTIONS

1. **Global write by any authenticated user.** The setting is global and PUT uses
   `requireAuth`. In a multi-tenant deployment this is a privilege issue. Mitigation:
   switch PUT to `requireAdmin` (requires `ADMIN_EMAILS` to be configured). Documented
   in D5/section 6.
2. **Non-Groq defaults are best-effort.** Only the Groq default is verifiable from the
   repo. `gpt-4o-mini`, `meta-llama/llama-3.3-70b-instruct`, `gemini-2.0-flash` may
   drift. This is exactly why the Settings override exists. The plan does not browse;
   if the implementor can verify provider model lists, update `DEFAULT_MODELS` and its
   comment accordingly.
3. **Mid-use model changes.** Model is resolved once per LLM call, after key leasing.
   In-flight calls keep the old model; the next call uses the new one. Cache TTL means
   cross-process propagation can take up to 5 s; same-process writes invalidate
   immediately.
4. **Invalid model strings are only caught at call time.** No pre-flight validation
   against provider `/models`. Mitigation: `LlmModelError` reports provider + model;
   the UI allows correction. Pre-flight validation is a possible follow-up.
5. **DB table missing before migration.** `readDbModel` catches the error, logs, and
   falls back; the feature degrades to defaults rather than crashing.
6. **Test mock coupling.** Any new test that imports an AI service exercising LLM calls
   must mock `./providerModels.js` (or the DB) to avoid a real Prisma connection.
7. **`z.record` avoided deliberately** to prevent zod-version key-schema ambiguity;
   explicit optional provider keys are used instead.
8. **Frontend typecheck is optional.** Adding `tsc --noEmit` may surface pre-existing
   frontend type errors unrelated to this change; the plan scopes that decision in 12.3.

---

## 17. IMPLEMENTOR CHECKLIST (1:1 with steps)

- [ ] Add `AppSetting` to `backend/prisma/schema.prisma` (section 3.1).
- [ ] Create migration `backend/prisma/migrations/20260914000000_add_app_settings/migration.sql` (3.2).
- [ ] Run `npm run db:migrate -- --name add_app_settings` and `npm run db:generate` in `backend`.
- [ ] Create `backend/src/ai/providerModels.ts` exactly (section 4).
- [ ] Add model-settings schemas to `backend/src/shared/validation.ts` (section 5).
- [ ] Create `backend/src/routes/settings.ts` (section 6).
- [ ] Mount `/settings` in `backend/src/routes/index.ts` (section 7).
- [ ] Migrate `ai/resumeGenerator.ts` (8.1) - 5 sites + `withLlmClient` key param.
- [ ] Migrate `ai/interviewGenerator.ts` (8.2) - restructure.
- [ ] Migrate `ai/evaluation.ts` (8.3).
- [ ] Migrate `ats/improver.ts` (8.4).
- [ ] Migrate `ats/refiner.ts` (8.5).
- [ ] Migrate `ats/matchEnhancer.ts` (8.6).
- [ ] Migrate `ats/llmEvaluator.ts` (8.7).
- [ ] Migrate `resume/parser.ts` (8.8) - delete both constants.
- [ ] Migrate `profile/parser.ts` (8.9).
- [ ] Migrate `routes/tailor.ts` (8.10).
- [ ] Confirm `grep -rn "llama-3.1-70b-versatile\|llama-3.3-70b-versatile" backend/src` shows only `providerModels.ts` + tests.
- [ ] Update `backend/src/ai/providerBaseUrl.test.ts` (section 9).
- [ ] Create `backend/src/ai/providerModels.test.ts` (10.1).
- [ ] Create `backend/src/routes/settings.test.ts` (10.2).
- [ ] Run `npm test` in `backend` - all green.
- [ ] Create `src/services/api/settings.ts` (11.1).
- [ ] Export from `src/services/api/index.ts` (11.2).
- [ ] Create `src/hooks/useSettings.ts` (11.3).
- [ ] Add the "AI Models" card to `src/pages/Settings.tsx` (11.4).
- [ ] Run `npm run build` and `npm run lint` at root.
- [ ] (Optional) add root `typecheck` script and run it (12.3).
- [ ] (Optional) document `*_MODEL` env vars in `.env.example`.
- [ ] Verify acceptance criteria 1-10 (section 13).
