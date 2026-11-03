// The backend-side render client - the ONLY way the API process reaches a render.
//
// NORMATIVE DOC: .planning/decisions/ADR-042-*.md D2 (the backend must not import a Docker
//                client and must not shell out to Docker)
//                .planning/decisions/ADR-044-*.md D1 (the transport: one framed request over
//                a unix socket, loopback TCP as the dev fallback)
// Task:         T1031
//
// WHAT THIS MODULE IS FORBIDDEN TO CONTAIN, and why that is the whole point of it.
// ADR-042 D2 decided that a process which can create containers is host-root-equivalent, so
// the API process must not be one. That is a negative requirement, and a negative requirement
// is only real if something enforces it:
//
//   - no Docker client library is imported (and none is added as a dependency);
//   - `node:child_process` is not imported, so the backend cannot shell out to `docker`;
//   - the only transport is an HTTP request on a unix socket or a loopback socket, carrying a
//     frame the broker parses.
//
// The repo-wide grep gate is `dockerode|docker-modem|child_process` over `backend/src` with
// `render/broker` excluded, and `brokerClient.test.ts` re-runs it over the source tree rather
// than trusting the CI step, so a regression fails a TEST and not only a lint job.
//
// WHAT THE CLIENT GUARANTEES, and the two properties that make it usable rather than merely
// present:
//
//   1. THE FRAME IS WRITTEN EXACTLY AS THE BROKER READS IT:
//      `4-byte BE uint32 L | L bytes UTF-8 JSON JobSpec | exactly treeBytes of ustar`, where
//      the tar comes from `openStageTreeStream()` (T1013) - so the staged tree the container
//      receives is the tree the stager validated, and the client never re-implements a
//      serialiser. The declared `treeBytes` is the length actually written, computed from
//      the buffer, so a mis-declared size is impossible by construction rather than by care.
//
//   2. A 201 IS VERIFIED BEFORE A BYTE IS HANDED ON. `validateRenderArtifact` ran on the
//      BROKER's side of the wire; the client re-checks the three things it can: that the
//      declared byte length matches the body it received, that the body is non-empty and
//      starts with the format's magic bytes (`%PDF-` for pdf), and - T1052 - that the body
//      HASHES TO THE `x-clearance-sha256` THE BROKER DECLARED. The last one is the only check
//      that ties the bytes to their own digest: a header is a CLAIM, and the claim used to be
//      validated for SHAPE (`/^[0-9a-f]{64}$/`) and never compared to anything. So a broker (or
//      anything on the socket) that returned a well-formed digest over the wrong bytes - or
//      over bytes that were substituted after the broker hashed them - was accepted, and the
//      storage port then filed those bytes at the address the DECLARED digest names, which is
//      content addressing laundering. The digest is therefore computed WHILE the response is
//      read (one pass, one extra `hash.update` per chunk - the body is already buffered, so
//      this is not a second read) and compared to the header before `render` returns. A
//      response that fails any of the three is a `RENDER_ARTIFACT_INVALID` with its own
//      reason, never a "successful" render of something unusable - the client is the last gate
//      before the bytes reach the storage port (T1032) and the API.
//
// The 201 body is returned as a Buffer under the policy 6.2 cap rather than as a stream, for
// the same reason the broker buffers it: the caller needs the length and the digest to key
// the storage write, and a stream would force it to choose between re-reading the bytes and
// forwarding an unverifiable one. The cap is policy 6.2's 20 MiB, the same number the broker
// enforced twice before the wire.

import { createHash } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

import {
  RENDER_LIMITS,
  RENDER_OUTCOME_CODES,
  buildCompileArgs,
  type RenderEngine,
  type RenderFormat,
} from './sandbox.js';
import { openStageTreeStream, type StageTree } from './stage.js';

// ---------------------------------------------------------------------------
// The wire contract, re-declared for the client
// ---------------------------------------------------------------------------

export const BROKER_RENDER_PATH = '/v1/render';
export const BROKER_TOKEN_HEADER = 'x-clearance-render-token';
export const BROKER_FRAME_PREFIX_BYTES = 4;

export const BROKER_RESPONSE_HEADERS = Object.freeze({
  outcome: 'x-clearance-outcome',
  sha256: 'x-clearance-sha256',
  bytes: 'x-clearance-bytes',
  mime: 'x-clearance-mime',
  durationMs: 'x-clearance-duration-ms',
});

/** The JobSpec the broker accepts. Narrow on purpose; see `broker/createArgs.ts`. */
export interface RenderJobSpec {
  readonly jobId: string;
  readonly engine: RenderEngine;
  readonly format: 'pdf';
  readonly templateId: string;
  readonly templateVersion: string;
  readonly expectedEngineVersion: string;
  readonly creationTimestampUnix: number;
  readonly treeBytes: number;
  readonly treeFileCount: number;
  readonly userId: string;
  readonly revisionId: string;
}

/** Magic bytes per format. A CONTENT check, matching policy 6.3.6's rule. */
const MAGIC: Readonly<Record<RenderFormat, Buffer>> = Object.freeze({
  pdf: Buffer.from('%PDF-', 'latin1'),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  svg: Buffer.from('<svg', 'latin1'),
});

/** The maximum artifact this client will buffer. Policy 6.2, the same cap the broker used. */
export const CLIENT_MAX_ARTIFACT_BYTES = RENDER_LIMITS.outputBytes;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A non-201 answer from the broker. Carries the code and the reason verbatim. */
export class BrokerClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason: string,
    /** The broker's fixed, user-facing message. Never a diagnostic (policy 9.3). */
    readonly message: string,
  ) {
    super(`RENDER_BROKER_${status}: ${code} (${reason})`);
    this.name = 'BrokerClientError';
  }
}

/** The client could not reach a broker at all: no socket, refused, or a transport error. */
export class BrokerUnavailableError extends Error {
  readonly code = 'RENDER_BROKER_UNAVAILABLE';
  constructor(cause: string) {
    super(`RENDER_BROKER_UNAVAILABLE: ${cause}`);
    this.name = 'BrokerUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const BROKER_ENV_KEYS = Object.freeze({
  socket: 'RENDER_BROKER_SOCKET',
  url: 'RENDER_BROKER_URL',
  token: 'RENDER_BROKER_TOKEN',
});

export interface BrokerEndpoint {
  /** A unix socket path (or a Windows named pipe path). Preferred. */
  readonly socketPath?: string;
  /** TCP loopback fallback. `url` is only honoured for a loopback host. */
  readonly url?: string;
  readonly token: string;
}

export interface BrokerClientConfig {
  readonly endpoint: BrokerEndpoint;
  /** Transport budget for one render. Policy 9.1's 10 s plus the kill grace and margin. */
  readonly timeoutMs?: number;
  readonly log?: (...args: unknown[]) => void;
}

/**
 * Read the endpoint from the environment, LAZILY and without throwing.
 *
 * Nothing throws at import time, which is what keeps this module importable from a test
 * (and from `storage.test.ts`'s grep gate) whether or not a broker is configured. The
 * rendering of the wire defaults lives in the compose service, and `.env.example` documents
 * the three keys; `backend/src/config/env.ts` is deliberately NOT touched by this task, so
 * the keys are declared here and exported for the wiring task to consume.
 */
export function brokerEndpointFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrokerEndpoint | null {
  const token = env[BROKER_ENV_KEYS.token];
  if (token === undefined || token.length === 0) return null;
  const socketPath = env[BROKER_ENV_KEYS.socket];
  if (socketPath !== undefined && socketPath.length > 0) return { socketPath, token };
  const url = env[BROKER_ENV_KEYS.url];
  if (url === undefined || url.length === 0) return null;
  return { url, token };
}

/** The default budget: the 10 s wall, the 2 s kill grace, and margin for staging/extraction. */
export const CLIENT_DEFAULT_TIMEOUT_MS = RENDER_LIMITS.wallClockMs + RENDER_LIMITS.killGraceMs + 5_000;

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * Build the framed body: `4-byte BE uint32 L | L bytes UTF-8 JSON | the ustar tree`.
 *
 * The length prefix is the SPEC's byte length, not the tree's: the broker reads exactly `L`
 * bytes of JSON and then treats the remainder as the tree. Getting that backwards is the
 * classic way to build a client that works against nothing.
 *
 * The tree bytes are the ones `openStageTreeStream()` emits, drained into ONE buffer so the
 * declared `treeBytes` can be set from the real length. `openStageTreeStream` assembles the
 * archive in memory from a tree that is already bounded to 5 files / 8 MiB, so this is a
 * bounded copy and not a new unbounded read.
 */
export async function buildFrame(spec: RenderJobSpec, tree: StageTree): Promise<Buffer> {
  const specJson = Buffer.from(JSON.stringify(spec), 'utf8');
  const treeBytes = await drain(openStageTreeStream(tree));
  if (treeBytes.length > RENDER_LIMITS.inputTotalBytes) {
    throw new Error('RENDER_INPUT_TOO_LARGE: the staged tree exceeds the broker input bound');
  }
  if (treeBytes.length !== spec.treeBytes) {
    // A mis-declared size is a caller bug, and it is caught HERE rather than becoming a
    // truncated frame the broker has to diagnose.
    throw new Error('RENDER_INPUT_INVALID: spec.treeBytes must equal the staged tree length');
  }
  const prefix = Buffer.alloc(BROKER_FRAME_PREFIX_BYTES);
  prefix.writeUInt32BE(specJson.length, 0);
  return Buffer.concat([prefix, specJson, treeBytes]);
}

/** Drain a readable into a single buffer, refusing to exceed a cap. */
async function drain(source: Readable, cap = RENDER_LIMITS.inputTotalBytes): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of source) {
    const bytes = chunk as Buffer;
    total += bytes.length;
    if (total > cap) {
      source.destroy();
      throw new Error('RENDER_INPUT_TOO_LARGE: the staged tree exceeds the broker input bound');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface RenderResult {
  readonly outcome: 'ok';
  readonly sha256: string;
  readonly byteSize: number;
  readonly mimeType: string;
  readonly durationMs: number;
  readonly artifact: Buffer;
}

export class RenderBrokerClient {
  constructor(private readonly config: BrokerClientConfig) {}

  /**
   * Send one render request and return the verified artifact.
   *
   * Throws `BrokerClientError` for any non-201 (the code and reason come from the broker
   * verbatim, so a route can map them through its own error convention without re-deriving
   * anything), and `BrokerUnavailableError` when the transport itself failed. A 201 whose
   * body fails the client's own length/magic/digest check is ALSO `BrokerClientError` with
   * `RENDER_ARTIFACT_INVALID` - the client never reports a render as successful on the
   * strength of a status code alone.
   */
  async render(spec: RenderJobSpec, tree: StageTree): Promise<RenderResult> {
    const body = await buildFrame(spec, tree);
    const { status, headers, payload, sha256: receivedSha256 } = await this.send(body, spec.format);
    if (status !== 201) {
      throw parseFailure(status, payload);
    }
    const outcome = headerValue(headers, BROKER_RESPONSE_HEADERS.outcome);
    if (outcome !== 'ok') {
      throw new BrokerClientError(status, 'RENDER_BROKER_CONTRACT', 'OUTCOME_HEADER_NOT_OK', '');
    }
    const declaredBytes = Number(headerValue(headers, BROKER_RESPONSE_HEADERS.bytes));
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes !== payload.length) {
      throw new BrokerClientError(
        status,
        'RENDER_ARTIFACT_INVALID',
        'ARTIFACT_SIZE_CHANGED',
        'the rendered document could not be produced',
      );
    }
    if (payload.length === 0 || payload.length > CLIENT_MAX_ARTIFACT_BYTES) {
      throw new BrokerClientError(
        status,
        'RENDER_ARTIFACT_INVALID',
        'ARTIFACT_TOO_LARGE',
        'the rendered document could not be produced',
      );
    }
    // The broker already ran policy 6.3 check 6; this is the client refusing to be the
    // component that skips it because it trusted a header.
    const magic = MAGIC[spec.format];
    if (payload.length < magic.length || !payload.subarray(0, magic.length).equals(magic)) {
      throw new BrokerClientError(
        status,
        'RENDER_ARTIFACT_INVALID',
        'ARTIFACT_BAD_MAGIC',
        'the rendered document could not be produced',
      );
    }
    const sha256 = headerValue(headers, BROKER_RESPONSE_HEADERS.sha256);
    if (sha256 === undefined || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new BrokerClientError(
        status,
        'RENDER_ARTIFACT_INVALID',
        'ARTIFACT_DIGEST_MISSING',
        'the rendered document could not be produced',
      );
    }
    // T1052: THE HEADER IS A CLAIM, SO IT IS COMPARED. `receivedSha256` was computed from the
    // bytes this process actually read off the socket, in `send`, so the two digests describe
    // the same artifact and the comparison is meaningful. Without it the client validated the
    // SHAPE of a digest and then trusted it, and a wrong-but-well-formed one put bytes that
    // hash to something else at an address derived from the DECLARED digest - which is the one
    // input the content-addressed store cannot check for itself (it verifies the bytes against
    // the KEY, and the key is derived from the digest this header claims). The comparison is
    // AFTER the shape check on purpose: a missing or malformed digest is a contract violation
    // with its own reason, and a well-formed digest that does not describe the body is a
    // different fault with a different one.
    if (receivedSha256 !== sha256) {
      throw new BrokerClientError(
        status,
        'RENDER_ARTIFACT_INVALID',
        'ARTIFACT_DIGEST_MISMATCH',
        'the rendered document could not be produced',
      );
    }
    const durationMs = Number(headerValue(headers, BROKER_RESPONSE_HEADERS.durationMs) ?? '0');
    return {
      outcome: 'ok',
      sha256,
      byteSize: declaredBytes,
      mimeType: headerValue(headers, BROKER_RESPONSE_HEADERS.mime) ?? 'application/octet-stream',
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      artifact: payload,
    };
  }

  private send(
    body: Buffer,
    format: RenderFormat,
  ): Promise<{
    status: number;
    headers: IncomingMessage['headers'];
    payload: Buffer;
    /** The digest of the bytes THIS PROCESS read, computed as they arrive (T1052). */
    sha256: string;
  }> {
    const endpoint = this.config.endpoint;
    const timeoutMs = this.config.timeoutMs ?? CLIENT_DEFAULT_TIMEOUT_MS;
    const https = endpoint.socketPath === undefined && (endpoint.url ?? '').startsWith('https:');

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        fn();
      };
      const send = (options: Record<string, unknown>): ClientRequest => {
        const client = (https ? httpsRequest : httpRequest)(options, (res) => {
          const chunks: Buffer[] = [];
          // The digest is accumulated HERE, in the read loop, rather than computed from the
          // joined buffer afterwards: it is the same amount of hashing either way, and doing
          // it inline is what makes the property "this is the digest of the bytes this socket
          // delivered" a structural fact of the read rather than a second pass a future edit
          // could reorder or drop. `createHash` is also the reason a hostile broker cannot
          // make the client skip the check by sending a body it never hashed.
          const digest = createHash('sha256');
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > CLIENT_MAX_ARTIFACT_BYTES + 4096) {
              res.destroy();
              done(() =>
                reject(
                  new BrokerClientError(
                    502,
                    'RENDER_ARTIFACT_INVALID',
                    'RESPONSE_TOO_LARGE',
                    'the rendered document could not be produced',
                  ),
                ),
              );
              return;
            }
            digest.update(chunk);
            chunks.push(chunk);
          });
          res.once('end', () => {
            done(() =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                payload: Buffer.concat(chunks),
                sha256: digest.digest('hex'),
              }),
            );
          });
          res.once('error', (error: Error) => done(() => reject(new BrokerUnavailableError(error.message))));
        });
        client.setTimeout(timeoutMs, () => {
          client.destroy();
          done(() => reject(new BrokerUnavailableError('the broker did not answer in time')));
        });
        client.once('error', (error: Error) => done(() => reject(new BrokerUnavailableError(error.message))));
        client.write(body);
        client.end();
        return client;
      };

      // The unix socket is the transport of record. The TCP fallback is loopback-ONLY and
      // that is enforced here rather than documented: a broker reachable on a routable
      // address with a shared-secret header is a remote-code-execution surface wearing an
      // auth header.
      if (endpoint.socketPath !== undefined && endpoint.socketPath.length > 0) {
        send({
          socketPath: endpoint.socketPath,
          path: BROKER_RENDER_PATH,
          method: 'POST',
          headers: frameHeaders(endpoint.token, body.length, format),
        });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(endpoint.url ?? '');
      } catch {
        done(() => reject(new BrokerUnavailableError('RENDER_BROKER_URL is not a URL')));
        return;
      }
      const host = parsed.hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
        done(() => reject(new BrokerUnavailableError('the broker URL must be loopback')));
        return;
      }
      send({
        protocol: parsed.protocol,
        host,
        port: parsed.port === '' ? 80 : Number(parsed.port),
        path: `${parsed.pathname.replace(/\/$/, '')}${BROKER_RENDER_PATH}`,
        method: 'POST',
        headers: frameHeaders(endpoint.token, body.length, format),
      });
    });
  }
}

/** The request headers. Only the framing ones; nothing about the user or the template. */
function frameHeaders(token: string, length: number, format: RenderFormat): Record<string, string> {
  return {
    [BROKER_TOKEN_HEADER]: token,
    'content-type': 'application/octet-stream',
    'content-length': String(length),
    'x-clearance-render-format': format,
  };
}

/**
 * Read one response header as a string.
 *
 * Node types a header as `string | string[] | undefined` because a repeated header arrives
 * as an array. A repeated `x-clearance-sha256` is a contract violation, not a value to pick
 * one of, so the array case is refused by returning `undefined` - which every caller here
 * treats as "missing" and therefore as a refusal.
 */
function headerValue(
  headers: IncomingMessage['headers'],
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Turn a non-201 body into a `BrokerClientError`.
 *
 * The body is a small JSON envelope, and it is parsed DEFENSIVELY: a broker that is not this
 * broker, or a proxy that answered instead, must not be able to make the client throw a
 * `SyntaxError` with an attacker-influenced message. An unparseable body becomes a fixed
 * `RENDER_BROKER_UNAVAILABLE` and the raw text is dropped rather than interpolated.
 */
function parseFailure(status: number, payload: Buffer): BrokerClientError {
  let code = 'RENDER_BROKER_UNAVAILABLE';
  let reason = 'MALFORMED_ERROR_BODY';
  let message = 'the renderer is temporarily unavailable';
  try {
    const parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.code === 'string') code = parsed.code;
    if (typeof parsed.reason === 'string') reason = parsed.reason;
    if (typeof parsed.message === 'string') message = parsed.message;
  } catch {
    // Deliberately empty: see the doc comment.
  }
  return new BrokerClientError(status, code, reason, message);
}

/**
 * Build the JobSpec for a staged tree, deriving the three numbers that must agree with it.
 *
 * `expectedEngineVersion` comes from `buildCompileArgs`, NOT from a constant here: the plan
 * is what decides which engine version is pinned, so a pin bump in `sandbox.ts` moves the
 * wire value with it and cannot leave a client declaring a version the broker will refuse.
 * That is the RENDER_TOOLCHAIN_MISMATCH path being structurally unreachable from a stale
 * caller rather than merely unlikely.
 */
export function buildJobSpec(input: {
  readonly jobId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly creationTimestampUnix: number;
  readonly userId: string;
  readonly revisionId: string;
  readonly format?: RenderFormat;
  readonly treeBytes: number;
  readonly treeFileCount: number;
  /** Defaults to `'typst'`, so every existing caller is unchanged. */
  readonly engine?: RenderEngine;
}): RenderJobSpec {
  const format = input.format ?? 'pdf';
  const engine = input.engine ?? 'typst';
  const plan = buildCompileArgs(engine, {
    creationTimestampUnix: input.creationTimestampUnix,
    format,
  });
  if (format !== 'pdf') {
    // The broker serves PDF only. Refusing here, with a named reason, is what keeps a
    // future caller from widening the wire format without a policy decision.
    throw new Error('RENDER_REQUEST_INVALID: the render broker serves format "pdf" only');
  }
  return {
    jobId: input.jobId,
    engine,
    format: 'pdf',
    templateId: input.templateId,
    templateVersion: input.templateVersion,
    expectedEngineVersion: plan.engineVersion,
    creationTimestampUnix: input.creationTimestampUnix,
    treeBytes: input.treeBytes,
    treeFileCount: input.treeFileCount,
    userId: input.userId,
    revisionId: input.revisionId,
  };
}

export { RENDER_OUTCOME_CODES };
