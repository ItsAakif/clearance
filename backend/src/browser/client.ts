/**
 * Browser-tier thin client (wave 6, ADR-029 decision 2).
 *
 * A thin wrapper over ONLY the surface the T720 probe recorded with
 * evidence in `.planning/research/camofox-protocol.md`. Anything the
 * probe marked "unknown" (concurrency degradation point, exact failure
 * shapes, measured image delta) is handled defensively here, never
 * assumed.
 *
 * PROBE-FINDING -> DESIGN MAPPING (full table in `.planning/progress/T722-*.md`):
 *  1. Control surface is an in-process automation LIBRARY whose browser
 *     hands back page objects (`newPage(): Promise<Page>`), NOT a
 *     first-party HTTP service -> the `BrowserTransportFactory` interface
 *     below mirrors that library shape structurally, with zero static
 *     imports so the slim image stays library-free.
 *  2. Session semantics are explicit-close (page AND browser) -> every
 *     public function acquires its session and closes it in a `finally`.
 *  3. Failure shapes are UNKNOWN (nothing was executed) -> runtime
 *     classify-and-map: only observed signals (status codes, challenge
 *     markup, auth-wall forms) may yield `blocked`; anything
 *     unrecognised maps to `crashed`, never to `blocked`.
 *  4. Footprint cannot ship in the slim image -> the library is an
 *     OPTIONAL runtime-only resolution (dynamic `import()` inside a
 *     try/catch); a missing module reports UNAVAILABLE, never throws.
 *  5. Cancellation is abort-by-close (inferred, unexecuted) -> every
 *     step races a deadline and closes the session on timeout; the
 *     pool (T723) owns cross-call cooperative cancel.
 *  6. No agentic browsing (ADR-029 decision 5) -> there is deliberately
 *     NO click/type/login operation: navigate, read, screenshot,
 *     bounded evaluate, close.
 *
 * INVARIANTS (asserted by `client.test.ts`):
 *  - The guard (`./guard.js`) runs BEFORE any transport call on every
 *    navigation; a denial means zero transport attempts.
 *  - Exactly ONE transport attempt per call. A `blocked` (or `dead`,
 *    or `timeout`) outcome never triggers a second attempt.
 *  - Every call carries an explicit timeout (deadline shared by all
 *    steps); every session is closed in a `finally`, including on
 *    guard denial after connect, on timeout, and on throw.
 *  - This module performs NO logging at all, so no secret (URL
 *    credential, endpoint credential, page content) can leak into logs.
 *    Error text is additionally passed through `redactCredentials`.
 */

import {
  isRedirectAllowed,
  isUrlAllowed,
  isUrlAllowedWithResolvedIp,
} from './guard.js';
import { env } from '../config/env.js';

/** Correct-spelling module specifier recorded by the T720 probe (npm `camoufox-js`). */
export const AUTOMATION_MODULE_SPECIFIER = 'camoufox-js';

/** Per-call navigation/operation budget when the caller passes none. */
export const DEFAULT_NAV_TIMEOUT_MS = 30000;
/** Hard bounds for a caller-supplied timeout: every call is bounded. */
export const MIN_NAV_TIMEOUT_MS = 50;
export const MAX_NAV_TIMEOUT_MS = 120000;
/** Bounded in-page evaluation: script and serialised-result caps. */
export const MAX_EVAL_SCRIPT_CHARS = 4000;
export const MAX_EVAL_RESULT_CHARS = 20000;
/** Bounded memory: rendered HTML is truncated past this length. */
export const MAX_HTML_CHARS = 1000000;

/** Actionable hint attached to every UNAVAILABLE outcome. */
export const BROWSER_UNAVAILABLE_HINT =
  'The browser tier is optional. Install the automation library ' +
  '(`npm i camoufox-js` + fetch the engine) or point CAMOUFOX_WS_ENDPOINT ' +
  'at a remote endpoint (full image / sidecar); otherwise deep search ' +
  'continues with the cheaper tiers.';

/** Tier reachability probe for the descriptor (T724) and orchestrator. Never throws. */
export type BrowserAvailability =
  | { available: true; mode: 'library' | 'remote' }
  | { available: false; reason: string; hint: string };

export type BrowserOutcomeStatus =
  | 'ok'
  | 'blocked'
  | 'dead'
  | 'timeout'
  | 'crashed'
  | 'guard-rejected'
  | 'unavailable';

export interface RenderedPageOk {
  status: 'ok';
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  html: string;
  truncated: boolean;
  attempts: number;
}

export interface ScreenshotOk {
  status: 'ok';
  url: string;
  finalUrl: string;
  httpStatus: number | null;
  image: Uint8Array;
  mediaType: 'image/png';
  attempts: number;
}

export interface EvaluateOk {
  status: 'ok';
  url: string;
  finalUrl: string;
  value: unknown;
  attempts: number;
}

/**
 * Terminal failure shape. `attempts` is the number of transport
 * attempts made: 0 when the guard denied before any request, otherwise
 * exactly 1 — this client never retries (ADR-029: `blocked` is
 * reported, not circumvented).
 */
export interface BrowserFailure {
  status: 'blocked' | 'dead' | 'timeout' | 'crashed' | 'guard-rejected' | 'unavailable';
  url: string;
  reason: string;
  hint?: string;
  attempts: number;
}

export type FetchPageResult = RenderedPageOk | BrowserFailure;
export type ScreenshotResult = ScreenshotOk | BrowserFailure;
export type EvaluateResult = EvaluateOk | BrowserFailure;

/**
 * Structural mirror of the probed library surface (T720 evidence:
 * `newPage(): Promise<Page>`; page exposes navigation, rendered
 * content, screenshot, bounded evaluation, explicit close). Structural
 * on purpose: no static import of the optional library, so importing
 * this module can never fail when the library is absent.
 */
export interface AutomationPage {
  goto(
    url: string,
    opts: { timeoutMs: number },
  ): Promise<{
    httpStatus: number | null;
    finalUrl?: string | null;
    remoteAddress?: string | null;
  }>;
  content(): Promise<string>;
  screenshot(): Promise<Uint8Array>;
  evaluate(script: string, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface AutomationBrowser {
  newPage(): Promise<AutomationPage>;
  close(): Promise<void>;
}

/**
 * Injection point. Production uses `defaultTransportFactory` (lazy
 * optional-library bridge below); tests inject mocks. An injected
 * factory bypasses the `CAMOUFOX_ENABLED` flag — the caller (pool /
 * tier) owns the flag check, the factory owns the mechanism.
 */
export type BrowserTransportFactory = (
  timeoutMs: number,
) => Promise<AutomationBrowser>;

export interface BrowserCallOptions {
  timeoutMs?: number;
  transport?: BrowserTransportFactory;
}

export interface EvaluateCallOptions extends BrowserCallOptions {
  maxResultChars?: number;
}

/** Branded error: the tier is absent/misconfigured. Mapped to `unavailable`, never thrown out. */
export class BrowserUnavailableError extends Error {
  readonly hint: string;
  constructor(reason: string, hint: string = BROWSER_UNAVAILABLE_HINT) {
    super(reason);
    this.name = 'BrowserUnavailableError';
    this.hint = hint;
  }
}

function clampTimeout(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_NAV_TIMEOUT_MS;
  if (raw < MIN_NAV_TIMEOUT_MS) return MIN_NAV_TIMEOUT_MS;
  if (raw > MAX_NAV_TIMEOUT_MS) return MAX_NAV_TIMEOUT_MS;
  return Math.floor(raw);
}

/** Strip `user:pass@` credentials so error text can never carry a secret. */
export function redactCredentials(text: string): string {
  return text.replace(/:\/\/[^/\s@]+@/g, '://***@');
}

function sanitiseErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error';
  return redactCredentials(raw).slice(0, 500);
}

function isMissingModuleError(err: unknown): boolean {
  if (err instanceof BrowserUnavailableError) return true;
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  if (code === 'ERR_MODULE_NOT_FOUND') return true;
  const msg = err instanceof Error ? err.message : String(err);
  // Node raises `Cannot find module`; bundlers/test runners report a
  // failed resolve instead. Either means the optional tier is absent.
  return /cannot find module|failed to resolve import|err_module_not_found/i.test(
    msg,
  );
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'BrowserTimeoutError' || err.name === 'TimeoutError')
  );
}

function timeoutError(step: string, ms: number): Error {
  const err = new Error(`browser ${step} timed out after ${ms}ms`);
  err.name = 'BrowserTimeoutError';
  return err;
}

/** Race one step against the shared deadline. Attaches handlers immediately (no dangling rejections). */
function raceDeadline<T>(task: Promise<T>, step: string, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutError(step, ms));
    }, ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function guardRejected(url: string, reason: string, attempts: number): BrowserFailure {
  return { status: 'guard-rejected', url, reason, attempts };
}

/**
 * Default bridge to the probed library surface. Wired from the T720
 * README evidence (`Camoufox(opts)` -> `browser.newPage()`; remote
 * `launchServer` + `connect(wsEndpoint)`), NOT executed against a live
 * engine in this environment — failures surface as `unavailable` /
 * `crashed` at runtime, never as an import-time throw.
 */
async function defaultTransportFactory(
  timeoutMs: number,
): Promise<AutomationBrowser> {
  // Variable specifier on purpose: tsc must not try to resolve the
  // optional library's types at build time.
  const specifier: string = AUTOMATION_MODULE_SPECIFIER;
  let mod: {
    Camoufox?: new (opts: Record<string, unknown>) => {
      newPage(): Promise<AutomationPage>;
      close(): Promise<void>;
    };
    firefox?: { connect(endpoint: string): Promise<AutomationBrowser> };
    default?: {
      Camoufox?: new (opts: Record<string, unknown>) => {
        newPage(): Promise<AutomationPage>;
        close(): Promise<void>;
      };
      firefox?: { connect(endpoint: string): Promise<AutomationBrowser> };
    };
  };
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch (err) {
    throw new BrowserUnavailableError(
      `automation library is not installed (${sanitiseErrorMessage(err)})`,
    );
  }
  const remote = (env.CAMOUFOX_WS_ENDPOINT ?? '').trim();
  if (remote !== '') {
    const connector = mod.firefox ?? mod.default?.firefox;
    if (!connector) {
      throw new BrowserUnavailableError(
        'CAMOUFOX_WS_ENDPOINT is set but the installed library exposes no remote-connect surface',
      );
    }
    return connector.connect(remote);
  }
  const CamoufoxCtor = mod.Camoufox ?? mod.default?.Camoufox;
  if (!CamoufoxCtor) {
    throw new BrowserUnavailableError(
      'installed library does not expose the probed constructor surface',
    );
  }
  const browser = new CamoufoxCtor({ timeout: timeoutMs });
  return {
    newPage: () => browser.newPage(),
    close: () => browser.close(),
  };
}

async function launchBrowser(
  factory: BrowserTransportFactory,
  timeoutMs: number,
  deadline: number,
): Promise<AutomationBrowser> {
  return raceDeadline(
    factory(timeoutMs),
    'launch',
    Math.max(1, deadline - Date.now()),
  );
}

/** Best-effort close: close errors never mask the primary outcome. Never throws. */
export async function closeBrowserSession(
  browser: AutomationBrowser | null | undefined,
): Promise<void> {
  if (!browser) return;
  try {
    await browser.close();
  } catch {
    // Intentionally swallowed: release must not fail a run.
  }
}

async function closePageQuietly(
  page: AutomationPage | null | undefined,
): Promise<void> {
  if (!page) return;
  try {
    await page.close();
  } catch {
    // Intentionally swallowed: release must not fail a run.
  }
}

interface OpenedSession {
  browser: AutomationBrowser;
  page: AutomationPage;
  nav: {
    httpStatus: number | null;
    finalUrl: string;
    remoteAddress?: string | null;
  };
}

/**
 * Guard -> launch -> page -> navigate. Exactly one navigation attempt.
 * Returns the opened session (ownership transfers to the caller, which
 * closes it) or a terminal failure (anything acquired is released here
 * before returning, so a failed open can never leak a session).
 */
async function openSession(
  url: string,
  timeoutMs: number,
  deadline: number,
  factory: BrowserTransportFactory,
): Promise<{ session: OpenedSession } | { failure: BrowserFailure }> {
  const urlVerdict = isUrlAllowed(url);
  if (!urlVerdict.allowed) {
    return {
      failure: guardRejected(url, `navigation refused: ${urlVerdict.reason}`, 0),
    };
  }
  let browser: AutomationBrowser | null = null;
  let page: AutomationPage | null = null;
  // Set ONLY on the success path below. The `finally` releases whatever
  // was acquired on every other exit (guard denial after connect,
  // navigation throw, timeout) so a failed open can never leak a session.
  let transferred = false;
  try {
    browser = await launchBrowser(factory, timeoutMs, deadline);
    page = await raceDeadline(
      browser.newPage(),
      'newPage',
      Math.max(1, deadline - Date.now()),
    );
    const nav = await raceDeadline(
      page.goto(url, { timeoutMs: Math.max(1, deadline - Date.now()) }),
      'goto',
      Math.max(1, deadline - Date.now()),
    );
    const finalUrl =
      typeof nav.finalUrl === 'string' && nav.finalUrl !== '' ? nav.finalUrl : url;
    if (finalUrl !== url) {
      const redirectVerdict = isRedirectAllowed(url, finalUrl);
      if (!redirectVerdict.allowed) {
        return {
          failure: guardRejected(
            url,
            `redirect refused: ${redirectVerdict.reason}`,
            1,
          ),
        };
      }
    }
    // DNS-rebinding pre-check: run only when the transport exposes the
    // address it actually connected to (guard module documents this as
    // the client's duty; the page surface may not provide it).
    if (typeof nav.remoteAddress === 'string' && nav.remoteAddress !== '') {
      const ipVerdict = isUrlAllowedWithResolvedIp(url, nav.remoteAddress);
      if (!ipVerdict.allowed) {
        return {
          failure: guardRejected(
            url,
            `connected address refused: ${ipVerdict.reason}`,
            1,
          ),
        };
      }
    }
    transferred = true;
    return {
      session: {
        browser,
        page,
        nav: { httpStatus: nav.httpStatus, finalUrl, remoteAddress: nav.remoteAddress },
      },
    };
  } catch (err) {
    if (isMissingModuleError(err)) {
      const reason =
        err instanceof BrowserUnavailableError
          ? sanitiseErrorMessage(err)
          : `automation library is not installed (${sanitiseErrorMessage(err)})`;
      return {
        failure: {
          status: 'unavailable',
          url,
          reason,
          hint: BROWSER_UNAVAILABLE_HINT,
          attempts: 0,
        },
      };
    }
    if (isTimeoutError(err)) {
      return {
        failure: {
          status: 'timeout',
          url,
          reason: sanitiseErrorMessage(err),
          attempts: 1,
        },
      };
    }
    return {
      failure: {
        status: 'crashed',
        url,
        reason: sanitiseErrorMessage(err),
        attempts: 1,
      },
    };
  } finally {
    if (!transferred) {
      await closePageQuietly(page);
      await closeBrowserSession(browser);
    }
  }
}

/**
 * Own the session lifecycle: open, run exactly one guarded operation,
 * classify, close in `finally`. The operation callback MUST NOT retry.
 */
async function withSession<T>(
  url: string,
  options: BrowserCallOptions | undefined,
  run: (session: OpenedSession, remainingMs: () => number) => Promise<T>,
  classify: (outcome: T | unknown, error: unknown) => T,
): Promise<T> {
  const timeoutMs = clampTimeout(options?.timeoutMs ?? env.CAMOUFOX_NAV_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const factory = options?.transport ?? defaultTransportFactory;
  const remainingMs = (): number => Math.max(1, deadline - Date.now());
  if (Date.now() >= deadline) {
    return classify(null, timeoutError('budget', timeoutMs));
  }
  const opened = await openSession(url, timeoutMs, deadline, factory);
  if ('failure' in opened) {
    // openSession already released anything it acquired; nothing to close.
    return opened.failure as unknown as T;
  }
  const { session } = opened;
  try {
    return await run(session, remainingMs);
  } catch (err) {
    return classify(null, err);
  } finally {
    await closePageQuietly(session.page);
    await closeBrowserSession(session.browser);
  }
}

/** HTTP-status classification from observed signals only. */
function classifyHttpStatus(
  httpStatus: number | null,
): BrowserFailure['status'] | null {
  if (httpStatus === 403 || httpStatus === 429) return 'blocked';
  if (httpStatus === 404 || httpStatus === 410) return 'dead';
  return null;
}

const CHALLENGE_MARKERS: readonly string[] = [
  'captcha',
  'cf-challenge',
  'datadome',
  'perimeterx',
  'arkose',
  'recaptcha',
  'hcaptcha',
  'turnstile',
  'verify you are human',
  'verify-you-are-human',
  'access denied',
  'attention required',
  'are you a robot',
  'unusual traffic',
  'challenge-platform',
];

const AUTH_WALL_PATTERN = /<input[^>]*type\s*=\s*["']?password/i;

/**
 * Body classification from observed signals only. An empty document is
 * NOT proof of a block (probe contract) — it stays `ok` with empty
 * content. Unknown shapes never map to `blocked`.
 */
function classifyBody(html: string): { blocked: true; reason: string } | { blocked: false } {
  if (AUTH_WALL_PATTERN.test(html)) {
    return { blocked: true, reason: 'blocked: auth wall (login form presented)' };
  }
  const lower = html.toLowerCase();
  for (const marker of CHALLENGE_MARKERS) {
    if (lower.includes(marker)) {
      return { blocked: true, reason: `blocked: challenge marker observed (${marker})` };
    }
  }
  return { blocked: false };
}

function toFailure(url: string, err: unknown): BrowserFailure {
  if (isMissingModuleError(err)) {
    return {
      status: 'unavailable',
      url,
      reason: sanitiseErrorMessage(err),
      hint: BROWSER_UNAVAILABLE_HINT,
      attempts: 1,
    };
  }
  if (isTimeoutError(err)) {
    return {
      status: 'timeout',
      url,
      reason: sanitiseErrorMessage(err),
      attempts: 1,
    };
  }
  return {
    status: 'crashed',
    url,
    reason: sanitiseErrorMessage(err),
    attempts: 1,
  };
}

/**
 * Navigate to a URL and read the rendered document (the "snapshot"
 * operation of the probed surface). Guard-checked, single attempt,
 * deadline-bounded, session closed in `finally`. Never throws for
 * operational outcomes.
 */
export async function fetchRenderedPage(
  url: string,
  options?: BrowserCallOptions,
): Promise<FetchPageResult> {
  return withSession<FetchPageResult>(
    url,
    options,
    async (session, remainingMs) => {
      const statusHit = classifyHttpStatus(session.nav.httpStatus);
      if (statusHit === 'blocked') {
        return {
          status: 'blocked',
          url,
          reason: `blocked: navigation answered HTTP ${session.nav.httpStatus}`,
          attempts: 1,
        };
      }
      if (statusHit === 'dead') {
        return {
          status: 'dead',
          url,
          reason: `dead: navigation answered HTTP ${session.nav.httpStatus}`,
          attempts: 1,
        };
      }
      const html = await raceDeadline(
        session.page.content(),
        'content',
        remainingMs(),
      );
      const body = classifyBody(html);
      if (body.blocked) {
        return { status: 'blocked', url, reason: body.reason, attempts: 1 };
      }
      const truncated = html.length > MAX_HTML_CHARS;
      return {
        status: 'ok',
        url,
        finalUrl: session.nav.finalUrl,
        httpStatus: session.nav.httpStatus,
        html: truncated ? html.slice(0, MAX_HTML_CHARS) : html,
        truncated,
        attempts: 1,
      };
    },
    (outcome, error) => {
      if (outcome !== null && typeof outcome === 'object' && 'status' in (outcome as Record<string, unknown>)) {
        return outcome as FetchPageResult;
      }
      if (error !== null && typeof error === 'object' && 'status' in (error as Record<string, unknown>)) {
        return error as FetchPageResult;
      }
      if (error === null) {
        return { status: 'crashed', url, reason: 'unknown client error', attempts: 1 };
      }
      return toFailure(url, error);
    },
  );
}

/**
 * Navigate to a URL and capture a screenshot of the rendered page.
 * Same guard/timeout/single-attempt/lifecycle contract as
 * `fetchRenderedPage`. Screenshots are captured for `ok` pages only;
 * a `blocked` page is reported, not recorded.
 */
export async function captureScreenshot(
  url: string,
  options?: BrowserCallOptions,
): Promise<ScreenshotResult> {
  return withSession<ScreenshotResult>(
    url,
    options,
    async (session, remainingMs) => {
      const statusHit = classifyHttpStatus(session.nav.httpStatus);
      if (statusHit === 'blocked') {
        return {
          status: 'blocked',
          url,
          reason: `blocked: navigation answered HTTP ${session.nav.httpStatus}`,
          attempts: 1,
        };
      }
      if (statusHit === 'dead') {
        return {
          status: 'dead',
          url,
          reason: `dead: navigation answered HTTP ${session.nav.httpStatus}`,
          attempts: 1,
        };
      }
      const html = await raceDeadline(
        session.page.content(),
        'content',
        remainingMs(),
      );
      const body = classifyBody(html);
      if (body.blocked) {
        return { status: 'blocked', url, reason: body.reason, attempts: 1 };
      }
      const image = await raceDeadline(
        session.page.screenshot(),
        'screenshot',
        remainingMs(),
      );
      return {
        status: 'ok',
        url,
        finalUrl: session.nav.finalUrl,
        httpStatus: session.nav.httpStatus,
        image,
        mediaType: 'image/png',
        attempts: 1,
      };
    },
    (outcome, error) => {
      if (outcome !== null && typeof outcome === 'object' && 'status' in (outcome as Record<string, unknown>)) {
        return outcome as ScreenshotResult;
      }
      if (error !== null && typeof error === 'object' && 'status' in (error as Record<string, unknown>)) {
        return error as ScreenshotResult;
      }
      if (error === null) {
        return { status: 'crashed', url, reason: 'unknown client error', attempts: 1 };
      }
      return toFailure(url, error);
    },
  );
}

/**
 * Navigate to a URL and run one bounded read-only evaluation against
 * the rendered document (e.g. extract structured listing data).
 * Script length and result size are capped; the script runs after a
 * successful guarded navigation only. No credentials are ever
 * submitted and no second attempt follows a `blocked` outcome.
 */
export async function evaluateOnPage(
  url: string,
  script: string,
  options?: EvaluateCallOptions,
): Promise<EvaluateResult> {
  if (typeof script !== 'string' || script.length === 0) {
    return { status: 'crashed', url, reason: 'evaluate script must be a non-empty string', attempts: 0 };
  }
  if (script.length > MAX_EVAL_SCRIPT_CHARS) {
    return {
      status: 'crashed',
      url,
      reason: `evaluate script exceeds ${MAX_EVAL_SCRIPT_CHARS} characters`,
      attempts: 0,
    };
  }
  const maxResultChars = (() => {
    const raw = options?.maxResultChars;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      return MAX_EVAL_RESULT_CHARS;
    }
    return Math.min(Math.floor(raw), MAX_EVAL_RESULT_CHARS);
  })();
  return withSession<EvaluateResult>(
    url,
    options,
    async (session, remainingMs) => {
      const statusHit = classifyHttpStatus(session.nav.httpStatus);
      if (statusHit === 'blocked') {
        return {
          status: 'blocked',
          url,
          reason: `blocked: navigation answered HTTP ${session.nav.httpStatus}`,
          attempts: 1,
        };
      }
      if (statusHit === 'dead') {
        return {
          status: 'dead',
          url,
          reason: `dead: navigation answered HTTP ${session.nav.httpStatus}`,
          attempts: 1,
        };
      }
      const value = await raceDeadline(
        session.page.evaluate(script, remainingMs()),
        'evaluate',
        remainingMs(),
      );
      let serialised: string;
      try {
        serialised = JSON.stringify(value) ?? 'null';
      } catch {
        return { status: 'crashed', url, reason: 'evaluate result is not serialisable', attempts: 1 };
      }
      if (serialised.length > maxResultChars) {
        return {
          status: 'crashed',
          url,
          reason: `evaluate result exceeds ${maxResultChars} characters`,
          attempts: 1,
        };
      }
      return { status: 'ok', url, finalUrl: session.nav.finalUrl, value, attempts: 1 };
    },
    (outcome, error) => {
      if (outcome !== null && typeof outcome === 'object' && 'status' in (outcome as Record<string, unknown>)) {
        return outcome as EvaluateResult;
      }
      if (error !== null && typeof error === 'object' && 'status' in (error as Record<string, unknown>)) {
        return error as EvaluateResult;
      }
      if (error === null) {
        return { status: 'crashed', url, reason: 'unknown client error', attempts: 1 };
      }
      return toFailure(url, error);
    },
  );
}

/**
 * Tier reachability probe for the descriptor (T724) and the
 * orchestrator (wave 7). Reports UNAVAILABLE with an actionable
 * message when the tier is disabled or the library/endpoint is
 * missing. NEVER throws — not at import, not here.
 */
export async function isBrowserAvailable(): Promise<BrowserAvailability> {
  try {
    const remote = (env.CAMOUFOX_WS_ENDPOINT ?? '').trim();
    if (remote !== '') {
      return { available: true, mode: 'remote' };
    }
    if (env.CAMOUFOX_ENABLED !== 'true') {
      return {
        available: false,
        reason: 'browser tier is disabled (CAMOUFOX_ENABLED is not "true")',
        hint: BROWSER_UNAVAILABLE_HINT,
      };
    }
    const specifier: string = AUTOMATION_MODULE_SPECIFIER;
    try {
      await import(specifier);
    } catch {
      return {
        available: false,
        reason: 'automation library is not installed',
        hint: BROWSER_UNAVAILABLE_HINT,
      };
    }
    return { available: true, mode: 'library' };
  } catch (err) {
    return {
      available: false,
      reason: sanitiseErrorMessage(err),
      hint: BROWSER_UNAVAILABLE_HINT,
    };
  }
}
