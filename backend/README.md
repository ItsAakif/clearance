# Clearance Backend

Production-ready backend for Clearance - an ATS-optimized resume builder.

Built with **Express + Prisma** for a standard Node.js backend architecture.

## Tech Stack

- **Framework**: Express.js 4.x
- **Database**: PostgreSQL with Prisma ORM
- **Auth**: JWT tokens in httpOnly cookies
- **AI**: Multi-provider support (OpenAI, Groq, OpenRouter, Gemini)
- **File Processing**: pdf-parse, mammoth, docx, puppeteer

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- npm or yarn

### Setup

1. **Navigate to backend:**
   ```bash
   cd backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```

4. **Configure environment variables:**
   
   Edit `.env` with your values:
   - `DATABASE_URL` - PostgreSQL connection string
   - `JWT_SECRET` - Generate with `openssl rand -base64 32`
   - `CLIENT_URL` - Frontend URL for CORS

5. **Start database:**
   ```bash
   # Using Docker
   docker run -d --name clearance-db \
     -e POSTGRES_USER=clearance \
     -e POSTGRES_PASSWORD=clearance \
     -e POSTGRES_DB=clearance \
     -p 5432:5432 \
     postgres:14
   ```

6. **Generate Prisma client and run migrations:**
   ```bash
   npm run db:generate
   npm run db:migrate
   ```

7. **Start the development server:**
   ```bash
   npm run dev
   ```

   Backend runs at `http://localhost:3001`

### Frontend Connection

The existing Vite frontend connects via the API client at `src/services/api/client.ts`.

Set `VITE_API_URL=http://localhost:3001/api` in the frontend `.env` file.

## NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build TypeScript to dist/ |
| `npm start` | Run production build |
| `npm run db:generate` | Generate Prisma client |
| `npm run db:migrate` | Run database migrations |
| `npm run db:push` | Push schema changes (dev) |
| `npm run db:studio` | Open Prisma Studio |

## Project Structure

```
backend/
├── prisma/
│   └── schema.prisma       # Database schema
├── src/
│   ├── index.ts            # Express server entry point
│   ├── lib/
│   │   └── prisma.ts       # Prisma client singleton
│   ├── middleware/
│   │   └── auth.ts         # JWT authentication middleware
│   ├── routes/
│   │   ├── index.ts        # Route aggregator
│   │   ├── auth.ts         # Authentication routes
│   │   ├── resume.ts       # Resume CRUD routes
│   │   ├── ats.ts          # ATS scanning routes
│   │   ├── job-match.ts    # Job matching routes
│   │   └── templates.ts    # Template catalog routes
│   ├── resume/
│   │   ├── parser.ts       # PDF/DOCX parsing
│   │   └── export.ts       # PDF/DOCX export (legacy)
│   ├── ats/
│   │   └── scanner.ts      # Deterministic scoring engine
│   ├── ai/
│   │   └── keyRotation.ts  # Multi-key rotation with failover
│   └── shared/
│       ├── validation.ts   # Zod schemas
│       ├── errors.ts       # Error handling
│       └── auth.ts         # Auth helpers
├── .env.example            # Environment template
├── package.json
└── tsconfig.json
```

## API Endpoints

### Authentication
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /api/auth/signup | No | Create account |
| POST | /api/auth/login | No | Login |
| POST | /api/auth/logout | No | Logout |
| GET | /api/auth/me | Yes | Get current user |
| PUT | /api/auth/profile | Yes | Update profile |
| POST | /api/auth/forgot-password | No | Request password reset |
| POST | /api/auth/reset-password | No | Reset password |

### Resumes
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /api/resumes | Yes | List all resumes |
| GET | /api/resumes/:id | Yes | Get single resume |
| POST | /api/resumes | Yes | Create resume |
| PUT | /api/resumes/:id | Yes | Update resume |
| DELETE | /api/resumes/:id | Yes | Delete resume |
| POST | /api/resumes/upload | Yes | Upload PDF/DOCX |
| POST | /api/resumes/:id/variants | Yes | Create variant |
| GET | /api/resumes/:id/export/pdf | Yes | Export as PDF |
| GET | /api/resumes/:id/export/docx | Yes | Export as DOCX |

### ATS Scanning
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /api/ats/scan/:resumeId | Yes | Scan resume |
| POST | /api/ats/scan-public | No | Public scan (rate limited) |
| GET | /api/ats/reports/:reportId | Yes | Get report |
| GET | /api/ats/resume/:resumeId/reports | Yes | Resume reports |

### Job Matching
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | /api/job-match | Yes | Match job description |
| GET | /api/job-match/:matchId | Yes | Get match result |

### Templates
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /api/templates | No | List templates |

## ATS Scoring Algorithm

The ATS scanner uses **deterministic, rule-based scoring** (no randomness):

| Category | Max Points | What It Checks |
|----------|------------|----------------|
| Formatting | 25 | Email/phone format, special chars, bullet length |
| Structure | 20 | Required sections present, proper organization |
| Content Quality | 25 | Action verbs, quantifiable achievements |
| Keywords | 20 | Skill coverage, keyword reinforcement |
| Completeness | 10 | All sections filled, sufficient detail |

**Score Thresholds:**
- 85+: Excellent
- 70-84: Good
- 50-69: Needs Work
- 0-49: Poor

## Security

Following `rules/security.md`:

- All inputs validated with Zod schemas
- Ownership enforced on all resources
- Parameterized queries only (Prisma ORM)
- No sensitive data in logs (passwords, tokens, PII)
- Generic error messages to users
- Rate limiting on all endpoints
- CORS configured for allowed origins
- JWT tokens in httpOnly cookies

## Deployment

### Railway / Render / Fly.io

1. Create PostgreSQL database
2. Set environment variables
3. Build command: `npm run build`
4. Start command: `npm start`

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
COPY prisma/ ./prisma/

RUN npx prisma generate

EXPOSE 3001
CMD ["npm", "start"]
```

```bash
# Build
npm run build
docker build -t clearance-backend .

# Run
docker run -p 3001:3001 \
  -e DATABASE_URL=... \
  -e JWT_SECRET=... \
  clearance-backend
```

## Development

```bash
# Run with hot reload
npm run dev

# Run database studio
npm run db:studio

# Create migration
npm run db:migrate

# Push schema changes (development)
npm run db:push
```

## License

MIT
