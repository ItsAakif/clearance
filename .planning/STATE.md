# Project State

## Current Position

- **Active Milestone**: v1.0 Resume-Matcher Integration
- **Current Phase**: 1 (Resume-Matcher & Reactive Resume Integration)
- **Phase Status**: Planning
- **Last Action**: Bootstrapped planning foundation from research summary; planning phase 1

## Decisions

- **Backend stack**: Node.js + Express + TypeScript + Prisma (PostgreSQL). NO Python runtime assumed — markitdown port must use an npm-compatible approach (e.g. `markitdown` via child process is NOT preferred; use a TS-native equivalent or LibreOffice/markitdown-as-service only if a Python service is introduced). Planner must decide and document.
- **LLM access**: Groq (llama-3.1-70b) via OpenAI-compatible client + BYOK keyManager. New AI services must use `leaseNextLlmKey`.
- **PDF export**: Existing uses Puppeteer (server) + docxtemplater. Research suggests @react-pdf/renderer (client). Planner must reconcile with existing export pipeline.
- **Templates**: Existing 20+ TSX templates in `src/features/resume-builder/templates/`. New 4 are ADDITIVE, not replacements.

## Pending Todos

- None captured yet (planning in progress)

## Blockers

- None

## Notes

- `.planning/` existed with `codebase/` docs but no ROADMAP/STATE/REQUIREMENTS. Bootstrapped on 2026-07-18 from research summary.
- Research summary derived from srbhr/Resume-Matcher (MIT/Apache-2.0) and amruthpillai/Reactive-Resume (MIT).
