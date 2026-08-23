# Testing Patterns

**Analysis Date:** 2026-07-17

## Test Framework

### Backend
- **Runner**: Vitest (`vitest@^4.1.0`)
- **Config**: `backend/vitest.config.ts`
  - Environment: `node`
  - Globals: `true`
  - Setup: `backend/src/test/setup.ts` (sets `NODE_ENV=test`, `JWT_SECRET`, `CLIENT_URL`)
  - Include: `src/**/*.test.ts`
- **HTTP Testing**: Supertest (`supertest@^7.2.2`)
- **Run Command**: `cd backend && npm test`

### Frontend
- **No test framework configured**
- No Vitest/Jest config in root
- No `@testing-library/*` dependencies
- No `*.test.tsx` or `*.spec.tsx` files found
- No Cypress/Playwright config

---

## Backend Test Structure

```
backend/src/
├── test/
│   └── setup.ts              # Global test env setup
├── routes/
│   └── api.smoke.test.ts     # Only test file found
└── (no other *.test.ts files)
```

### Existing Test: `backend/src/routes/api.smoke.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('API Smoke Tests', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/health returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```

**Run**: `cd backend && npm test` → executes vitest with the smoke tests.

---

## Test Coverage Gaps (Critical)

### Zero Coverage — Core Business Logic

| Module | File | Risk |
|--------|------|------|
| AI Evaluation | `backend/src/ai/evaluation.ts` | Core job scoring logic untested |
| AI Key Manager | `backend/src/ai/keyManager.ts` | BYOK key rotation, rate-limit handling untested |
| AI Resume Generator | `backend/src/ai/resumeGenerator.ts` | Resume tailoring untested |
| Job Sources | `backend/src/jobSources/index.ts` | Greenhouse/Ashby/Lever/Workday scrapers untested |
| Job Sources Liveness | `backend/src/jobSources/liveness.ts` | Link checking untested |
| ATS Scanner | `backend/src/ats/scanner.ts` | Resume ATS parsing untested |
| Resume Parser | `backend/src/resume/parser.ts` | PDF/DOCX parsing untested |
| Profile Parser | **Missing** | Career profile extraction referenced but no implementation found |
| Template Analyzer | `backend/src/templates/analyzer.ts` | Template variable extraction untested |

### Zero Coverage — Auth & Security
- `backend/src/middleware/auth.ts` — JWT verify, cookie handling, admin detection
- `backend/src/shared/auth.ts` — `ensureOwnership`, `sanitizeUser`, `requireUser`
- `backend/src/shared/errors.ts` — Error hierarchy, `handleApiError`
- `backend/src/lib/crypto.ts` — AES-256-GCM encrypt/decrypt/mask
- `backend/src/routes/auth.ts` — Login, signup, password reset, OAuth

### Zero Coverage — Usage & Billing
- `backend/src/shared/usage.ts` — `assertUsageAllowed`, `buildUsageIncrement`, limit logic
- `backend/src/routes/admin.ts` — Admin-only endpoints

### Zero Coverage — Data Models
- No Prisma model tests
- No database integration tests (requires test DB)

---

## Running Tests

### Backend Only
```bash
cd backend
npm test              # Run all tests (vitest run)
npm test -- --watch   # Watch mode
npm test -- --coverage # With coverage (requires @vitest/coverage-v8)
```

### Frontend
```bash
# No test command available
# Would need: npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
```

---

## CI/CD Status

**No CI configuration detected**
- No `.github/workflows/` directory
- No `.gitlab-ci.yml`, `.circleci/`, `azure-pipelines.yml`
- No `npm test` in root `package.json` scripts

---

## Recommended Test Additions

### 1. Unit Tests for Shared Utilities
```typescript
// backend/src/shared/validation.test.ts
import { validateInput, loginSchema } from './validation.js';
import { ValidationError } from './errors.js';

describe('validateInput', () => {
  it('returns parsed data on valid input', () => {
    const result = validateInput(loginSchema, { email: 'a@b.com', password: 'password123' });
    expect(result.email).toBe('a@b.com');
  });

  it('throws ValidationError with formatted message on invalid input', () => {
    expect(() => validateInput(loginSchema, { email: 'bad', password: 'short' }))
      .toThrow(ValidationError);
  });
});
```

### 2. Auth Middleware Tests
```typescript
// backend/src/middleware/auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { requireAuth } from './auth.js';
import { verifyToken } from './auth.js';

vi.mock('../lib/prisma.js', () => ({
  default: {
    user: { findUnique: vi.fn() }
  }
}));

describe('requireAuth', () => {
  it('returns 401 when no token', async () => {
    const req = { cookies: {}, headers: {} };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    
    await requireAuth(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
```

### 3. Key Manager Tests
```typescript
// backend/src/ai/keyManager.test.ts
import { leaseNextKey, markKeyFailure, isRateLimitError } from './keyManager.js';
import prisma from '../lib/prisma.js';

vi.mock('../lib/prisma.js');
vi.mock('../lib/crypto.js', () => ({
  decryptSecret: (s: string) => s
}));

describe('keyManager', () => {
  it('rotates through multiple keys', async () => {
    // setup mock keys
    // call leaseNextKey multiple times
    // assert rotation
  });

  it('marks rate limited keys with cooldown', async () => {
    // call markKeyFailure with isRateLimited=true
    // assert rateLimitedUntil set
  });
});
```

### 4. API Integration Tests (Supertest)
```typescript
// backend/src/routes/jobs.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';

describe('POST /api/jobs/:id/evaluate', () => {
  beforeEach(async () => {
    await prisma.jobEvaluation.deleteMany();
    await prisma.jobListing.deleteMany();
    await prisma.resume.deleteMany();
    await prisma.user.deleteMany();
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/jobs/123/evaluate');
    expect(res.status).toBe(401);
  });

  it('evaluates job and increments usage for FREE plan', async () => {
    // create user, resume, job listing
    // POST with auth cookie
    // expect 201 + evaluation object
    // expect aiGenerationsUsed incremented
  });
});
```

---

## Test Data & Factories

**No factory/fixture library detected.** Recommended:
```bash
cd backend && npm install -D @faker-js/faker
```

Example factory pattern:
```typescript
// backend/src/test/factories.ts
import { faker } from '@faker-js/faker';
import { PrismaClient } from '@prisma/client';

export function createTestUser(overrides = {}) {
  return {
    id: faker.string.uuid(),
    email: faker.internet.email(),
    name: faker.person.fullName(),
    plan: 'FREE',
    resumeCreationsUsed: 0,
    resumeCreationsLimit: 5,
    aiGenerationsUsed: 0,
    aiGenerationsLimit: 3,
    atsScansUsed: 0,
    atsScansLimit: 3,
    jobMatchesUsed: 0,
    jobMatchesLimit: 3,
    ...overrides
  };
}
```

---

## Coverage Targets (Suggested)

| Layer | Target |
|-------|--------|
| Shared utilities (validation, errors, usage, auth, crypto) | 90%+ |
| AI modules (keyManager, evaluation, resumeGenerator) | 80%+ |
| Route handlers (happy path + auth + validation errors) | 70%+ |
| Job sources (mock HTTP responses) | 60%+ |

---

## Adding Frontend Tests (Future)

1. **Install**:
```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom @vitejs/plugin-react
```

2. **Config** (`vitest.config.ts`):
```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

3. **Example Hook Test**:
```typescript
// src/hooks/useAuth.test.tsx
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from './useAuth';
import { authApi } from '@/services/api';

vi.mock('@/services/api', () => ({
  authApi: { getCurrentUser: vi.fn() }
}));

const wrapper = ({ children }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

it('returns user when authenticated', async () => {
  authApi.getCurrentUser.mockResolvedValue({ id: '1', email: 'a@b.com', plan: 'PRO' });
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
  expect(result.current.user.email).toBe('a@b.com');
});
```

---

*Testing analysis: 2026-07-17*