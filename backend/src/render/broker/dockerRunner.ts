// The ONLY module in the repository that touches the Docker CLI.
//
// NORMATIVE DOC: .planning/decisions/ADR-042-*.md D2 (the backend must never shell out to
//                Docker; a broker process owns the socket)
//                .planning/specs/clearance-v2/render-sandbox-policy.md sec. 9.4 (captured
//                diagnostics are bounded)
// Task:         T1031
//
// WHY THIS FILE IS THE ONLY PLACE, AND WHY IT LIVES UNDER render/broker/
//   ADR-042 D2 is a security decision, not a style preference: a process that can create
//   containers is host-root-equivalent, so the API process must not be one. The repo-wide
//   grep gate is `dockerode|docker-modem|child_process` outside `backend/src/render/broker/`,
//   and this directory is the only permitted exception. `brokerClient.ts` - the module the
//   backend imports - reaches Docker exclusively through an HTTP frame on a unix socket,
//   which is why it needs no Docker client of any kind.
//
// NO DEPENDENCY IS ADDED. `node:child_process` is in the standard library, and spawning the
// CLI with an argument ARRAY is what makes the "no `sh -c` anywhere in the compile path"
// rule (policy 5.4) structural rather than a convention: there is no shell to inject into.
// A `spawn` with `shell: true` anywhere in this file would make every argv in
// `createArgs.ts` decorative, so it is never used and the absence is asserted by
// `broker.test.ts`.
//
// TWO ENVIRONMENTS, AND THEY ARE NOT RELATED. This module passes the docker CLI its OWN
// environment (PATH, HOME, DOCKER_HOST - the CLI cannot run without PATH), and separately
// passes the CONTAINER its environment as `--env KEY=VALUE` flags built from the plan.
// The two are never merged: no `process.env` key is ever read here to populate a
// container's environment, so a broker deployed with `TYPST_ROOT=/` or `HOME=/root` cannot
// influence what a compile sees. That is the "never merged with the broker's own
// environment" requirement, and it is why the CLI env is an explicit allowlist-plus-PATH
// rather than `process.env`.

import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * What one `docker ...` invocation produced.
 *
 * `code` is the CLI's exit code. A `null` code (a signal) is normalised to `128 + signum`
 * so a caller never has to branch on a nullable number, and so "the container was SIGKILLed
 * (137)" and "the CLI could not be spawned (127)" are the same SHAPE of answer.
 */
export interface DockerRunResult {
  readonly code: number;
  /** Captured stdout, DECODED and TRUNCATED to `stdoutLimit` bytes. */
  readonly stdout: string;
  /** Captured stderr, DECODED and TRUNCATED to `stderrLimit` bytes. */
  readonly stderr: string;
  /** True when the invocation was killed by a signal rather than exiting. */
  readonly signaled: boolean;
}

export interface DockerRunOptions {
  /** Written to the child's stdin. `null` closes stdin immediately. */
  readonly stdin?: Readable | null;
  /**
   * A hard byte bound on what may be written to stdin. Exceeding it destroys the stdin
   * pipe and fails the call, which is the broker's "abort if the frame exceeds treeBytes"
   * control: the excess is never delivered, so a client cannot make the broker's stdin
   * writer hold more than the declared tree size.
   */
  readonly maxStdinBytes?: number;
  /**
   * Where raw stdout goes when it is BULK rather than diagnostic - the `tar -c` capture.
   * When set, `result.stdout` is empty: bulk bytes are never buffered into a string, which
   * is what keeps a 20 MiB artifact out of the process heap.
   */
  readonly stdoutTo?: Writable;
  /** Bound on the captured stdout. Default `DEFAULT_CAPTURE_BYTES`. */
  readonly stdoutLimit?: number;
  /** Bound on the captured stderr. Default `DEFAULT_CAPTURE_BYTES`. */
  readonly stderrLimit?: number;
  /**
   * Wall-clock bound for THIS invocation. The broker does not use it for the compile
   * (that budget is orchestrated above, so the TERM/grace/KILL sequence is observable on
   * the injected runner); it exists for the short administrative calls - `create`, `start`,
 * `kill`, `rm` - where a wedged daemon must not wedge a job slot forever.
   */
  readonly timeoutMs?: number;
}

export interface DockerRunner {
  /**
   * Run one `docker` subcommand. `argv` is the subcommand and its arguments, WITHOUT the
   * `docker` word: `['create', ...flags, image, 'infinity']`. The binary is this port's
   * own configuration, so a test can assert the exact subcommand sequence without knowing
   * where the binary lives, and `broker.test.ts` uses precisely that to pin the
   * TERM -> grace -> KILL -> `rm -f` order.
   */
  run(argv: readonly string[], options?: DockerRunOptions): Promise<DockerRunResult>;
  /** The resolved binary path/name, for the boot log. Never a secret. */
  readonly binary: string;
}

/** Policy 9.4's 64 KiB. The same bound the redaction applies, applied to the capture. */
export const DEFAULT_CAPTURE_BYTES = 64 * 1024;

/** The default administrative timeout. Short: a hung `docker create` must fail fast. */
export const DEFAULT_ADMIN_TIMEOUT_MS = 30_000;

/** The environment key names the broker reads. Exported so `.env.example`/compose and the
 *  tests can assert the same list. */
export const DOCKER_BIN_ENV = 'RENDER_DOCKER_BIN';

/** 127 is the conventional "command not found"; used for a spawn that never happened. */
const EXIT_CANNOT_EXEC = 127;

function decodeTail(buffer: Buffer): string {
  return buffer.toString('utf8');
}

/**
 * Append to a bounded capture buffer.
 *
 * Truncation is at the FRONT: the tail of a diagnostic is the useful part, and a compile
 * that emits 10 MiB of warnings wants its last lines, not its first. The dropped prefix is
 * marked so an operator can tell a clipped capture from a short one.
 */
function appendBounded(target: Buffer, chunk: Buffer, limit: number): Buffer {
  if (target.length + chunk.length <= limit) {
    return Buffer.concat([target, chunk]);
  }
  const keep = Math.max(0, limit - 40);
  const combined = Buffer.concat([target, chunk]);
  const tail = combined.subarray(combined.length - keep);
  return Buffer.concat([Buffer.from('...[capture truncated]'), tail]);
}

export interface DockerRunnerOptions {
  /** Overridable for a pinned path; defaults to `$RENDER_DOCKER_BIN` then `docker`. */
  readonly binary?: string;
  /** The CLI's own environment. Defaults to PATH + DOCKER_HOST/DOCKER_CONTEXT only. */
  readonly env?: Readonly<Record<string, string>>;
  /** Injected for tests; defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the real runner.
 *
 * `argv` is validated here rather than trusted: a token that is not a non-empty string is
 * a caller bug, and passing it to `spawn` would surface as an opaque `ERR_INVALID_ARG_TYPE`
 * from deep inside Node. There is no shell, so this is a shape check, not a security check -
 * the security property is `shell: false` plus the closed flag vocabulary in
 * `createArgs.ts`.
 */
export function createDockerCliRunner(options: DockerRunnerOptions = {}): DockerRunner {
  const binary =
    options.binary ?? process.env[DOCKER_BIN_ENV] ?? 'docker';
  const cliEnv: Record<string, string> = {
    // PATH is the only variable the CLI strictly needs, and DOCKER_HOST/DOCKER_CONTEXT are
    // how an operator points a broker at a non-default daemon. Everything else the broker
    // process happens to have - including anything named `TYPST_*` - is deliberately NOT
    // forwarded, so the container environment and the CLI environment cannot be confused
    // for one another.
    PATH: process.env.PATH ?? '',
    ...(process.env.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: process.env.DOCKER_HOST }),
    ...(process.env.DOCKER_CONTEXT === undefined
      ? {}
      : { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT }),
    ...(options.env ?? {}),
  };
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    binary,
    async run(argv: readonly string[], runOptions: DockerRunOptions = {}): Promise<DockerRunResult> {
      if (!Array.isArray(argv) || argv.length === 0) {
        throw new Error('RENDER_BROKER_INVALID: a docker argv is required');
      }
      for (const token of argv) {
        if (typeof token !== 'string' || token.length === 0) {
          throw new Error('RENDER_BROKER_INVALID: a docker argv token must be a non-empty string');
        }
      }

      const stdoutLimit = runOptions.stdoutLimit ?? DEFAULT_CAPTURE_BYTES;
      const stderrLimit = runOptions.stderrLimit ?? DEFAULT_CAPTURE_BYTES;
      const timeoutMs = runOptions.timeoutMs ?? DEFAULT_ADMIN_TIMEOUT_MS;

      // A CALLER-SUPPLIED SINK IS OBSERVED, not merely written to. `stdoutTo` is a
      // `Writable` the broker owns, and a BOUNDED one (the spool capture) raises `'error'`
      // from its own `_write` when it passes its cap - on THIS tick, from an I/O callback,
      // while the `run` promise is still pending. With nothing listening, Node treats that
      // as an unhandled `'error'` event and takes the process down, so an over-bound
      // artifact would crash the broker instead of resolving as the contract's
      // `RENDER_ARTIFACT_INVALID`. This listener never swallows the error from the caller's
      // own `waitForSink` (which attaches its own): it only guarantees the transport can
      // never be the thing that dies.
      runOptions.stdoutTo?.on('error', () => undefined);

      return await new Promise<DockerRunResult>((resolve, reject) => {
        // `shell: false` is the load-bearing option and is never overridden.
        const child = spawn(binary, [...argv], {
          shell: false,
          env: cliEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let stdout: Buffer = Buffer.alloc(0);
        let stderr: Buffer = Buffer.alloc(0);
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let stdinBytes = 0;
        let stdinOverflow = false;

        const finish = (result: DockerRunResult): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(result);
        };
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          reject(error);
        };

        // Administrative timeout: SIGKILL the CLI itself (never the container) and report
        // a timeout as a non-zero code, so the job's own classification decides what a
        // wedged daemon MEANS rather than this layer deciding it.
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
          timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish({ code: 124, stdout: decodeTail(stdout), stderr: decodeTail(stderr), signaled: true });
          }, timeoutMs);
          timer.unref?.();
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          if (runOptions.stdoutTo !== undefined) {
            if (!runOptions.stdoutTo.write(chunk)) {
              child.stdout?.pause();
              runOptions.stdoutTo.once('drain', () => child.stdout?.resume());
            }
            return;
          }
          stdout = appendBounded(stdout, chunk, stdoutLimit);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = appendBounded(stderr, chunk, stderrLimit);
        });

        // stdin. The byte bound is enforced as bytes are written, so an over-large frame
        // is cut off rather than delivered.
        const stdin = runOptions.stdin;
        if (stdin === undefined || stdin === null) {
          child.stdin?.end();
        } else {
          child.stdin?.on('error', () => undefined);
          const maxStdin = runOptions.maxStdinBytes ?? Number.POSITIVE_INFINITY;
          stdin.on('data', (chunk: Buffer) => {
            if (stdinOverflow) return;
            stdinBytes += chunk.length;
            if (stdinBytes > maxStdin) {
              // Destroy the PIPE, not the source: the caller's stream may be a live socket
              // and destroying it would take the whole request down with it.
              stdinOverflow = true;
              child.stdin?.destroy();
              return;
            }
            child.stdin?.write(chunk);
          });
          stdin.on('error', () => child.stdin?.destroy());
          stdin.once('end', () => child.stdin?.end());
          stdin.once('close', () => child.stdin?.end());
        }

        child.on('error', (error) => {
          // A spawn that never happened (EACCES, ENOENT) is a broker fault, not a render
          // outcome, and is reported as a rejected call so the caller classifies it.
          fail(new Error(`RENDER_BROKER_DOCKER: the docker CLI could not be started: ${error.message}`));
        });
        child.on('close', (code, signal) => {
          const normalized =
            code === null || code === undefined
              ? signal === null || signal === undefined
                ? EXIT_CANNOT_EXEC
                : 128 + signalNumber(signal)
              : code;
          finish({
            code: stdinOverflow ? 74 : normalized,
            stdout: decodeTail(stdout),
            stderr: decodeTail(stderr),
            signaled: signal !== null && signal !== undefined,
          });
        });
      });
    },
  };
}

/** POSIX signal name -> number, for the `128 + signum` normalisation. */
function signalNumber(signal: string): number {
  const table: Readonly<Record<string, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal] ?? 1;
}

/** Exposed for the boot preflight's log line and for tests that assert the gate. */
export const DOCKER_IMAGE_INSPECT_TIMEOUT_MS = 10_000;
