# Feature Spec: Job Discovery + career-ops Evaluation + Template-Tailored Resumes + BYOK

**Project:** Clearance (AI Resume Builder) — `E:\Projects\Webd+AI\Clearance`
**Status:** Spec v1.0 (implementation-ready)
**Author:** Kilo (deep research on `santifer/career-ops` + Clearance codebase analysis)
**Date:** 2026-07-17

---

## 0. Executive Summary

We are adding an end-to-end **job search & apply** workflow to Clearance, modeled on the
open-source `career-ops` system, but built **natively into Clearance's web stack** (not as a
CLI skill). The workflow:

1. **Discover** jobs from public ATS sources (zero-token, no-auth) — "find the job".
2. **Evaluate** each listing with a ported career-ops A–F rubric (LLM, Groq/OpenAI) + scam/ghost-job flag.
3. **Tailor** the user's selected resume **into their chosen Clearance template** and export DOCX/PDF.
4. **Track** applications through a pipeline view (saved → tailored → applied).
5. **BYOK**: users bring their own LLM key (Groq/OpenAI/OpenRouter/Gemini) **and** their own
   search key (Tavily) — the backend already has the `AIProviderKey` model + `keyManager`;
   we extend it to search and expose management UI.

**Feasibility:** CONFIRMED. All UI can reuse existing patterns (`AppLayout` + `Card` grid +
`Button`/`Input`/`Dialog`/`Tabs`/`Sheet`/`Select`/`Badge`/`Progress`, `useToast`,
`useLimitCheck`/`UpgradeModal`, react-query hooks, `apiClient` service layer). The
`TemplateSelector` (Sheet+Tabs+cards) pattern is reused for template picking.

---

## 1. Research Findings (grounded)

### 1.1 career-ops (`santifer/career-ops`, MIT, 60k★)
- **What it is:** an *agentic skill* that runs inside an AI coding CLI. Its core IP is the
  **A–F evaluation rubric** (`modes/oferta.md` + `modes/_shared.md`): role summary, CV match,
  level strategy, comp research, personalization, interview prep (STAR+R), plus **Block G
  posting-legitimacy** (scam/ghost-job detection). Scores 1.0–5.0; recommends NOT applying
  below 4.0.
- **Pipeline:** `scan` (providers/ → Greenhouse, Ashby, Lever, Workday, BambooHR, Teamtailor,
  RSS/JSON boards) → `evaluate` (reads `cv.md`) → `generate` (ATS PDF via Playwright) →
  `track` (`data/applications.md`). **Human-in-the-loop: never auto-submits.**
- **Principles to honor:** local-first logic, AI-agnostic (prompt files), human-in-the-loop,
  authenticity-first (never invent experience).

### 1.2 Clearance existing assets (reuse)
- `backend/src/ai/resumeGenerator.ts` — Groq-based generation w/ key rotation → extend to *tailor*.
- `backend/src/ai/keyManager.ts` — **reads `prisma.aIProviderKey` (provider, apiKey, isActive,
  rateLimitedUntil)** → already BYOK-ready for LLM. No route manages keys yet.
- `backend/src/routes/job-match.ts` — rule-based keyword match (lightweight) → keep as quick match.
- `backend/src/routes/export.ts` — HTML→DOCX/PDF via `puppeteer-core` → reuse for tailored output.
- `backend/src/routes/templates.ts` + `templates/analyzer.ts` — template metadata/sections →
  "selected template" source of truth.
- `prisma/schema.prisma` — `Resume`, `JobMatch`, `ATSReport`, **`AIProviderKey`** already exist.
- Frontend: `Match.tsx`, `TemplateSelector.tsx`, `resumeApi` service, `useAuth`
  hooks, `App.tsx` routing — all copy-paste-able patterns.

### 1.3 BYOK status
- `AIProviderKey` model supports `openai | groq | openrouter | gemini`. **No management route.**
- Tavily/search has **no** provider support yet → must add `tavily` provider + search path.

---

## 2. Data Model (Prisma additions)

Add to `backend/prisma/schema.prisma`:

```prisma
// ---- Job Discovery & Tracking ----

model JobListing {
  id            String   @id @default(uuid())
  externalId    String?                                   // id from source board
  source        String                                       // 'greenhouse' | 'ashby' | 'lever' | 'workday' | 'rss'
  sourceUrl     String
  title         String
  company       String
  location      String?
  description   String                                       // raw JD text
  applyUrl      String?
  postedAt      DateTime?
  expiresAt     DateTime?
  isActive      Boolean  @default(true)
  lastVerifiedAt DateTime?
  createdAt     DateTime @default(now())

  evaluations   JobEvaluation[]
  applications  Application[]

  @@unique([source, externalId])
  @@index([company])
  @@index([isActive, postedAt])
}

model JobEvaluation {
  id            String   @id @default(uuid())
  userId        String
  jobListingId  String
  resumeId      String?
  // A-F rubric scores (1-5 each) + overall
  roleSummary   String?
  cvMatchScore  Float?                                      // A
  levelFitScore Float?                                      // B
  compFitScore  Float?                                      // C
  personalizationScore Float?                               // D
  interviewPrepScore   Float?                               // E
  legitimacyScore Float?                                    // G (posting legitimacy)
  overallScore  Float                                       // weighted 1-5
  recommendation String?                                     // 'apply' | 'maybe' | 'skip'
  isScam        Boolean  @default(false)
  reportJson    Json?                                        // full structured report
  createdAt     DateTime @default(now())

  user          User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobListing    JobListing @relation(fields: [jobListingId], references: [id], onDelete: Cascade)
  tailoredResumes TailoredResume[]

  @@index([userId, createdAt])
}

model TailoredResume {
  id            String   @id @default(uuid())
  userId        String
  jobEvaluationId String?
  sourceResumeId String                                  // base resume tailored from
  templateId    String                                       // selected Clearance template
  jobListingId  String?
  title         String
  content       Json                                        // tailored resume data (sections)
  html          String?                                      // rendered HTML for export
  createdAt     DateTime @default(now())

  user          User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobEvaluation JobEvaluation? @relation(fields: [jobEvaluationId], references: [id], onDelete: SetNull)
  applications  Application[]

  @@index([userId, createdAt])
}

model Application {
  id              String   @id @default(uuid())
  userId          String
  jobListingId    String
  tailoredResumeId String?
  status          String   @default("saved")                // saved|tailored|applied|interview|offer|rejected
  notes           String?
  appliedAt       DateTime?
  createdAt       DateTime @default(now())

  user            User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  jobListing      JobListing @relation(fields: [jobListingId], references: [id], onDelete: Cascade)
  tailoredResume  TailoredResume? @relation(fields: [tailoredResumeId], references: [id], onDelete: SetNull)

  @@index([userId, status])
}
```

**Extend `AIProviderKey`** (add `label`, `lastValidatedAt`):
```prisma
model AIProviderKey {
  id               String    @id @default(uuid())
  userId           String?                                   // NULL = system/global key
  provider         String    // 'openai' | 'groq' | 'openrouter' | 'gemini' | 'tavily'
  apiKey           String
  label            String?
  isActive         Boolean   @default(true)
  lastUsedAt       DateTime?
  lastValidatedAt  DateTime?
  failureCount     Int       @default(0)
  rateLimitedUntil DateTime?
  createdAt        DateTime  @default(now())

  user User? @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

---

## 3. Backend Implementation

### 3.1 Job Sources (`backend/src/jobSources/`)
Port career-ops `providers/` concept — **zero-token, no-auth** public ATS APIs.
- `index.ts` — registry + `searchJobs(query, sources)` dispatcher.
- `greenhouse.ts`, `ashby.ts`, `lever.ts`, `workday.ts`, `rss.ts` — per-board fetchers returning
  normalized `JobListing` drafts.
- `liveness.ts` — `checkLiveness(url)` (HEAD/GET) to drop expired postings (mirror career-ops
  `check-liveness.mjs`).
- Respects BYOK Tavily? No — job boards are scraped directly; Tavily is for **web research**
  inside evaluation (comp research, company research), gated by user's Tavily key.

### 3.2 Evaluation engine (`backend/src/ai/evaluation.ts`)
- Port `modes/oferta.md` + `_shared.md` rubric into a system prompt (Groq/OpenAI via keyManager).
- `evaluateJob({ resumeData, jobDescription, tavilyKey? })` → structured JSON: A–G scores,
  overall, recommendation, isScam, roleSummary, interviewPrep bullets, comp notes.
- Uses Tavily (user key via `keyManager` `tavily` provider) for comp/company research when present.
- **Authenticity guard** in prompt: never invent experience.

### 3.3 Routes
- `backend/src/routes/jobs.ts` (new):
  - `GET /api/jobs/search?q=&sources=` → runs `jobSources`, upserts `JobListing`, returns list.
  - `GET /api/jobs/:id` → listing detail.
  - `POST /api/jobs/:id/evaluate` → body `{ resumeId }`, runs evaluation, stores `JobEvaluation`,
    enforces usage limit (`jobMatches` bucket reuse or new `evaluations` bucket).
- `backend/src/routes/tailor.ts` (new):
  - `POST /api/tailor` → body `{ jobEvaluationId | jobDescription, resumeId, templateId }`.
    Loads resume + template sections (from `templates/analyzer`), LLM rewrites bullets/summary to
    mirror JD (truthful), stores `TailoredResume`, returns id + preview HTML.
  - `GET /api/tailor/:id/export?format=pdf|docx` → reuse `export.ts` HTML→DOCX/PDF.
- `backend/src/routes/applications.ts` (new): CRUD for `Application` (pipeline).
- `backend/src/routes/keys.ts` (new): **BYOK management** (see §5).
- Register all in `backend/src/routes/index.ts`.

### 3.4 Key Manager extension (`backend/src/ai/keyManager.ts`)
- Add `leaseNextTavilyKey()` (provider `tavily`) + `leaseNextLlmKey(provider?)` generalizing
  `leaseNextGroqKey`. Keep rotation + rate-limit cooldown. Fall back to env only when no
  user/system DB keys.

---

## 4. Frontend Implementation (matches existing conventions)

### 4.1 Routing (`src/App.tsx`)
Add (lazy + `ProtectedRoute`):
```
/app/jobs        → JobsPage (discovery + filters)
/app/jobs/:id    → JobDetailPage (eval + tailor)
/app/applications → ApplicationsPage (pipeline)
/app/settings    → extend SettingsPage (BYOK section)
```

### 4.2 Pages / Features
- **`src/pages/Jobs.tsx`** — mirrors `Match.tsx` layout: `AppLayout` + header + `Card` grid of
  `JobCard` (company, title, location, source badge, posted date). Search `Input` + source
  `Select` + "Scan" `Button` (Loader2 spinner). Uses `useJobs` hook → `apiClient.get('/jobs/search')`.
- **`src/features/jobs/JobCard.tsx`** — `Card` with company/title/location, `Badge` for source,
  "Evaluate" button → navigate to detail.
- **`src/pages/JobDetail.tsx`** — `Card` layout: JD preview, resume `Select` (reuse `useResumes`),
  "Evaluate" → shows `JobEvaluationReport` (A–G scores as `Progress` bars, overall score,
  recommendation badge, scam warning `AlertCircle`). Then **Template Picker** reusing
  `TemplateSelector` pattern (Sheet+Tabs+cards) → "Tailor Resume" → preview + export buttons
  (PDF/DOCX via `resumeApi`/`apiClient.downloadPost`).
- **`src/features/jobs/JobEvaluationReport.tsx`** — score bars + recommendation + STAR/R
  interview-prep bullets + comp notes.
- **`src/features/jobs/TailorPanel.tsx`** — template picker + tailor trigger + preview + export.
- **`src/pages/Applications.tsx`** — pipeline columns (saved/tailored/applied/interview) using
  `Card` + `Badge` + status `Select` to move stages.
- **BYOK UI** — extend `Settings.tsx` with an "API Keys" `Card`: list keys (`Badge` per provider),
  add-key `Dialog` (provider `Select` + `Input` for key + label), revoke button, validate state.
  Mirrors coupon `Dialog` pattern already in Settings.

### 4.3 Services & Hooks (mirror `resume.ts` / `useAuth.ts`)
- `src/services/api/jobs.ts` — `jobsApi.search`, `.get`, `evaluate`; `tailorApi.create`,
  `.export`; `applicationsApi.list`, `.updateStatus`. `keysApi.list/create/delete/validate`.
- `src/hooks/useJobs.ts`, `useTailor.ts`, `useApplications.ts`, `useApiKeys.ts` — react-query
  hooks (query keys, mutations, `useToast` feedback) following `useAuth.ts` style.

---

## 5. BYOK (Bring Your Own Keys)

### 5.1 Scope
- **LLM key:** Groq / OpenAI / OpenRouter / Gemini — for evaluation + tailoring.
- **Search key:** Tavily — for comp/company research during evaluation.
- Keys stored encrypted-at-rest (note: current model stores plaintext `apiKey` — add
  `lib/crypto.ts` AES encryption; document as security requirement).
- Per-user keys take precedence over system env keys (extend `keyManager` to filter by
  `userId` when present).
- Free users can use BYOK to bypass usage limits (common pattern) — decide via config flag
  `BYOK_BYPASSES_LIMITS`.

### 5.2 Backend (`backend/src/routes/keys.ts`)
- `GET /api/keys` → list user's keys (masked: `tvly-…1234`).
- `POST /api/keys` → `{ provider, apiKey, label }`, validate via provider ping
  (Groq `/models`, Tavily `/search` test), store encrypted, set `lastValidatedAt`.
- `DELETE /api/keys/:id` → revoke.
- Admin route (`requireAdmin`) to manage system/global keys (env fallback equivalents).
- Enforce ownership; never return raw key after creation.

### 5.3 keyManager changes
- `leaseNextLlmKey(userId?)` and `leaseNextTavilyKey(userId?)` read `AIProviderKey` filtered by
  `userId` (or system keys when `userId` null), with rotation + rate-limit cooldown.
- `getDatabaseKeys(provider, userId?)` generalizes existing `getDatabaseGroqKeys`.

---

## 6. Security & Risks
- **Key encryption:** encrypt `AIProviderKey.apiKey` at rest (`lib/crypto.ts`); current plaintext
  is a CONCERN from earlier map — fix as part of this work.
- **Truthfulness:** tailoring prompt forbids inventing experience (career-ops stance) to avoid
  interview misconduct.
- **Human-in-the-loop:** app generates tailored doc + tracking; **never auto-submits** (career-ops
  hard rule).
- **Scam/ghost-job:** surface `isScam` + legitimacy score prominently with warning UI.
- **Rate limits:** reuse `shared/usage.ts` + `assertUsageAllowed` for evaluations; BYOK may exempt.
- **ATS source fragility:** stick to no-auth public sources; don't scrape LinkedIn/auth boards.

---

## 7. Build Order (phased, each independently shippable)
1. **Phase 1 — Data & BYOK foundation:** Prisma migrations (`JobListing`, `JobEvaluation`,
   `TailoredResume`, `Application`, `AIProviderKey` extensions), `keys.ts` route + `useApiKeys`
   + Settings BYOK UI, keyManager Tavily/LLM generalization + encryption.
2. **Phase 2 — Job Discovery:** `jobSources/`, `jobs.ts` search route, `Jobs.tsx` + `JobCard`
   + `useJobs`.
3. **Phase 3 — Evaluation:** `ai/evaluation.ts`, `POST /jobs/:id/evaluate`, `JobDetail.tsx` +
   `JobEvaluationReport` (A–G + scam flag).
4. **Phase 4 — Tailor to Template:** `tailor.ts`, `TailorPanel` (reuse `TemplateSelector`),
   export via `export.ts`, preview.
5. **Phase 5 — Tracking:** `applications.ts` + `Applications.tsx` pipeline.
6. **Phase 6 — Polish:** liveness checks, usage limits, scam UI, loading/empty states.

---

## 8. Success Criteria
- [ ] User can search jobs from ≥3 public ATS sources.
- [ ] User can evaluate a listing → A–G scores + recommendation + scam flag.
- [ ] User can tailor a resume into any Clearance template → export DOCX/PDF.
- [ ] User can track applications through pipeline stages.
- [ ] User can add/revoke their own LLM + Tavily keys; keys used for eval/search.
- [ ] All new UI follows existing `AppLayout`/`Card`/`Dialog`/`Tabs`/`Sheet` conventions.
- [ ] Keys encrypted at rest; no key returned in plaintext after creation.
- [ ] No auto-submission; human-in-the-loop preserved.
