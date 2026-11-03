import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import routes from './routes/index.js';
import { requireAuth } from './middleware/auth.js';
import { env } from './config/env.js';
import { createRenderLimiter } from './render/env.js';

const app = express();

/**
 * Full-scan requests are bounded by their FULL_BATCH_PAGES work batch (200
 * pages after T910 / ADR-034 D7, with the composed `maxUnits` cap of 320 from
 * `budgets.ts`), not by the shared 100-request/15-minute API budget. Keep a
 * separate, higher ceiling so a client-driven sweep and its intentional
 * progress traffic are not blocked by ordinary interactive API calls.
 */
export const FULL_SCAN_RATE_LIMIT_MAX = 1500;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const allowedOrigins = [
  env.CLIENT_URL || 'http://localhost:5173',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:8081',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin && env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    if (origin && allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

export const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  // A SPA issues many reads per page (catalogue, boards, applications, profile,
  // keys, providers, settings/models, auth/me). 100/15min was far below that and
  // produced a 429 storm. 2000/15min is a sane authenticated budget; authLimiter,
  // fullScanLimiter and renderLimiter keep their own (stricter) ceilings.
  max: 2000,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Inside app.use('/api', ...), req.path is mount-relative: run snapshots
  // are /jobs/runs/... (including the existing cancel suffix). Full-scan
  // GETs are skipped here because their dedicated limiter below owns them.
  skip: (req) =>
    /^\/jobs\/runs\//.test(req.path) ||
    (req.method === 'GET' && req.path === '/jobs/full-scan'),
});

/**
 * Dedicated Full-scan limiter. The exact-path auth gate below populates
 * req.user before this middleware runs, so the production key is the
 * authenticated user id rather than a shared connection IP. Keep the IP
 * fallback for defensive direct use of the exported limiter.
 */
export const fullScanLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: FULL_SCAN_RATE_LIMIT_MAX,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'unknown',
  message: { error: 'Too many Full-scan requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * The render limiter and the ONE path it meters. Exported so a test can assert the shape
 * (the key expression, the window, the policy maximum) without reaching into the
 * middleware, and so a future render surface is added here deliberately.
 *
 * The pattern is `^/resumes/[^/]+/render$`: `/resumes` is this app's V2 mount, then
 * exactly one non-slash segment (the resume id - a uuid, so a `/` can never be part of
 * it), then the literal `render`. The two `documents` reads are NOT metered, because they
 * serve STORED bytes rather than spending a container spawn.
 */
export const RENDER_RATE_LIMITED_PATH = /^\/resumes\/[^/]+\/render$/;

export const renderLimiter = createRenderLimiter(env.RENDER_PER_USER_PER_MINUTE);

app.use('/api', generalLimiter);

// Mount-relative path inside /api: only the exact GET /jobs/full-scan reaches
// the dedicated limiter. Authentication must finish before key generation;
// the route-level auth in the API router is later than this app-level mount.
// Keep the route gate unchanged; this preflight is what makes the user id
// available to the limiter without changing route ownership.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/jobs/full-scan') {
    return next();
  }

  return requireAuth(req, res, (authError?: unknown) => {
    if (authError) {
      return next(authError);
    }
    return fullScanLimiter(req, res, next);
  });
});

app.use('/api/auth/login', authLimiter);

// The render rate limiter (policy 10.2 O2, last row: "a dedicated express-rate-limit
// limiter keyed on `req.user?.id`, copying `fullScanLimiter` above"). It is a SEPARATE
// limiter, not a raise of `generalLimiter`'s budget, because a render is a container
// spawn and a content-bounded compile rather than an API read: ten renders a minute per
// user is the policy's number, and it is a containment property the way the concurrency
// caps are, so it is a knob that may be lowered and not one that competes with ordinary
// interactive traffic for one shared budget.
//
// Mounted behind the same auth preflight as `fullScanLimiter`, and for the same reason:
// `req.user` has to exist before the key is generated, or every user behind one proxy
// would share one bucket. `POST /resumes/:id/render` is matched exactly (one path segment
// after `/resumes`, the literal `render`), and a `V2_TYPST_RENDER`-off deployment still
// gets the limiter, because a route that returns 404 should not be an unmetered route.
app.use('/api', (req, res, next) => {
  if (req.method !== 'POST' || !RENDER_RATE_LIMITED_PATH.test(req.path)) {
    return next();
  }

  return requireAuth(req, res, (authError?: unknown) => {
    if (authError) {
      return next(authError);
    }
    return renderLimiter(req, res, next);
  });
});

app.use('/api/previews', express.static(path.join(__dirname, '../previews')));
app.use('/api', routes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[ERROR] ${new Date().toISOString()}:`, err.message);

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS policy violation' });
  }

  res.status(500).json({ error: 'An unexpected error occurred' });
});

export default app;
