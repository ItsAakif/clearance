# Coding Conventions

**Analysis Date:** 2026-07-17

## TypeScript Configuration

### Frontend (`tsconfig.app.json`)
- **Target**: ES2020
- **Module**: ESNext (bundler mode)
- **Strict Mode**: `false` (loose)
- **noImplicitAny**: `false`
- **noUnusedLocals**: `false`
- **noUnusedParameters**: `false`
- **noFallthroughCasesInSwitch**: `false`
- **strictNullChecks**: `false`
- **Path Aliases**: `@/*` → `./src/*`

### Backend (`backend/tsconfig.json`)
- **Target**: ES2022
- **Module**: NodeNext
- **ModuleResolution**: NodeNext
- **Strict Mode**: `true`
- **noImplicitAny**: `true` (implied by strict)
- **Path Aliases**: `@/*` → `./src/*`

### Shared Config (`tsconfig.json`)
- **baseUrl**: `.`
- **paths**: `@/*` → `./src/*`
- **noImplicitAny**: `false`
- **strictNullChecks**: `false`

---

## Project Structure

```
src/
├── components/
│   ├── ui/              # Radix UI + Tailwind components (Button, Card, Input, Select, Dialog, Badge, Progress, Switch, Tooltip, etc.)
│   ├── layout/          # AppLayout, Sidebar, Header
│   ├── ats/             # ATS-specific components
│   ├── landing/         # Landing page components
│   ├── animations/      # Framer Motion animations
│   └── backgrounds/     # 3D/background effects
├── features/
│   ├── jobs/            # Job search, evaluation, tailoring
│   ├── resume-builder/  # Resume editor, templates
│   ├── ats-report/      # ATS report display
│   ├── job-match/       # Job matching UI
│   └── template-selector/
├── hooks/
│   ├── useJobs.ts       # React Query hooks for jobs, applications, keys, profile, boards, searches
│   ├── useAuth.ts       # Auth state & mutations
│   ├── useATS.ts        # ATS scan hooks
│   ├── useResumeApi.ts  # Resume CRUD hooks
│   └── use-toast.ts     # Sonner toast wrapper
├── services/api/
│   ├── client.ts        # apiClient (fetch wrapper, credentials: 'include', 401→refresh)
│   ├── jobs.ts          # jobsApi, tailorApi, applicationsApi, keysApi, profileApi, boardsApi, searchesApi
│   ├── auth.ts          # authApi
│   ├── ats.ts           # atsApi
│   ├── templates.ts     # templateApi
│   ├── resume.ts        # resumeApi
│   └── admin.ts         # adminApi
├── lib/
│   ├── utils.ts         # cn(), formatters
│   ├── templateMapping.ts
│   └── exportHtml.ts
└── types/               # Shared TypeScript types
```

**Backend** (`backend/src/`)
```
src/
├── routes/              # Express routers (auth, jobs, resume, ats, profile, etc.)
├── middleware/
│   ├── auth.ts          # requireAuth, optionalAuth, JWT verify, cookie handling
│   └── admin.ts         # requireAdmin
├── shared/
│   ├── validation.ts    # Zod schemas + validateInput()
│   ├── errors.ts        # HttpError hierarchy + handleApiError()
│   ├── usage.ts         # assertUsageAllowed, buildUsageIncrement
│   └── auth.ts          # ensureOwnership, sanitizeUser, requireUser
├── lib/
│   ├── prisma.ts        # Prisma singleton
│   ├── crypto.ts        # encryptSecret/decryptSecret/maskKey (AES-256-GCM)
│   └── mailer.ts        # Nodemailer wrapper
├── ai/
│   ├── keyManager.ts    # BYOK key leasing (leaseNextKey, leaseNextLlmKey, rotation, rate-limit handling)
│   ├── evaluation.ts    # Job evaluation logic
│   └── resumeGenerator.ts
├── ats/scanner.ts       # ATS scanning logic
├── jobSources/          # Job board scrapers (Greenhouse, Ashby, Lever, Workday, RSS)
├── resume/parser.ts     # Resume parsing (PDF, DOCX)
├── templates/           # Template metadata & analyzer
└── test/setup.ts        # Vitest setup
```

---

## API Layer Conventions

### Frontend: `src/services/api/client.ts`
- **Single fetch wrapper** `apiClient` with `credentials: 'include'` (cookie-based auth)
- **Methods**: `get`, `post`, `put`, `patch`, `delete`, `upload`, `download`, `downloadPost`
- **Error handling**: Throws `ApiClientError` with `statusCode` and message
- **Base URL**: `import.meta.env.VITE_API_URL || 'http://localhost:3001/api'`

### Frontend: Route-specific API objects (`src/services/api/*.ts`)
- Each file exports a `*Api` object with typed methods
- Example: `jobsApi.search()`, `keysApi.create()`, `applicationsApi.list()`
- Re-exported from `src/services/api/index.ts`

### Backend: Route handlers
- **Pattern**: `requireAuth` middleware → validate with `validateInput(schema, data)` → business logic → `handleApiError(error, res)`
- **Validation**: Zod schemas in `backend/src/shared/validation.ts`
- **Ownership**: `await ensureOwnership(req.user!.id, resource.userId, 'Resource')` before mutations
- **Usage limits**: `assertUsageAllowed(user, 'metric')` + `buildUsageIncrement('metric')` for FREE plan enforcement

---

## React Query Patterns (`src/hooks/useJobs.ts`, `useAuth.ts`, etc.)

```typescript
// Query
export function useCareerProfile() {
  return useQuery({ queryKey: profileQueryKey, queryFn: () => profileApi.get() });
}

// Mutation with invalidation & toast
export function useUpsertProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<CareerProfile>) => profileApi.upsert(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileQueryKey });
      toast({ title: 'Profile saved' });
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });
}
```

**Conventions:**
- Query keys as `const` tuples: `export const profileQueryKey = ['careerProfile'] as const;`
- Mutations return `useMutation` with `onSuccess` → `invalidateQueries` + `toast`
- Errors caught via `onError` → `toast` with `variant: 'destructive'`
- Toast from `hooks/use-toast.ts` (Sonner wrapper)

---

## UI Component Patterns

### Component Library: `src/components/ui/*`
- **Radix UI primitives** + **Tailwind CSS** + `class-variance-authority` (cva)
- **Common components**: `Button`, `Card`, `Input`, `Select`, `Dialog`, `Badge`, `Progress`, `Switch`, `Tooltip`, `Form` (react-hook-form + Zod), `Table`, `Tabs`, `Accordion`, `DropdownMenu`, `Sheet`, `Drawer`, `Popover`, `HoverCard`, `AlertDialog`, `Avatar`, `Checkbox`, `RadioGroup`, `Slider`, `Command`, `InputOTP`, `Calendar`, `Carousel`, `Chart`, `Pagination`, `ScrollArea`, `ResizablePanels`, `Separator`, `Skeleton`, `Sonner` (toast), `Vaul` (drawer)

### Layout
- `AppLayout` in `components/layout/` — sidebar + header + content area
- `useAuth` hook provides `user`, `login`, `logout`, `signup`

### Forms
- **react-hook-form** + **@hookform/resolvers/zod**
- Schema defined in component or imported from shared types
- `Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`, `FormDescription` from `components/ui/form.tsx`

---

## Validation (Backend)

**Location**: `backend/src/shared/validation.ts`

- All user input validated via Zod schemas at route boundary
- Schemas: `loginSchema`, `signupSchema`, `resumeSchema`, `careerProfileSchema`, `parseProfileSchema`, `jobBoardSchema`, `savedSearchSchema`, `jobSearchSchema`, `evaluateJobSchema`, `tailorResumeSchema`, `createApiKeySchema`, `couponSchema`, etc.
- **Utility**: `validateInput(schema, data)` → throws `ValidationError` (extends `BadRequestError`) with formatted message
- **Strictness**: `.strict()` on career profile to reject unknown fields

---

## Authentication & Ownership

### Backend Auth (`backend/src/middleware/auth.ts`)
- **JWT** in `httpOnly` cookie (`token`) or `Authorization: Bearer` header
- `requireAuth` → attaches `req.user = { id, email, emailVerified, isAdmin }`
- `optionalAuth` → populates user if token present, never throws
- `generateToken(userId, email)`, `verifyToken(token)`, `setAuthCookie`, `clearAuthCookie`

### Authorization (`backend/src/shared/auth.ts`)
```typescript
// Must call before any mutation on user-owned resource
await ensureOwnership(currentUserId, resourceUserId, 'Resume');

// Plan enforcement
ensurePlan(userPlan, ['PRO'], 'AI Generation');

// Sanitize user for client response
sanitizeUser(user, isAdmin);
```

### Rate Limits / Usage (`backend/src/shared/usage.ts`)
```typescript
// Check before expensive operation
assertUsageAllowed(user, 'aiGenerations'); // throws ForbiddenError if limit reached

// Increment after successful operation (FREE plan only)
await prisma.user.update({ where: { id }, data: buildUsageIncrement('aiGenerations') });
```

**Metrics**: `resumeCreations`, `aiGenerations`, `atsScans`, `jobMatches`
**Free limits**: 5 / 3 / 3 / 3 respectively; PRO = unlimited

---

## Error Handling

### Backend (`backend/src/shared/errors.ts`)
```typescript
// Hierarchy
HttpError (base, statusCode, isOperational)
  ├── NotFoundError (404)
  ├── UnauthorizedError (401)
  ├── ForbiddenError (403)
  ├── BadRequestError (400)
  ├── ValidationError (400, extends BadRequestError)
  ├── ConflictError (409)
  ├── RateLimitError (429)
  └── InternalError (500) — logs internally, returns generic message

// Central handler
handleApiError(error, res); // logs, returns JSON { error: string }
```

**Security**: `logSecurityEvent(event, details)` — sanitizes passwords/tokens before logging

### Frontend
- `ApiClientError` from `client.ts` includes `statusCode`
- React Query `onError` → `toast({ variant: 'destructive' })`

---

## Cryptography & BYOK (`backend/src/lib/crypto.ts`, `backend/src/ai/keyManager.ts`)

### Encryption (AES-256-GCM)
```typescript
encryptSecret(plaintext: string): string;   // returns "iv.authTag.encrypted" (base64)
decryptSecret(payload: string): string;     // falls back to plaintext for legacy
maskKey(key: string): string;               // "sk-abcd…wxyz"
```
- Key derived from `KEY_ENCRYPTION_SECRET` or `JWT_SECRET` via SHA-256
- Never log plaintext keys

### Key Manager (`keyManager.ts`)
- **Providers**: `groq`, `openai`, `openrouter`, `gemini` (LLM); `tavily` (search)
- **Sources**: Database (per-user or system) → Env fallback (`GROQ_API_KEY`, `GROQ_API_KEY_1..20`)
- **Leasing**: `leaseNextKey(provider, userId?)` → round-robin rotation, updates `lastUsedAt`
- **Feedback**: `markKeySuccess(key)`, `markKeyFailure(key, isRateLimited)` → tracks `failureCount`, `rateLimitedUntil`
- **Convenience**: `leaseNextLlmKey(userId, preferred?)`, `leaseNextSearchKey(userId)`

---

## Database (Prisma)

**Client**: `backend/src/lib/prisma.ts` — singleton with dev logging
**Schema**: `backend/prisma/schema.prisma`
- Models: `User`, `Resume`, `ResumeVariant`, `JobListing`, `JobEvaluation`, `TailoredResume`, `Application`, `CareerProfile`, `JobBoard`, `SavedSearch`, `AIProviderKey`, `AdminSettings`
- Enums: `Plan` (FREE, PRO), `ApplicationStatus`, `JobSourceType`

---

## Environment & Config

### Frontend
- `VITE_API_URL` — backend base URL

### Backend (`backend/src/config/env.ts`)
- `JWT_SECRET`, `KEY_ENCRYPTION_SECRET`
- `DATABASE_URL`
- `OPENAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`
- `SMTP_*` for Nodemailer
- `CLIENT_URL`, `NODE_ENV`

---

## Linting & Formatting

**ESLint** (`eslint.config.js`):
- Frontend: `typescript-eslint`, `react-hooks`, `react-refresh`
- Backend: `typescript-eslint` with Node globals
- **Rules**: `@typescript-eslint/no-unused-vars: off`, `@typescript-eslint/no-explicit-any: warn`

**No Prettier config detected** — formatting via editor/IDE defaults.

---

## Imports & Path Aliases

| Scope | Alias | Resolves To |
|-------|-------|-------------|
| Frontend | `@/*` | `./src/*` |
| Backend | `@/*` | `./src/*` |

**Import order** (observed):
1. External packages
2. Internal aliases (`@/...`)
3. Relative imports (`./...`, `../...`)

---

## Naming Conventions

| Category | Convention | Example |
|----------|------------|---------|
| Files (React) | PascalCase | `JobCard.tsx`, `useJobs.ts` |
| Files (Backend) | kebab-case | `jobs.ts`, `keyManager.ts` |
| Components | PascalCase | `JobCard`, `AppLayout` |
| Hooks | camelCase + `use` prefix | `useJobs`, `useAuth` |
| Functions | camelCase | `validateInput`, `leaseNextKey` |
| Types/Interfaces | PascalCase | `JobListing`, `ApiKey` |
| Enums | PascalCase | `Plan`, `ApplicationStatus` |
| Constants | UPPER_SNAKE_CASE | `JWT_EXPIRES_IN`, `LLM_PROVIDERS` |
| Zod Schemas | camelCase + `Schema` suffix | `resumeSchema`, `createApiKeySchema` |

---

## Adding New Code

### New API Endpoint (Backend)
1. Add Zod schema to `backend/src/shared/validation.ts`
2. Create route file in `backend/src/routes/` (follow `jobs.ts` pattern)
3. Register in `backend/src/routes/index.ts`
4. Use `requireAuth`, `validateInput`, `ensureOwnership`, `assertUsageAllowed`, `handleApiError`

### New Frontend Query/Mutation
1. Add method to appropriate `*Api` in `src/services/api/`
2. Create hook in `src/hooks/useJobs.ts` (or new hook file)
3. Export from `src/hooks/index.ts`

### New UI Component
1. Create in `src/components/ui/` (follow `button.tsx` pattern with `cva`)
2. Export from `src/components/ui/index.ts`

### New Feature Area
1. Create folder under `src/features/<feature-name>/`
2. Add components, hooks, types
3. Wire into routing via `src/pages/`

---

*Convention analysis: 2026-07-17*