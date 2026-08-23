# Requirements: Phase 1 — Resume-Matcher & Reactive Resume Integration

## RM-01: Multi-Pass Refinement Pipeline + 3-Factor ATS Scoring
Port Resume-Matcher's pipeline into the Clearance backend:
- `backend/ats/improver.py` → TS module: initial AI tailoring pass (JD + master resume → tailored draft)
- `backend/ats/refiner.py` → TS module: multi-pass refinement (keyword injection from JD, AI-phrase simplification, master-alignment validation via LLM)
- `backend/ats/ats_scorer.py` → TS module: 3-factor weighted ATS score (Keyword Match 55%, Skills Coverage 25%, Section Completeness 20%)
- Cover letter + interview prep generators as downstream outputs
- Must use existing `leaseNextLlmKey` / `keyManager` for LLM calls; deterministic where possible.

## RM-02: markitdown-based Resume Parser
Replace/augment `backend/src/resume/parser.ts` with markitdown-grade extraction
(PDF/DOCX → Markdown → structured JSON with date restoration).
- Decision required: Node backend has no Python. Use TS-native equivalent
  (e.g. `pdf-parse` + `mammoth` enhanced, or `unpdf`/`libreoffice` headless) OR
  introduce a thin Python markitdown microservice. Planner documents choice.
- Must preserve existing `ParsedResume` shape consumed by downstream routes.

## RM-03: Reactive Resume 4 Templates + Client PDF Export
Port 4 Reactive Resume templates (Classic/MÉ Modern × Single/Two Column) into
`src/features/builder/templates/`:
- JSON-schema-compatible with existing Prisma Resume model
- PDF export via `@react-pdf/renderer` (client-side, no server needed) — reconcile with existing Puppeteer export
- Register in existing template registry

## RM-04: JD → Match → Builder Redirect Flow
In `src/features/job-match/JobMatchResults.tsx` add "Build Tailored Resume" button:
- Navigates to `/builder?jobMatchId={id}&prefill=tailored`
- Builder loads tailored content (from TailoredResume / job-match result) and prefills editor

## RM-05: 3rd Onboarding Option — AI-Assisted Build
Add to `src/pages/GetStarted.tsx` (currently Upload / Scratch):
- "🤖 AI-Assisted Build": paste JD → auto-extract skills → generate tailored sections → review & edit in builder
- Wires into existing builder; does NOT hardcode roles (per project preference: roles are user-supplied via doc)
