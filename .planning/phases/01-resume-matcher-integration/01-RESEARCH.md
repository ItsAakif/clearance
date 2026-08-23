# Phase 1 Research: Resume-Matcher & Reactive Resume Integration

**Research Date**: 2026-07-18
**Method**: Library/architecture analysis of srbhr/Resume-Matcher (MIT/Apache-2.0) and amruthpillai/Reactive-Resume (MIT)

## What to Cherry-Pick

### Resume-Matcher (srbhr/Resume-Matcher)
**Core Algorithm — Multi-Pass Refinement Pipeline:**
- **Keyword Injection** (refiner): inject missing JD keywords that exist in master resume but not in tailored version
- **AI Phrase Removal**: replace AI-generated buzzwords with simpler alternatives (local, no LLM)
- **Master Alignment Validation**: ensure no fabricated content was added (LLM-powered)
- **ATS Scoring** (ats.py): 3-factor weighted scoring — Keyword Match (55%), Skills Coverage (25%), Section Completeness (20%)

**Key Services to Adopt:**
- `parser.py`: markitdown for PDF/DOCX → Markdown, then LLM parsing with date restoration
- `improver.py`: initial AI tailoring (first pass)
- `refiner.py`: multi-pass refinement (core value)
- `ats.py`: ATS-style scoring
- `cover_letter.py`: cover letter generation
- `interview_prep.py`: interview prep generation

**Architecture (their project):**
- FastAPI backend (Python), Next.js + React frontend, TinyDB (JSON), LiteLLM for 100+ LLMs, PDF via Playwright

### Reactive Resume (amruthpillai/Reactive-Resume)
**Templates (4 core, all PDF-viewable):**
- Classic Single Column
- Modern Single Column
- Classic Two Column
- Modern Two Column
- Template structure: JSON Schema-based (4399 lines in schema.json)
- Template system: React components rendered to PDF via `@react-pdf/renderer`

**Builder Architecture:**
- Section-based (Summary, Experience, Education, Skills, Projects, etc.)
- Custom sections, drag-and-drop reordering, rich text (TipTap), real-time preview, A4/Letter sizing, custom CSS

**Data Model (JSON Schema compatible with Clearance Prisma Resume):**
```
basics: {name, label, email, phone, url, summary, location, profiles[]}
work: [{name, position, url, startDate, endDate, summary, highlights[]}]
education: [{institution, area, studyType, startDate, endDate, score}]
skills: [{name, level, keywords[]}]
projects: [{name, description, highlights[], keywords[], url}]
languages: [{language, fluency}]
meta: {theme, template, pageSize, ...}
```

## Actionable Recommendations for Clearance

1. **Integrate Multi-Pass Pipeline (High Impact)**
   - `backend/ats/refiner.ts` — multi-pass refinement
   - `backend/ats/improver.ts` — initial AI tailoring
   - `backend/ats/atsScorer.ts` — 3-factor ATS scoring
   - Flow: JD + Master Resume → Improver → Refiner → ATS Score → Builder

2. **Adopt Better Parser (Quick Win)**
   - Replace parser with markitdown-grade extraction. ⚠️ Clearance backend is Node/TS — markitdown is Python. Options:
     - (A) TS-native: enhance `pdf-parse`+`mammoth` with layout-aware post-processing, OR adopt `unpdf`/`pdfjs` + `mammoth`, OR drive LibreOffice headless → Markdown
     - (B) Python microservice running markitdown, called via HTTP from Node
   - Recommend (A) for simplicity unless complex layouts demand (B). Document choice.

3. **Add Reactive Resume Templates (Visual Polish)**
   - Port 4 templates into `src/features/builder/templates/`
   - Use `@react-pdf/renderer` for client PDF export (no server needed)
   - Schema is JSON-Schema-compatible with existing Prisma Resume model

4. **Wire Job Match → Builder Redirect**
   - In `JobMatchResults.tsx` add "Build Tailored Resume" button
   - Navigates to `/builder?jobMatchId={id}&prefill=tailored`

5. **3rd Onboarding Option: "AI-Assisted Build"**
   - Onboarding: Upload Existing (current) / Start from Scratch (current) / 🤖 AI-Assisted Build (NEW)
   - Paste JD → auto-extract skills → generate tailored sections → review & edit in builder

## Files to Create/Modify in Clearance

| File | Purpose |
|------|---------|
| backend/ats/refiner.ts | Multi-pass refinement (port from Resume-Matcher) |
| backend/ats/improver.ts | Initial AI tailoring pass |
| backend/ats/atsScorer.ts | 3-factor ATS scoring |
| backend/ats/parser.ts | markitdown-grade parser (or augmentation) |
| backend/ats/coverLetter.ts | Cover letter generator |
| backend/ats/interviewPrep.ts | Interview prep generator |
| backend/routes/matchAndBuild.ts | JD → Match → Builder flow |
| src/features/builder/templates/ | 4 templates from Reactive Resume |
| src/features/builder/ResumeBuilder.tsx | Enhanced builder with JD comparison view |
| src/pages/GetStarted.tsx | 3rd option: AI-Assisted Build |

## Validation Architecture

**Nyquist validation required.** Each plan must include `<verify>` with an `<automated>` command.

Test strategy:
- **Unit (Vitest)**: `atsScorer` 3-factor math, `refiner` keyword-injection determinism, `parser` shape preservation, `improver` output shape
- **Integration (Supertest)**: `POST /api/ats/tailor` end-to-end (JD + resume → refined + score), `POST /api/ats/parse` returns ParsedResume shape
- **Frontend**: build passes (`vite build`), route `/builder?jobMatchId=&prefill=tailored` renders prefilled; GetStarted shows 3 cards
- **Manual checkpoint**: visual template PDF export + AI-Assisted Build flow

## Common Pitfalls
- Don't break existing `ParsedResume` consumers (resume.ts, tailor.ts)
- Don't replace existing deterministic `scanner.ts` — new scorer is additive
- `@react-pdf/renderer` PDF must coexist with Puppeteer export (don't delete server export unless explicitly replacing)
- markitdown is Python — don't assume it runs in Node; decide and document
- Don't hardcode roles in AI-Assisted Build (project preference: user supplies roles via doc)

---
*Research for Phase 01 — derived from OSS analysis*
