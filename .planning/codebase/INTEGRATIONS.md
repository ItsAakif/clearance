# External Integrations

**Analysis Date:** 2025-07-17

## APIs & External Services

### AI / LLM Providers (BYOK — Bring Your Own Key)
Users can add their own API keys in Settings → API Keys. Keys are encrypted at rest with AES-256-GCM (`backend/src/lib/crypto.ts:17`) and never logged.

| Provider | Purpose | SDK/Client | Key Env Var | Validation |
|----------|---------|------------|-------------|------------|
| **Groq** | Primary LLM (resume generation, bullet improvement, summaries) | `openai` v4.68.0 (baseURL override) | `GROQ_API_KEY` / `GROQ_API_KEY_1..20` | Ping on add; rate-limit aware rotation |
| **OpenAI** | Fallback LLM | `openai` v4.68.0 | `OPENAI_API_KEY` | Basic length check |
| **OpenRouter** | Multi-model gateway | `openai` v4.68.0 (baseURL override) | `OPENROUTER_API_KEY` | Basic length check |
| **Google Gemini** | Alternative LLM | `openai` v4.68.0 (baseURL override) | `GEMINI_API_KEY` | Basic length check |

**Key Management** (`backend/src/ai/keyManager.ts`):
- Database keys take precedence over env fallback
- Round-robin rotation across multiple keys per provider
- Automatic rate-limit detection (`isRateLimitError` at line 144) and cooldown
- Per-user keys + system-wide keys (admin)
- Success/failure tracking updates `lastUsedAt`, `failureCount`, `rateLimitedUntil`

### Web Search
| Provider | Purpose | SDK/Client | Key Env Var |
|----------|---------|------------|-------------|
| **Tavily** | Compensation/company research for job evaluation | Native `fetch` to `api.tavily.com` | `TAVILY_API_KEY` |

Used in `backend/src/ai/evaluation.ts:129` when user has a Tavily key configured and `useTavily: true`.

### Job Sources (Zero-Token Public ATS APIs)
No API keys required. Public unauthenticated endpoints only.

| Source | Type | Endpoint Pattern | Implementation |
|--------|------|------------------|----------------|
| **Greenhouse** | ATS board | `https://boards-api.greenhouse.io/v1/boards/{board}/jobs` | `backend/src/jobSources/index.ts:26` |
| **Ashby** | ATS board | GraphQL `https://jobs.ashbyhq.com/api/non-user-graphql` | `backend/src/jobSources/index.ts:46` |
| **Lever** | ATS board | `https://api.lever.co/v0/postings/{site}` | `backend/src/jobSources/index.ts:76` |
| **Workday** | RSS/JSON feed | Configurable `feedUrl` | `backend/src/jobSources/index.ts:96` |
| **RSS/JSON** | Generic feed | Configurable `feedUrl` | `backend/src/jobSources/index.ts:114` |

Users configure boards in Settings → Job Boards (stored in `JobBoard` model). See `backend/src/routes/jobs.ts:29`.

### Authentication
| Provider | Method | Implementation |
|----------|--------|----------------|
| **Email/Password** | JWT in httpOnly cookie (7d) + bcryptjs | `backend/src/middleware/auth.ts`, `backend/src/routes/auth.ts` |
| **Google OAuth** | OAuth 2.0 → JWT cookie | `google-auth-library` v10.5.0, `backend/src/routes/auth.ts` |
| **Email Verification** | SHA-256 hashed token, 24h expiry | `backend/src/auth/email.ts:17` |
| **Password Reset** | SHA-256 hashed token, 1h expiry | `backend/src/auth/email.ts:35` |

Auth config: `backend/src/config/env.ts:8` (`JWT_SECRET`, min 16 chars).

### Payments
| Provider | Purpose | Implementation |
|----------|---------|----------------|
| **Stripe** | Pro subscriptions ($5/mo), coupons, webhooks | `stripe` v17.1.0, `backend/src/routes/payment.ts` |

**Webhook Events Handled** (`payment.ts:143`):
- `checkout.session.completed` → upgrade to Pro
- `customer.subscription.updated` → sync status/period
- `customer.subscription.deleted` → downgrade to Free
- `invoice.payment_failed` → mark `past_due`

Required env: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`.

### Email (Transactional)
| Provider | Implementation |
|----------|----------------|
| **SMTP** (any) | `nodemailer` v8.0.2, `backend/src/lib/mailer.ts` |
| **Dev fallback** | Ethereal test accounts (auto-created) |

Env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`. Used for verification & password reset emails.

### Database
| Provider | ORM | Connection |
|----------|-----|------------|
| **PostgreSQL** | Prisma 5.22.0 | `DATABASE_URL` env var |

Schema: `backend/prisma/schema.prisma` (User, Resume, ATSReport, JobMatch, JobListing, JobEvaluation, CareerProfile, JobBoard, AIProviderKey, Coupon, Template, etc.)

### File Processing
| Library | Purpose |
|---------|---------|
| `pdf-parse` 1.1.1 | PDF text extraction (`backend/src/resume/parser.ts:89`) |
| `mammoth` 1.8.0 | DOCX text extraction (`backend/src/resume/parser.ts:95`) |
| `docx` 8.5.0 | DOCX generation (backend templates) |
| `html-to-docx` 1.8.0 | HTML → DOCX export (`backend/src/routes/export.ts:111`) |
| `puppeteer-core` 23.5.0 | HTML → PDF via headless Chrome (`backend/src/routes/export.ts:83`) |

### Document Templates
Pre-built `.docx` templates in `backend/templates/` (18 files). Used for resume export.

## Data Storage

| Type | Provider | Connection |
|------|----------|------------|
| **Primary DB** | PostgreSQL | `DATABASE_URL` (Prisma) |
| **File Storage** | Local filesystem (uploads in memory via multer) | No external blob store |
| **Caching** | None (in-memory only) | — |

## Authentication & Identity

| Component | Detail |
|-----------|--------|
| **JWT** | HS256, 7-day expiry, httpOnly cookie (`token`), `SameSite=lax` |
| **Password Hash** | bcryptjs, cost 10 (default) |
| **API Key Encryption** | AES-256-GCM, key derived from `KEY_ENCRYPTION_SECRET` or `JWT_SECRET` via SHA-256 |
| **Admin Access** | Email allowlist via `ADMIN_EMAILS` env var (comma-separated) |

## Monitoring & Observability

| Area | Implementation |
|------|----------------|
| **Logging** | `console.log` / `console.error` (structured prefix: `[Clearance API]`, `[Stripe]`, `[Mailer]`, `[ResumeGenerator]`) |
| **Error Tracking** | None (Sentry, etc. not configured) |
| **Health Checks** | None exposed |
| **Rate Limiting** | `express-rate-limit` on all routes (default) + per-key AI rate limiting |

## CI/CD & Deployment

| Component | Status |
|-----------|--------|
| **Hosting** | Not configured (manual `node dist/index.js`) |
| **CI Pipeline** | None detected |
| **Container** | No Dockerfile |
| **Migrations** | `prisma migrate deploy` (manual) |

## Environment Configuration

### Frontend (`.env` / `.env.example`)
| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_URL` | Yes | Backend API base (e.g., `http://localhost:3001/api`) |
| `VITE_STRIPE_PUBLISHABLE_KEY` | For payments | Stripe public key |
| `VITE_ENABLE_PUBLIC_SCAN` | No | Feature flag |
| `VITE_ENABLE_AI_FEATURES` | No | Feature flag |
| `VITE_GA_MEASUREMENT_ID` | No | Google Analytics |
| `VITE_POSTHOG_KEY` | No | PostHog analytics |

### Backend (`backend/.env` / `backend/.env.example`)
| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string |
| `JWT_SECRET` | **Yes** | Min 16 chars, used for JWT + key encryption |
| `PORT` | No (default 3001) | Server port |
| `NODE_ENV` | No (default development) | `development` \| `test` \| `production` |
| `CLIENT_URL` | No (default localhost:5173) | CORS origin |
| `API_URL` | No | Public API base URL |
| `STRIPE_SECRET_KEY` | For payments | Stripe secret key |
| `STRIPE_PRICE_ID` | For payments | Pro plan price ID |
| `STRIPE_WEBHOOK_SECRET` | For payments | Webhook signing secret |
| `GROQ_API_KEY` / `GROQ_API_KEY_1..20` | For AI (system fallback) | Groq keys for rotation |
| `OPENAI_API_KEY` | Optional | OpenAI fallback |
| `OPENROUTER_API_KEY` | Optional | OpenRouter fallback |
| `GEMINI_API_KEY` | Optional | Google Gemini fallback |
| `TAVILY_API_KEY` | Optional | Web search for job eval |
| `KEY_ENCRYPTION_SECRET` | Optional | Override for API key encryption (defaults to JWT_SECRET) |
| `SMTP_HOST` | For email | SMTP server |
| `SMTP_PORT` | For email | SMTP port (587) |
| `SMTP_USER` | For email | SMTP username |
| `SMTP_PASS` | For email | SMTP password |
| `EMAIL_FROM` | For email | From address (default noreply@clearance.app) |
| `ADMIN_EMAILS` | Optional | Comma-separated admin emails |

## Webhooks & Callbacks

### Incoming
| Endpoint | Provider | Purpose |
|----------|----------|---------|
| `POST /api/payment/webhook` | Stripe | Subscription lifecycle events |

### Outgoing
| Target | Trigger | Purpose |
|--------|---------|---------|
| Tavily API | Job evaluation (if enabled) | Compensation/company research |
| Groq/OpenAI/etc. | AI resume generation, evaluation | LLM completions |
| SMTP server | Auth events | Verification/reset emails |

## Security Notes

- **API Keys**: Encrypted at rest (AES-256-GCM), never logged, masked in API responses (`maskKey` at `crypto.ts:43`)
- **JWT**: httpOnly cookie, `Secure` in production, `SameSite=lax`
- **CORS**: Restricted to `CLIENT_URL` (env)
- **Rate Limiting**: Global `express-rate-limit` + per-provider AI key rotation with cooldown
- **File Uploads**: 10MB max, MIME allowlist (PDF, DOCX, TXT), filename sanitization, extension blocklist
- **Webhook Verification**: Stripe signature verification required (`payment.ts:135`)

---

*Integration audit: 2025-07-17*