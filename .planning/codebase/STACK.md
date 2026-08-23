# Technology Stack

**Analysis Date:** 2025-07-17

## Languages

**Primary:**
- **TypeScript** 5.6.2 (backend) / 5.8.3 (frontend) — Strict mode on backend, relaxed on frontend
- **Node.js** >=18.0.0 (engines field in backend/package.json)

**Runtime:**
- **Frontend:** Vite 5.4.19 dev server + production build
- **Backend:** tsx 4.19.1 for dev (`tsx watch`), `node dist/index.js` for production

**Package Manager:**
- **npm** (lockfiles: `package-lock.json` in root and backend/)
- Workspaces: Not used — two independent `package.json` files

## Frameworks

### Frontend (`package.json`)
| Package | Version | Purpose |
|---------|---------|---------|
| **React** | 18.3.1 | UI framework |
| **React DOM** | 18.3.1 | DOM renderer |
| **Vite** | 5.4.19 | Build tool & dev server |
| **React Router** | 6.30.1 | Client-side routing |
| **TanStack Query** | 5.83.0 | Server state / data fetching |
| **React Hook Form** | 7.61.1 | Form handling |
| **Zod** | 3.25.76 | Schema validation (shared with backend) |
| **@hookform/resolvers** | 3.10.0 | Zod ↔ RHF integration |

### UI / Styling
| Package | Version | Purpose |
|---------|---------|---------|
| **Tailwind CSS** | 3.4.17 | Utility-first CSS |
| **tailwindcss-animate** | 1.0.7 | Animation utilities |
| **@tailwindcss/typography** | 0.5.16 | Prose styling |
| **Radix UI primitives** | 1.x | 20+ unstyled accessible components (accordion, dialog, dropdown, select, tabs, toast, tooltip, etc.) |
| **class-variance-authority** | 0.7.1 | Component variant management |
| **clsx** / **tailwind-merge** | 2.1.1 / 2.6.0 | Class name utilities |
| **Lucide React** | 0.462.0 | Icon library |
| **Framer Motion** | 11.18.2 | Animations |
| **Embla Carousel** | 8.6.0 | Carousel/slider |
| **React Resizable Panels** | 2.1.9 | Resizable layouts |
| **cmdk** | 1.1.1 | Command palette |
| **next-themes** | 0.3.0 | Dark mode |
| **input-otp** | 1.4.2 | OTP input |
| **vaul** | 0.9.9 | Drawer component |

### Data Visualization / 3D / Document
| Package | Version | Purpose |
|---------|---------|---------|
| **Recharts** | 2.15.4 | Charts |
| **Three.js** | 0.170.0 + @react-three/fiber 8.18.0 + @react-three/drei 9.122.0 | 3D backgrounds |
| **docx** | 8.5.0 (backend) / docx-preview 0.3.7 (frontend) | DOCX generation & preview |
| **html-to-docx** | 1.8.0 | HTML → DOCX export |
| **pdf-parse** | 1.1.1 | PDF text extraction |
| **mammoth** | 1.8.0 | DOCX text extraction |
| **playwright** | ^1.61.1 | HTML → PDF via headless Chromium (`import { chromium } from 'playwright'`) |

### Backend (`backend/package.json`)
| Package | Version | Purpose |
|---------|---------|---------|
| **Express** | 4.21.0 | HTTP server |
| **Prisma** | 5.22.0 | ORM (PostgreSQL) |
| **@prisma/client** | 5.22.0 | Generated client |
| **Zod** | 3.23.8 | Request validation (shared schemas) |
| **jsonwebtoken** | 9.0.2 | JWT auth (httpOnly cookie) |
| **bcryptjs** | 2.4.3 | Password hashing |
| **cookie-parser** | 1.4.6 | Cookie parsing |
| **cors** | 2.8.5 | CORS middleware |
| **express-rate-limit** | 7.4.0 | Rate limiting |
| **multer** | 1.4.5-lts.1 | File uploads (memory storage) |
| **nodemailer** | 8.0.2 | Transactional email (SMTP) |
| **google-auth-library** | 10.5.0 | OAuth (Google) |
| **OpenAI** | 4.68.0 | LLM client (used with Groq/OpenRouter/Gemini via baseURL override) |
| **uuid** | 10.0.0 | UUID generation |
| **crypto** (native) | — | AES-256-GCM encryption for API keys |

### AI / ML
- **Groq** (primary): `llama-3.1-70b-versatile` via OpenAI-compatible API
- **OpenAI** / **OpenRouter** / **Google Gemini**: Supported via BYOK (`backend/src/ai/keyManager.ts:22`)
- **Tavily**: Web search for job evaluation compensation research (`backend/src/ai/evaluation.ts:129`)

### Testing
| Package | Version | Purpose |
|---------|---------|---------|
| **Vitest** | 4.1.0 | Unit/integration test runner |
| **Supertest** | 7.2.2 | HTTP API testing |
| **@types/supertest** | 7.2.0 | Types |

### Linting / Formatting
- **ESLint** 9.32.0 (flat config `eslint.config.js`)
- **typescript-eslint** 8.38.0
- **eslint-plugin-react-hooks** 5.2.0
- **eslint-plugin-react-refresh** 0.4.20
- **Prettier**: Not explicitly configured (uses defaults)

## Configuration

### TypeScript
**Frontend** (`tsconfig.app.json`):
- Target: ES2020
- Module: ESNext (bundler)
- JSX: react-jsx
- Strict: `false` (relaxed: noImplicitAny, noUnusedLocals, strictNullChecks all `false`)
- Path alias: `@/*` → `./src/*`

**Backend** (`backend/tsconfig.json`):
- Target: ES2022
- Module: NodeNext
- Strict: `true`
- Path alias: `@/*` → `./src/*`
- Output: `./dist` with declarations + sourcemaps

### Vite (`vite.config.ts`)
- Plugin: `@vitejs/plugin-react-swc`
- Dev server: port 8080, host `::`
- Path alias: `@` → `./src`
- Lovable tagger plugin in development

### Tailwind (`tailwind.config.ts`)
- Content: `./index.html`, `./src/**/*.{js,ts,jsx,tsx}`
- Theme: extends with CSS variables for theming
- Plugins: `tailwindcss-animate`, `@tailwindcss/typography`

### Backend Dev
- `tsx watch src/index.ts` — hot reload
- `vitest run` — tests
- Prisma commands: `db:generate`, `db:migrate`, `db:push`, `db:studio`, `db:seed`

## Platform Requirements

**Development:**
- Node.js >= 18
- PostgreSQL 14+ (via `DATABASE_URL`)
- Playwright Chromium installed (for HTML→PDF export via `playwright`)
- SMTP server (optional, for email verification/reset)

**Production:**
- Node.js >= 18
- PostgreSQL 14+
- Redis (optional, not yet used)
- Playwright Chromium in PATH for PDF export
- SMTP credentials (for transactional email)

---

*Stack analysis: 2025-07-17*