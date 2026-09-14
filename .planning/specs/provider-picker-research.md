# Provider / Model Selector UI — Research Survey

**Date:** 2026-09-14
**Author:** architect (research survey; dedicated research subagent unavailable)
**Purpose:** Find open-source AI provider/model selector UIs and patterns that Clearance
(React 18 + shadcn/ui + Tailwind 3.4, Vite, Express + Prisma backend) can reuse or copy to
replace its hardcoded per-provider key rows + separate model box with a unified
"Add provider -> enter key -> pick model" flow (Kilo Code / Copilot style).
**Status:** Research only. No application code was modified.

---

## 0. TL;DR

- **No drop-in React component exists that is worth adopting wholesale.** The two best-known
  tools (Kilo Code, Roo Code, Cline, Continue, LibreChat) are either SolidJS (Kilo) or deeply
  coupled to VS Code messaging / their own data layer (Roo/Cline/Continue/LibreChat).
- **The reusable assets are: (a) interaction patterns, (b) provider preset data, (c) zod-schema
  patterns, (d) the "fetch models from the provider's /models endpoint" mechanism.**
- **Best pattern source: Kilo Code** (MIT) — `DialogSelectProvider -> DialogConnectProvider ->
  model picker` flow, searchable/grouped lists, custom-provider support with auto-fetch.
- **Best data/schema source: Roo Code** (Apache-2.0) — per-provider zod schemas,
  `MODELS_BY_PROVIDER`, dynamic-vs-static-vs-local provider classification.
- **Best headless React library to copy from: `open-model-selector`** (MIT, cmdk + Radix
  Popover, fetches `{baseUrl}/models`, ships normalizers for 10+ OpenAI-compatible providers).
  Also `@tombcato/ai-selector` (MIT, 20+ providers, `useAIConfig` headless hook) and
  `ai-sdk-react-model-picker` (Apache-2.0, Continue-derived).
- **Model fetching is solved for every provider in scope.** OpenAI, OpenRouter, Groq, Mistral,
  DeepSeek, Together, Fireworks, Z.ai, Azure, Ollama, LM Studio all expose a `/models`-style
  endpoint. **Anthropic now has `GET /v1/models` too** (added 2025) — the old "no list
  endpoint, hardcode it" situation is outdated. Gemini exposes `GET /v1beta/models`
  (strip the `models/` prefix). Z.ai's `/paas/v4/models` exists but is unreliable (returns
  coding-only models per zai-org/z-ai-sdk-python#68) — use a hardcoded catalog for Z.ai.
- **Key architectural constraint for Clearance:** every current Clearance LLM call goes through
  the OpenAI SDK with a provider-specific `baseURL`. That extends cleanly to groq/openai/
  openrouter/gemini/zai/deepseek/mistral/together/fireworks/ollama/lmstudio/azure (azure via
  `defaultHeaders: { "api-key": ... }`). **Anthropic is the only provider that is NOT
  OpenAI-compatible** (own `/v1/messages` protocol, `x-api-key` + `anthropic-version` headers)
  and needs a separate client path.

---

## 1. Kilo Code (github.com/Kilo-Org/kilocode)

| Field | Value |
|---|---|
| Repo / npm | `Kilo-Org/kilocode` (monorepo; VS Code ext, JetBrains plugin, CLI). No reusable npm package for the UI. |
| License | **MIT** (clients). Gateway/Cloud backend is source-available, not MIT — do not copy backend. |
| Stack | **SolidJS** (both the CLI TUI `packages/app` and the VS Code webview `packages/kilo-vscode/webview-ui` use Solid primitives: `createSignal`, `createMemo`, `onCleanup`). Kilo is a fork of OpenCode (opencode-ai). |
| Stars / activity | ~21k stars, very active (2026). |

### The flow to copy (verified from source)

1. `ModelSelectorPopover` (`packages/app/src/components/dialog-select-model.tsx`) — popover
   with a searchable model list, grouped by provider, "Recommended" providers first
   (`popularProviders` from `@/hooks/use-providers`), free/latest tags, tooltip metadata.
   Header actions: **"+" (connect provider)** and **sliders (manage models)**.
2. `DialogSelectProvider` (`dialog-select-provider.tsx`) — searchable list of providers,
   grouped "Recommended" / "Other", plus a **Custom provider** entry. Selecting one opens
   `DialogConnectProvider`.
3. `DialogConnectProvider` — enter API key; validates; then fetches available models.
4. `DialogCustomProvider` — custom OpenAI-compatible provider: display name, base URL,
   headers, env auth, model list. PR #12217 ("improve custom provider setup") is the reference
   implementation: inline validation that keeps the dialog open on error, **auto-discover
   models from the provider and pick from a searchable list instead of typing model IDs**,
   edit/delete with confirmation, preserve manually-entered models when re-fetching.
5. VS Code webview equivalent: `packages/kilo-vscode/webview-ui/src/components/shared/ModelSelector.tsx`
   (search, favorites, recommended group, provider grouping, keyboard nav, disabled states for
   unconfigured providers) + `webview-ui/src/components/kilocode/hooks/useProviderModels.ts`
   (per-provider model resolution: static catalogs for groq/deepseek/mistral/xai/cerebras,
   router-fetched for openrouter/requesty/litellm, localhost-discovered for ollama/lmstudio).

### Reusable for Clearance

- **Patterns (high value):** the 3-step dialog cascade; searchable grouped lists; "custom
  provider" with auto-fetch; disabled/greyed models for unconfigured providers.
- **Provider catalog data (medium value):** Kilo's own catalog is served by the commercial
  Kilo Gateway (500+ models) — **not reusable**. The BYOK custom-provider flow is.
- **Components (none):** SolidJS, not React. Porting = rewrite in React/shadcn.

### Adaptation effort

Medium. Port the flow into shadcn primitives (Dialog, Command/cmdk for search, Popover).
The app already has `cmdk` and all Radix primitives installed. No license risk (MIT).

---

## 2. Roo Code (RooCodeInc/Roo-Code) and Cline (cline/cline)

| Field | Value |
|---|---|
| Repo | `RooCodeInc/Roo-Code` (archived 2026; community fork `Zoo-Code-Org/Zoo-Code` continues it). Cline: `cline/cline`. |
| License | **Apache-2.0** (both). |
| Stack | TypeScript. VS Code extension; webview UI is **React** (Roo's `src/webview-ui`), but every component talks to the extension host via `postMessage` — not portable as-is. |

### Architecture worth copying (verified from source)

- `packages/types/src/provider-settings.ts`:
  - Per-provider zod schemas (`anthropicSchema`, `openRouterSchema`, `deepSeekSchema`,
    `zaiSchema`, `fireworksSchema`, `ollamaSchema`, `lmStudioSchema`, ...) merged into one
    flat `providerSettingsSchema` — **the exact pattern Clearance's `validation.ts` should
    adopt** for a growing provider list.
  - `MODELS_BY_PROVIDER: Record<ProviderName, { id; label; models: string[] }>` — static
    catalogs keyed by provider.
  - Provider classification: **static** (hardcoded model lists: anthropic, deepseek, gemini,
    mistral, zai, fireworks, ...), **dynamic** (`dynamicProviders = ["openrouter",
    "vercel-ai-gateway", "litellm", "requesty", "roo", "unbound", "poe"]` — models fetched
    from remote APIs), **local** (`ollama`, `lmstudio` — discovered from localhost endpoints).
  - `getApiProtocol()` — "anthropic" vs "openai" protocol per provider (Roo's answer to the
    Anthropic-not-OpenAI-compatible problem).
- `src/core/config/ProviderSettingsManager.ts` — profile storage: `apiConfigs` record keyed
  by name, `modeApiConfigs`, zod-validated load/save, **migrations** for schema evolution
  (rate-limit fields, model renames via `MODEL_MIGRATIONS`). Good pattern for Clearance's
  AppSetting-based storage.
- `src/api/providers/*.ts` — one handler per provider with the official base URL baked in
  (e.g. `OpenRouterHandler`: `openRouterBaseUrl || "https://openrouter.ai/api/v1"`;
  `ZAiHandler`: `zaiApiLineConfigs[...].baseUrl` for international vs China).
- `src/api/providers/fetchers/` — `getModels({ provider })` for dynamic providers.
- Cline (the origin): same architecture, simpler; "OpenAI Compatible" provider = base URL +
  key + model ID; model lists hardcoded in `src/shared/api.ts`.

### Reusable for Clearance

- **Data/schema patterns (high value):** per-provider zod schema union; static/dynamic/local
  classification; `MODELS_BY_PROVIDER` shape; model-migration map.
- **Base URL + key field conventions (high value):** see preset table in section 7.
- **Components (low value):** React but VS Code-coupled; would need re-wiring to Clearance's
  REST API. Not worth it.

### Adaptation effort

Low for data/schema (copy the zod pattern into `backend/src/shared/validation.ts`), medium
for UI (build fresh on shadcn). Apache-2.0 — safe to reuse with attribution.

---

## 3. Continue (github.com/continuedev/continue)

| Field | Value |
|---|---|
| Repo / npm | `continuedev/continue`; SDK `@continuedev/sdk` (npm + PyPI). |
| License | **Apache-2.0**. |
| Stack | TypeScript; VS Code/JetBrains extensions + CLI; config-driven (`config.yaml`). |

### What it does (verified)

- Provider config is **declarative YAML blocks** (`models: - provider: openai, model: gpt-4,
  apiBase, apiKey, roles, capabilities, requestOptions`). Continue Hub
  (`github.com/continuedev/*-continue-hub`, e.g. `openai-continue-hub`,
  `anthropic-continue-hub`, `openrouter-continue-hub`) publishes **ready-to-use per-provider
  config blocks** — reusable as *data*.
- **Dynamic model fetching** (PR #12046, "Add Model GUI"): after entering an API key, a
  refresh icon fetches available models from the provider (works with Ollama, OpenRouter,
  Anthropic, Gemini, and OpenAI-compatible providers), auto-detects capabilities (context
  length, max tokens, tool support), **merges fetched models with the hardcoded list
  (hardcoded take precedence)**, and persists settings to config.yaml. This merge behavior is
  exactly the right UX for Clearance (presets first, fetched models appended).
- `ai-sdk-react-model-picker` (npm, Apache-2.0) is a community extraction of Continue's model
  selection into a React component library (see section 5).

### Reusable for Clearance

- **Patterns (high value):** fetch-and-merge model lists; capability auto-detection.
- **Hub block data (medium value):** per-provider YAML blocks are a good source for preset
  base URLs / model IDs, but the preset table in section 7 already covers Clearance's scope.
- **Components (low value):** Continue's GUI is React but tied to its config system.

### Adaptation effort

Low (patterns only). Apache-2.0 — safe.

---

## 4. LibreChat (github.com/danny-avila/LibreChat)

| Field | Value |
|---|---|
| Repo / npm | `danny-avila/LibreChat`; data layer in `librechat-data-provider` (npm). |
| License | **MIT**. |
| Stack | React (client) + Node/Express (server). |

### What it does (verified)

- Endpoint -> model cascade selector: `client/src/components/Chat/Menus/Endpoints/` with
  `EndpointMenuContent`, `EndpointItem`, `SearchResults` (Ariakit-based menus, lazy-mounted
  submenus, search with aliases). Endpoints config comes from the server
  (`librechat.yaml`), model lists per endpoint, "custom endpoints" = any OpenAI-compatible
  API with no proxy.
- The selector is deeply coupled to `librechat-data-provider` types and the server config
  shape — **not portable as components**.

### Reusable for Clearance

- **Patterns (medium value):** endpoint->model cascade, searchable submenu, lazy rendering of
  large model lists, "custom endpoint" concept.
- **Components (low value):** too coupled.

### Adaptation effort

Low-medium (patterns only). MIT — safe.

---

## 5. Headless React libraries for "LLM provider picker"

All verified on npm/GitHub (2026). None are mature enough to be a hard dependency, but each is
a legitimate MIT/Apache source to copy from.

| Package | License | Stack | What it gives you | Notes |
|---|---|---|---|---|
| `open-model-selector` (sethbang) | MIT | React 18/19, cmdk + Radix Popover | Accessible combobox that fetches `{baseUrl}/models` and normalizes responses; **built-in normalizers for Venice, OpenAI, OpenRouter, Together, Mistral, Groq, Cerebras, NVIDIA NIM, DeepSeek, SambaNova, Helicone**; `useModels` hook; managed/controlled modes; favorites; "Use System Default" sentinel | **Closest match to Clearance's need.** Scoped CSS (`--oms-`), dark mode. ~1 star repo but functional. |
| `@tombcato/ai-selector` | MIT | React + Vue, Tailwind | `AIConfigForm` (provider -> key -> model -> test connection) + headless `useAIConfig` hook; **20+ built-in providers**; model discovery; AES-encrypted localStorage; zero-backend or proxy modes | Very close to the desired "Add provider -> key -> model" flow. |
| `ai-sdk-react-model-picker` (hbmartin) | Apache-2.0 | React, Vercel AI SDK v5 | `ModelSelect` + `ProviderRegistry` + `AIProvider` base class (models, key validation, client creation); storage adapters; **derived from Continue.dev** | Small downloads (~13/wk) but clean architecture. |
| `@cappasoft/openrouter-model-selector` + `@cappasoft/openrouter-models` | MIT | React | OpenRouter-specific selector + **headless client** (`createOpenRouterModelsClient().listModels()`) | Good reference for the OpenRouter fetch path. |
| `ai-model-selector` (barrymister) | MIT | React | `useModelSelection` hook + provider/model components; capability filtering; exclusion guards | Headless-friendly. |

**Recommendation:** do not depend on any of these. Copy the *normalizer + fetch* pattern from
`open-model-selector` and the *provider registry + key validation* pattern from
`ai-sdk-react-model-picker`, and build the UI on Clearance's existing shadcn primitives
(Dialog + Command/cmdk + Popover are already in `package.json`).

---

## 6. How tools fetch available models per provider

Verified against official docs (2026). All endpoints are GET, JSON.

| Provider | Models endpoint | Auth for the call | Response shape / notes |
|---|---|---|---|
| OpenAI | `GET https://api.openai.com/v1/models` | `Authorization: Bearer` | `{ data: [{ id, object, created, owned_by }] }` |
| OpenRouter | `GET https://openrouter.ai/api/v1/models` | **Public — no auth required** (OpenRouterTeam/skills commit b9f8a85) | `{ data: [{ id, name, context_length, pricing, ... }] }`; optional `offset`/`limit` (max 1000), `output_modalities`, `sort` |
| Groq | `GET https://api.groq.com/openai/v1/models` | `Authorization: Bearer` | OpenAI-shaped |
| Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models` | `?key=` query param or `x-goog-api-key` header | `{ models: [{ name: "models/gemini-...", displayName, inputTokenLimit, outputTokenLimit, supportedGenerationMethods }] }` — **strip the `models/` prefix**; paged (pageSize default 50, max 1000) |
| Anthropic | `GET https://api.anthropic.com/v1/models` | `x-api-key` + `anthropic-version: 2023-06-01` headers | **Exists since 2025** (letta's "Sadly hardcoded" comment is outdated; letta now calls `client.models.list()`). `{ data: [{ id, display_name, max_input_tokens, max_tokens, capabilities }] }`; cursor-paginated (`after_id`/`before_id`, limit 1-1000) |
| Mistral | `GET https://api.mistral.ai/v1/models` | `Authorization: Bearer` | `{ data: [{ id, capabilities, max_context_length, ... }] }` |
| DeepSeek | `GET https://api.deepseek.com/models` | `Authorization: Bearer` | OpenAI-shaped `{ data: [{ id, owned_by }] }` |
| Together | `GET https://api.together.xyz/v1/models` (legacy) / `https://api.together.ai/v1/models` (new) | `Authorization: Bearer` | Array of `{ id, display_name, organization, context_length, pricing }` |
| Fireworks | `GET https://api.fireworks.ai/inference/v1/models` | `Authorization: Bearer` | OpenAI-shaped; also `GET /v1/accounts/{account_id}/models` (paged, pageSize max 200) |
| Z.ai | `GET https://api.z.ai/api/paas/v4/models` | `Authorization: Bearer` | **Exists but unreliable** — per zai-org/z-ai-sdk-python#68 it "currently only returns coding-related models... not fully available to external users". Use a hardcoded catalog. |
| Azure OpenAI | Legacy: `GET {endpoint}/openai/models?api-version=2024-10-21`; new v1 API: `GET {endpoint}/openai/v1/models` | `api-key` header (NOT Bearer) | Lists models accessible by the resource; **deployment names are the model IDs** |
| Ollama | `GET http://localhost:11434/api/tags` | none | `{ models: [{ name, model, size, details }] }`; also OpenAI-compatible `/v1/models` |
| LM Studio | `GET http://localhost:1234/v1/models` | none (optional `Authorization: Bearer $LM_API_TOKEN`) | OpenAI-shaped; JIT loading may list all downloaded models |

**Anthropic handling in practice:** tools that predate the Models API hardcode a curated list
(letta `MODEL_LIST`, Claude Code's picker). Modern tools (letta 2026, anthropics/skills) call
`GET /v1/models` and merge with a hardcoded context-window lookup table. **Recommended for
Clearance: fetch `/v1/models`, fall back to a curated preset list on failure.**

---

## 7. Provider preset table (verified 2026)

Flagship models below are only those confirmed from official docs / official repos in this
survey. Anything not directly confirmed is marked `[unverified]`.

| Provider | Official base URL | Key format / prefix | Models-list endpoint | Flagship models (verified) | Auth header style |
|---|---|---|---|---|---|
| groq | `https://api.groq.com/openai/v1` | `gsk_...` (legacy); newer keys `ggsk_...` (Clearance's own Settings copy says "starts with ggsk-") `[prefix uncertain]` | `GET /openai/v1/models` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `meta-llama/llama-4-maverick-17b-128e-instruct`, `meta-llama/llama-4-scout-17b-16e-instruct`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` | `Authorization: Bearer` |
| openai | `https://api.openai.com/v1` | `sk-proj-...` (project keys, current standard); legacy `sk-...` deprecated | `GET /v1/models` | `gpt-6-astra` (flagship), `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; `gpt-5.4` family (gpt-4o retires 2026-10-23) | `Authorization: Bearer` |
| openrouter | `https://openrouter.ai/api/v1` | `sk-or-v1-...` | `GET /api/v1/models` (public) | Catalog of 400+ (e.g. `openai/gpt-5.x`, `anthropic/claude-opus-4-6`, `google/gemini-3.x`) — fetch, don't hardcode | `Authorization: Bearer` |
| gemini | `https://generativelanguage.googleapis.com/v1beta` (OpenAI-compat: `.../v1beta/openai`) | `AIza...` | `GET /v1beta/models` (strip `models/` prefix) | `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `gemini-3.8-flash`, `gemini-3-flash-preview`, `gemini-3.5-flash-lite` | `?key=` or `x-goog-api-key` (OpenAI-compat path uses Bearer) |
| anthropic | `https://api.anthropic.com/v1` | `sk-ant-...` (e.g. `sk-ant-api03-...`) | `GET /v1/models` (exists since 2025) | `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5` (per official anthropics/skills models.md); `claude-fable-5-1` / `claude-mythos-5-1` `[unverified — new names in anthropics/skills, verify before shipping]` | `x-api-key` + `anthropic-version: 2023-06-01` (NOT Bearer) |
| zai (Zhipu) | `https://api.z.ai/api/paas/v4` (intl) / `https://open.bigmodel.cn/api/paas/v4` (CN) | none specific | `GET /paas/v4/models` (unreliable — hardcode instead) | `glm-5.3`, `glm-5.2`, `glm-4.7`, `glm-4.7-flash` | `Authorization: Bearer` |
| deepseek | `https://api.deepseek.com` (or `/v1`) | `sk-...` | `GET /models` | `deepseek-v4-pro`, `deepseek-v4-flash` (legacy `deepseek-chat`/`deepseek-reasoner` = V3.2, discontinued 2026-07-24) | `Authorization: Bearer` |
| mistral | `https://api.mistral.ai/v1` | none specific | `GET /v1/models` | `mistral-large-latest`, `mistral-medium-2508`, `codestral-2501`, `mistral-small-latest` | `Authorization: Bearer` |
| together | `https://api.together.xyz/v1` (legacy) / `https://api.together.ai/v1` (new) | none specific | `GET /models` | `deepseek-ai/DeepSeek-V4-Pro`, `deepseek-ai/DeepSeek-V4-Flash-0731`, `Qwen/Qwen3.8-2.4T-A95B`, `zai-org/GLM-5.2`, `moonshotai/Kimi-K3`, `MiniMaxAI/MiniMax-M3` | `Authorization: Bearer` |
| fireworks | `https://api.fireworks.ai/inference/v1` | none specific | `GET /v1/models` | `accounts/fireworks/models/deepseek-v3p1`, `accounts/fireworks/models/glm-5p2`, `accounts/fireworks/models/llama-v3p1-8b-instruct` | `Authorization: Bearer` |
| azure-openai | `https://{resource}.openai.azure.com/openai/v1` (new v1 API, GA 2026) or `.../openai/deployments/{deployment}` (legacy) | resource key (no prefix) | `GET {endpoint}/openai/models?api-version=...` (legacy) / `GET {endpoint}/openai/v1/models` (v1) | Deployment names are the model IDs (e.g. `gpt-4.1-nano`, `gpt-5.4`) — user-defined | `api-key` header (NOT Bearer); legacy also needs `api-version` query param |
| ollama | `http://localhost:11434` (OpenAI-compat `/v1`) | none | `GET /api/tags` | Whatever is pulled locally (e.g. `qwen3:8b`, `llama3.3`, `deepseek-r1`, `gemma4`) | none |
| lmstudio | `http://localhost:1234/v1` | none | `GET /v1/models` | Whatever is loaded (JIT loading may list all downloaded) | none (optional Bearer `LM_API_TOKEN`) |

---

## 8. How this maps to Clearance (verified repo state)

### Current state (verified by reading the repo)

- **Frontend** (`src/pages/Settings.tsx`): hardcoded `KEY_PROVIDERS` array (11 rows incl.
  non-LLM: groq/openai/openrouter/gemini/tavily/adzuna/jooble/careerjet/firecrawl/crawl4ai/
  rapidapi) with per-row key inputs + "Save All Keys"; separate "AI Models" card with 4
  hardcoded LLM providers (`LLM_MODEL_PROVIDERS` from `src/services/api/settings.ts`:
  `'groq' | 'openai' | 'openrouter' | 'gemini'`) and free-text model inputs.
- **Backend**:
  - `backend/src/ai/keyManager.ts` — `LLM_PROVIDERS = ['groq','openai','openrouter','gemini']`;
    `leaseNextKey` with DB-first, env fallback (`${PROVIDER}_API_KEY`, rotation `_1..20`).
  - `backend/src/ai/providerModels.ts` — `DEFAULT_MODELS` for the same 4 providers; DB
    AppSetting `model:<provider>` overrides; 5s cache.
  - **Base URL mapping is duplicated in ~10 files** (`evaluation.ts`, `resumeGenerator.ts`,
    `interviewGenerator.ts`, `matchEnhancer.ts`, `llmEvaluator.ts`, `improver.ts`, `refiner.ts`,
    `resume/parser.ts`, `profile/parser.ts`, `routes/tailor.ts`) — every one is a
    `provider === 'groq' ? ... : provider === 'openrouter' ? ... : provider === 'gemini' ?
    ... : 'https://api.openai.com/v1'` chain. All calls use the OpenAI SDK.
  - `backend/src/shared/validation.ts` — `apiKeyProviderSchema` (12 providers),
    `llmModelProviderSchema` (4), `updateModelSettingsSchema` (4, `.strict()`).
  - `backend/src/routes/keys.ts` — POST validates LLM keys by length >= 8 only.
  - `backend/src/routes/settings.ts` — GET/PUT `/settings/models`.
- **Stack:** React 18.3, shadcn/ui (Radix), Tailwind 3.4, `cmdk` 1.1.1, react-query 5,
  zod 3.25, framer-motion. Backend: Express + Prisma + `openai` SDK.

### Recommended target architecture (research-level recommendation; implementation spec is a separate artefact)

1. **Provider registry module** (`backend/src/ai/providerRegistry.ts`) — single source of
   truth: `{ id, label, baseUrl, keyPrefix, authStyle: 'bearer' | 'api-key' | 'x-api-key' |
   'none', modelsEndpoint, protocol: 'openai' | 'anthropic', defaultModels, presetModels }`
   for the 13 providers in section 7. Replace the ~10 duplicated base-URL chains with
   `getProviderBaseUrl(provider)`.
2. **Backend endpoints**: `GET /api/providers` (preset registry, no secrets),
   `POST /api/providers/:id/models` (backend proxies the provider's models endpoint so keys
   never leave the server and CORS is avoided; returns normalized `{ id, name }[]`),
   extend `POST /api/keys` validation to use `keyPrefix` hints + real probe where cheap.
3. **Frontend flow** (Kilo pattern on shadcn): "AI Providers" card lists configured
   providers (key status + selected model + change/remove); "Add provider" opens a
   searchable Dialog (Command) grouped Recommended/Other + Custom; selecting one opens a
   key-entry dialog; on save, fetch models (backend proxy) and show a searchable model
   picker; fetched models merge with presets (presets first, per Continue's merge rule).
4. **Anthropic caveat:** needs a non-OpenAI client path (either `@anthropic-ai/sdk` or a
   thin `/v1/messages` fetch with `x-api-key` + `anthropic-version` headers). Everything else
   in scope works with the existing OpenAI SDK + `baseURL` (+ `defaultHeaders` for Azure's
   `api-key`).
5. **Z.ai caveat:** hardcode the GLM catalog; do not rely on `/paas/v4/models`.

---

## 9. License summary (reuse safety)

| Source | License | Reusable as |
|---|---|---|
| Kilo Code | MIT | Patterns only (SolidJS) |
| Roo Code / Cline | Apache-2.0 | Data + schema patterns |
| Continue | Apache-2.0 | Patterns + hub block data |
| LibreChat | MIT | Patterns only |
| open-model-selector | MIT | Normalizer/fetch pattern |
| @tombcato/ai-selector | MIT | Provider registry + flow pattern |
| ai-sdk-react-model-picker | Apache-2.0 | Provider registry pattern |
| @cappasoft/openrouter-model-selector | MIT | OpenRouter fetch pattern |

All safe for a commercial/self-hosted app with attribution. No GPL/SSPL anywhere in scope.

---

## 10. Uncertainty flags

- Groq key prefix: `gsk_` historically; Clearance's own copy says `ggsk-`. Both seen in the
  wild — treat prefix as a *hint*, never a hard validation gate.
- `claude-fable-5-1` / `claude-mythos-5-1` appear in the official anthropics/skills repo but
  are new; verify against `GET /v1/models` before shipping.
- Together's `api.together.ai` vs `api.together.xyz`: both documented; prefer the new
  `api.together.ai` but keep `api.together.xyz` as fallback.
- Azure v1 API (`/openai/v1`, no `api-version`) is GA per MS Learn 2026; legacy
  `/openai/deployments/{name}?api-version=...` still works.
- Z.ai `/paas/v4/models` behavior confirmed only via the zai-org SDK issue; treat as
  unreliable.
- Model names for OpenAI/Gemini/DeepSeek/Z.ai/Mistral/Together/Fireworks/Groq were verified
  against official docs pages captured in this survey (2026); model catalogs change fast —
  the UI should always prefer live fetch over presets.