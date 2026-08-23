# Remediation & Phase 1 Implementation Plan (post-payment-removal)

> Context: Brownfield onboarding complete. Payment system removed for open-source/self-host.
> This plan covers (A) code-issue fixes and (B) implementation of the partial/missing
> features **except payment**. RM-05 (AI-Assisted Build) was confirmed already implemented
> during re-audit (AIBuild.tsx + GetStarted link + routes), so it is excluded.

## A. DONE — Payment System Removal
Removed (all had zero importers; verified by grep):
- `backend/src/shared/validation.ts` → deleted `couponSchema`, `adminCouponSchema` + `CouponInput`/`AdminCouponInput` type exports.
- `backend/src/shared/auth.ts` → deleted `ensurePlan()` (subscription-plan gating).
- `backend/src/routes/ai.ts` → fixed stale `// enforce usage limits` comment.
- Confirmed `stripe` is **not** in `backend/package.json` and no `import Stripe` exists; frontend has zero payment refs; Prisma schema has no Subscription/Coupon/UsageLog/plan fields.
- Kept `api.smoke.test.ts` payment→404 assertion as a regression guard.

## B. Code Issues (fixes)
1. **Doc drift — STACK.md**: says `puppeteer-core` but backend uses **Playwright** (`chromium` from `playwright` in resume/tailor/templates/export). Also lists `Stripe` as a dependency (not installed). Update stack table.
2. **Doc drift — ARCHITECTURE.md**: references `shared/usage.ts` (does not exist) and a missing `profileParser.ts`. Correct after items 4 & 6.
3. **Empty `scraper/` directory**: remove it (no implementation; referenced as "auxiliary" but unused).
4. **Dead plan/usage logic**: after `ensurePlan` removal, audit `shared/auth.ts` "remaining resume generations" logic and any other plan/usage references; remove if orphaned.
5. **`profileParser` extraction**: `backend/src/routes/profile.ts` duplicates LLM profile-parse logic inline. Extract to `backend/src/profile/parser.ts` and reuse.
6. **Test harness**: only 1 smoke test (5 assertions). Add Vitest unit tests for highest-risk pure logic: `ats/scanner.ts` (scoring), `resume/parser.ts`, `ai/keyManager.ts` (rotation/rate-limit), `ai/evaluation.ts`, `routes/tailor.ts`. Add a frontend test setup (Vitest + Testing Library).
7. **Frontend type safety**: `tsconfig.app.json` has `strict: false` (no `noImplicitAny`/`strictNullChecks`). Tighten incrementally to reduce runtime bugs.
8. **Mixed package managers**: both `package-lock.json` and `bun.lockb` present. Standardize on npm (remove `bun.lockb`). Low priority.

## C. Feature Implementation (RM-01 / RM-02 / RM-03 / RM-04)
All build on the existing baseline (resume CRUD, ATS scan, job-match, tailor, AI generation, templates, Playwright export).

### RM-01 — Multi-pass refinement pipeline + 3-factor ATS scorer
- Add `backend/src/ats/improver.ts` (initial AI tailoring: JD + master resume → draft), `refiner.ts` (multi-pass: keyword injection, AI-phrase simplification, master-alignment LLM validation), `atsScorer.ts` (3-factor weighted: Keyword Match 55% / Skills Coverage 25% / Section Completeness 20%).
- Reuse existing `leaseNextLlmKey`/`keyManager`. Keep deterministic where possible.
- Wire into `/api/ats` (new score mode) and `/api/tailor` (feed refined draft).
- Frontend: surface 3-factor breakdown in `features/ats-report/`.

### RM-02 — markitdown-grade resume parser
- Decision required: **TS-native** (`pdf-parse` + `mammoth` enhanced / `unpdf` / LibreOffice headless) vs **thin Python markitdown microservice**. Recommend TS-native to keep single runtime (Node, no Python assumed per STATE.md).
- Enhance `backend/src/resume/parser.ts`: PDF/DOCX → Markdown → structured JSON with date restoration; **preserve existing `ParsedResume` shape** consumed downstream.
- Add parser unit tests (item B.6).

### RM-03 — 4 Reactive Resume templates + client PDF export
- Add 4 templates to `src/features/resume-builder/templates/`: Classic/MÉ-Modern × Single/Two-Column, JSON-schema-compatible with Prisma `Resume`.
- Register in `templates/registry.ts` + `templates/index.ts`.
- Add client-side PDF export via **`@react-pdf/renderer`** (add to root `package.json`), reconciled with existing server Playwright export (keep both; offer choice in UI).
- Verify preview/export for all 4.

### RM-04 — JD → Match → Builder redirect flow
- In `src/features/job-match/JobMatchResults.tsx` add **"Build Tailored Resume"** button → `navigate('/builder?jobMatchId=${id}&prefill=tailored')`.
- In `src/pages/Build.tsx` (or builder hook): load tailored content from JobMatch/TailoredResume and prefill editor.
- Confirm end-to-end: match → tailor → builder.

## D. Recommended Sequencing
1. B.1–B.4 doc/cleanup quick wins (low risk, unblocks accuracy).
2. B.6 test harness standup (prerequisite for safe feature work).
3. RM-02 parser (foundational; everything consumes parsing).
4. RM-01 pipeline (depends on parser + scoring).
5. RM-03 templates + client PDF.
6. RM-04 redirect.
7. B.5/B.7/B.8 polish; re-run audit + lint.

## E. Decisions Needed (blockers before coding)
- **RM-02 parser approach**: TS-native (recommended) vs Python microservice.
- **Client PDF lib**: add `@react-pdf/renderer` to root deps (yes/no).
- **Self-host scope**: confirm no remaining plan/usage gating desired (ensurePlan already removed; verify B.4).

## F. Execution Note
Subagent spawns are currently broken in this session (cached `openrouter` model; the
`kilo.jsonc` fix applies after a window restart). Until then, implementation is done
inline by the orchestrator, or via GSD lifecycle (`/gsd-plan-phase 1`, `/gsd-execute-phase 1`)
once the model config is reloaded.

## G. Progress Log (executed 2026-08-21)
### Completed — Code Issues
- **Payment system fully removed**: `validation.ts` PAYMENT SCHEMAS + type exports, `auth.ts` `ensurePlan`, `ai.ts` stale "enforce usage limits" comment. `stripe` confirmed NOT a dependency; frontend/Prisma have no payment code. Smoke test payment→404 kept as a removal guard.
- **Doc drift fixed**: `STACK.md` (puppeteer-core → Playwright; removed phantom Stripe dep + Stripe requirement bullet), `ARCHITECTURE.md` (Playwright reference, removed `STRIPE_SECRET_KEY`, resolved the stale `profileParser` GAP note).
- **Removed empty `scraper/` directory.**
- **Extracted `profile/parser.ts`** (`parseProfileFromResume`) out of `routes/profile.ts` (removes duplication).
- **Removed dead `checkGenerationLimit`** from `shared/auth.ts`.
- **Test harness**: added `backend/src/resume/parser.test.ts` (9 tests: validateUploadedFile, normalizeDate, resumeToMarkdown). Full backend suite green (14 tests).

### Completed — RM-02 (markitdown-grade parser)
- `resume/parser.ts`: exported `ParsedResume`; added `normalizeDate` (date restoration → `YYYY-MM` / `Present`) applied in the LLM mapping; added `resumeToMarkdown` (faithful Markdown intermediate of the structured resume). Preserves the existing `ParsedResume` shape consumed downstream.

### Remaining (not yet implemented) — ALL DONE
- **RM-01** ✅: `ats/atsScorer.ts` (3-factor: Keyword 55% / Skills 25% / Section 20%), `ats/improver.ts` (pass 1), `ats/refiner.ts` (pass 2 + alignment guard). Wired into `POST /api/tailor/pipeline` and `POST /api/ats/score-job`. Unit-tested (`atsScorer.test.ts`). Backend suite green (19 tests).
- **RM-03** ✅: 4 Reactive Resume templates via shared `ReactiveBase` (classic/modern/clean/engineering), registered in `registry.ts` + `index.ts`; `@react-pdf/renderer` added to root deps; client-side `ResumePdf.tsx` export wired into Build.tsx export menu (reconciles with existing server Playwright export).
- **RM-04** ✅: Already implemented in `src/pages/Match.tsx` (handleBuildTailored → atsApi.buildFromJd → navigate /app/build/:id?jobMatchId=...); Build.tsx already consumes jobMatchId. No code needed.
- Optional code issues still open: tighten frontend `tsconfig.app.json` (`strict`), standardize package manager (remove `bun.lockb`), add frontend test setup.
