# Codebase Concerns

**Analysis Date:** 2026-07-17

---

## Critical — Missing Implementation

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Critical** | `backend/src/ai/profileParser.ts` does NOT exist. Required for POST `/profile/parse-from-resume` (Step 2 of plan). Blocks auto-fill from resume on Profile page. | `backend/src/ai/` (missing file) | Only `evaluation.ts`, `keyManager.ts`, `resumeGenerator.ts` exist in `backend/src/ai/`. No `profileParser.ts`. Profile route `backend/src/routes/profile.ts:53-116` has inline parsing logic but no dedicated module. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Critical** | Evaluation/tailor profile integration incomplete. `evaluateJob` accepts optional `profile` but `tailor.ts` passes only `summary` + `topSkills`. Other CareerProfile fields (seniority, min/maxSalary, locationPref, remoteOnly, redFlags, proofPoints, industries) are not passed to the LLM prompt. | `backend/src/routes/tailor.ts:30-39`, `backend/src/ai/evaluation.ts:85-106` | `buildTailorUser()` only passes `profile.summary` and `profile.topSkills`. `buildUserPrompt()` in `evaluation.ts` supports full `CareerProfileLike` but tailor route doesn't use it. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Critical** | Job search with `boards=` does NOT load user's CareerProfile and pass to `evaluateJob`. Step 5 of plan requires this. | `backend/src/routes/jobs.ts:18-76` (search), `jobs.ts:132-224` (evaluate) | `/search` returns raw listings. `/jobs/:id/evaluate` loads profile (lines 160-179) and passes to `evaluateJob`. But `GET /jobs/search?boards=` does not trigger evaluation. Plan Step 5 requires profile-aware job scan. |

---

## High — Feature Gaps / Incomplete Gating

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **High** | Profile completion gating on frontend: Save button NOT disabled when `isComplete=false`. Spec says "Save disabled until isComplete, missing fields highlighted". Current code shows warning banner but allows save. | `src/pages/Profile.tsx:90-99`, `Profile.tsx:322-329` | `isComplete` computed (lines 90-99) checks only `targetRoles`, `seniority`, `topSkills`. Save button `disabled={upsert.isPending}` (line 326) — does NOT check `isComplete`. Missing fields highlighted via `missing` state (line 117) but not required for save. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **High** | Frontend `REQUIRED_FIELDS` constant referenced but NOT defined in `Profile.tsx`. Causes runtime error if used. | `src/pages/Profile.tsx:185,199,264` | Lines 185, 199, 264 reference `REQUIRED_FIELDS.includes('targetRoles')` etc. but no such constant exists in file. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **High** | Job scan uses profile? `GET /jobs/scan` (line 79-118) fetches boards and runs sources but does NOT load CareerProfile or run evaluation. Plan Step 5: "GET /jobs/search with boards= should load user's CareerProfile and pass to evaluateJob". | `backend/src/routes/jobs.ts:79-118` | `/scan` endpoint upserts listings only. No profile loading, no evaluation. |

---

## Medium — BYOK Key Management

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Medium** | `keyManager.ts` rotation uses simple round-robin `rotationIndex` without considering key health (failureCount, rateLimitedUntil). Could repeatedly hit exhausted keys. | `backend/src/ai/keyManager.ts:110-111` | `const key = keys[rotationIndex % keys.length];` — no skip logic for keys with high `failureCount` or future `rateLimitedUntil`. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Medium** | `leaseNextLlmKey` tries providers in fixed order `['groq', 'openai', 'openrouter', 'gemini']` but doesn't respect user preference or provider capabilities (e.g., some models only on specific providers). | `backend/src/ai/keyManager.ts:163-174` | Hardcoded `LLM_PROVIDERS` array. No way to prefer `gemini` for certain tasks. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Medium** | Env fallback keys (`GROQ_API_KEY`, `GROQ_API_KEY_1..20`) used ONLY when no database keys exist. If DB keys exist but are all rate-limited, code throws "No keys configured" instead of falling back to env. | `backend/src/ai/keyManager.ts:100-102` | `const fallbackKeys = databaseKeys.length === 0 ? getEnvKeys(provider) : [];` — should also fall back when all DB keys are rate-limited. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Medium** | `resumeGenerator.ts` uses hardcoded Groq model `llama-3.1-70b-versatile`. No model selection per provider. `evaluation.ts` also hardcodes same model. | `backend/src/ai/resumeGenerator.ts:166`, `evaluation.ts:156` | Tightly coupled to Groq. If user only has OpenAI keys, generation fails. |

---

## Medium — Hardcoded / Stale Code

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Medium** | Hardcoded Chrome paths in `tailor.ts:86-91` for PDF export. Windows-specific paths break on Linux/macOS CI. | `backend/src/routes/tailor.ts:86-91` | Array of hardcoded paths including `C:\Program Files\Google\Chrome\Application\chrome.exe`. No dynamic discovery via `which`/`where` or `puppeteer` default. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Medium** | `jobSources/index.ts` has no fallback/demo boards (confirmed clean), but `runSource()` returns `[]` silently on missing config instead of throwing descriptive error. | `backend/src/jobSources/index.ts:141-161` | Each case returns `[]` if `board`/`feedUrl` missing. Caller `jobs.ts:30-35` builds configs from user's JobBoard records — if user misconfigures, search returns empty without feedback. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Medium** | Prisma schema: `CareerProfile.parsedFromResumeId` is `String?` but no FK relation to `Resume`. Orphaned reference possible. | `backend/prisma/schema.prisma:227` | Field defined but no `@relation` — referential integrity not enforced. |

---

## Low — Testing & TypeScript Gaps

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Low** | **Zero frontend unit/e2e tests**. Only backend smoke test exists (`api.smoke.test.ts`). No vitest, testing-library, playwright, or cypress config. | `backend/src/routes/api.smoke.test.ts` (only test file) | Frontend `package.json` has no test script. No `vitest.config.ts`, no `*.test.tsx` in `src/`. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Low** | Frontend TypeScript config: `strict: false`, `noImplicitAny: false`, `strictNullChecks: false`. Backend is `strict: true`. Inconsistent strictness allows implicit `any` in React components. | `tsconfig.json:9-14`, `backend/tsconfig.json:9` | Frontend base config disables core strict checks. `tsconfig.app.json` likely inherits. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Low** | `backend/src/lib/crypto.ts:32` — legacy plaintext fallback: `if (!ivB64 || !tagB64 || !dataB64) return payload;`. If encryption format changes, silently returns ciphertext as plaintext. | `backend/src/lib/crypto.ts:32` | No migration path; old unencrypted keys in DB would be returned as-is. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Low** | `keyManager.ts` uses in-memory `rotationIndex` and `lock` — not safe for multi-instance deployment (horizontal scaling). Each instance maintains own rotation state. | `backend/src/ai/keyManager.ts:25-26` | `let rotationIndex = 0; let lock: Promise<void> = Promise.resolve();` — process-local. |

---

## Security — Verified OK (No Concerns Found)

| Area | Status | Evidence |
|------|--------|----------|
| JWT in httpOnly cookie | ✅ Secure | `auth.ts:141-147` — `httpOnly: true, secure: production, sameSite: 'lax'` |
| BYOK keys encrypted at rest | ✅ AES-256-GCM | `crypto.ts:17-28` — proper IV, authTag, key derivation via SHA-256 |
| Human-in-the-loop for applications | ✅ Enforced | `applications.ts` — status transitions require user action; no auto-apply |
| No secrets in `.env` files | ✅ Verified | `.env.example` files only; no `.env` committed |
| Rate limiting on auth endpoints | ✅ | `app.ts:47-61` — login/signup/reset limited to 10/15min |
| CORS restricted to allowed origins | ✅ | `app.ts:11-32` — explicit allowlist with credentials |

---

## Dead Code / Unused Exports

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Low** | `evaluation.ts` exports `checkLiveness` (re-export from `liveness.ts`) but not used internally. | `backend/src/ai/evaluation.ts:187` | `export { checkLiveness };` — only used in `jobs.ts:13` import. Could import directly from `liveness.ts`. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Low** | `resumeGenerator.ts` exports `improveResumeBullet`, `generateProfessionalSummary` — check if used in routes. | `backend/src/ai/resumeGenerator.ts:210-285` | Not imported in `ai.ts` routes or elsewhere. May be dead code. |

| Priority | Issue | Location | Evidence |
|----------|-------|----------|----------|
| **Low** | `keyManager.ts` exports Groq aliases (`leaseNextGroqKey`, `markGroqKeySuccess`, `markGroqKeyFailure`, `isGroqRateLimitError`) for backward compat with `resumeGenerator.ts`. | `backend/src/ai/keyManager.ts:182-185` | Only `resumeGenerator.ts` uses them. Could migrate to generic `leaseNextKey('groq')`. |

---

## Scaling Limits

| Area | Current Capacity | Limit | Scaling Path |
|------|------------------|-------|--------------|
| BYOK key rotation | In-memory round-robin | Single instance only | Move rotation state to Redis or DB `lastUsedAt` ordering |
| Job source fetching | Sequential `Promise.all` per board | ~5 boards × 30 jobs = 150 req | Add concurrency limit, caching, pagination |
| PDF export | Puppeteer launches Chrome per request | ~1-2 concurrent PDFs per CPU core | Use headless Chrome pool or serverless function |
| Tavily research | 1 request per evaluation | Rate limited by API key | Cache company/comp research by domain |

---

## Missing Critical Features (Per Plan)

| Feature | Status | Blocking Issue |
|---------|--------|----------------|
| POST `/profile/parse-from-resume` | ❌ Not implemented | `profileParser.ts` missing; inline logic in `profile.ts:53-116` works but not extracted |
| Profile-aware job scan (`GET /jobs/search?boards=`) | ❌ Not implemented | `/search` doesn't load profile or evaluate |
| Tailor uses full CareerProfile | ❌ Partial | Only `summary` + `topSkills` passed |
| Frontend save-gating | ❌ Not enforced | Save button not disabled on incomplete profile |
| Frontend missing field highlighting | ⚠️ Partial | `missing` state set from parse but `REQUIRED_FIELDS` constant missing |

---

*Concerns audit: 2026-07-17*