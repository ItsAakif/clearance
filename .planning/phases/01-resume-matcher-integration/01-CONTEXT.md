# Phase 1: Resume-Matcher & Reactive Resume Integration - Context

**Gathered**: 2026-07-18
**Status**: Ready for planning
**Source**: Research summary (cherry-pick from Resume-Matcher + Reactive Resume)

<domain>
## Phase Boundary

This phase integrates specific capabilities from two OSS projects into the existing
Clearance (React + Express) platform. It does NOT rebuild the app — it extends the
existing parser, ATS, tailor, templates, job-match, and onboarding surfaces.

What this phase delivers (5 workstreams):
1. Multi-pass AI tailoring pipeline (improver → refiner → 3-factor ATS scorer) + cover letter / interview prep generators
2. Better PDF/DOCX parser (markitdown-grade extraction)
3. 4 ported Reactive Resume templates with client-side PDF export
4. JD → Match → Builder redirect ("Build Tailored Resume" button)
5. 3rd onboarding option: "AI-Assisted Build" (paste JD → extract → generate → review)

</domain>

<decisions>
## Implementation Decisions

### Backend / AI
- All LLM calls MUST use `leaseNextLlmKey(userId)` from `backend/src/ai/keyManager.ts` (Groq default, BYOK supported). Do NOT instantiate raw OpenAI clients for new code.
- New ATS scoring (3-factor) is ADDITIVE — keep existing deterministic `scanner.ts` intact; new scorer is a separate module consumed by the tailoring flow.
- Parser output MUST keep the existing `ParsedResume` shape so `resume.ts` / downstream routes don't break.

### Templates
- 4 new templates are ADDITIVE to the existing 20+ TSX templates. Register in `src/features/resume-builder/templates/registry.ts`.
- PDF export: research suggests `@react-pdf/renderer` (client-side). This must coexist with the existing Puppeteer server export. Planner decides integration (new export path vs replace) and documents it.

### Frontend Flow
- "Build Tailored Resume" button lives in `src/features/job-match/JobMatchResults.tsx`, routes to `/builder?jobMatchId={id}&prefill=tailored`.
- 3rd onboarding card added to `src/pages/GetStarted.tsx` (alongside Upload + Scratch).

### OpenCode's Discretion
- Exact module/file layout within `backend/ats/` and `src/features/builder/templates/`
- How markitdown is realized in a Node backend (TS-native vs Python microservice) — MUST document the chosen approach and why
- Cover letter / interview prep UI surface (API-only vs minimal UI)
- Test granularity

</decisions>

<specifics>
## Specific Ideas

From research summary (srbhr/Resume-Matcher, MIT/Apache-2.0):
- **refiner.py**: keyword injection (JD keywords present in master but missing in tailored), AI-phrase removal (local, no LLM), master-alignment validation (LLM)
- **ats.py** 3-factor: Keyword Match 55%, Skills Coverage 25%, Section Completeness 20%
- **parser.py**: markitdown → Markdown → LLM parse with date restoration
- **cover_letter.py**, **interview_prep.py**: generators

From amruthpillai/Reactive-Resume (MIT):
- 4 templates: Classic Single, Modern Single, Classic Two Column, Modern Two Column
- Schema JSON (4399 lines) — compatible with Clearance Prisma Resume model
- `@react-pdf/renderer` for PDF

Files to create/modify (research suggested):
- backend/ats/refiner.ts, backend/ats/improver.ts, backend/ats/atsScorer.ts, backend/ats/parser.ts, backend/ats/coverLetter.ts, backend/ats/interviewPrep.ts
- backend/routes/matchAndBuild.ts
- src/features/builder/templates/* (4 templates)
- src/features/builder/ResumeBuilder.tsx (JD comparison view)
- src/pages/GetStarted.tsx (3rd option)

</specifics>

<deferred>
## Deferred Ideas

- Full AI-assisted resume builder process that is DIFFERENT from job-matching-with-JD (auto-detected as a future phase, NOT in scope here). Explicitly out of scope per request.

</deferred>

---
*Phase: 01-resume-matcher-integration*
*Context gathered: 2026-07-18 via Research Summary*
