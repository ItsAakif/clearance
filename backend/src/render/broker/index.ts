// The render broker - the process that owns the Docker socket.
//
// NORMATIVE DOC: .planning/decisions/ADR-042-*.md D2 (the broker owns container creation)
//                .planning/decisions/ADR-044-*.md D1 (the transport, the exec-based
//                staging/extraction, the kill order, the boot preflight)
//                .planning/specs/clearance-v2/render-sandbox-policy.md sec. 9 (failure
//                semantics: the CLOSED outcome set, the kill budget, the error surface),
//                sec. 10.2 (concurrency and queueing), sec. 6.3 (artifact validation)
//                .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 3
// Task:         T1031
//
// THE PER-JOB SEQUENCE, in the order the contract fixes it. Each step is one numbered
// block in `runJob` and each is separately injectable, so a test can make ANY of them fail
// and assert the `finally` still ran:
//
//   (1) auth            - the shared secret, compared in constant time. Wrong or absent ->
//                         401, and NOTHING ELSE HAPPENS: no spec is read, no slot is
//                         taken, no container exists.
//   (2) spec            - the 4-byte prefix and at most 64 KiB of JSON, read under that
//                         bound, and validated against the closed schema. NO tree byte is
//                         read yet: the spec is all `acquire()` needs, so taking the slot
//                         before the tree is what stops N concurrent requests from each
//                         buffering 8 MiB before any of them is run, queued or refused.
//   (3) admission       - host 2 / per-user 1 / queue 8, else 429 `RENDER_BUSY` (policy
//                         10.2), with the body still unread. Released in the `finally`.
//   (4) tree            - exactly `treeBytes` of ustar, bounded by the declared length
//                         (itself capped at 8 MiB by the schema in step 2). A short or a
//                         long frame is refused here, still before a container exists.
//   (5) plan + argv     - `buildCompileArgs('typst', ...)` is the ONLY argv builder and
//                         `buildContainerCreateArgs(plan, spec, hostRoot)` is the ONLY
//                         container description. Neither is hand-written here; there is no
//                         `typst` or `pdflatex` literal anywhere in this directory.
//   (6) create          - `docker create`, environment set at CREATE as a complete map.
//   (7) stage           - `docker exec -i <c> tar -x -C /work` with the framed tree on
//                         stdin, aborted and killed if the frame exceeds `treeBytes` or
//                         ends short of it.
//   (8) compile         - `docker exec -w /work` with `plan.argv` as an ARRAY and the same
//                         env re-asserted per key. Wall budget 10 s, raced against a
//                         client disconnect.
//   (9) kill            - `docker kill -s TERM`, `killGraceMs` (2 s), `docker kill -s KILL`.
//   (10) extract        - `docker exec <c> tar -c -C /out .` into a bounded private spool,
//                         then `validateRenderArtifact` (T1013) UNCHANGED.
//   (11) finally        - `docker rm -f <c>`, delete the spool, release the slot, log the
//                         policy-9.4-redacted diagnostics. Never the response.
//
// A NOTE ON THE NUMBERING, because the plan fixes an order and this file has to be honest
// about which order it can actually implement. T1040 sec. 3 lists "(2) admission ...
// (3) parse+validate JobSpec", and `acquire()` needs `spec.userId` - so the literal order is
// not implementable, and the orchestrator's ruling 12 is the resolution: the SPEC is read and
// validated first, admission is taken on the strength of it, and the TREE is read only after.
// That is the only ordering that keeps both properties the contract wants (nothing runs
// without a slot; nothing buffers without a slot).
//
// WHY THE ENVIRONMENT IS SET TWICE. At CREATE so the container is describable on its own
// (and so `docker inspect` shows the policy values, which is what policy 10.1 item 4 wants),
// and again on the EXEC because `docker exec` inherits the container's configured
// environment and a per-exec `--env` is the only way to re-assert each key independently.
// The second source is stronger, not weaker: `assertPlanEnvOnExec` fails closed if the two
// ever disagree, so a container created before a policy change cannot be reused with stale
// values.
//
// WHY THE ARTIFACT IS BUFFERED RATHER THAN STREAMED TO THE CLIENT. The response bytes are
// read (under the validated cap) BEFORE the `finally` runs, because the `finally` deletes
// the spool the bytes live in. Buffering is what makes "the container is gone, the spool is
// gone and the slot is released BEFORE a single byte reaches the client" a property of the
// control flow rather than a race. The bound is policy 6.2's 20 MiB, already enforced twice
// (capture sink, extractor) and a third time by `validateRenderArtifact`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { lstat, readFile, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, type Writable } from 'node:stream';

import {
  LATEX_PIN,
  RENDER_LIMITS,
  RENDER_OUTCOME_CODES,
  RENDER_PATHS,
  RENDER_QUOTA,
  buildCompileArgs,
  type CompilePlan,
  type RenderEngine,
} from '../sandbox.js';
import { StageError, validateRenderArtifact } from '../stage.js';
import {
  RENDER_WORKER_IMAGE,
  buildContainerCreateArgs,
  enginePinFor,
  workerImageFor,
  type BrokerJobSpec,
} from './createArgs.js';
import {
  createDockerCliRunner,
  DEFAULT_ADMIN_TIMEOUT_MS,
  DOCKER_IMAGE_INSPECT_TIMEOUT_MS,
  type DockerRunner,
} from './dockerRunner.js';
import { REDACT_MAX_BYTES, redactDiagnostics } from './redact.js';
import {
  SPOOL_DEFAULT_ROOT,
  SpoolOverflowError,
  createSpool,
  extractUstarToDir,
  stagedTextCandidates,
  waitForSink,
  type Spool,
} from './spool.js';

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

export const BROKER_RENDER_PATH = '/v1/render';
export const BROKER_TOKEN_HEADER = 'x-clearance-render-token';

export const BROKER_RESPONSE_HEADERS = Object.freeze({
  outcome: 'x-clearance-outcome',
  sha256: 'x-clearance-sha256',
  bytes: 'x-clearance-bytes',
  mime: 'x-clearance-mime',
  durationMs: 'x-clearance-duration-ms',
});

/** The four-byte big-endian length prefix that precedes the JSON JobSpec. */
export const FRAME_PREFIX_BYTES = 4;

/**
 * The sidecar files pdflatex writes beside `artifact.pdf` with the mandated argv.
 *
 * `-interaction=nonstopmode` always writes the log, `-recorder` writes the `.fls`, and a
 * document that creates cross-references writes `.aux`. They are REMOVED before
 * extraction so policy 6.3's "exactly one entry" check still describes `/out`. The list is
 * fixed and derived from the policy jobname, never from caller content.
 */
const LATEX_SIDECAR_PATHS: readonly string[] = Object.freeze(
  ['.aux', '.log', '.fls', '.out', '.toc', '.lof', '.lot', '.nav', '.snm', '.vrb', '.bbl', '.blg', '.idx', '.ind', '.ilg'].map(
    (suffix) => `${RENDER_PATHS.out}/artifact${suffix}`,
  ),
);

/**
 * The host root used when a caller constructs a `Broker` directly without one.
 *
 * It is a POSIX-shaped absolute path so every emitted bind is host-absolute and the argv
 * invariants hold in a unit test with no daemon. It is NOT a deployable value: the compose
 * service sets `RENDER_HOST_TYPST_ROOT`, and `main()` refuses to boot without it, because a
 * root that merely happens to be absolute is no guarantee that the daemon can resolve it.
 */
export const DEFAULT_HOST_ROOT = '/clearance-host-repo';

/**
 * The largest JobSpec this broker will read. The staged tree has its own, much larger
 * bound (`RENDER_LIMITS.inputTotalBytes`), so a tight spec cap turns an unbounded read
 * into a bounded one before a single byte of the tree is accepted.
 */
export const MAX_SPEC_BYTES = 64 * 1024;

/**
 * The outcome codes, exactly as `sandbox.ts` declares them. NOTHING is added here (ADR-044
 * D1: the boot preflight is why a missing image needs no new code), so this is a type-level
 * and a test-level re-assertion of a set that already exists rather than a second copy.
 */
export type RenderOutcome = (typeof RENDER_OUTCOME_CODES)[number];

/**
 * TRANSPORT rejections - failures of the CHANNEL, not of a render.
 *
 * A request that never reached the render path (no token, a malformed frame, a spec that is
 * not a JobSpec) has no render outcome to report: nothing compiled, nothing was staged, no
 * container existed. Inventing an outcome code for it would be a lie AND would violate the
 * closed set, so the channel uses its own disjoint vocabulary. The set is asserted disjoint
 * from `RENDER_OUTCOME_CODES` in `broker.test.ts`, and every code the broker CAN emit for an
 * actual render is a member of the policy set.
 *
 * `RENDER_BUSY`, `RENDER_INPUT_TOO_LARGE` and `RENDER_TOOLCHAIN_MISMATCH` are POLICY codes
 * and are emitted as such even though they are transport-shaped (a 429, a 400): they are
 * in the closed set and the policy names them for exactly these situations.
 */
export const BROKER_TRANSPORT_CODES = Object.freeze([
  'RENDER_UNAUTHORIZED',
  'RENDER_REQUEST_INVALID',
  'RENDER_BROKER_UNAVAILABLE',
] as const);

export type BrokerTransportCode = (typeof BROKER_TRANSPORT_CODES)[number];

/** Every code the broker can put in a response body. */
export type BrokerResponseCode = RenderOutcome | BrokerTransportCode;

/**
 * The fixed, user-facing message per policy 9.2's "User-facing" column.
 *
 * A LOOKUP TABLE, never a template, for the reason `stage.ts` and `storage.ts` use the same
 * shape: interpolating anything caller-derived into a message is the failure mode policy
 * 9.3 exists to prevent. These strings are the ONLY text a client ever sees, and they are
 * asserted verbatim against the policy document in `broker.test.ts`.
 */
export const OUTCOME_MESSAGES: Readonly<Record<BrokerResponseCode, string>> = Object.freeze({
  ok: 'The document was rendered.',
  RENDER_COMPILE_ERROR: 'This template could not be rendered. Check your content and try again.',
  RENDER_TIMEOUT: 'Rendering took too long and was stopped.',
  RENDER_RESOURCE_LIMIT: 'This document is too large or complex to render.',
  RENDER_ARTIFACT_INVALID: 'The rendered document could not be produced.',
  RENDER_INPUT_TOO_LARGE: 'This document is too large to render.',
  RENDER_TOOLCHAIN_MISMATCH: 'This template needs a different rendering engine version.',
  RENDER_BUSY: 'The renderer is busy. Try again shortly.',
  RENDER_UNAUTHORIZED: 'The render request was not authorized.',
  RENDER_REQUEST_INVALID: 'The render request was malformed.',
  RENDER_BROKER_UNAVAILABLE: 'The renderer is temporarily unavailable.',
});

/** HTTP status per code. `ok` is 201; the rest are 4xx/5xx. */
const STATUS_FOR: Readonly<Record<BrokerResponseCode, number>> = Object.freeze({
  ok: 201,
  RENDER_COMPILE_ERROR: 422,
  RENDER_TIMEOUT: 504,
  RENDER_RESOURCE_LIMIT: 422,
  RENDER_ARTIFACT_INVALID: 422,
  RENDER_INPUT_TOO_LARGE: 413,
  RENDER_TOOLCHAIN_MISMATCH: 422,
  RENDER_BUSY: 429,
  RENDER_UNAUTHORIZED: 401,
  RENDER_REQUEST_INVALID: 400,
  RENDER_BROKER_UNAVAILABLE: 503,
});

// ---------------------------------------------------------------------------
// The JobSpec schema - CLOSED
// ---------------------------------------------------------------------------

/** The exact key set. An unknown key is a rejection, not a strip (T1040 ruling 4's shape). */
export const JOB_SPEC_KEYS = Object.freeze([
  'jobId',
  'engine',
  'format',
  'templateId',
  'templateVersion',
  'expectedEngineVersion',
  'creationTimestampUnix',
  'treeBytes',
  'treeFileCount',
  'userId',
  'revisionId',
] as const);

/** The closed reason vocabulary for a JobSpec rejection. Machine-readable, log-safe. */
export const JOB_SPEC_REASONS = Object.freeze([
  'SPEC_NOT_JSON_OBJECT',
  'SPEC_UNKNOWN_KEY',
  'SPEC_MISSING_KEY',
  'SPEC_FIELD_TYPE',
  'ENGINE_UNSUPPORTED',
  'FORMAT_UNSUPPORTED',
  'TIMESTAMP_INVALID',
  'TREE_BYTES_OUT_OF_RANGE',
  'TREE_FILE_COUNT_OUT_OF_RANGE',
  'TREE_BYTES_EXCEEDED',
  'ENGINE_VERSION_MISMATCH',
] as const);

export type JobSpecReason = (typeof JOB_SPEC_REASONS)[number];

export class JobSpecError extends Error {
  constructor(readonly code: BrokerResponseCode, readonly reason: JobSpecReason) {
    super(`${code}: ${reason}`);
    this.name = 'JobSpecError';
  }
}

/**
 * C0 + DEL + C1, the same class `assertSafeStageName()` refuses in `sandbox.ts`.
 *
 * The string fields are ids, and an id that carries a control byte is either a protocol
 * confusion or a log-injection attempt: a newline in a `templateId` would split the job
 * log line this module writes. The check is here rather than in the type system because the
 * values arrive as `unknown` from JSON.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * The closed JobSpec validator.
 *
 * Every rejection is a `JobSpecError` carrying a code and a reason from a CLOSED set, and
 * the message is the concatenation of the two - so no caller value (a template id, a user
 * id, a revision id, a path, a byte count) can reach a log or a response through it.
 *
 * The three caps and the pin:
 *   - `creationTimestampUnix` is REQUIRED and must be a non-negative INTEGER. It is what
 *     makes `SOURCE_DATE_EPOCH` deterministic (policy 7.4); typst's PDF writer falls back
 *     to wall clock without it, so "two runs are byte-identical" would be false.
 *   - `treeBytes <= RENDER_LIMITS.inputTotalBytes` (8 MiB) and
 *     `treeFileCount <= RENDER_LIMITS.inputFileCount` (5) are policy 5.2.2, enforced BEFORE
 *     any container exists, which is why they can never become an OOM.
 *   - `expectedEngineVersion` must equal the pin, or `RENDER_TOOLCHAIN_MISMATCH` (policy
 *     9.2). It is the check that stops a template from silently rendering against a
 *     different engine than its pins declare.
 *
 * `engine`/`format` are the two NARROW literals, checked with an explicit reason each
 * rather than a generic type error, because "your engine is not supported here" and "the
 * broker only renders PDF" are different operator stories.
 */
export function parseJobSpec(raw: unknown): BrokerJobSpec {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new JobSpecError('RENDER_REQUEST_INVALID', 'SPEC_NOT_JSON_OBJECT');
  }
  const offered = raw as Record<string, unknown>;
  for (const key of Object.keys(offered)) {
    if (!(JOB_SPEC_KEYS as readonly string[]).includes(key)) {
      throw new JobSpecError('RENDER_REQUEST_INVALID', 'SPEC_UNKNOWN_KEY');
    }
  }
  for (const key of JOB_SPEC_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(offered, key)) {
      throw new JobSpecError('RENDER_REQUEST_INVALID', 'SPEC_MISSING_KEY');
    }
  }

  const stringField = (key: string): string => {
    const value = offered[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
      throw new JobSpecError('RENDER_REQUEST_INVALID', 'SPEC_FIELD_TYPE');
    }
    if (CONTROL_CHARS.test(value)) {
      throw new JobSpecError('RENDER_REQUEST_INVALID', 'SPEC_FIELD_TYPE');
    }
    return value;
  };
  const integerField = (key: string): number => {
    const value = offered[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new JobSpecError('RENDER_REQUEST_INVALID', 'SPEC_FIELD_TYPE');
    }
    return value;
  };

  const engine = offered.engine;
  if (engine !== 'typst' && engine !== 'latex') {
    throw new JobSpecError('RENDER_REQUEST_INVALID', 'ENGINE_UNSUPPORTED');
  }
  if (offered.format !== 'pdf') {
    throw new JobSpecError('RENDER_REQUEST_INVALID', 'FORMAT_UNSUPPORTED');
  }

  const creationTimestampUnix = integerField('creationTimestampUnix');
  if (creationTimestampUnix < 0) {
    throw new JobSpecError('RENDER_REQUEST_INVALID', 'TIMESTAMP_INVALID');
  }

  const treeBytes = integerField('treeBytes');
  if (treeBytes < 0 || treeBytes > RENDER_LIMITS.inputTotalBytes) {
    throw new JobSpecError('RENDER_INPUT_TOO_LARGE', 'TREE_BYTES_OUT_OF_RANGE');
  }
  const treeFileCount = integerField('treeFileCount');
  if (treeFileCount < 1 || treeFileCount > RENDER_LIMITS.inputFileCount) {
    throw new JobSpecError('RENDER_INPUT_TOO_LARGE', 'TREE_FILE_COUNT_OUT_OF_RANGE');
  }

  const expectedEngineVersion = stringField('expectedEngineVersion');
  if (expectedEngineVersion !== enginePinFor(engine)) {
    throw new JobSpecError('RENDER_TOOLCHAIN_MISMATCH', 'ENGINE_VERSION_MISMATCH');
  }

  return Object.freeze({
    jobId: stringField('jobId'),
    engine,
    format: 'pdf',
    templateId: stringField('templateId'),
    templateVersion: stringField('templateVersion'),
    expectedEngineVersion,
    creationTimestampUnix,
    treeBytes,
    treeFileCount,
    userId: stringField('userId'),
    revisionId: stringField('revisionId'),
  });
}

/**
 * Classify a fault that escaped the per-step handling.
 *
 * BY THE STAMPED CODE, deliberately. `StageError` and `SpoolOverflowError` both carry a
 * `code` from a closed set, and a `RENDER_ARTIFACT_INVALID` from either must land on
 * `RENDER_ARTIFACT_INVALID` regardless of which reason fired - matching on reason strings
 * would turn every future reason into a silent misclassification, which is exactly the
 * failure mode a closed code set exists to prevent.
 *
 * A `BrokerFrameError` is a channel violation (400). Everything else is a broker or host
 * fault, which is a 503: the render never started, so no policy outcome describes it, and
 * reporting one would be a lie the route would map to a user-facing "the document is too
 * large" that nothing supports.
 */
export function classifyBrokerFault(error: unknown): BrokerResponseCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'RENDER_ARTIFACT_INVALID') return 'RENDER_ARTIFACT_INVALID';
  if (error instanceof BrokerFrameError) return 'RENDER_REQUEST_INVALID';
  if (error instanceof JobSpecError) return error.code;
  return 'RENDER_BROKER_UNAVAILABLE';
}

// ---------------------------------------------------------------------------
// Admission (policy 10.2)
// ---------------------------------------------------------------------------

export interface BrokerQuota {
  readonly concurrentPerHost: number;
  readonly concurrentPerUser: number;
  readonly queueDepth: number;
}

/** The policy defaults. Lowering is always allowed (policy 10.2); raising is not. */
export const BROKER_QUOTA: BrokerQuota = Object.freeze({
  concurrentPerHost: RENDER_QUOTA.concurrentPerHost,
  concurrentPerUser: RENDER_QUOTA.concurrentPerUser,
  queueDepth: RENDER_QUOTA.queueDepth,
});

export class BrokerBusyError extends Error {
  readonly code = 'RENDER_BUSY';
  constructor() {
    super('RENDER_BUSY: the render queue is full');
    this.name = 'BrokerBusyError';
  }
}

interface Waiter {
  readonly userId: string;
  readonly resolve: () => void;
}

/**
 * A bounded in-process queue, which policy 10.2 requires and explicitly forbids
 * generalising ("No queue infrastructure at MVP ... an in-process bounded queue in the broker
 * is sufficient").
 *
 * The arithmetic, stated so the tests can read it off the implementation:
 *   - a job runs IMMEDIATELY iff the host is below `concurrentPerHost` AND its user is below
 *     `concurrentPerUser` AND the queue is empty. The queue-empty clause is what keeps a
 *     newly-arriving job from jumping ahead of jobs already waiting - fairness is part of
 *     the contract ("beyond this, `RENDER_BUSY`"), and a job that can leapfrog a queue can
 *     starve one indefinitely;
 *   - otherwise it is QUEUED while `queued < queueDepth`, so with the policy defaults 2 run,
 *     8 wait and the 9th is refused with `RENDER_BUSY`;
 *   - `pump()` re-scans the queue on every acquire and every release and grants every
 *     waiter whose constraints are now satisfiable, skipping (not dropping) one that is
 *     not, so a per-user waiter never busy-waits on a host that still has a free slot for
 *     a different user.
 */
export class AdmissionController {
  private activeHost = 0;
  private readonly activePerUser = new Map<string, number>();
  private waiters: Waiter[] = [];

  constructor(readonly quota: BrokerQuota = BROKER_QUOTA) {}

  get running(): number {
    return this.activeHost;
  }

  get queued(): number {
    return this.waiters.length;
  }

  isRunning(userId: string): boolean {
    return (this.activePerUser.get(userId) ?? 0) > 0;
  }

  async acquire(userId: string): Promise<void> {
    if (this.fits(userId) && this.waiters.length === 0) {
      this.take(userId);
      return;
    }
    if (this.waiters.length >= this.quota.queueDepth) {
      throw new BrokerBusyError();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ userId, resolve });
    });
    this.pump();
  }

  release(userId: string): void {
    this.give(userId);
    this.pump();
  }

  /**
   * Refuse every queued waiter, for shutdown. The jobs then fail rather than hang.
   *
   * NO COUNTER IS DECREMENTED HERE, and that is a correction rather than an omission. A
   * queued waiter has not been granted a slot - `take()` runs when it is granted, in
   * `pump()` - so releasing "on its behalf" decremented the host counter for jobs that never
   * held it, and `running` read 0 while granted jobs were still executing. Nothing wedged
   * (the process is going away), but the accounting was briefly false, and a counter that
   * lies once is a counter nothing else can be trusted from.
   */
  drain(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private fits(userId: string): boolean {
    return (
      this.activeHost < this.quota.concurrentPerHost &&
      (this.activePerUser.get(userId) ?? 0) < this.quota.concurrentPerUser
    );
  }

  private take(userId: string): void {
    this.activeHost += 1;
    this.activePerUser.set(userId, (this.activePerUser.get(userId) ?? 0) + 1);
  }

  private give(userId: string): void {
    this.activeHost = Math.max(0, this.activeHost - 1);
    const next = (this.activePerUser.get(userId) ?? 1) - 1;
    if (next <= 0) this.activePerUser.delete(userId);
    else this.activePerUser.set(userId, next);
  }

  private pump(): void {
    for (let index = 0; index < this.waiters.length; ) {
      const waiter = this.waiters[index] as Waiter;
      if (this.fits(waiter.userId)) {
        this.take(waiter.userId);
        this.waiters.splice(index, 1);
        waiter.resolve();
        continue;
      }
      index += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Compile-exit classification (policy 9.2 / 9.1)
// ---------------------------------------------------------------------------

/**
 * Classify a finished compile.
 *
 * `RENDER_TIMEOUT` is decided by the CALLER, not here: the wall budget is a supervisor
 * concern, and a timed-out job has no exit code to classify (the supervisor killed the
 * container while the compile was still running). This function classifies only what
 * actually EXITED.
 *
 * Order matters, and it is the triage order:
 *   1. exit 0 with no resource symptom -> `ok`;
 *   2. a memory / PID / `ENOSPC` symptom -> `RENDER_RESOURCE_LIMIT`, whatever the exit code.
 *      A template that exhausts memory is a resource failure even if the engine chose to
 *      exit 1, and reporting it as a compile error sends the triage after the wrong cause;
 *   3. anything else non-zero -> `RENDER_COMPILE_ERROR`.
 *
 * The symptom match is deliberately case-insensitive and substring-based, because the
 * signals come from four different places (the kernel's OOM message, busybox, the musl
 * dynamic loader, typst's own allocator failure) and none of them is pinned. The exit codes
 * are the reliable part, so both are used: 137 (SIGKILL, which is what an OOM kill is) and
 * 139 (SIGSEGV) are resource symptoms on their own, and the text covers the rest.
 */
export function classifyCompileExit(
  code: number,
  stdout: string,
  stderr: string,
): RenderOutcome {
  if (code === 0) return 'ok';
  const text = `${stdout}\n${stderr}`.toLowerCase();
  const resourceSymptom =
    code === 137 ||
    code === 139 ||
    /out of memory|oom|cannot allocate memory|memory allocation failed/.test(text) ||
    /no space left on device|enospc/.test(text) ||
    /resource temporarily unavailable|cannot fork|too many open files|emfile|pid limit|failed to create thread/.test(
      text,
    );
  if (resourceSymptom) return 'RENDER_RESOURCE_LIMIT';
  return 'RENDER_COMPILE_ERROR';
}

// ---------------------------------------------------------------------------
// Environment re-assertion on the exec
// ---------------------------------------------------------------------------

/**
 * Resolve the engine BINARY NAME the plan carries to the path the container can execute.
 *
 * This step exists because of something only a live run reveals, and it is worth stating
 * precisely because it looks like the broker re-authoring the argv:
 *
 *   `buildCompileArgs()` puts the BARE BINARY NAME in `argv[0]` - `'typst'`, `'pdflatex'` -
 *   because the plan is also consumed by callers that resolve it against the image's
 *   ENTRYPOINT (`docker compose run typst-worker --version` works precisely because the
 *   entrypoint IS the binary). The broker cannot use that route: it REPLACES the entrypoint
 *   with the PID-1 holder, and `docker exec` resolves a bare name against the container's
 *   `PATH` - which the image deliberately does not set (policy 3.4 / 4.7: the compile
 *   environment is COMPLETE and never merged, so there is no `PATH` to add, and adding one
 *   would be a new policy value in a module that is not allowed to invent them).
 *
 *   So the broker qualifies `argv[0]` against `RENDER_PATHS.toolchain` - `/opt/typst`, the
 *   read-only bind of the pinned toolchain, a POLICY CONSTANT from `sandbox.ts`. That is the
 *   whole transformation: no flag is added, removed or reordered (policy 13.2's constraint,
 *   applied here for the same reason), `argv[1..]` is passed through untouched, and the
 *   binary NAME still comes from the single argv builder. A hand-written `'typst'` literal
 *   would have been the alternative and is exactly what the G2 grep gate forbids.
 *
 * The containment check is real rather than decorative: the name is plan-derived, so a plan
 * carrying `../../bin/sh` would resolve outside the toolchain mount, and the read-only bind
 * is the only thing between that and execution.
 */
export function resolveEngineBinary(argv0: string, engine: RenderEngine = 'typst'): string {
  if (typeof argv0 !== 'string' || argv0.length === 0) {
    throw new Error('RENDER_POLICY_VIOLATION: the plan carries no engine binary');
  }
  if (argv0.includes('/') || argv0.includes('\\')) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: the engine binary must be a bare name, resolved against the toolchain mount',
    );
  }
  const toolchain = engine === 'latex' ? RENDER_PATHS.latexToolchain : RENDER_PATHS.toolchain;
  const resolved = path.posix.join(toolchain, argv0);
  const prefix = `${toolchain}/`;
  if (!resolved.startsWith(prefix) || resolved.length <= prefix.length) {
    throw new Error('RENDER_POLICY_VIOLATION: the engine binary must resolve inside the toolchain mount');
  }
  return resolved;
}

/**
 * Build the `docker exec` argv for the compile: the env re-asserted per key, then `-w`, the
 * container, and `plan.argv` VERBATIM as an array.
 *
 * `plan.argv` is passed through untouched apart from `argv[0]`, which is qualified by
 * `resolveEngineBinary` (see the note there: the image has no `PATH`, and the entrypoint the
 * binary would otherwise come from is the PID-1 holder). There is no typesetter literal in
 * this directory - the broker consumes `buildCompileArgs()`'s output, which policy 13.2
 * makes the single permitted argv builder in the repository, and `broker.test.ts` greps for
 * the literals to keep that true.
 */
export function buildCompileExecArgs(plan: CompilePlan, containerId: string): string[] {
  const argv: string[] = ['exec', '-w', plan.cwd];
  for (const key of Object.keys(plan.env).sort()) {
    argv.push('--env', `${key}=${plan.env[key] as string}`);
  }
  argv.push(containerId);
  argv.push(resolveEngineBinary(plan.argv[0] as string, plan.engine));
  argv.push(...plan.argv.slice(1));
  return argv;
}

/**
 * Assert the exec argv carries EXACTLY the plan's environment.
 *
 * The second source is stronger than the first, so it is checked rather than assumed: a
 * container created before a policy change and then reused would carry a stale value, and
 * the failure mode of a stale `TYPST_ROOT` is a WIDER sandbox, not a failed render. This is
 * the fail-closed assertion that makes the re-assertion a control rather than a comment.
 */
export function assertPlanEnvOnExec(argv: readonly string[], plan: CompilePlan): void {
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--env') continue;
    const pair = argv[index + 1];
    if (pair === undefined) throw new Error('RENDER_POLICY_VIOLATION: --env requires KEY=value');
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new Error('RENDER_POLICY_VIOLATION: --env arguments must be KEY=value');
    pairs.push([pair.slice(0, eq), pair.slice(eq + 1)]);
  }
  const argvKeys = pairs.map(([key]) => key).sort();
  const planKeys = Object.keys(plan.env).sort();
  if (argvKeys.length !== planKeys.length) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: the exec environment must be exactly the plan environment',
    );
  }
  for (const key of planKeys) {
    if (argvKeys[planKeys.indexOf(key)] !== key) {
      throw new Error('RENDER_POLICY_VIOLATION: the exec environment key set must equal the plan');
    }
  }
  for (const [key, value] of Object.entries(plan.env)) {
    if (!pairs.some(([pairKey, pairValue]) => pairKey === key && pairValue === value)) {
      throw new Error(`RENDER_POLICY_VIOLATION: the exec environment is missing "${key}=${value}"`);
    }
  }
  // `plan.argv` must survive intact, which is the property that lets the broker stay
  // ignorant of the engine entirely. The only tolerated difference is `argv[0]`, which
  // `resolveEngineBinary` qualifies against the toolchain mount; the comparison below
  // therefore starts at index 1 and the first token is checked against the toolchain path.
  const tail = argv.slice(argv.length - plan.argv.length);
  const toolchain = plan.engine === 'latex' ? RENDER_PATHS.latexToolchain : RENDER_PATHS.toolchain;
  if (path.posix.dirname(tail[0] as string) !== toolchain) {
    throw new Error('RENDER_POLICY_VIOLATION: the engine binary must resolve inside the toolchain mount');
  }
  if (!argv.slice(argv.length - plan.argv.length + 1).every((token, i) => token === plan.argv[i + 1])) {
    throw new Error('RENDER_POLICY_VIOLATION: the exec argv must end with the plan argv');
  }
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

export class BrokerFrameError extends Error {
  constructor(readonly reason: 'SPEC_TOO_LARGE' | 'FRAME_TRUNCATED' | 'TREE_EXCEEDED' | 'TREE_TRUNCATED') {
    super(`RENDER_REQUEST_INVALID: ${reason}`);
    this.name = 'BrokerFrameError';
  }
}

/**
 * The framed body, read in TWO PHASES, and the second phase only runs once the job has been
 * admitted (T1040 ruling 12).
 *
 * The frame is `4-byte BE length | L bytes UTF-8 JSON | exactly treeBytes of ustar`, and the
 * reason it is read in two pieces rather than one is a memory bound, not a stylistic
 * preference: a single authenticated client may send up to `RENDER_LIMITS.inputTotalBytes`
 * (8 MiB) of tree, and a broker that read it before taking a slot would let N concurrent
 * requests each hold 8 MiB while none of them is running, queued or refused - so the
 * concurrency and queue-depth controls (policy 10.2) would bound nothing at all. `readSpec()`
 * is therefore bounded by `MAX_SPEC_BYTES` (64 KiB), admission happens on the strength of the
 * spec's `userId` alone, and only a job that HOLDS a slot reads a tree - and that read is
 * bounded by the DECLARED `treeBytes`, which the closed JobSpec schema has already capped at
 * the policy's 8 MiB, so the buffered tree can never exceed what the staging caps allow.
 *
 * The reads are bounded AS THE BYTES ARE ACCEPTED, not afterwards: a spec is cut off at the
 * cap before it is even parsed, and a tree is cut off the moment it passes its declared
 * length. An over-large frame is therefore never held in full, let alone piped into a
 * container. That is the same mid-stream property `stage.ts` insists on for its own copy
 * loop (ADR-042 D4 calls the review's mid-stream bound "not redundant ... the only thing that
 * stops bytes landing before a rejection").
 *
 * Buffering the tree rather than streaming it to `docker exec` is a deliberate trade: the
 * declared cap makes it small and bounded, and in exchange the broker can hand the exact
 * bytes over as a `Readable.from(buffer)` - no partial-write state, no backpressure bug - and
 * the staged CONTENT is available for the policy 9.4 `<content>` redaction, which a pure
 * stream could never supply.
 *
 * The two phases share ONE iterator, and each counts its OWN bytes. The first version of this
 * reader carried a single `accepted` counter across both phases and never re-based it when
 * the reader moved onto the spec, so a spec that arrived split across chunks - which any
 * chunked writer or proxy produces, and `brokerClient` avoids only by writing the whole
 * frame in one `write()` - was measured as short and refused with a false `FRAME_TRUNCATED`
 * on a perfectly well-formed request.
 */
export interface FrameReader {
  /** Read the 4-byte prefix and the JSON spec. Bounded at `MAX_SPEC_BYTES`. */
  readSpec(): Promise<{ spec: unknown; specJson: string }>;
  /**
   * Read the tree. Bounded at `declaredBytes` (and never above the policy's own
   * `inputTotalBytes`): a longer stream is refused mid-flight, a shorter one on the way out.
   */
  readTree(declaredBytes: number): Promise<Buffer>;
}

/** Build a two-phase reader over ONE source. The source is consumed exactly once. */
export function createFrameReader(source: Readable): FrameReader {
  if (source === null || typeof source !== 'object' || typeof source[Symbol.asyncIterator] !== 'function') {
    throw new BrokerFrameError('FRAME_TRUNCATED');
  }
  const iterator = source[Symbol.asyncIterator]();
  // Whatever the spec read overshot by is the first slice of the tree, so it is held here
  // rather than re-read (the source is a single-pass stream).
  let pending: Buffer = Buffer.alloc(0);
  let specRead = false;

  const nextChunk = async (): Promise<Buffer | null> => {
    const next = await iterator.next();
    if (next.done === true) return null;
    return next.value as Buffer;
  };

  /** Accumulate until at least `wanted` bytes are in hand. Null means the source ended. */
  const accumulate = async (seed: Buffer, wanted: number): Promise<Buffer | null> => {
    const parts: Buffer[] = seed.length === 0 ? [] : [seed];
    let have = seed.length;
    while (have < wanted) {
      const chunk = await nextChunk();
      if (chunk === null) {
        return have === 0 ? null : Buffer.concat(parts);
      }
      parts.push(chunk);
      have += chunk.length;
    }
    return Buffer.concat(parts);
  };

  return {
    async readSpec(): Promise<{ spec: unknown; specJson: string }> {
      if (specRead) throw new BrokerFrameError('FRAME_TRUNCATED');
      specRead = true;
      const prefix = await accumulate(Buffer.alloc(0), FRAME_PREFIX_BYTES);
      if (prefix === null || prefix.length < FRAME_PREFIX_BYTES) {
        throw new BrokerFrameError('FRAME_TRUNCATED');
      }
      const specLength = prefix.readUInt32BE(0);
      if (specLength === 0 || specLength > MAX_SPEC_BYTES) {
        throw new BrokerFrameError('SPEC_TOO_LARGE');
      }
      const specBuffer = await accumulate(prefix.subarray(FRAME_PREFIX_BYTES), specLength);
      if (specBuffer === null || specBuffer.length < specLength) {
        throw new BrokerFrameError('FRAME_TRUNCATED');
      }
      // Re-slice to EXACTLY the spec, so a chunk that overshot the frame boundary leaves the
      // remainder readable rather than silently absorbed.
      pending = specBuffer.subarray(specLength);
      const specJson = specBuffer.subarray(0, specLength).toString('utf8');
      let spec: unknown;
      try {
        spec = JSON.parse(specJson);
      } catch {
        throw new BrokerFrameError('FRAME_TRUNCATED');
      }
      return { spec, specJson };
    },

    async readTree(declaredBytes: number): Promise<Buffer> {
      if (!specRead) throw new BrokerFrameError('FRAME_TRUNCATED');
      const cap =
        Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
          ? Math.min(declaredBytes, RENDER_LIMITS.inputTotalBytes)
          : RENDER_LIMITS.inputTotalBytes;
      const seed = pending;
      pending = Buffer.alloc(0);
      const parts: Buffer[] = seed.length === 0 ? [] : [seed];
      let total = seed.length;
      if (total > cap) throw new BrokerFrameError('TREE_EXCEEDED');
      for (;;) {
        const chunk = await nextChunk();
        if (chunk === null) break;
        total += chunk.length;
        // Refuse the moment the DECLARED length is passed, so an over-sending client never
        // gets its excess buffered (policy 5.2.2, enforced before a container exists).
        if (total > cap) throw new BrokerFrameError('TREE_EXCEEDED');
        parts.push(chunk);
      }
      const tree = Buffer.concat(parts);
      // A short frame is a truncated tar. Also a protocol violation, and equally refused
      // before anything is staged.
      if (tree.length < declaredBytes) throw new BrokerFrameError('TREE_TRUNCATED');
      return tree;
    },
  };
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

export interface BrokerDeps {
  readonly docker: DockerRunner;
  readonly now: () => number;
  readonly log: (...args: unknown[]) => void;
  /** Injected so the 2 s kill grace does not have to be waited for in a test. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly spoolRoot?: string;
  readonly image?: string;
  /** The LaTeX worker image. Optional so existing single-engine deployments boot; when
   *  set, the preflight inspects it TOO, so a latex-capable broker fails at boot rather
   *  than on the first latex job. */
  readonly latexImage?: string;
  readonly token?: string;
  readonly quota?: BrokerQuota;
  /**
   * The repository root AS THE DOCKER DAEMON SEES IT, for the three policy-4.5 binds
   * (T1040 ruling 10). Required in the compose deployment - `main()` fails boot without it -
   * and defaulted here only so a unit test can construct a broker without one.
   */
  readonly hostRoot?: string;
}

export interface BrokerRenderRequest {
  /** The single token header. Anything else is ignored - not forwarded, not logged. */
  readonly token?: string | undefined;
  readonly body: Readable;
  /** Registers a client-disconnect listener. Returns a disposer. */
  readonly onAbort?: (listener: () => void) => () => void;
}

export interface BrokerRenderResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The artifact bytes on 201; a JSON `{code, reason, message}` otherwise. */
  readonly body: Buffer;
}

export interface JobLog {
  readonly event: 'render.job';
  readonly jobId: string;
  readonly outcome: BrokerResponseCode;
  readonly engine: RenderEngine;
  readonly engineVersion: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly durationMs: number;
  readonly byteSize: number;
  readonly sha256: string;
  /** Present on a non-ok outcome. Already redacted (policy 9.4). Never in the response. */
  readonly diagnostics?: string;
}

export class Broker {
  private readonly admission: AdmissionController;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly spoolRoot: string;
  private readonly image: string;
  private readonly latexImage: string | undefined;
  private readonly token: string | undefined;
  private readonly hostRoot: string;
  private closed = false;

  constructor(private readonly deps: BrokerDeps) {
    this.admission = new AdmissionController(deps.quota ?? BROKER_QUOTA);
    this.delay =
      deps.delay ??
      ((ms: number) => new Promise<void>((resolve) => {
        const handle = setTimeout(resolve, ms);
        handle.unref?.();
      }));
    this.spoolRoot = deps.spoolRoot ?? process.env.RENDER_BROKER_SPOOL_ROOT ?? SPOOL_DEFAULT_ROOT;
    this.image = deps.image ?? RENDER_WORKER_IMAGE;
    this.latexImage = deps.latexImage ?? process.env.RENDER_BROKER_LATEX_WORKER_IMAGE;
    this.token = deps.token ?? process.env.RENDER_BROKER_TOKEN;
    this.hostRoot = deps.hostRoot ?? DEFAULT_HOST_ROOT;
  }

  get quota(): AdmissionController {
    return this.admission;
  }

  /**
   * The BOOT preflight (ADR-044 D1): `docker image inspect <pin>`, and a missing image is a
   * BOOT failure - one log line and a non-zero exit - not a new outcome code.
   *
   * That is the whole reason this task needs no code in `sandbox.ts`. A render against a
   * missing image is not a per-job outcome: it is a deployment that cannot render at all,
   * and failing at boot means the operator learns before a user does, instead of learning
   * from a `RENDER_COMPILE_ERROR` whose cause is 200 lines away in a daemon log.
   */
  async preflight(): Promise<{ ok: boolean; code: number; message: string }> {
    const images = [this.image];
    if (this.latexImage !== undefined && this.latexImage.length > 0 && this.latexImage !== this.image) {
      images.push(this.latexImage);
    }
    for (const image of images) {
      const result = await this.deps.docker
        .run(['image', 'inspect', image], { timeoutMs: DOCKER_IMAGE_INSPECT_TIMEOUT_MS })
        .catch((error: unknown) => ({
          code: 125,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          signaled: false,
        }));
      if (result.code !== 0) {
        return {
          ok: false,
          code: 1,
          message: `RENDER_BROKER_PREFLIGHT_FAILED: the pinned worker image ${image} is not present`,
        };
      }
    }
    return { ok: true, code: 0, message: 'RENDER_BROKER_READY' };
  }

  /** Compare the shared secret in constant time, without leaking its length by an early
   *  return. A missing or wrong token is a 401 and NOTHING ELSE HAPPENS. */
  private authorized(presented: string | undefined): boolean {
    if (this.token === undefined || this.token.length === 0) return false;
    if (typeof presented !== 'string' || presented.length === 0) return false;
    const expected = Buffer.from(this.token, 'utf8');
    const actual = Buffer.from(presented, 'utf8');
    if (expected.length !== actual.length) {
      // Still compare, against a same-length dummy, so the timing does not depend on the
      // presented value's length.
      timingSafeEqual(expected, expected);
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  async handle(request: BrokerRenderRequest): Promise<BrokerRenderResponse> {
    // (1) AUTH. Before anything else, and before a single byte of the body is read.
    if (!this.authorized(request.token)) {
      return this.failure('RENDER_UNAUTHORIZED', 'TOKEN_MISSING_OR_WRONG', 0);
    }
    if (this.closed) {
      return this.failure('RENDER_BROKER_UNAVAILABLE', 'BROKER_SHUTDOWN', 0);
    }

    // (2) THE SPEC, and only the spec: `4-byte prefix + at most 64 KiB of JSON`. The tree is
    // NOT read here (T1040 ruling 12), which is what makes the next block a real admission
    // decision rather than a formality: without it, N concurrent authenticated requests would
    // each buffer up to 8 MiB before any of them was running, queued or refused, and the
    // policy 10.2 concurrency/queue controls would bound nothing.
    const reader = createFrameReader(request.body);
    let spec: BrokerJobSpec;
    try {
      const frame = await reader.readSpec();
      spec = parseJobSpec(frame.spec);
    } catch (error) {
      return this.frameFailure(error);
    }

    // (3) ADMISSION, on the strength of `userId` alone, BEFORE a single tree byte is
    // accepted. A full queue is a 429 with the body still unread - see the note on
    // `createFrameReader`.
    try {
      await this.admission.acquire(spec.userId);
    } catch (error) {
      if (error instanceof BrokerBusyError) {
        return this.failure('RENDER_BUSY', 'ADMISSION_QUEUE_FULL', 0);
      }
      throw error;
    }

    try {
      // The tree, now that the slot is held. Bounded by the DECLARED `treeBytes`, which the
      // closed schema has already capped at the policy's 8 MiB, so this can never buffer
      // more than the staging caps permit.
      let tree: Buffer;
      try {
        tree = await reader.readTree(spec.treeBytes);
      } catch (error) {
        return this.frameFailure(error);
      }
      return await this.runJob(spec, tree, request);
    } finally {
      // (10) Always: the slot goes back, whatever happened - including a frame error, which
      // is why this `finally` opens BEFORE the tree read rather than around `runJob`.
      this.admission.release(spec.userId);
    }
  }

  /** A frame-phase rejection: the closed reason vocabulary, never a caller value. */
  private frameFailure(error: unknown): BrokerRenderResponse {
    const reason = error instanceof JobSpecError ? error.reason : this.reasonOf(error);
    const code = error instanceof JobSpecError ? error.code : 'RENDER_REQUEST_INVALID';
    return this.failure(code, reason, 0);
  }

  private reasonOf(error: unknown): string {
    if (error instanceof BrokerFrameError) return error.reason;
    if (error instanceof SpoolOverflowError) return error.reason;
    if (error instanceof StageError) return error.reason;
    if (error instanceof Error && error.message.startsWith('RENDER_POLICY_VIOLATION')) {
      return 'POLICY_INVARIANT_VIOLATION';
    }
    return 'REQUEST_MALFORMED';
  }

  private failure(
    code: BrokerResponseCode,
    reason: string,
    durationMs: number,
  ): BrokerRenderResponse {
    return {
      status: STATUS_FOR[code],
      headers: Object.freeze({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        [BROKER_RESPONSE_HEADERS.outcome]: code,
        [BROKER_RESPONSE_HEADERS.durationMs]: String(durationMs),
      }),
      body: Buffer.from(
        JSON.stringify({ code, reason, message: OUTCOME_MESSAGES[code] }),
        'utf8',
      ),
    };
  }

  /**
   * One job, start to finish. The container's id, the spool and the diagnostics are
   * collected in locals and consumed by the `finally`, so every exit path - success,
   * compile error, timeout, abort, broker crash - runs the same cleanup.
   */
  private async runJob(
    spec: BrokerJobSpec,
    tree: Buffer,
    request: BrokerRenderRequest,
  ): Promise<BrokerRenderResponse> {
    const started = this.deps.now();
    const diagnostics: string[] = [];
    const addDiagnostic = (label: string, text: string): void => {
      if (text.length > 0) diagnostics.push(`[${label}] ${text}`);
    };
    // The staged CONTENT, read out of the tree ONCE and up front, so the per-job log line
    // can be written SYNCHRONOUSLY in the `finally`. An asynchronous log would be a race
    // with the caller's own logging, and a diagnostic that is still in flight when the
    // broker tears down is a diagnostic that never gets redacted.
    const stagedContent = await stagedTextCandidates(tree);

    // (5) The plan. `buildCompileArgs` is the ONLY argv builder, and it is also where a
    // pin mismatch is caught (RENDER_TOOLCHAIN_MISMATCH) - which is why
    // `buildContainerCreateArgs` re-checks it rather than trusting the caller.
    let plan: CompilePlan;
    let createArgs: readonly string[];
    try {
      plan = buildCompileArgs(spec.engine, {
        creationTimestampUnix: spec.creationTimestampUnix,
        format: spec.format,
        expectedEngineVersion: spec.expectedEngineVersion,
      });
      createArgs = buildContainerCreateArgs(plan, spec, this.hostRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code: BrokerResponseCode = message.startsWith('RENDER_TOOLCHAIN_MISMATCH')
        ? 'RENDER_TOOLCHAIN_MISMATCH'
        : message.startsWith('RENDER_INPUT_INVALID')
          ? 'RENDER_REQUEST_INVALID'
          : 'RENDER_BROKER_UNAVAILABLE';
      this.deps.log({ event: 'render.job', jobId: spec.jobId, outcome: code, reason: 'PLAN_REFUSED' });
      return this.failure(code, 'PLAN_REFUSED', this.elapsed(started));
    }

    let containerId: string | null = null;
    let spool: Spool | null = null;
    let capture: Writable | null = null;
    let disposeAbort: (() => void) | undefined;
    let aborted = false;
    // A disconnect has to be able to WIN the race against the wall clock, not merely be
    // noticed after it, so it is a promise the race can select on rather than a flag read
    // once the compile has already settled.
    const abortSignal = createDeferred();
    let artifact: Buffer | null = null;
    let outcome: BrokerResponseCode = 'RENDER_BROKER_UNAVAILABLE';
    let artifactDigest = '';
    let artifactSize = 0;

    try {
      spool = await createSpool(this.spoolRoot);

      // (5) CREATE. A non-zero create is a BROKER/host fault (the image is missing, the
      // daemon is down), not a render outcome, so it is a 503 - the boot preflight is what
      // turns the common cause into a boot failure instead.
      const created = await this.deps.docker.run(['create', ...createArgs], {
        timeoutMs: DEFAULT_ADMIN_TIMEOUT_MS,
      });
      addDiagnostic('create', `${created.stderr}${created.stdout}`);
      if (created.code !== 0) {
        outcome = 'RENDER_BROKER_UNAVAILABLE';
        return this.failure(outcome, 'CONTAINER_CREATE_FAILED', this.elapsed(started));
      }
      containerId = created.stdout.trim().split(/\s+/)[0] ?? '';
      if (containerId.length === 0) {
        outcome = 'RENDER_BROKER_UNAVAILABLE';
        return this.failure(outcome, 'CONTAINER_CREATE_FAILED', this.elapsed(started));
      }

      const startResult = await this.deps.docker.run(['start', containerId], {
        timeoutMs: DEFAULT_ADMIN_TIMEOUT_MS,
      });
      addDiagnostic('start', startResult.stderr);
      if (startResult.code !== 0) {
        outcome = 'RENDER_BROKER_UNAVAILABLE';
        return this.failure(outcome, 'CONTAINER_START_FAILED', this.elapsed(started));
      }

      disposeAbort = request.onAbort?.(() => {
        aborted = true;
        abortSignal.resolve();
      });

      // (6) STAGE. `docker exec -i <c> tar -x -C /work` with the tree on stdin. There is no
      // host path: `/work` is a tmpfs and the bytes travel through the exec pipe (ADR-042
      // D4), so nothing an attacker-influenced write produces can reach host disk.
      // `maxStdinBytes` is the frame bound restated at the pipe: the broker has already
      // refused an over-declared frame, and this is what refuses an over-SENT one.
      const staged = await this.deps.docker.run(
        ['exec', '-i', containerId, 'tar', '-x', '-C', plan.cwd],
        {
          stdin: Readable.from(tree),
          maxStdinBytes: spec.treeBytes,
          timeoutMs: DEFAULT_ADMIN_TIMEOUT_MS,
        },
      );
      addDiagnostic('stage', staged.stderr);
      if (staged.code !== 0) {
        // A staging failure is an INPUT failure, not a compile failure: the tree never
        // reached the engine, so there is no Typst diagnostic to go looking for. The kill
        // path runs anyway, because a half-extracted `/work` is a state no next job may
        // inherit.
        await this.killContainer(containerId);
        outcome = 'RENDER_INPUT_TOO_LARGE';
        return this.failure(outcome, 'STAGING_FAILED', this.elapsed(started));
      }

      // (8) COMPILE, under the wall budget AND against a client disconnect, with the env
      // re-asserted per key. The abort is a THIRD arm of the race, not a flag polled after
      // it: a client that walks away mid-compile must reach the kill path now, not when the
      // compile happens to exit or the 10 s budget expires.
      const execArgs = buildCompileExecArgs(plan, containerId);
      assertPlanEnvOnExec(execArgs, plan);
      const compile = await this.raceWallClock(
        this.deps.docker.run(execArgs, {
          timeoutMs: plan.timeoutMs + plan.killGraceMs + DEFAULT_ADMIN_TIMEOUT_MS,
        }),
        plan.timeoutMs,
        abortSignal.promise,
      );
      addDiagnostic('compile.stdout', compile.stdout);
      addDiagnostic('compile.stderr', compile.stderr);

      if (compile.timedOut || compile.aborted || aborted) {
        // (9) KILL: TERM, the policy grace, KILL. The ORDER is the contract, and it is
        // asserted on the injected runner in `broker.test.ts`.
        await this.killContainer(containerId);
        outcome = 'RENDER_TIMEOUT';
        return this.failure(
          outcome,
          compile.aborted || aborted ? 'CLIENT_DISCONNECTED' : 'WALL_CLOCK_EXCEEDED',
          this.elapsed(started),
        );
      }

      const classified = classifyCompileExit(compile.code, compile.stdout, compile.stderr);
      if (classified !== 'ok') {
        // A failed compile may have wedged the container (a runaway child, a stuck mount),
        // so the SAME kill path runs before the response. `/out` is discarded on every
        // non-ok outcome (policy 6.1): there is no partial artifact.
        await this.killContainer(containerId);
        outcome = classified;
        return this.failure(outcome, 'COMPILE_NOT_OK', this.elapsed(started));
      }

      // (8b) LATEX SIDECARS. pdflatex always writes a log and, with `-recorder`, a `.fls`;
      // a document with an `.aux` writes that too. Those are ENGINE byproducts, not the
      // artifact, and `/out` must contain exactly one entry for policy 6.3's check to
      // mean anything. They are removed by FIXED basename (no caller content, no glob),
      // and the extraction still tars `.` so an UNEXPECTED fourth file remains visible
      // to `validateRenderArtifact` rather than being silently ignored.
      if (plan.engine === 'latex') {
        const cleanup = await this.deps.docker.run(
          ['exec', containerId, 'rm', '-f', ...LATEX_SIDECAR_PATHS],
          { timeoutMs: DEFAULT_ADMIN_TIMEOUT_MS },
        );
        addDiagnostic('cleanup', cleanup.stderr);
        if (cleanup.code !== 0) {
          await this.killContainer(containerId);
          outcome = 'RENDER_ARTIFACT_INVALID';
          return this.failure(outcome, 'LATEX_SIDECAR_CLEANUP_FAILED', this.elapsed(started));
        }
      }

      // (10) EXTRACT. `tar -c -C /out .` into the bounded private spool. The capture sink
      // fails the job at the moment the byte count passes the cap, so the excess never
      // reaches the host file.
      const sink = spool.openCapture();
      capture = sink;
      // THE ERROR LISTENER, attached BEFORE the child starts, and it is load-bearing rather
      // than defensive. `dockerRunner` writes the child's stdout from an I/O 'data' callback
      // while `run` is still PENDING, so a `SpoolOverflowError` is emitted long before the
      // `await` that eventually reaches `waitForSink`. Three consequences, and only the
      // first two are obvious:
      //   1. with nothing listening, a Node `Writable` that emits 'error' takes the PROCESS
      //      down - so a spool over its bound would crash the broker instead of returning
      //      `RENDER_ARTIFACT_INVALID`, and acceptance bullet A4 would hold only against the
      //      synchronous test fake;
      //   2. `waitForSink` attaches its `once('error')` too LATE to see it, so without a
      //      recorded error the broker would go on to read a TRUNCATED archive and report
      //      some other artifact failure - the wrong reason for the right code;
      //   3. the error has to be REMEMBERED, not merely absorbed, which is what
      //      `waitForSink`'s own listener would have done had it been there in time.
      // `on`, not `once`: a write overflow and the subsequent `final` can raise twice, and the
      // second one must be observed too. The holder is an OBJECT because a bare `let` would
      // be narrowed to `never` by control-flow analysis that cannot see the assignment.
      const sinkFailure: { error: Error | null } = { error: null };
      sink.on('error', (error: unknown) => {
        if (sinkFailure.error === null) {
          sinkFailure.error = error instanceof Error ? error : new Error(String(error));
        }
      });
      let extractCode = 0;
      let extractStderr = '';
      try {
        const extracted = await this.deps.docker.run(
          ['exec', containerId, 'tar', '-c', '-C', '/out', '.'],
          { stdoutTo: sink, timeoutMs: DEFAULT_ADMIN_TIMEOUT_MS },
        );
        extractCode = extracted.code;
        extractStderr = extracted.stderr;
        // The capture is a FILE, so the child's stdout arriving is not the same event as
        // the bytes landing on disk. Ending (if the producer did not) and then WAITING is
        // what makes the read-back below see a complete archive. `end()` is skipped on a
        // sink the bound has already destroyed: `end()` on a destroyed stream sets no state
        // and emits nothing, so `waitForSink` would then wait for events that have already
        // been and gone.
        if (!sink.writableEnded && !sink.destroyed) sink.end();
        await waitForSink(sink);
      } catch (error) {
        // The sink raised: the spool is over its bound. `validateRenderArtifact` never
        // runs, and the outcome is policy 6.2/6.3's `RENDER_ARTIFACT_INVALID`.
        sink.destroy();
        capture = null;
        addDiagnostic('extract.sink', error instanceof Error ? error.message : String(error));
        outcome = 'RENDER_ARTIFACT_INVALID';
        return this.failure(outcome, 'SPOOL_BOUND_EXCEEDED', this.elapsed(started));
      }
      // The error that landed while the child was still running - the real transport's
      // ordering, and the one the fake cannot produce. Same outcome, same reason: the broker
      // was handed more than the policy allows, which is what `SPOOL_BOUND_EXCEEDED` says.
      if (sinkFailure.error !== null) {
        capture = null;
        addDiagnostic('extract.sink', sinkFailure.error.message);
        outcome = 'RENDER_ARTIFACT_INVALID';
        return this.failure(outcome, 'SPOOL_BOUND_EXCEEDED', this.elapsed(started));
      }
      capture = null;
      addDiagnostic('extract', extractStderr);
      if (extractCode !== 0) {
        outcome = 'RENDER_ARTIFACT_INVALID';
        return this.failure(outcome, 'EXTRACTION_FAILED', this.elapsed(started));
      }

      // The bounded ustar reader, then policy 6.3's six checks, UNCHANGED (T1013).
      // `Readable.from([buffer])`, not `Readable.from(buffer)`: the single-argument form
      // iterates a Buffer BYTE BY BYTE, which is correct but allocates one chunk per byte
      // of a 20 MiB cap.
      const archive = await readFileBounded(spool.archivePath);
      const extracted = await extractUstarToDir(Readable.from([archive]), spool.outDir);
      diagnostics.push(
        `[extract] ${extracted.fileCount} file(s), ${extracted.totalBytes} byte(s)`,
      );

      const validated = await validateRenderArtifact({ outDir: spool.outDir, format: plan.format });
      const bytes = await readFileBounded(validated.path);
      if (bytes.length !== validated.byteSize) {
        outcome = 'RENDER_ARTIFACT_INVALID';
        return this.failure(outcome, 'ARTIFACT_SIZE_CHANGED', this.elapsed(started));
      }

      artifact = bytes;
      artifactDigest = validated.sha256;
      artifactSize = validated.byteSize;
      outcome = 'ok';
      return {
        status: STATUS_FOR.ok,
        headers: Object.freeze({
          'content-type': validated.mimeType,
          'cache-control': 'no-store',
          [BROKER_RESPONSE_HEADERS.outcome]: 'ok',
          [BROKER_RESPONSE_HEADERS.sha256]: validated.sha256,
          [BROKER_RESPONSE_HEADERS.bytes]: String(validated.byteSize),
          [BROKER_RESPONSE_HEADERS.mime]: validated.mimeType,
          [BROKER_RESPONSE_HEADERS.durationMs]: String(this.elapsed(started)),
        }),
        body: bytes,
      };
    } catch (error) {
      // A fault that escaped the per-step handling is classified by the CODE the thrower
      // stamped, not by its reason string: `stage.ts` and `spool.ts` both use a closed code
      // set, and a StageError carrying `RENDER_ARTIFACT_INVALID` must land on
      // `RENDER_ARTIFACT_INVALID` whatever its reason was - matching on reasons would make
      // every new reason a silent misclassification.
      const code = classifyBrokerFault(error);
      const reason = this.reasonOf(error);
      if (containerId !== null) {
        await this.killContainer(containerId).catch(() => undefined);
      }
      addDiagnostic('broker', error instanceof Error ? error.message : String(error));
      return this.failure(code, reason, this.elapsed(started));
    } finally {
      // (10) THE FINALLY. Order is deliberate and asserted: the container goes first (so a
      // wedged compile cannot out-live the response), then the spool (the only host bytes
      // this task creates), then the diagnostics are redacted and logged. The slot is
      // released by the CALLER's finally, one level up, so it is released even if this
      // cleanup itself throws.
      disposeAbort?.();
      // The capture is destroyed on EVERY path, not only the one that awaited it: a job that
      // threw between `openCapture()` and `waitForSink()` would otherwise leave a live
      // descriptor on a file the `dispose()` below is about to delete, and - on a platform
      // that locks open files - a failing delete. `destroy()` on an already-finished sink is
      // a no-op, and the error listener attached above means it cannot raise unobserved.
      if (capture !== null) {
        capture.destroy();
        capture = null;
      }
      if (containerId !== null) {
        await this.deps.docker
          .run(['rm', '-f', containerId], { timeoutMs: DEFAULT_ADMIN_TIMEOUT_MS })
          .catch(() => undefined);
      }
      if (spool !== null) {
        await spool.dispose();
      }
      this.logJob(spec, outcome, started, artifactSize, artifactDigest, diagnostics, stagedContent);
    }
  }

  /** TERM, the policy grace, KILL. Never `rm` - the `finally` owns that, so the
   *  TERM -> grace -> KILL -> rm ORDER is a property of the call site and is observable on
   *  the injected runner. */
  private async killContainer(containerId: string): Promise<void> {
    await this.deps.docker
      .run(['kill', '-s', 'TERM', containerId], { timeoutMs: DEFAULT_ADMIN_TIMEOUT_MS })
      .catch(() => undefined);
    await this.delay(RENDER_LIMITS.killGraceMs);
    await this.deps.docker
      .run(['kill', '-s', 'KILL', containerId], { timeoutMs: DEFAULT_ADMIN_TIMEOUT_MS })
      .catch(() => undefined);
  }

  /**
   * Race the compile against the wall budget AND against a client disconnect.
   *
   * The timer lives HERE rather than inside the runner so the kill sequence is visible to
   * the caller's finally: if the runner owned the deadline, the TERM/grace/KILL calls would
   * be the runner's business and a test could only see one opaque "it timed out".
   *
   * The abort is the third arm, and it is the reason the disconnect is PROMPT. Reading an
   * `aborted` flag after the race settles still ends at the same kill path, but only once the
   * compile exits or the whole 10 s budget expires - which is a 10-second wait on a container
   * nobody is waiting for any more. Racing it means the disconnect arm wins the moment it
   * fires, under the injected runner as much as on the real transport.
   */
  private async raceWallClock(
    work: Promise<{ code: number; stdout: string; stderr: string }>,
    timeoutMs: number,
    abort?: Promise<void>,
  ): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
  }> {
    const arms: Array<Promise<{ kind: 'done' | 'timeout' | 'aborted' }>> = [
      work.then(() => ({ kind: 'done' as const })),
      this.delay(timeoutMs).then(() => ({ kind: 'timeout' as const })),
    ];
    if (abort !== undefined) {
      arms.push(abort.then(() => ({ kind: 'aborted' as const })));
    }
    const outcome = await Promise.race(arms);
    if (outcome.kind === 'done') {
      const result = await work;
      return { ...result, timedOut: false, aborted: false };
    }
    // The compile is still in flight; the TERM/KILL that follows stops it. The promise is
    // observed so an unhandled rejection can never become an unhandled crash in a long-
    // lived broker process.
    void work.catch(() => undefined);
    return { code: 0, stdout: '', stderr: '', timedOut: true, aborted: outcome.kind === 'aborted' };
  }

  private elapsed(started: number): number {
    return Math.max(0, this.deps.now() - started);
  }

  /**
   * The per-job log line (policy 9.2's "all non-ok outcomes go to the log" and 10.5's
   * per-job record), with the diagnostics redacted by policy 9.4 and truncated to 64 KiB.
   *
   * This is the ONLY place a diagnostic exists, and the return value of `handle()` is
   * built without reference to `diagnostics` - which is what makes "the response carries no
   * diagnostics" a structural fact rather than a review commitment. The staged content is
   * passed in as a redaction CANDIDATE, so a template that echoes its own input into a
   * diagnostic cannot put a user's resume text into the log.
   */
  private logJob(
    spec: BrokerJobSpec,
    outcome: BrokerResponseCode,
    started: number,
    byteSize: number,
    sha256: string,
    diagnostics: readonly string[],
    stagedContent: readonly string[],
  ): void {
    const redacted =
      outcome === 'ok'
        ? undefined
        : redactDiagnostics(diagnostics.join('\n'), { stagedContent });
    const record: JobLog = {
      event: 'render.job',
      jobId: spec.jobId,
      outcome,
      engine: spec.engine,
      engineVersion: spec.expectedEngineVersion,
      templateId: spec.templateId,
      templateVersion: spec.templateVersion,
      durationMs: this.elapsed(started),
      byteSize,
      sha256,
      ...(redacted === undefined ? {} : { diagnostics: redacted.slice(0, REDACT_MAX_BYTES) }),
    };
    this.deps.log(record);
  }

  /** Refuse queued work and mark the broker closed. The HTTP server is stopped by the
   *  caller, which owns the socket. */
  close(): void {
    this.closed = true;
    this.admission.drain();
  }
}

/** Read a spool file, bounded. A file that grew past the cap is a policy failure, not a
 *  buffer. */
async function readFileBounded(file: string): Promise<Buffer> {
  const bytes = await readFile(file);
  if (bytes.length > RENDER_LIMITS.outputBytes) {
    throw new SpoolOverflowError(RENDER_LIMITS.outputBytes);
  }
  return bytes;
}

/**
 * A one-shot signal that RESOLVES, and never rejects.
 *
 * It is on the disconnect path of a long-lived broker, and a rejected promise there would be
 * a second unhandled-rejection surface in exactly the code that exists to eliminate them. A
 * disconnect is a fact, not a failure: the race selects on it and the kill path runs, which
 * is the whole contract. The `resolve` is latched so a second `'aborted'` event (a client
 * that closes twice) is a no-op rather than a second state change.
 */
function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let fire: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { promise, resolve: () => fire() };
}

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

export interface BrokerServer {
  readonly server: Server;
  readonly broker: Broker;
  /** Bound address, for the boot log. A unix socket reports its path. */
  address(): { path?: string; port?: number } | string | null;
  close(): Promise<void>;
}

export interface BrokerListenOptions {
  /** A unix socket path. Preferred; the volume is `/run/clearance-render`. */
  readonly socketPath?: string;
  /** The TCP dev fallback. Loopback only - a broker on a routable address is not a
   *  fallback, it is an exposure. */
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly spoolRoot?: string;
  readonly image?: string;
  readonly latexImage?: string;
  readonly quota?: BrokerQuota;
  /** The repository root the docker daemon resolves bind sources against. */
  readonly hostRoot?: string;
  readonly log?: (...args: unknown[]) => void;
  readonly docker?: DockerRunner;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
}

/**
 * Create the HTTP server. Kept separate from `createBroker` so the whole job pipeline is
 * reachable with a fake runner and no socket at all - which is how the admission
 * arithmetic, the kill order and the redaction are proven without Docker.
 */
export function createBrokerServer(options: BrokerListenOptions): BrokerServer {
  const broker = new Broker({
    docker: options.docker ?? createDockerCliRunner(),
    now: options.now ?? (() => Date.now()),
    log: options.log ?? ((...args: unknown[]) => console.error(...args)),
    ...(options.delay === undefined ? {} : { delay: options.delay }),
    ...(options.spoolRoot === undefined ? {} : { spoolRoot: options.spoolRoot }),
    ...(options.image === undefined ? {} : { image: options.image }),
    ...(options.latexImage === undefined ? {} : { latexImage: options.latexImage }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.quota === undefined ? {} : { quota: options.quota }),
    ...(options.hostRoot === undefined ? {} : { hostRoot: options.hostRoot }),
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void respond(broker, req, res);
  });
  // No header timeout games: the wall budget belongs to the job, and the transport must not
  // impose a second, conflicting one.
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;

  return {
    server,
    broker,
    address(): { path?: string; port?: number } | string | null {
      // Node returns the socket PATH as a plain string for a unix-socket listener, and an
      // `AddressInfo` for a TCP one. There is no third shape, and the union is the honest
      // type - `Server.address()` is declared `string | AddressInfo | null`.
      const bound = server.address();
      if (bound === null || typeof bound === 'string') return bound;
      return { port: bound.port };
    },
    async close(): Promise<void> {
      broker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function respond(
  broker: Broker,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST' || (req.url ?? '') !== BROKER_RENDER_PATH) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        code: 'RENDER_REQUEST_INVALID',
        reason: 'UNKNOWN_ROUTE',
        message: OUTCOME_MESSAGES.RENDER_REQUEST_INVALID,
      }),
    );
    return;
  }
  const header = req.headers[BROKER_TOKEN_HEADER];
  const token = Array.isArray(header) ? header[0] : header;
  let response: BrokerRenderResponse;
  try {
    response = await broker.handle({
      token,
      body: req,
      onAbort: (listener) => {
        req.once('aborted', listener);
        res.once('close', () => {
          if (!res.writableFinished) listener();
        });
        return () => {
          req.removeListener('aborted', listener);
        };
      },
    });
  } catch (error) {
    response = {
      status: 503,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(
        JSON.stringify({
          code: 'RENDER_BROKER_UNAVAILABLE',
          reason: 'BROKER_CRASHED',
          message: OUTCOME_MESSAGES.RENDER_BROKER_UNAVAILABLE,
        }),
        'utf8',
      ),
    };
    void error;
  }
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(response.status, { ...response.headers });
  res.end(response.body);
}

// ---------------------------------------------------------------------------
// The socket path - a stale socket is reclaimed, anything else is refused
// ---------------------------------------------------------------------------

/**
 * Why a socket path was refused. CLOSED, because it is a boot-time operator diagnosis and a
 * free-text reason here would be a place where an unexpected path shape could reach a log.
 */
export const SOCKET_PATH_REFUSAL_REASONS = Object.freeze([
  'NOT_A_SOCKET',
  'UNLINK_FAILED',
] as const);

export type SocketPathRefusalReason = (typeof SOCKET_PATH_REFUSAL_REASONS)[number];

/**
 * The ONE filesystem fact the decision turns on.
 *
 * Narrower than `fs.Stats` on purpose: the socket-path decision is a security decision
 * (`is this entry something I may destroy?`), and a port that exposes only the question being
 * asked cannot be widened later without a reviewer noticing. `isSocket()` alone is enough,
 * because a non-socket is refused whatever it actually is.
 */
export interface SocketPathStat {
  isSocket(): boolean;
}

/**
 * The two filesystem operations the socket path needs, as a PORT.
 *
 * This exists for the same reason `DockerRunner` does: the transport decision has to be
 * provable with no daemon, no network and no privileged filesystem. One thing it buys that
 * the docker port could not - a real `AF_UNIX` socket inode cannot be CREATED on Windows at
 * all (`net.Server.listen(path)` there binds a NAMED PIPE and a filesystem path is rejected
 * with `EACCES`), so on a Windows dev box the stale-socket branch is only reachable by
 * injecting the stat and planting a real file for the real `unlink` to remove. On Linux the
 * same branch is additionally exercised against a real socket inode, end to end.
 */
export interface SocketPathFs {
  lstat(target: string): Promise<SocketPathStat>;
  unlink(target: string): Promise<void>;
}

/** The real filesystem, through the same narrow port. */
export const NODE_SOCKET_PATH_FS: SocketPathFs = {
  lstat: (target) => lstat(target),
  unlink: (target) => unlink(target),
};

/**
 * A boot failure, not a render outcome: the transport could not be prepared, so there is no
 * job to classify and nothing to report to a client. `main()` turns this into ONE log line
 * and a non-zero exit, which is the same shape the preflight and the two configuration
 * requirements already use.
 */
export class SocketPathError extends Error {
  constructor(
    readonly socketPath: string,
    readonly reason: SocketPathRefusalReason,
    detail: string,
  ) {
    super(`RENDER_BROKER_SOCKET_PATH: ${detail}`);
    this.name = 'SocketPathError';
  }
}

/** What the caller does with the socket path once it is clean. */
export type SocketPathPreparation =
  | { readonly kind: 'absent' }
  | { readonly kind: 'stale-removed' };

/**
 * Prepare the configured unix-socket path BEFORE listening, and fail closed on anything the
 * broker cannot prove it owns.
 *
 * THE DEFECT THIS EXISTS FOR, observed live: a broker killed without running its shutdown
 * handler (docker kill, an OOM kill, a host power loss) leaves `/run/clearance-render/
 * broker.sock` behind, because that path is a DIRECTORY VOLUME shared with the backend, so
 * the inode outlives the process that made it. Every later boot then died with
 * `EADDRINUSE`, the container restart-looped, and the whole render path stayed down until an
 * operator deleted the file by hand. The failure was invisible from inside the broker - it
 * looked like "docker is wedged" - and it was not self-healing.
 *
 * THE THREE CASES, and why the third one refuses rather than removes:
 *   1. `ENOENT` -> the normal first boot. Nothing to do.
 *   2. `lstat` says SOCKET -> we have not bound yet, so nobody is serving this path and the
 *      only thing that can be there is a leftover. Unlink it, say so in ONE line that names
 *      the path, and bind. This is the reclaim that turns the wedge into a normal boot.
 *   3. `lstat` says anything else (regular file, directory, symlink) -> REFUSE, one line,
 *      non-zero exit, and the path is left untouched. Removing an unexpected path is how a
 *      typo'd `RENDER_BROKER_SOCKET` deletes a real file, and `lstat` (not `stat`) is what
 *      keeps a symlink from being followed INTO something else first. A refusal is also the
 *      honest answer for a socket that some OTHER live broker is holding: two brokers on one
 *      volume is a deployment fault, and the operator needs to see it, not have it papered
 *      over.
 *
 * `lstat` rather than `stat` is the load-bearing detail. `stat` follows a symlink, so a
 * symlink at the path would report whatever its TARGET is - a socket at the far end would be
 * unlinked at the near end (destroying the link, not the socket, and leaving the live one
 * bound) and a regular file would be unlinked on its behalf. `lstat` describes the directory
 * ENTRY, which is the thing we are about to remove.
 */
export async function prepareSocketPath(
  socketPath: string,
  fs: SocketPathFs = NODE_SOCKET_PATH_FS,
): Promise<SocketPathPreparation> {
  let stats: SocketPathStat;
  try {
    stats = await fs.lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    // A path we cannot even stat (a permission error on the parent directory, for instance)
    // is a path we cannot prove we own, so it is treated exactly like case 3.
    throw new SocketPathError(
      socketPath,
      'NOT_A_SOCKET',
      `the socket path ${socketPath} could not be inspected (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}); refusing to remove a path this broker cannot verify`,
    );
  }

  if (!stats.isSocket()) {
    throw new SocketPathError(
      socketPath,
      'NOT_A_SOCKET',
      `the socket path ${socketPath} exists and is not a unix socket; refusing to remove it (a stale socket is removed automatically, so this is a real file, a directory or a symlink)`,
    );
  }

  try {
    await fs.unlink(socketPath);
  } catch (error) {
    throw new SocketPathError(
      socketPath,
      'UNLINK_FAILED',
      `a stale socket was found at ${socketPath} but could not be removed (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}); remove it by hand and restart`,
    );
  }
  return { kind: 'stale-removed' };
}

/**
 * Release the socket path on shutdown, best effort.
 *
 * NOT THE SAME FUNCTION AS `prepareSocketPath`, deliberately, and the difference is the whole
 * point of the split: `prepareSocketPath` may only remove a path it has PROVEN is a socket,
 * because it runs before this broker has bound anything. Here the socket IS ours - it was
 * bound by this process and the server has just closed - so the path is removed
 * unconditionally and a failure is logged rather than raised. The common case therefore
 * leaves nothing behind, which is what keeps the next boot in case 1 instead of case 2.
 *
 * Best effort means best effort: an unlink that fails here (the volume already went away, a
 * read-only remount, a Windows named pipe, which is not a file at all) is a log line, never a
 * throw, because the alternative is a crash on the way out of a clean shutdown.
 */
export async function releaseSocketPath(
  socketPath: string | undefined,
  log: (...args: unknown[]) => void,
  fs: SocketPathFs = NODE_SOCKET_PATH_FS,
): Promise<void> {
  if (socketPath === undefined || socketPath.length === 0) return;
  try {
    await fs.unlink(socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // `ENOENT` is not a failure: something else already removed it, which is the state we
    // were trying to reach.
    if (code === 'ENOENT') return;
    log('RENDER_BROKER_SOCKET_RELEASE', `could not unlink ${socketPath} (${code ?? 'unknown error'})`);
  }
}

// ---------------------------------------------------------------------------
// The entry point (`node dist/render/broker/index.js` in the broker container)
// ---------------------------------------------------------------------------

export const BROKER_ENV_KEYS = Object.freeze({
  socket: 'RENDER_BROKER_SOCKET',
  url: 'RENDER_BROKER_URL',
  token: 'RENDER_BROKER_TOKEN',
  spoolRoot: 'RENDER_BROKER_SPOOL_ROOT',
  image: 'RENDER_BROKER_WORKER_IMAGE',
  latexImage: 'RENDER_BROKER_LATEX_WORKER_IMAGE',
  dockerBin: 'RENDER_DOCKER_BIN',
  hostRoot: 'RENDER_HOST_TYPST_ROOT',
});

/**
 * `main()` - only runs when this file is the process entry point, so importing the broker
 * from a test never starts a server.
 *
 * The boot sequence is fixed: config, preflight, then listen. A missing worker image is a
 * non-zero exit with ONE log line, and the socket is never created, so a backend that
 * starts anyway gets a connection error rather than a job that fails after admission.
 *
 * FOURTH BOOT REQUIREMENT, and the only one about the TRANSPORT rather than the job: the
 * configured unix-socket path is claimed with `prepareSocketPath` immediately before the
 * bind, so a socket left in the shared volume by an unclean stop is reclaimed automatically
 * instead of wedging every later boot with EADDRINUSE, and a path that is NOT a socket is
 * refused (one line, exit 1, the path untouched) rather than deleted. The shutdown handler
 * then releases the path it bound, so the common case leaves nothing behind.
 *
 * THREE configuration keys are BOOT requirements, not defaults, and all three fail the same
 * way (one line, exit 1) for the same reason: a broker that starts without one of them
 * cannot do its job, and a job-shaped failure for a deployment fault sends the triage after
 * the wrong cause.
 *   - `RENDER_BROKER_TOKEN`: an unauthenticated render broker is a public RCE queue.
 *   - `RENDER_HOST_TYPST_ROOT`: the repository root the DOCKER DAEMON resolves the three
 *     policy-4.5 binds against (T1040 ruling 10). There is deliberately no default and no
 *     relative fallback: a relative bind source is expanded by the CLI against the CLI's own
 *     CWD, which inside this container is `/app` and holds no repository, so a "helpful"
 *     default here is precisely the defect this key was added to remove. The compose service
 *     sets it (see `docker-compose.yml`); on a Linux host it is the checkout path, and on
 *     Docker Desktop it is the VM's own mount of the host filesystem.
 *
 * ONE broker is built, and it is the one that serves. The preflight used to run against a
 * second, throwaway `Broker` with its own docker runner - two objects that could disagree
 * about configuration, and the one that mattered was not the one that had been checked.
 *
 * The socket path is claimed BEFORE the preflight, which is both the cheaper order and the
 * only one a test can reach without a daemon: the reclaim is a single `lstat`, and a REFUSED
 * path is therefore reported as exactly one line on a host that has no Docker at all - which
 * is the situation an operator is in when the path is wrong. Nothing is bound until the
 * preflight has passed, so an image that is missing still leaves no socket behind.
 */
export interface MainOverrides {
  readonly docker?: DockerRunner;
  readonly now?: () => number;
  readonly log?: (...args: unknown[]) => void;
  /** The socket-path port. Real by default; injected so the boot wiring is provable on a
   *  host that cannot create a unix socket inode at all. */
  readonly socketPathFs?: SocketPathFs;
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  overrides: MainOverrides = {},
): Promise<number> {
  const log =
    overrides.log ??
    ((...args: unknown[]): void => {
      console.error('[render-broker]', ...args);
    });
  const token = env[BROKER_ENV_KEYS.token];
  if (token === undefined || token.length === 0) {
    log('RENDER_BROKER_CONFIG: RENDER_BROKER_TOKEN is required and was not set');
    return 1;
  }
  const hostRoot = env[BROKER_ENV_KEYS.hostRoot];
  if (hostRoot === undefined || hostRoot.length === 0) {
    log('RENDER_BROKER_CONFIG: RENDER_HOST_TYPST_ROOT is required and was not set');
    return 1;
  }

  const socketPath = env[BROKER_ENV_KEYS.socket];
  const url = env[BROKER_ENV_KEYS.url];
  let boundSocketPath: string | undefined;
  if (socketPath !== undefined && socketPath.length > 0) {
    // The path is reclaimed BEFORE the bind, and the reclaim REFUSES anything it cannot
    // prove is a leftover socket: an unclean stop leaves the inode in the shared volume, and
    // without this every later boot died with EADDRINUSE and the render path stayed down
    // until an operator deleted the file by hand. A refusal is one line and a non-zero exit.
    try {
      const prepared = await prepareSocketPath(
        socketPath,
        overrides.socketPathFs ?? NODE_SOCKET_PATH_FS,
      );
      if (prepared.kind === 'stale-removed') {
        log('RENDER_BROKER_SOCKET_RECLAIMED', `removed the stale socket at ${socketPath}`);
      }
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  const image = env[BROKER_ENV_KEYS.image];
  const latexImage = env[BROKER_ENV_KEYS.latexImage];
  const server = createBrokerServer({
    token,
    hostRoot,
    log,
    ...(image === undefined ? {} : { image }),
    ...(latexImage === undefined ? {} : { latexImage }),
    ...(env[BROKER_ENV_KEYS.spoolRoot] === undefined
      ? {}
      : { spoolRoot: env[BROKER_ENV_KEYS.spoolRoot] }),
    docker:
      overrides.docker ??
      createDockerCliRunner(
        env[BROKER_ENV_KEYS.dockerBin] === undefined
          ? {}
          : { binary: env[BROKER_ENV_KEYS.dockerBin] as string },
      ),
    now: overrides.now ?? (() => Date.now()),
  });

  const preflight = await server.broker.preflight();
  if (!preflight.ok) {
    log(preflight.message);
    return preflight.code;
  }

  if (socketPath !== undefined && socketPath.length > 0) {
    await new Promise<void>((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(socketPath, () => {
        server.server.removeListener('error', reject);
        resolve();
      });
    });
    boundSocketPath = socketPath;
    log('RENDER_BROKER_READY', `listening on ${socketPath}`);
  } else if (url !== undefined && url.length > 0) {
    // The dev fallback. Loopback only, enforced rather than documented.
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1') {
      log('RENDER_BROKER_CONFIG: the TCP fallback may only bind loopback');
      return 1;
    }
    await new Promise<void>((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(Number(parsed.port || 80), parsed.hostname, () => {
        server.server.removeListener('error', reject);
        resolve();
      });
    });
    log('RENDER_BROKER_READY', `listening on ${url}`);
  } else {
    log(`RENDER_BROKER_CONFIG: set ${BROKER_ENV_KEYS.socket} or ${BROKER_ENV_KEYS.url}`);
    return 1;
  }

  // The socket is unlinked AFTER the listener has closed, so nothing can be connected to a
  // path that no longer has a server behind it, and `releaseSocketPath` is best effort: a
  // failed unlink must not turn a clean shutdown into a non-zero exit.
  const shutdown = (): void => {
    void server
      .close()
      .then(() =>
        releaseSocketPath(boundSocketPath, log, overrides.socketPathFs ?? NODE_SOCKET_PATH_FS),
      )
      .then(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return 0;
}

// `require.main === module` rather than a static branch, so the module stays importable
// under ESM, CommonJS and vitest alike. `void` the result: `main` resolves once listening.
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main().then((code) => {
    if (code !== 0) process.exit(code);
  });
}

export type { BrokerJobSpec } from './createArgs.js';
export { RENDER_WORKER_IMAGE, buildContainerCreateArgs } from './createArgs.js';
