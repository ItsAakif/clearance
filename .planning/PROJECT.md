# Project: Clearance

> AI-assisted resume platform — ATS scoring, job discovery, resume tailoring, and
> polished template export — built as a React (Vite) SPA frontend with an Express +
> TypeScript + Prisma/PostgreSQL backend.

## Purpose

Clearance helps job seekers turn a master resume into tailored, ATS-friendly
versions for specific jobs. It combines: resume parsing, a multi-factor ATS score,
JD↔resume matching, LLM-powered tailoring, and a library of exportable templates
(DOCX/PDF). The current milestone ports the highest-value capabilities of
**Resume-Matcher** (multi-pass AI tailoring + 3-factor ATS scoring) and
**Reactive Resume** (polished PDF templates) into the existing pipeline.

## Tech Stack (summary — see `.planning/codebase/STACK.md` for detail)

- **Frontend**: React 18 + TypeScript (relaxed strict), Vite 5, React Router 6,
  TanStack Query, React Hook Form + Zod, Tailwind CSS + Radix (shadcn/ui),
  Recharts, Three.js, Framer Motion, docx/html-to-docx, pdf-parse/mammoth.
- **Backend**: Node.js ≥ 18, Express 4, TypeScript (strict), Prisma 5 (PostgreSQL),
  JWT auth (httpOnly cookie), Zod validation, Multer uploads, Nodemailer,
  `openai` SDK (used with Groq/OpenRouter/Gemini via `baseURL` override).
- **AI/ML**: Groq (`llama-3.1-70b`) primary; OpenAI/OpenRouter/Gemini via BYOK;
  Tavily for web search. All LLM access routed through `leaseNextLlmKey`.
- **Testing**: Vitest + Supertest. **Lint/Format**: ESLint 9 (flat) + typescript-eslint.
- **Tooling**: npm (two independent `package.json`s — root frontend + `backend/`, no workspaces).

## Architecture (summary — see `.planning/codebase/ARCHITECTURE.md` for detail)

- **Browser (SPA)** → REST over HTTPS (`credentials: include`) → **Express API** (port 3001,
  route groups under `/api/*`: auth, resumes, ats, job-match, templates, ai,
  export, admin, keys, jobs, tailor, applications, profile, boards, searches) →
  **PostgreSQL** via Prisma.
- **Key pipelines**: (1) Resume parse → ATS scan → template render → DOCX/PDF export;
  (2) Job discovery → evaluation (A-F rubric) → tailoring → application tracking;
  (3) BYOK key management (AES-256-GCM at rest, round-robin leasing/rotation);
  (4) LLM-assisted profile parsing from resume.
- **Auth**: JWT in httpOnly cookie, `requireAuth`/`optionalAuth` middleware, admin via
  `ADMIN_EMAILS`. Rate limiting per app/auth/public-ATS tiers.

## Current Milestone & Phase

- **Milestone**: `v1.0 Resume-Matcher Integration`
- **Phase**: 1 — *Resume-Matcher & Reactive Resume Integration* (status: Planning)
- **Requirements**: RM-01..RM-05 (see `.planning/REQUIREMENTS.md`)
- **Roadmap**: `.planning/ROADMAP.md` · **State**: `.planning/STATE.md`

## Key Decisions & Constraints

- **Node backend, no assumed Python runtime.** markitdown-grade parsing must be
  TS-native (`pdf-parse`/`mammoth`/`unpdf`/LibreOffice headless) or a thin Python
  microservice — the planner documents the chosen approach (RM-02).
- **LLM access via `leaseNextLlmKey` / `keyManager`** with BYOK. New AI services must
  not hardcode keys.
- **Existing PDF export (Puppeteer + docxtemplater) must be reconciled**, not replaced,
  with any new client-side `@react-pdf/renderer` export (RM-03).
- **Templates are additive**: 20+ existing TSX templates remain; the 4 ported
  Reactive Resume templates are new additions, registered in the existing registry.
- **User-supplied roles**: onboarding/AI flows must not hardcode job roles — roles are
  always provided by the user via document input.

## Repository Layout

```
/                         React frontend (Vite) + root config
  src/                    App, pages, features (resume-builder, job-match), hooks, services
  backend/                Express API (src/: routes, ai, resume, ats, jobSources, lib, shared)
  scraper/                (auxiliary scraping tooling)
  public/                 Static assets
  .planning/              GSD planning artifacts (this directory)
```

## Planning Pointers

- Requirements: `.planning/REQUIREMENTS.md`
- Roadmap: `.planning/ROADMAP.md`
- State: `.planning/STATE.md`
- Codebase map: `.planning/codebase/` (STACK, ARCHITECTURE, STRUCTURE, CONVENTIONS,
  TESTING, INTEGRATIONS, CONCERNS)
