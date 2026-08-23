# Clearance

AI-powered resume builder with ATS optimization, job matching, and smart tailoring.

## Features

- **Resume Builder** — Build resumes from scratch or upload existing PDF/DOCX for parsing
- **ATS Scanning** — Deterministic rule-based scoring (formatting, structure, content, keywords, completeness) + optional LLM evaluation
- **Job Matching** — Keyword matching with role-specific banks, tailoring suggestions
- **Job Discovery** — Multi-source search (Greenhouse, Ashby, Lever, Workday, RSS, scrapers, aggregators)
- **Smart Tailoring** — Multi-pass AI pipeline (improver → refiner → 3-factor score)
- **AI-Assisted Build** — Paste a job description to auto-generate resume sections
- **Application Tracking** — Pipeline management (saved → tailored → applied → interview → offer)
- **PDF/DOCX Export** — Client-side PDF via @react-pdf/renderer + server-side Playwright HTML-to-PDF
- **Google OAuth** — Sign in with Google
- **BYOK AI Keys** — Bring your own API keys for OpenAI, Groq, OpenRouter, Gemini, Tavily, Exa

## Tech Stack

- **Frontend**: React 18, Vite, TypeScript, Tailwind CSS, shadcn-ui, React Query
- **Backend**: Express.js, TypeScript, Prisma ORM (PostgreSQL)
- **Auth**: JWT in httpOnly cookies, bcrypt, Google OAuth2
- **AI**: Multi-provider support (OpenAI, Groq, OpenRouter, Gemini) with key rotation
- **Export**: @react-pdf/renderer, Playwright, docxtemplater

## Getting Started

### Prerequisites
- Node.js 18+
- PostgreSQL 14+ (or Neon/Supabase)

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   cd backend && npm install && cd ..
   ```
3. Copy and configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```
4. Set up the database:
   ```bash
   cd backend
   npx prisma generate
   npx prisma migrate dev
   cd ..
   ```
5. Start development:
   ```bash
   # Backend (port 3001)
   cd backend && npm run dev

   # Frontend (port 8080)
   npm run dev
   ```

### Docker

```bash
docker compose up --build
```

## Project Structure

```
├── src/                    # Frontend React app
│   ├── pages/              # Route pages (22 pages)
│   ├── features/           # Feature modules (resume-builder, ats-report, job-match, jobs, template-selector)
│   ├── components/         # Shared UI components
│   ├── hooks/              # React Query hooks
│   ├── services/api/       # API client layer
│   └── types/              # TypeScript type definitions
├── backend/                # Express API server
│   ├── src/
│   │   ├── routes/         # API route handlers (16 route files)
│   │   ├── ai/             # AI services (key rotation, evaluation, resume generation)
│   │   ├── ats/            # ATS scanning engine
│   │   ├── jobSources/     # Job discovery (scrapers, aggregators, search)
│   │   ├── resume/         # Resume parsing and export
│   │   ├── middleware/      # Auth, admin middleware
│   │   └── shared/         # Validation, errors, auth helpers
│   └── prisma/             # Database schema
└── .planning/              # Project planning docs
```

## Environment Variables

See `.env.example` for all required and optional variables. Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret for JWT signing (min 16 chars) |
| `CLIENT_URL` | Yes | Frontend URL for CORS |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret |

## License

MIT
