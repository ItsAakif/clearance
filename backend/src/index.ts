// Clearance Backend - Express Server Entry Point
// Per security.md: Rate limit all endpoints, validate CORS, use secure cookies

import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(process.cwd(), '../.env') });
import app from './app.js';
import { assertRequiredRuntimeConfig, env } from './config/env.js';
import { flags } from './config/flags.js';
import { connectWithRetry } from './lib/prisma.js';
import { setResumeRenderPort } from './routes/resumes.js';
import { createRenderPort } from './render/renderPort.js';
import { assertRequiredStorageConfig } from './render/storage.js';
import { runSweepCycle } from './discovery/sweepCycle.js';
import { startSweepScheduler } from './discovery/sweepScheduler.js';
import { createSweepCycleDeps } from './routes/jobs.js';

assertRequiredRuntimeConfig();

// ---------------------------------------------------------------------------
// The render port - registered ONLY when the flag is on (T1043)
// ---------------------------------------------------------------------------
// `POST /resumes/:id/render` resolves its renderer through `setResumeRenderPort`, and with
// no port installed that call is a 404 (`requireRenderPort`). That 404 is the shipped
// default: the render tier is a feature flag, and a deployment that has not opted in must
// keep answering exactly what it answered before this phase existed. The `V2_TYPST_RENDER`
// check is therefore the WHOLE registration - there is no second, quieter path that
// installs a port, and `flags.v2TypstRender` defaults to OFF and is read from a schema whose
// only truthy spellings are `true` and `on` (T1002), so an operator typo leaves the
// pre-existing 404 in place rather than half-enabling the tier.
//
// `createRenderPort()` CONSTRUCTS rather than merely references the port, and that
// construction touches no socket, reads no template and creates no storage root: the broker
// client and the template registry are built on the port's FIRST render. So registration is
// cheap and a broken template fails a RENDER (with the registry's machine reason), never a
// boot that has other work to do. `assertRequiredStorageConfig()` mirrors
// `assertRequiredRuntimeConfig()`: outside production the development default is fine, and
// in production an unset artifact root is a configuration error rather than a directory
// silently appearing in the image. It is inside the flag check for the same reason - with
// the tier off no artifact is ever written, so requiring its root would be a boot failure
// for a configuration nothing reads.
if (flags.v2TypstRender) {
  assertRequiredStorageConfig();
  setResumeRenderPort(createRenderPort());
  console.log('[Clearance API] V2 Typst render: ON');
}

// Warm the pooled connection with backoff. Never crash boot: the server
// stays up and per-query retry covers later recovery from idle-pooler
// terminations (FATAL 57P01).
connectWithRetry().catch(() => {
  // Bounded warning already logged inside connectWithRetry; stay silent here.
});

const PORT = env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Clearance API] Server running on port ${PORT}`);
  console.log(`[Clearance API] Environment: ${env.NODE_ENV || 'development'}`);
});

// ---------------------------------------------------------------------------
// Registry sweep scheduler (SWEEP_INTERVAL_HOURS, default 0 = disabled)
// ---------------------------------------------------------------------------
// Started AFTER listen so a boot loop never kicks off crawler work before the
// API is serving. Every failure path is swallowed inside the scheduler: a tick
// error is logged and the next interval still fires. The scheduler registers
// its own SIGTERM/SIGINT handlers to clear the timer, so shutdown is not held
// open by the interval (the timer is `unref()`d as well).
try {
  startSweepScheduler({
    runCycle: (options) => runSweepCycle(createSweepCycleDeps(), options),
  });
} catch (error) {
  // A scheduler that cannot start is never a boot failure: the API and the
  // manual/route sweep entry points stay available.
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[sweep-scheduler] failed to start: ${message}`);
}

// Shutdown: the scheduler registers its own SIGTERM/SIGINT handlers (which
// call `stopSweepScheduler`) when it starts a timer, so there is exactly one
// registration and the interval never keeps the process alive (`unref()`).

export default app;
