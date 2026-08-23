# Codebase Structure

**Analysis Date:** 2025-07-17

## Directory Layout

```
E:\Projects\Webd+AI\Clearance\
├── backend/                          # Express API (port 3001)
│   ├── src/
│   │   ├── index.ts                  # Entry point → app.listen(3001)
│   │   ├── app.ts                    # Express setup: CORS, rate-limit, cookie-parser, static /api/previews
│   │   ├── config/env.ts             # Zod-validated env (JWT_SECRET, DATABASE_URL, CLIENT_URL, etc.)
│   │   ├── lib/
│   │   │   ├── prisma.ts             # PrismaClient singleton
│   │   │   ├── crypto.ts             # AES-256-GCM encrypt/decrypt for API keys
│   │   │   └── mailer.ts             # Nodemailer transporter
│   │   ├── middleware/
│   │   │   ├── auth.ts               # JWT verify (cookie + Bearer), requireAuth, optionalAuth, set/clear cookie
│   │   │   └── admin.ts              # requireAdmin (checks req.user.isAdmin)
│   │   ├── routes/                   # 15 route modules mounted at /api/*
│   │   │   ├── index.ts              # Router aggregator (see Route Groups table)
│   │   │   ├── auth.ts               # signup, login, logout, me, profile, forgot/reset, verify, Google OAuth
│   │   │   ├── resume.ts             # CRUD, upload/parse, variants, archive, export PDF/DOCX (1223 lines)
│   │   │   ├── ats.ts                # scan (auth + public), reports
│   │   │   ├── job-match.ts          # match resume vs JD
│   │   │   ├── payment.ts            # Stripe checkout, portal, webhooks
│   │   │   ├── templates.ts          # list templates + metadata
│   │   │   ├── ai.ts                 # AI-guided resume generation, bullet improvement
│   │   │   ├── export.ts             # HTML→PDF/DOCX (Puppeteer + html-to-docx)
│   │   │   ├── admin.ts              # admin stats, user mgmt
│   │   │   ├── keys.ts               # BYOK CRUD (encrypted storage)
│   │   │   ├── jobs.ts               # Job discovery (boards), evaluation (A-F rubric), liveness
│   │   │   ├── tailor.ts             # Tailor resume to JD → HTML → export
│   │   │   ├── applications.ts       # Application tracking (kanban status)
│   │   │   ├── profile.ts            # CareerProfile CRUD + parse-from-resume (LLM)
│   │   │   ├── boards.ts             # JobBoard CRUD (Greenhouse/Ashby/Lever/Workday/RSS)
│   │   │   └── saved-searches.ts     # SavedSearch CRUD
│   │   ├── resume/
│   │   │   └── parser.ts             # PDF/DOCX/TXT → ParsedResume (pdf-parse, mammoth)
│   │   ├── ats/
│   │   │   └── scanner.ts            # ATS scoring algorithm (keywords, formatting, sections)
│   │   ├── ai/
│   │   │   ├── keyManager.ts         # Unified key leasing (Groq/OpenAI/OpenRouter/Gemini + Tavily)
│   │   │   ├── evaluation.ts         # evaluateJob() — A-F rubric, BYOK, optional Tavily research
│   │   │   └── resumeGenerator.ts    # AI-guided resume from questionnaire
│   │   ├── jobSources/
│   │   │   ├── index.ts              # fetchGreenhouse, fetchAshby, fetchLever, fetchWorkday, fetchRss
│   │   │   └── liveness.ts           # checkLiveness(applyUrl) — HEAD request
│   │   ├── templates/
│   │   │   ├── analyzer.ts           # Analyze .docx template structure
│   │   │   ├── metadata.ts           # Template registry (id, name, category, preview, defaultSettings)
│   │   │   └── operations.ts         # Template file operations
│   │   ├── auth/
│   │   │   ├── email.ts              # sendVerificationEmail, sendPasswordResetEmail
│   │   │   └── operations.ts         # Token create/hash/verify helpers
│   │   ├── shared/
│   │   │   ├── validation.ts         # Zod schemas (createResume, updateResume, tailorResume, etc.)
│   │   │   ├── usage.ts              # assertUsageAllowed, buildUsageIncrement (FREE plan limits)
│   │   │   ├── errors.ts             # Custom errors + handleApiError, logSecurityEvent
│   │   │   └── auth.ts               # sanitizeUser, ensureOwnership
│   │   └── test/setup.ts             # Vitest setup
│   ├── prisma/
│   │   ├── schema.prisma             # Full schema (User, Resume, ATSReport, JobMatch, JobListing, JobEvaluation, TailoredResume, Application, AIProviderKey, CareerProfile, JobBoard, SavedSearch, Template, Coupon, ResumeVariant)
│   │   └── seed.ts                   # Seed templates, admin user
│   ├── templates/                    # .docx template files (20+ templates)
│   │   ├── Professional-Standard.docx
│   │   ├── ModernMinimal.docx
│   │   ├── ClassicElegant.docx
│   │   └── ... (previews in backend/previews/*.png)
│   ├── scripts/
│   │   ├── convert-templates.js      # .docx → preview PNG
│   │   ├── generate-previews.js
│   │   └── safe-convert-templates.js
│   ├── dist/                         # Compiled output (tsc)
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
│
├── src/                              # React SPA (Vite, port 5173)
│   ├── main.tsx                      # React 18 root + providers
│   ├── App.tsx                       # Routes (lazy-loaded) + ProtectedRoute wrapper
│   ├── App.css                       # Global styles (minimal)
│   ├── index.css                     # Tailwind base + CSS variables
│   ├── vite-env.d.ts                 # Vite types
│   ├── components/
│   │   ├── ui/                       # 50+ shadcn/ui primitives (Radix + Tailwind)
│   │   │   ├── button.tsx, input.tsx, dialog.tsx, dropdown-menu.tsx, ...
│   │   │   ├── toast.tsx, toaster.tsx, sonner.tsx
│   │   │   ├── sidebar.tsx, sheet.tsx, tabs.tsx, table.tsx
│   │   │   └── ... (see ui/ directory for full list)
│   │   ├── layout/
│   │   │   ├── AppLayout.tsx         # Sidebar nav (collapsible), mobile drawer, logout, theme toggle
│   │   │   └── LandingHeader.tsx     # Marketing header
│   │   ├── ProtectedRoute.tsx        # Redirects to /auth if !isAuthenticated
│   │   ├── ats/                      # ATSQuickScore, ATSScoreDisplay
│   │   └── ... (feature-specific components)
│   ├── features/
│   │   ├── resume-builder/           # Inline editor + template system
│   │   │   ├── templates/            # 20+ template components
│   │   │   │   ├── index.ts          # Barrel export
│   │   │   │   ├── registry.ts       # Template registry, categories
│   │   │   │   ├── TemplateRenderer.tsx
│   │   │   │   ├── EditableField.tsx, EditableBulletList.tsx, EditableSkills.tsx
│   │   │   │   ├── TemplateCustomizer.tsx (colors, fonts, spacing)
│   │   │   │   ├── InlineColorPicker.tsx
│   │   │   │   ├── ResizableLayout.tsx (sidebar, header, columns)
│   │   │   │   ├── BaseComponents.tsx (ResumePage, Section, EntryHeader...)
│   │   │   │   ├── types.ts          # TemplateProps, TemplateCustomization, FontFamily, SpacingSettings
│   │   │   │   └── *.tsx             # ProfessionalStandard, ModernMinimal, ClassicElegant, TwoColumnExecutive, ElegantSidebar, PhotoHeader, CreativeDesigner, Timeline, Compact, SimpleATS, MinimalistDesigner, SidebarPhotoLeft/Right, BoldHeader, HeaderPhotoCentered, SplitEqual, ModernCards, ClassicSidebar, ExecutiveClassic, TechModern, AccentLine, PortfolioDesigner
│   │   │   ├── DynamicFormEditor.tsx
│   │   │   ├── DocxPreview.tsx
│   │   │   ├── DocumentEditor.tsx
│   │   │   ├── InlineResumeEditor.tsx
│   │   │   ├── ResumePreview.tsx
│   │   │   └── ResumeEditor.tsx
│   │   ├── job-match/
│   │   │   ├── JobMatchResults.tsx
│   │   │   └── index.ts
│   │   └── template-selector/
│   │       ├── TemplateSelector.tsx
│   │       ├── TemplateControls.tsx
│   │       ├── TemplateCard.tsx
│   │       └── index.ts
│   ├── hooks/                        # React Query hooks (colocated by domain)
│   │   ├── index.ts                  # Barrel export
│   │   ├── useAuth.ts                # useCurrentUser, useAuth, useLogin, useSignup, useLogout, useForgotPassword, useCompletePasswordReset, useUpdateProfile, useResendVerificationEmail, useDeleteAccount
│   │   ├── useResumeApi.ts           # useResumes, useResume, useCreateResume, useUpdateResume, useDeleteResume, useUploadResume, useExportPdf, useExportDocx
│   │   ├── useATS.ts                 # useATSReport, useResumeATSReports, useScanResume, useScanResumePublic, useJobMatch, useMatchJob
│   │   ├── useJobs.ts                # useJobs, useJobBoards, useJobEvaluations, useTailoredResumes
│   │   ├── usePayment.ts             # useSubscriptionStatus, useIsPro, useCheckout, useApplyCoupon
│   │   ├── useTemplateSettings.ts
│   │   ├── useResumeData.ts          # Local resume form state (context-like)
│   │   ├── useDynamicResumeData.ts
│   │   ├── use-toast.ts              # Sonner toast wrapper
│   │   └── use-mobile.tsx            # useIsMobile hook
│   ├── lib/
│   │   ├── utils.ts                  # cn() className merger
│   │   ├── templateMapping.ts        # Frontend↔Backend template ID mapping
│   │   └── exportHtml.ts             # buildExportDocument() — clones rendered DOM for PDF/DOCX
│   ├── pages/                        # Route components (lazy-loaded in App.tsx)
│   │   ├── Index.tsx                 # Landing page
│   │   ├── GetStarted.tsx            # Onboarding flow entry
│   │   ├── AIGuided.tsx              # AI questionnaire → resume
│   │   ├── Build.tsx                 # Inline editor (main workspace)
│   │   ├── Upload.tsx                # File upload → parse → create resume
│   │   ├── Match.tsx                 # Job match (paste JD)
│   │   ├── Jobs.tsx                  # Job search (boards + query)
│   │   ├── JobDetail.tsx             # Job listing + evaluate + tailor
│   │   ├── Applications.tsx          # Kanban board (saved→applied→interview→offer→rejected)
│   │   ├── Settings.tsx              # Plan, BYOK keys, subscription, account
│   │   ├── Profile.tsx               # CareerProfile editor + parse-from-resume
│   │   ├── ATSScan.tsx               # Public + auth scan
│   │   ├── Resumes.tsx               # Resume list + create
│   │   ├── Templates.tsx             # Template gallery
│   │   ├── Admin.tsx                 # Admin dashboard
│   │   ├── Auth.tsx                  # Login/Signup forms
│   │   ├── ForgotPassword.tsx
│   │   ├── ResetPassword.tsx
│   │   ├── VerifyEmail.tsx
│   │   ├── Terms.tsx
│   │   ├── Privacy.tsx
│   │   └── NotFound.tsx
│   ├── services/api/                 # API client layer
│   │   ├── client.ts                 # apiClient (fetch wrapper, cookies, upload, download)
│   │   ├── index.ts                  # Barrel export
│   │   ├── auth.ts                   # authApi (login, signup, me, logout, profile, password)
│   │   ├── resume.ts                 # resumeApi (CRUD, upload, variants, export, transformResume)
│   │   ├── ats.ts                    # atsApi (scan, reports, match)
│   │   ├── jobs.ts                   # jobsApi (search, scan, evaluate, listings)
│   │   ├── payment.ts                # paymentApi (subscription, checkout)
│   │   ├── admin.ts                  # adminApi (stats, users)
│   │   ├── ai.ts                     # aiApi (generate, improve)
│   │   ├── keys.ts                   # keysApi (BYOK CRUD)
│   │   ├── templates.ts              # templatesApi (list, metadata)
│   │   ├── export.ts                 # exportApi (htmlToPdf, htmlToDocx)
│   │   ├── tailor.ts                 # tailorApi (create, export, list)
│   │   ├── applications.ts           # applicationsApi (CRUD)
│   │   ├── profile.ts                # profileApi (CRUD, parseFromResume)
│   │   └── boards.ts                 # boardsApi (CRUD)
│   ├── types/                        # TypeScript interfaces
│   │   ├── index.ts                  # Re-exports
│   │   ├── auth.ts                   # User, LoginCredentials, SignupCredentials
│   │   ├── resume.ts                 # Resume, ResumeVariant, PersonalInfo, ExperienceItem, EducationItem, ResumeSection, Skill, DynamicResumeData
│   │   ├── ats.ts                    # ATSReport, ATSCategoryScore, JobMatch
│   │   └── template.ts               # TemplateInfo, TemplateCategory, TemplateCustomization
│   └── components/                   # Shared components (UpgradeModal, NavLink)
│
├── public/                           # Static assets
│   ├── favicon.ico
│   ├── placeholder.svg
│   └── robots.txt
│
├── .planning/                        # GSD planning artifacts
│   └── codebase/                     # ← These docs live here
│
├── package.json                      # Frontend deps (React 18, Vite, TanStack Query, Radix, Tailwind, Framer Motion, Three.js, Recharts, Zod)
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
├── vite.config.ts
├── tailwind.config.ts
├── postcss.config.js
└── README.md
```

---

## Directory Purposes

| Directory | Purpose |
|-----------|---------|
| `backend/src/routes/` | API endpoint definitions (15 modules). Each exports an Express Router mounted at `/api/<name>`. |
| `backend/src/ai/` | AI orchestration: key management, evaluation rubric, resume generation. |
| `backend/src/jobSources/` | Zero-auth job board fetchers (Greenhouse, Ashby, Lever, Workday, RSS). |
| `backend/src/resume/` | File parsing (PDF/DOCX/TXT → structured JSON). |
| `backend/src/ats/` | ATS compatibility scanner (keyword, formatting, section analysis). |
| `backend/src/templates/` | Template metadata, analysis, file operations. |
| `backend/src/middleware/` | Auth, admin, rate-limit, CORS, error handling. |
| `backend/src/shared/` | Cross-cutting: Zod validation, usage limits, error classes, ownership checks. |
| `backend/prisma/` | Database schema + seed. Single source of truth for data model. |
| `backend/templates/` | Source `.docx` files for template-based DOCX export (docxtemplater). |
| `src/pages/` | Top-level route components (lazy-loaded). Each maps to a URL in `App.tsx`. |
| `src/features/` | Feature-scoped components with internal structure (resume-builder, job-match, template-selector). |
| `src/hooks/` | React Query hooks — one file per domain (auth, resume, ats, jobs, payment). |
| `src/services/api/` | Typed API clients — one file per backend route group. Transform backend↔frontend types. |
| `src/components/ui/` | shadcn/ui primitives (Button, Dialog, DropdownMenu, Toast, etc.). Do not modify directly. |
| `src/components/layout/` | App shell: sidebar navigation, mobile drawer, theme toggle, logout. |
| `src/lib/` | Frontend utilities: `cn()`, template ID mapping, HTML export builder. |
| `src/types/` | Shared TypeScript interfaces mirroring Prisma models + frontend extensions. |

---

## Key File Locations

### Entry Points
- **Backend:** `backend/src/index.ts` → `backend/src/app.ts`
- **Frontend:** `src/main.tsx` → `src/App.tsx`

### Configuration
- **Backend env:** `backend/src/config/env.ts` (Zod schema)
- **Frontend env:** `import.meta.env.VITE_API_URL` (defaults to `http://localhost:3001/api`)
- **Database:** `backend/prisma/schema.prisma`
- **TypeScript:** `tsconfig.json` (frontend), `backend/tsconfig.json` (backend)
- **Tailwind:** `tailwind.config.ts`
- **Vite:** `vite.config.ts`

### Route Definitions
- **Backend:** `backend/src/routes/index.ts` (aggregates 15 routers)
- **Frontend:** `src/App.tsx` (30+ lazy-loaded routes)

### Data Access
- **Prisma Client:** `backend/src/lib/prisma.ts` (singleton)
- **API Client:** `src/services/api/client.ts` (fetch wrapper with cookies)

### Authentication
- **Backend middleware:** `backend/src/middleware/auth.ts`
- **Frontend hooks:** `src/hooks/useAuth.ts`

### Template System
- **Backend metadata:** `backend/src/templates/metadata.ts`
- **Frontend registry:** `src/features/resume-builder/templates/registry.ts`
- **Frontend components:** `src/features/resume-builder/templates/*.tsx` (20+ templates)

---

## Naming Conventions

| Artifact | Convention | Example |
|----------|------------|---------|
| **Backend routes** | kebab-case file, default export Router | `backend/src/routes/job-match.ts` |
| **Frontend pages** | PascalCase, matches route | `src/pages/JobDetail.tsx` |
| **React components** | PascalCase, co-located with feature | `src/features/resume-builder/templates/ProfessionalStandard.tsx` |
| **Hooks** | `use` + PascalCase, domain-grouped | `src/hooks/useResumeApi.ts` |
| **API clients** | `<domain>Api` camelCase | `src/services/api/resume.ts` → `resumeApi` |
| **Types** | PascalCase interfaces | `src/types/resume.ts` → `Resume`, `ExperienceItem` |
| **Prisma models** | PascalCase singular | `Resume`, `JobListing`, `AIProviderKey` |
| **Database columns** | camelCase | `userId`, `createdAt`, `templateId` |

---

## Where to Add New Code

| New Feature | Backend Location | Frontend Location |
|-------------|------------------|-------------------|
| **API endpoint** | `backend/src/routes/<name>.ts` + mount in `index.ts` | `src/services/api/<name>.ts` + export in `index.ts` |
| **React Query hook** | — | `src/hooks/use<Domain>.ts` + export in `hooks/index.ts` |
| **Page/route** | — | `src/pages/<Name>.tsx` + add lazy route in `App.tsx` |
| **UI component (feature)** | — | `src/features/<feature>/<Component>.tsx` |
| **UI primitive** | — | `src/components/ui/<name>.tsx` (follow shadcn pattern) |
| **Database model** | `backend/prisma/schema.prisma` → `prisma migrate dev` | Update `src/types/` if needed |
| **Template** | Add `.docx` to `backend/templates/` + entry in `metadata.ts` | Add component in `features/resume-builder/templates/` + register in `registry.ts` |
| **Job board source** | Add fetcher in `backend/src/jobSources/index.ts` | Add type in `JobSourceConfig` + UI in `Settings`/`Boards` |
| **AI provider** | Add to `LLM_PROVIDERS` in `backend/src/ai/keyManager.ts` | Add to key management UI in `Settings` |

---

## Special Directories

| Directory | Purpose | Generated? | Committed? |
|-----------|---------|------------|------------|
| `backend/dist/` | `tsc` output | Yes | No (gitignored) |
| `backend/previews/` | Template preview PNGs | Yes (scripts) | Yes |
| `node_modules/` | Dependencies | Yes | No |
| `.planning/` | GSD artifacts (this doc) | Manual | Yes |
| `public/` | Static assets served by Vite | No | Yes |

---

*Structure analysis: 2025-07-17*