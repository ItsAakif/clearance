# Roadmap: Clearance — Resume-Matcher Integration

## Overview

Clearance is a React + Express resume platform (ATS scoring, job matching, tailoring,
template export). This phase cherry-picks the highest-value capabilities from two
open-source projects — **Resume-Matcher** (multi-pass AI tailoring + 3-factor ATS
scoring) and **Reactive Resume** (4 polished PDF templates + JSON schema) — and
wires them into the existing Clearance pipeline so users get a stronger
JD→Match→Tailor→Build flow plus a third "AI-Assisted Build" onboarding path.

## Phases

- [ ] **Phase 1: Resume-Matcher & Reactive Resume Integration** - Port multi-pass refinement pipeline, markitdown parser, 3-factor ATS scoring, 4 RTF templates, JD→Builder redirect, and AI-Assisted Build onboarding

## Phase Details

### Phase 1: Resume-Matcher & Reactive Resume Integration
**Goal**: A stronger resume pipeline where users can run a multi-pass AI tailoring
(improver → refiner → ATS score), parse complex PDFs/DOCX better, pick from 4
polished templates, jump from a job match straight into a tailored builder, and
start a resume via an AI-assisted (JD-paste) onboarding path.
**Depends on**: Nothing (first phase)
**Requirements**: [RM-01, RM-02, RM-03, RM-04, RM-05]
**Success Criteria** (what must be TRUE):
  1. User can run multi-pass tailoring on a resume + JD and get a refined, alignment-validated result with a 3-factor ATS score
  2. User can parse a PDF/DOCX resume and get structured JSON (better layout handling than current parser)
  3. User can preview and export a resume using any of the 4 ported Reactive Resume templates (single/two column × classic/modern) to PDF
  4. User can click "Build Tailored Resume" from job match results and land in the builder pre-filled with tailored content
  5. User can start a resume via an "AI-Assisted Build" onboarding option (paste JD → extract skills → generate sections → review in builder)
**Plans**: TBD (refined during planning)

Plans:
- [ ] 01-01: [Multi-pass refinement pipeline + 3-factor ATS scorer]
- [ ] 01-02: [markitdown-based resume parser]
- [ ] 01-03: [Reactive Resume 4 templates + client PDF export]
- [ ] 01-04: [JD → Match → Builder redirect flow]
- [ ] 01-05: [AI-Assisted Build onboarding option]

## Progress

**Execution Order:**
Phases execute in numeric order: 1

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Resume-Matcher Integration | 0/5 | Not started | - |
