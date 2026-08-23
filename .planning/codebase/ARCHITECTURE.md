# Architecture

**Analysis Date:** 2025-07-17

## System Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           BROWSER (React SPA)                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │
│  │   Pages     │  │  Features   │  │    Hooks    │  │   Services/API  │   │
│  │  (routes)   │──│  (components)│──│ (react-query)│──│   (apiClient)   │   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └────────┬────────┘   │
└───────────────────────────────────────────────────────────────┼────────────┘
                                                                 │ HTTPS + cookies
                                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        EXPRESS API (port 3001)                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     Route Groups (mounted at /api/*)                 │   │
│  │  auth | resume | ats | job-match | payment | templates | ai          │   │
│  │  export | admin | keys | jobs | tailor | applications | profile      │   │
│  │  boards | searches                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐   │
│  │  Middleware │  │  Services   │  │    AI/ML    │  │  Job Discovery  │   │
│  │  (auth,     │  │  (prisma,   │  │ (evaluation,│  │ (Greenhouse,    │   │
│  │   rate-limit,│  │  crypto,    │  │  resumeGen, │  │  Ashby, Lever,  │   │
│  │   cors)     │  │   mailer)   │  │  keyManager)│  │  Workday, RSS)  │   │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                                                 │ Prisma ORM
                                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      POSTGRESQL (via Prisma)                                │
│  User, Resume, ATSReport, JobMatch, Template, CareerProfile, JobBoard,     │
│  JobListing, JobEvaluation, TailoredResume, Application, AIProviderKey,    │
│  SavedSearch, Subscription, UsageLog, Coupon, ResumeVariant                │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key Integration Points:**
- **Browser → API**: REST over HTTPS, `credentials: 'include'` for httpOnly JWT cookie (fallback: Bearer token in `Authorization` header)
- **API → DB**: Prisma Client (type-safe, connection pooled)
- **API → External AI**: OpenAI-compatible clients via `keyManager.ts` (Groq, OpenAI, OpenRouter, Gemini) + Tavily for search
- **API → Job Boards**: Zero-auth public APIs (Greenhouse, Ashby, Lever, Workday RSS, generic RSS)

---

## Major Data Pipelines

### 1. Resume Parsing → ATS Scoring → Template Rendering → DOCX/PDF Export

```
POST /api/resumes/upload (multipart/form-data)
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ backend/src/resume/parser.ts                                   │
│  • validateUploadedFile() - size (10MB), mime, filename sanit │
│  • parseUploadedResume(buffer, mimeType) → ParsedResume       │
│     - pdf-parse for PDF, mammoth for DOCX, text for TXT       │
│     - Section detection via regex (experience, education, etc)│
│     - Entity extraction (email, phone, LinkedIn, name)        │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
POST /api/resumes (create from parsed JSON)
         │
         ▼
POST /api/ats/scan/:resumeId
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ backend/src/ats/scanner.ts                                     │
│  • scanResumeContent(ResumeData) → ATSScanResult              │
│  • Categories: formatting, keywords, sections, length, contact│
│  • Scoring: 0-100 overall, status enum (excellent|good|...)   │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
GET /api/resumes/:id/export/pdf  or  /export/docx
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ backend/src/routes/resume.ts                                   │
│  • generatePdf() → Puppeteer (Chrome headless)                │
│  • generateFromTemplate() → docxtemplater + PizZip (.docx)    │
│  • Fallback: programmatic docx via `docx` package             │
└──────────────────────────────────────────────────────────────┘
```

**Key Files:**
- `backend/src/resume/parser.ts` — file parsing & structure extraction
- `backend/src/ats/scanner.ts` — ATS scoring algorithm
- `backend/src/routes/resume.ts` — CRUD + export endpoints
- `backend/src/routes/export.ts` — HTML→PDF/DOCX rendering
- `src/services/api/resume.ts` — frontend API client with transformers

---

### 2. Job Discovery → Evaluation → Tailoring → Application Tracking

```
User configures JobBoard (Greenhouse/Ashby/Lever/Workday/RSS)
         │
         ▼
POST /api/boards  →  prisma.jobBoard.create()
         │
         ▼
GET /api/jobs?source=greenhouse&q=backend
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ backend/src/jobSources/index.ts                                │
│  • fetchGreenhouse(board, query)  → boards-api.greenhouse.io  │
│  • fetchAshby(company, query)     → jobs.ashbyhq.com GraphQL  │
│  • fetchLever(site, query)        → api.lever.co              │
│  • fetchWorkday(rssUrl, query)    → generic RSS/JSON          │
│  • fetchRss(feedUrl, query)       → generic RSS parser        │
│  • runSource(config)              → unified entry point       │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
POST /api/jobs/evaluate  (with resumeId + jobListingId)
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ backend/src/ai/evaluation.ts  — evaluateJob()                 │
│  1. leaseNextLlmKey(userId) → Groq/OpenAI/OpenRouter/Gemini  │
│  2. Optional: leaseNextSearchKey() → Tavily for comp research │
│  3. Build prompt with A-F rubric (cvMatch, levelFit, compFit, │
│     personalization, interviewPrep, legitimacy)              │
│  4. Call LLM with JSON response_format                        │
│  5. Persist JobEvaluation (scores 1-5, overall, recommendation│
│     apply/maybe/skip, isScam flag)                            │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
POST /api/tailor  (jobEvaluationId + resumeId + templateId)
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ backend/src/routes/tailor.ts                                   │
│  1. Load source resume + job description                      │
│  2. Load CareerProfile for context (topSkills, seniority)     │
│  3. LLM rewrite with TAILOR_PROMPT (truthful mirroring)       │
│  4. renderResumeHtml() → minimal inline-styled HTML           │
│  5. Persist TailoredResume (content JSON + HTML + templateId) │
│  6. Export via exportBuffer(html, 'pdf'|'docx')               │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
POST /api/applications  (status: saved|tailored|applied|interview|offer|rejected)
         │
         ▼
Prisma: Application { userId, jobListingId, tailoredResumeId?, status, notes }
```

**Key Files:**
- `backend/src/jobSources/index.ts` — zero-auth ATS fetchers
- `backend/src/ai/evaluation.ts` — A-F rubric, BYOK key leasing
- `backend/src/routes/tailor.ts` — LLM rewrite + HTML render + export
- `backend/src/routes/jobs.ts` — evaluation endpoint, liveness check
- `backend/src/routes/applications.ts` — application tracking CRUD

---

### 3. BYOK (Bring Your Own Key) — AI Provider Key Management

```
User adds key in Settings → POST /api/keys
         │
         ▼
backend/src/lib/crypto.ts  encryptSecret() → AES-256-GCM (key from env)
         │
         ▼
prisma.aiProviderKey.create({ provider, apiKey: encrypted, userId })
         │
         ▼
Later: leaseNextLlmKey(userId)  or  leaseNextSearchKey(userId)
         │
         ▼
backend/src/ai/keyManager.ts
  • getDatabaseKeys(provider, userId) → decryptSecret(), order by lastUsedAt
  • getEnvKeys(provider) → process.env GROQ_API_KEY[_1..20], TAVILY_API_KEY
  • Rotation: round-robin across available keys (database first, env fallback)
  • markKeySuccess() / markKeyFailure() → rate-limit tracking per key
  • isRateLimitError() → detects 429, quota, "too many requests"
```

**Supported Providers:**
- LLM: `groq` (default llama-3.1-70b), `openai`, `openrouter`, `gemini`
- Search: `tavily`

**Key Files:**
- `backend/src/ai/keyManager.ts` — leasing, rotation, rate-limit handling
- `backend/src/lib/crypto.ts` — encrypt/decrypt with AES-256-GCM
- `backend/src/routes/keys.ts` — CRUD for user keys (encrypted at rest)

---

### 4. Profile Parsing from Resume (LLM-assisted)

```
POST /api/profile/parse-from-resume/:resumeId
         │
         ▼
backend/src/routes/profile.ts (lines 52-116)
  1. Load resume JSON (summary, experience, education, skills)
  2. leaseNextLlmKey(userId) → Groq llama-3.1-70b
  3. System prompt: extract career profile facts → JSON
  4. Return { suggested: {targetRoles, seniority, topSkills, industries, summary},
             missing: [minSalary, maxSalary, locationPref, remoteOnly, redFlags] }
```

Profile parsing from resume is implemented in `backend/src/profile/parser.ts` (`parseProfileFromResume`), called by `routes/profile.ts`. Extracted to remove duplication.

---

## Route Groups (from `backend/src/routes/index.ts`)

| Prefix | Module | Responsibility |
|--------|--------|----------------|
| `/auth` | `auth.ts` | Signup, login, logout, OAuth, password reset, email verify |
| `/resumes` | `resume.ts` | CRUD, upload/parse, variants, archive, export PDF/DOCX |
| `/ats` | `ats.ts` | Scan resume (auth + public), reports |
| `/job-match` | `job-match.ts` | Match resume vs JD (keywords, score) |
| `/payment` | `payment.ts` | Stripe checkout, portal, webhooks |
| `/templates` | `templates.ts` | List templates, metadata |
| `/ai` | `ai.ts` | AI-guided resume generation, bullet improvement |
| `/export` | `export.ts` | HTML→PDF/DOCX (preview & saved resumes) |
| `/admin` | `admin.ts` | Admin-only stats, user management |
| `/keys` | `keys.ts` | BYOK key CRUD (encrypted storage) |
| `/jobs` | `jobs.ts` | Job discovery, evaluation (A-F rubric), liveness |
| `/tailor` | `tailor.ts` | Tailor resume to JD + template → export |
| `/applications` | `applications.ts` | Application tracking (kanban status) |
| `/profile` | `profile.ts` | CareerProfile CRUD + parse-from-resume |
| `/boards` | `boards.ts` | JobBoard CRUD (Greenhouse/Ashby/Lever/Workday/RSS) |
| `/searches` | `saved-searches.ts` | SavedSearch CRUD |

---

## Authentication & Authorization

**Strategy:** JWT in httpOnly cookie (`token`) with `SameSite=lax`, `Secure` in prod. Fallback: `Authorization: Bearer <token>` header.

**Middleware:** `backend/src/middleware/auth.ts`
- `requireAuth` — validates JWT, attaches `req.user { id, email, emailVerified, isAdmin }`
- `optionalAuth` — populates user if token present, never fails
- `generateToken(userId, email)` — 7d expiry, HS256
- `verifyToken(token)` → `JwtPayload | null`
- `setAuthCookie` / `clearAuthCookie`

**Admin Check:** `adminEmails` from `ADMIN_EMAILS` env var (comma-separated). `req.user.isAdmin` set in middleware.

**Rate Limiting (app.ts):**
- General: 100 req / 15 min
- Auth endpoints: 10 req / 15 min
- Public ATS scan: 5 req / hour

---

## Data Models (Prisma Schema Highlights)

```prisma
// Core identity
User { id, email, passwordHash, plan(FREE|PRO), stripeCustomerId, usageCounters... }

// Resume (structured JSON)
Resume { userId, name, personalInfo(Json), summary, experience(Json), education(Json), 
         skills(String[]), sections(Json), templateId, templateSettings(Json), 
         lastATSScore?, variants: ResumeVariant[] }

// ATS Scanning
ATSReport { resumeId?, userId?, overallScore(0-100), status, categories(Json), 
            keywords(Json), formatting(Json), isPublicScan }

// Job Discovery
JobBoard { userId, type(greenhouse|ashby|lever|workday|rss), boardId?, feedUrl?, isActive }
JobListing { externalId, source, title, company, description, applyUrl, isActive }
JobEvaluation { userId, jobListingId, resumeId?, 
                cvMatchScore, levelFitScore, compFitScore, personalizationScore, 
                interviewPrepScore, legitimacyScore, overallScore, recommendation, isScam }

// Tailoring
TailoredResume { userId, jobEvaluationId?, sourceResumeId, templateId, jobListingId?, 
                 title, content(Json), html }

// Applications
Application { userId, jobListingId, tailoredResumeId?, status(saved|tailored|applied|interview|offer|rejected) }

// BYOK
AIProviderKey { userId?, provider(groq|openai|openrouter|gemini|tavily), 
                apiKey(encrypted), isActive, lastUsedAt, failureCount, rateLimitedUntil }

// Career Profile
CareerProfile { userId@unique, targetRoles[], seniority, min/maxSalary, locationPref, 
                remoteOnly, topSkills[], industries[], redFlags[], proofPoints[], summary }
```

---

## Error Handling Pattern

**Backend (`backend/src/shared/errors.ts`):**
- Custom error classes: `BadRequestError`, `NotFoundError`, `ForbiddenError`, `ConflictError`, `UnauthorizedError`
- `handleApiError(error, res)` — maps to HTTP status, logs `[ERROR] timestamp: message`
- Security events logged via `logSecurityEvent(type, details)`

**Frontend (`src/services/api/client.ts`):**
- `ApiClientError` with `statusCode`
- `request()` throws on non-2xx, parses JSON error body
- `uploadFile()` / `downloadFile()` / `downloadFilePost()` for multipart/blob

---

## Frontend Data Flow

```
Page Component (e.g., Build.tsx)
    │
    ├── useResume(id) → react-query (staleTime: 2min)
    ├── useResumeData() → local state (React context-like hook)
    │
    ├── TemplateRenderer (from features/resume-builder/templates)
    │     │
    │     ├── EditableField / EditableBulletList / EditableSkills
    │     ├── TemplateCustomizer (colors, fonts, spacing)
    │     └── onDataChange → debounced PATCH /api/resumes/:id (800ms)
    │
    └── Export → resumeApi.exportPdf()/exportDocx() → blob download
```

**Key Hooks (`src/hooks/`):**
- `useAuth` → `useCurrentUser` (react-query, 10min stale, retry: false on 401)
- `useResumes` / `useResume` / `useCreateResume` / `useUpdateResume` / `useUploadResume`
- `useATSReport` / `useScanResume` / `useMatchJob`
- `useJobs` / `useJobEvaluations` / `useTailoredResumes`
- `useSubscriptionStatus` / `useCheckout`

**API Client (`src/services/api/client.ts`):**
- Base URL: `import.meta.env.VITE_API_URL || 'http://localhost:3001/api'`
- `credentials: 'include'` for cookie auth
- Methods: `get`, `post`, `put`, `patch`, `delete`, `upload`, `download`, `downloadPost`

---

## Cross-Cutting Concerns

| Concern | Implementation |
|---------|----------------|
| **Validation** | Zod schemas in `backend/src/shared/validation.ts` (`createResumeSchema`, `tailorResumeSchema`, etc.) |
| **Usage Limits** | `backend/src/shared/usage.ts` — `assertUsageAllowed()`, `buildUsageIncrement()` per plan |
| **Ownership** | `backend/src/shared/auth.ts` — `ensureOwnership(userId, resourceUserId, resourceName)` |
| **Encryption** | `backend/src/lib/crypto.ts` — AES-256-GCM, key from `ENCRYPTION_KEY` env |
| **Email** | `backend/src/lib/mailer.ts` + `backend/src/auth/email.ts` — Nodemailer, verification/reset |
| **Templates** | `backend/templates/*.docx` + `backend/src/templates/metadata.ts` (preview images, categorization) |
| **Frontend UI** | shadcn/ui (Radix) + Tailwind, `src/components/ui/*` primitives |
| **Theme** | `next-themes` (localStorage + system preference) |

---

## Deployment Requirements

| Component | Requirement |
|-----------|-------------|
| **Runtime** | Node.js ≥ 18 |
| **Database** | PostgreSQL (Prisma) |
| **Browser** | Playwright Chromium for PDF generation (`import { chromium } from 'playwright'` in `resume.ts`, `tailor.ts`, `templates.ts`, `export.ts`) |
| **Env Vars** | `DATABASE_URL`, `JWT_SECRET`, `CLIENT_URL`, `API_URL`, `ENCRYPTION_KEY`, `SMTP_*`, `GOOGLE_CLIENT_ID/SECRET`, `GROQ_API_KEY` (or other AI providers), `TAVILY_API_KEY` |
| **Ports** | Frontend: 5173 (Vite), Backend: 3001 (Express) |

---

*Architecture analysis: 2025-07-17*