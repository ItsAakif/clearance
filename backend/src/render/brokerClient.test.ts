// Render broker client - tests against a REAL local socket.
//
// NORMATIVE DOC: .planning/decisions/ADR-042-*.md D2 (the backend reaches Docker only
//                through the broker)
//                .planning/decisions/ADR-044-*.md D1 (the framed transport)
// Task:         T1031
//
// WHY THIS FILE EXISTS AND WHY IT IS AN INTEGRATION TEST. The task contract's seventh
// acceptance bullet asks for the client to be exercised "against a real local socket": a
// wrong/absent token is 401, a truncated tar frame aborts and triggers the kill path, and a
// 201 streams the artifact with a matching sha256. Those three are transport facts, and a
// transport fact cannot be proven by calling a function - it needs a socket, a frame, a
// header and bytes on the wire. So this file starts the REAL broker server from
// `broker/index.ts` (with the fake `DockerRunner`, so no daemon is needed) and drives it
// with the REAL `RenderBrokerClient` from `brokerClient.ts`. The only thing faked is the
// Docker CLI itself, which is the one boundary the unit half cannot cross anyway.
//
// The socket form is platform-correct rather than hardcoded: POSIX uses a filesystem path
// under the OS temp dir, and Windows uses a named pipe (`\\.\pipe\...`), because a
// `C:\...\broker.sock` path is not a bindable socket on Windows. A `listen` that fails is
// reported as SKIPPED-WITH-REASON rather than silently passing - the same discipline the
// orchestrator's ruling 7 requires of the live half.

import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RENDER_LIMITS, RENDER_PATHS, TYPST_PIN, type CompilePlan } from './sandbox.js';
import { buildCompileArgs } from './sandbox.js';
import { openStageTreeStream, type StageTree } from './stage.js';
import {
  BROKER_RENDER_PATH,
  BROKER_RESPONSE_HEADERS,
  BROKER_TOKEN_HEADER,
  RENDER_WORKER_IMAGE,
  type BrokerJobSpec,
} from './broker/index.js';
import {
  BrokerClientError,
  BrokerUnavailableError,
  CLIENT_MAX_ARTIFACT_BYTES,
  CLIENT_DEFAULT_TIMEOUT_MS,
  RenderBrokerClient,
  buildFrame,
  buildJobSpec,
  brokerEndpointFromEnv,
  type RenderJobSpec,
} from './brokerClient.js';
import type { DockerRunOptions, DockerRunResult, DockerRunner } from './broker/dockerRunner.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STAMP = 1_757_000_000;
const TOKEN = 'shared-secret-token-value';

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'latin1'),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1'),
  Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
]);

function stagedTree(): StageTree {
  const files = [
    { name: RENDER_PATHS.names.typstTemplate, bytes: Buffer.from('#set page(width: "A4")\n', 'utf8') },
    { name: RENDER_PATHS.names.data, bytes: Buffer.from('{"name":"Ada Lovelace"}', 'utf8') },
  ].sort((a, b) => (a.name < b.name ? -1 : 1));
  return Object.freeze({
    engine: 'typst',
    files: Object.freeze(files),
    names: Object.freeze(files.map((file) => file.name)),
    totalBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    packageCacheDir: '.pkgcache',
    limits: RENDER_LIMITS,
  });
}

async function treeBytesOf(tree: StageTree): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of openStageTreeStream(tree)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function jobSpec(userId = 'user-a'): Promise<RenderJobSpec> {
  const tree = stagedTree();
  const tar = await treeBytesOf(tree);
  return buildJobSpec({
    jobId: 'job-0001',
    templateId: 'typst-resume-classic',
    templateVersion: '1',
    creationTimestampUnix: STAMP,
    userId,
    revisionId: 'rev-1',
    treeBytes: tar.length,
    treeFileCount: tree.names.length,
  });
}

/** The frame the client builds, which the broker reads. Same function, one definition. */
function ustarOf(name: string, body: Buffer): Buffer {
  const blocks: Buffer[] = [];
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'latin1');
  header.write('0000600', 100, 8, 'latin1');
  header.write('0000000', 108, 8, 'latin1');
  header.write('0000000', 116, 8, 'latin1');
  header.write(body.length.toString(8).padStart(11, '0'), 124, 12, 'latin1');
  header.write('00000000000', 136, 12, 'latin1');
  header.write('0', 156, 1, 'latin1');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'latin1');
  header[154] = 0x00;
  header[155] = 0x20;
  blocks.push(header, body);
  const pad = body.length % 512;
  if (pad !== 0) blocks.push(Buffer.alloc(512 - pad, 0));
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

const ok: DockerRunResult = { code: 0, stdout: '', stderr: '', signaled: false };

interface FakeDocker extends DockerRunner {
  readonly calls: string[][];
  handler: (argv: readonly string[], options: DockerRunOptions) => DockerRunResult | Promise<DockerRunResult>;
}

function fakeDocker(
  handler: FakeDocker['handler'] = () => ok,
): FakeDocker {
  const calls: string[][] = [];
  const runner: FakeDocker = {
    binary: 'fake-docker',
    calls,
    handler,
    async run(argv, options = {}) {
      calls.push([...argv]);
      return await runner.handler(argv, options);
    },
  };
  return runner;
}

function happyDocker(outTar: Buffer = ustarOf('artifact.pdf', PDF_BYTES)): FakeDocker {
  return fakeDocker((argv, options) => {
    if (argv[0] === 'create') return { ...ok, stdout: 'c0ffee123456\n' };
    if (argv[0] === 'image') return ok;
    if (argv[0] === 'start' || argv[0] === 'rm' || argv[0] === 'kill') return ok;
    if (argv[0] === 'exec' && argv.includes('-c')) {
      if (options.stdoutTo !== undefined) {
        options.stdoutTo.write(outTar);
        options.stdoutTo.end();
      }
      return ok;
    }
    return ok;
  });
}

// ---------------------------------------------------------------------------
// The server harness
// ---------------------------------------------------------------------------

let spoolRoot = '';

/**
 * A platform-correct socket path.
 *
 * POSIX: a path under the OS temp dir. Windows: a NAMED PIPE - a filesystem path is not a
 * bindable socket there, and `listen` fails with EACCES, which would make the transport half
 * of this task unprovable on the machine doing the work.
 */
function socketPathFor(dir: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\clearance-broker-test-${process.pid}-${Math.abs(hash(dir))}`;
  }
  return path.join(dir, 'broker.sock');
}

function hash(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    total = (total * 31 + value.charCodeAt(index)) | 0;
  }
  return total;
}

interface Harness {
  readonly client: RenderBrokerClient;
  readonly docker: FakeDocker;
  close(): Promise<void>;
  /** The endpoint to hand the client, or `null` when the socket could not be bound. */
  readonly endpoint: { socketPath?: string; url?: string; token: string } | null;
  readonly skipReason: string | null;
}

async function startBroker(
  docker: FakeDocker,
  opts: { token?: string; mode?: 'socket' | 'loopback' } = {},
): Promise<Harness> {
  const { createBrokerServer } = await import('./broker/index.js');
  const token = opts.token === undefined ? TOKEN : opts.token;
  const server = createBrokerServer({
    token,
    spoolRoot,
    docker,
    log: () => undefined,
    // The wall budget must not expire on its own during a transport test; the kill grace
    // must not be waited for. Same split as the unit half.
    delay: async (ms: number) => {
      if (ms >= RENDER_LIMITS.wallClockMs) await new Promise<void>(() => undefined);
    },
  });

  if (opts.mode === 'loopback') {
    await new Promise<void>((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(0, '127.0.0.1', () => {
        server.server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return {
      client: new RenderBrokerClient({
        endpoint: { url: `http://127.0.0.1:${port}`, token },
        timeoutMs: 10_000,
      }),
      docker,
      endpoint: { url: `http://127.0.0.1:${port}`, token },
      skipReason: null,
      close: () => server.close(),
    };
  }

  const socketPath = socketPathFor(spoolRoot);
  try {
    await new Promise<void>((resolve, reject) => {
      server.server.once('error', reject);
      server.server.listen(socketPath, () => {
        server.server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await server.close().catch(() => undefined);
    return {
      client: new RenderBrokerClient({ endpoint: { socketPath, token } }),
      docker,
      endpoint: null,
      skipReason: `a local socket could not be bound on this platform: ${(error as Error).message}`,
      close: async () => undefined,
    };
  }
  return {
    client: new RenderBrokerClient({ endpoint: { socketPath, token }, timeoutMs: 10_000 }),
    docker,
    endpoint: { socketPath, token },
    skipReason: null,
    close: () => server.close(),
  };
}

beforeEach(() => {
  spoolRoot = mkdtempSync(path.join(os.tmpdir(), 'broker-client-test-'));
});

afterEach(() => {
  if (spoolRoot !== '') rmSync(spoolRoot, { recursive: true, force: true });
});

// ===========================================================================
// A7 - the real-socket half of the contract
// ===========================================================================

describe('render/brokerClient A7 - a real local socket', () => {
  it('A7.1 a 201 streams the artifact and the sha256 matches the bytes', async () => {
    const harness = await startBroker(happyDocker());
    try {
      expect(harness.skipReason).toBeNull();
      const spec = await jobSpec();
      const result = await harness.client.render(spec, stagedTree());
      expect(result.outcome).toBe('ok');
      expect(result.artifact).toEqual(PDF_BYTES);
      expect(result.artifact.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(result.byteSize).toBe(PDF_BYTES.length);
      expect(result.mimeType).toBe('application/pdf');
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      // The digest is the CLIENT's own claim, so recompute it: a header the broker and the
      // client agree on is worth nothing if it is not the digest of the bytes.
      expect(result.sha256).toBe(createHash('sha256').update(result.artifact).digest('hex'));
      expect(harness.docker.calls.map((argv) => argv[0])).toEqual([
        'create',
        'start',
        'exec',
        'exec',
        'exec',
        'rm',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('A7.2 a wrong or absent token is 401 and NO container is created', async () => {
    const harness = await startBroker(happyDocker());
    try {
      expect(harness.skipReason).toBeNull();
      for (const [label, token] of [
        ['absent', ''],
        ['wrong', 'not-the-token'],
        ['prefix', TOKEN.slice(0, TOKEN.length - 1)],
        ['longer', `${TOKEN}x`],
      ] as const) {
        const client = new RenderBrokerClient({
          endpoint: { ...(harness.endpoint as { socketPath?: string }), token: token === '' ? '' : token },
          timeoutMs: 10_000,
        });
        const error = await client.render(await jobSpec(), stagedTree()).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error, label).toBeInstanceOf(BrokerClientError);
        expect((error as BrokerClientError).status, label).toBe(401);
        expect((error as BrokerClientError).code, label).toBe('RENDER_UNAUTHORIZED');
        // The decisive assertion: auth is step (1), so NOTHING reached Docker.
        expect(harness.docker.calls, label).toHaveLength(0);
      }
    } finally {
      await harness.close();
    }
  });

  it('A7.3 a truncated tar frame aborts BEFORE a container exists', async () => {
    const harness = await startBroker(happyDocker());
    try {
      expect(harness.skipReason).toBeNull();
      const spec = await jobSpec();
      const full = await buildFrame(spec, stagedTree());
      // Cut the tail off: the declared `treeBytes` no longer matches what arrives.
      const truncated = full.subarray(0, full.length - 512);
      const error = await rawPost(harness.endpoint as { socketPath?: string }, TOKEN, truncated).then(
        (response) => response,
        (caught: unknown) => caught,
      );
      const response = error as { status: number; body: string };
      expect(response.status).toBe(400);
      const body = JSON.parse(response.body) as { code: string; reason: string };
      expect(body.code).toBe('RENDER_REQUEST_INVALID');
      expect(body.reason).toBe('TREE_TRUNCATED');
      // The abort happened at the frame reader, which is step (3): no `create` at all.
      expect(harness.docker.calls.filter((argv) => argv[0] === 'create')).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('A7.3b a truncated frame that reaches Docker triggers the KILL path', async () => {
    // The previous case is caught before the container exists. This one is the OTHER
    // truncation: the frame is well-formed enough to be accepted, and the breakage happens
    // inside the container, so the broker has a container to clean up. The kill path and the
    // `rm -f` are what the contract asks to be observable.
    const docker = fakeDocker((argv, options) => {
      if (argv[0] === 'create') return { ...ok, stdout: 'truncated1\n' };
      if (argv[0] === 'exec' && argv.includes('-x')) {
        return { code: 2, stdout: '', stderr: 'tar: unexpected EOF', signaled: false };
      }
      if (argv[0] === 'exec' && argv.includes('-c')) {
        if (options.stdoutTo !== undefined) {
          options.stdoutTo.write(ustarOf('artifact.pdf', PDF_BYTES));
          options.stdoutTo.end();
        }
        return ok;
      }
      return ok;
    });
    const harness = await startBroker(docker);
    try {
      expect(harness.skipReason).toBeNull();
      const error = await harness.client.render(await jobSpec(), stagedTree()).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(BrokerClientError);
      const brokerError = error as BrokerClientError;
      expect(brokerError.code).toBe('RENDER_INPUT_TOO_LARGE');
      expect(brokerError.reason).toBe('STAGING_FAILED');
      // TERM, grace, KILL, then rm -f: the container is destroyed, not leaked.
      const subcommands = docker.calls.map((argv) => argv[0]);
      expect(subcommands).toEqual(['create', 'start', 'exec', 'kill', 'kill', 'rm']);
      expect(docker.calls[3]).toEqual(['kill', '-s', 'TERM', 'truncated1']);
      expect(docker.calls[4]).toEqual(['kill', '-s', 'KILL', 'truncated1']);
      expect(docker.calls[5]).toEqual(['rm', '-f', 'truncated1']);
    } finally {
      await harness.close();
    }
  });

  it('A7.4 the loopback dev fallback carries the same frame', async () => {
    const harness = await startBroker(happyDocker(), { mode: 'loopback' });
    try {
      const result = await harness.client.render(await jobSpec(), stagedTree());
      expect(result.artifact).toEqual(PDF_BYTES);
      expect(result.sha256).toBe(createHash('sha256').update(PDF_BYTES).digest('hex'));
    } finally {
      await harness.close();
    }
  });

  it('A7.5 the loopback fallback REFUSES a non-loopback host', async () => {
    const client = new RenderBrokerClient({
      endpoint: { url: 'http://10.0.0.5:9000', token: TOKEN },
      timeoutMs: 2_000,
    });
    await expect(client.render(await jobSpec(), stagedTree())).rejects.toThrow(/loopback/);
  });

  it('A7.6 no broker at all is a BrokerUnavailableError, not a render outcome', async () => {
    const client = new RenderBrokerClient({
      endpoint: { socketPath: socketPathFor(path.join(spoolRoot, 'nothing-here')), token: TOKEN },
      timeoutMs: 2_000,
    });
    const error = await client.render(await jobSpec(), stagedTree()).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BrokerUnavailableError);
  });

  it('A7.7 a 201 whose body is not a PDF is refused by the client', async () => {
    const notAPdf = Buffer.from('%NOT-A-PDF-but-declared-as-one', 'latin1');
    const harness = await startBroker(happyDocker(ustarOf('artifact.pdf', notAPdf)));
    try {
      const error = await harness.client.render(await jobSpec(), stagedTree()).then(
        () => null,
        (caught: unknown) => caught,
      );
      // The broker's own policy 6.3.6 catches it first; the client check is the backstop for
      // a broker that is not this broker.
      expect(error).toBeInstanceOf(BrokerClientError);
      expect((error as BrokerClientError).code).toBe('RENDER_ARTIFACT_INVALID');
    } finally {
      await harness.close();
    }
  });

  it('A7.8 an unknown route is 404 and touches no docker', async () => {
    const harness = await startBroker(happyDocker());
    try {
      const response = await rawPostTo(harness.endpoint as { socketPath?: string }, TOKEN, Buffer.alloc(4), '/v1/nope');
      expect(response.status).toBe(404);
      expect(harness.docker.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

// ===========================================================================
// The frame, the spec builder and the configuration
// ===========================================================================

describe('render/brokerClient - the frame and the spec builder', () => {
  it('C1 buildFrame writes 4-byte BE length | JSON | the tree, and the broker reads it back', async () => {
    const spec = await jobSpec();
    const tree = stagedTree();
    const frame = await buildFrame(spec, tree);
    const length = frame.readUInt32BE(0);
    const json = JSON.parse(frame.subarray(4, 4 + length).toString('utf8')) as Record<string, unknown>;
    expect(json.engine).toBe('typst');
    expect(json.format).toBe('pdf');
    expect(json.expectedEngineVersion).toBe(TYPST_PIN.version);
    const rest = frame.subarray(4 + length);
    expect(rest.length).toBe(spec.treeBytes);
    expect(rest).toEqual(await treeBytesOf(tree));
  });

  it('C2 a mis-declared treeBytes is refused by the client, not shipped', async () => {
    const spec = { ...(await jobSpec()), treeBytes: 12 };
    await expect(buildFrame(spec, stagedTree())).rejects.toThrow(/treeBytes/);
  });

  it('C3 expectedEngineVersion comes from the plan, so a pin bump moves the wire value', () => {
    const plan: CompilePlan = buildCompileArgs('typst', { creationTimestampUnix: STAMP, format: 'pdf' });
    const spec = buildJobSpec({
      jobId: 'j',
      templateId: 't',
      templateVersion: '1',
      creationTimestampUnix: STAMP,
      userId: 'u',
      revisionId: 'r',
      treeBytes: 10,
      treeFileCount: 2,
    });
    expect(spec.expectedEngineVersion).toBe(plan.engineVersion);
    expect(spec.expectedEngineVersion).toBe(TYPST_PIN.version);
  });

  it('C4 a non-pdf format is refused with a named reason', () => {
    expect(() =>
      buildJobSpec({
        jobId: 'j',
        templateId: 't',
        templateVersion: '1',
        creationTimestampUnix: STAMP,
        userId: 'u',
        revisionId: 'r',
        treeBytes: 10,
        treeFileCount: 2,
        format: 'svg',
      }),
    ).toThrow(/format "pdf" only/);
  });

  it('C5 the endpoint comes from the env, and NOTHING throws when it is absent', () => {
    expect(brokerEndpointFromEnv({})).toBeNull();
    expect(brokerEndpointFromEnv({ RENDER_BROKER_TOKEN: '' })).toBeNull();
    expect(brokerEndpointFromEnv({ RENDER_BROKER_TOKEN: TOKEN })).toBeNull();
    expect(
      brokerEndpointFromEnv({ RENDER_BROKER_TOKEN: TOKEN, RENDER_BROKER_SOCKET: '/run/x.sock' }),
    ).toEqual({ socketPath: '/run/x.sock', token: TOKEN });
    expect(
      brokerEndpointFromEnv({ RENDER_BROKER_TOKEN: TOKEN, RENDER_BROKER_URL: 'http://127.0.0.1:9' }),
    ).toEqual({ url: 'http://127.0.0.1:9', token: TOKEN });
  });

  it('C6 the client artifact cap is policy 6.2, the same number the broker enforced', () => {
    expect(CLIENT_MAX_ARTIFACT_BYTES).toBe(RENDER_LIMITS.outputBytes);
    expect(RENDER_LIMITS.outputBytes).toBe(20_971_520);
    expect(CLIENT_DEFAULT_TIMEOUT_MS).toBe(RENDER_LIMITS.wallClockMs + RENDER_LIMITS.killGraceMs + 5_000);
  });

  it('C7 the wire constants agree on both sides of the socket', () => {
    expect(BROKER_RENDER_PATH).toBe('/v1/render');
    expect(BROKER_TOKEN_HEADER).toBe('x-clearance-render-token');
    expect(BROKER_RESPONSE_HEADERS.outcome).toBe('x-clearance-outcome');
    expect(BROKER_RESPONSE_HEADERS.sha256).toBe('x-clearance-sha256');
    expect(BROKER_RESPONSE_HEADERS.bytes).toBe('x-clearance-bytes');
    expect(BROKER_RESPONSE_HEADERS.mime).toBe('x-clearance-mime');
    expect(BROKER_RESPONSE_HEADERS.durationMs).toBe('x-clearance-duration-ms');
    expect(RENDER_WORKER_IMAGE).toBe(`clearance/typst-worker:${TYPST_PIN.version}`);
  });

  it('C8 a spec whose declared size disagrees with the tree never reaches the wire', async () => {
    // The client's `RenderJobSpec` narrows `engine`/`format` to the literals the broker
    // accepts, so a caller cannot even express `format: 'svg'` without a cast. This test
    // uses the cast and shows the SIZE check is what stops it.
    const spec = await jobSpec();
    const lying = { ...spec, treeBytes: spec.treeBytes + 1 } as RenderJobSpec;
    await expect(buildFrame(lying, stagedTree())).rejects.toThrow(/treeBytes/);
    const tooSmall = { ...spec, treeBytes: spec.treeBytes - 1 } as RenderJobSpec;
    await expect(buildFrame(tooSmall, stagedTree())).rejects.toThrow(/treeBytes/);
  });
});

// ===========================================================================
// T1052 - THE DECLARED DIGEST IS COMPARED, NOT MERELY VALIDATED FOR SHAPE
// ===========================================================================
//
// The real broker cannot be made to misreport its own digest: it hashes the bytes it
// validated, so the header is correct by construction and a live test would prove nothing.
// These cases therefore drive a FAKE broker - a plain `http.createServer` that answers the
// one path with whatever the test wants - because the property under test is precisely the
// thing a well-behaved broker cannot violate: what the client does when the component on
// the other end of the socket is NOT this broker. A misbehaving or substituted endpoint is
// the threat model the client exists for (ADR-044 D1: a shared secret on a loopback socket),
// so the honest test is one where the header is a lie.

interface FakeBrokerReply {
  readonly body: Buffer;
  /** What `x-clearance-sha256` claims. Deliberately not derived from `body`. */
  readonly sha256: string;
  /** Omitted means "declare the real length", which is what makes the test hard. */
  readonly bytes?: number;
  readonly mime?: string;
  readonly outcome?: string;
}

/** A broker that answers 201 with exactly the reply it is given, and touches nothing else. */
async function startFakeBroker(reply: FakeBrokerReply): Promise<{
  client: RenderBrokerClient;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    // Drain the frame so the client's write always completes, whatever the reply is.
    req.resume();
    req.once('end', () => {
      res.writeHead(201, {
        'content-type': 'application/octet-stream',
        'content-length': String(reply.body.length),
        [BROKER_RESPONSE_HEADERS.outcome]: reply.outcome ?? 'ok',
        [BROKER_RESPONSE_HEADERS.sha256]: reply.sha256,
        [BROKER_RESPONSE_HEADERS.bytes]: String(reply.bytes ?? reply.body.length),
        [BROKER_RESPONSE_HEADERS.mime]: reply.mime ?? 'application/pdf',
        [BROKER_RESPONSE_HEADERS.durationMs]: '1',
      });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    client: new RenderBrokerClient({
      endpoint: { url: `http://127.0.0.1:${port}`, token: TOKEN },
      timeoutMs: 10_000,
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('render/brokerClient T1052 - the received body is hashed and compared', () => {
  it('refuses a body that does NOT hash to the declared digest, even when everything else agrees', async () => {
    // The hard shape: the same LENGTH, so `ARTIFACT_SIZE_CHANGED` cannot catch it; the same
    // magic bytes, so `ARTIFACT_BAD_MAGIC` cannot catch it; a well-formed digest, so the
    // shape check cannot catch it. Only the digest COMPARISON can - which is exactly why it
    // was missing and why this is the fixture.
    const original = Buffer.concat([PDF_BYTES, Buffer.from('the bytes the broker hashed', 'latin1')]);
    const tampered = Buffer.concat([
      PDF_BYTES,
      // Padded to the SAME length rather than hand-counted: the point of the fixture is that
      // nothing but the digest comparison can tell the two apart.
      Buffer.from('the bytes that ARRIVED'.padEnd(original.length - PDF_BYTES.length, ' '), 'latin1'),
    ]);
    expect(tampered.length, 'the substitute is the same length as the original').toBe(original.length);
    expect(tampered.subarray(0, 5)).toEqual(Buffer.from('%PDF-', 'latin1'));

    const fake = await startFakeBroker({
      body: tampered,
      sha256: createHash('sha256').update(original).digest('hex'),
    });
    try {
      const error = await fake.client.render(await jobSpec(), stagedTree()).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(BrokerClientError);
      const clientError = error as BrokerClientError;
      expect(clientError.code).toBe('RENDER_ARTIFACT_INVALID');
      expect(clientError.reason).toBe('ARTIFACT_DIGEST_MISMATCH');
      // Fixed, user-facing text only (policy 9.3): no digest and no path in the message.
      expect(clientError.message).toBe('the rendered document could not be produced');
      expect(JSON.stringify(clientError.reason)).not.toContain(tampered.toString('latin1'));
    } finally {
      await fake.close();
    }
  });

  it('refuses a body whose declared digest belongs to an ENTIRELY different artifact', async () => {
    const fake = await startFakeBroker({
      body: PDF_BYTES,
      sha256: createHash('sha256').update('a completely different artifact').digest('hex'),
    });
    try {
      const error = await fake.client.render(await jobSpec(), stagedTree()).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(BrokerClientError);
      expect((error as BrokerClientError).code).toBe('RENDER_ARTIFACT_INVALID');
      expect((error as BrokerClientError).reason).toBe('ARTIFACT_DIGEST_MISMATCH');
    } finally {
      await fake.close();
    }
  });

  it('PASSES a body that does hash to the declared digest - the comparison is not a veto', async () => {
    // The control, and the reason the check can be added at all: an over-eager comparison
    // (a re-hash of a re-encoded body, a chunk boundary bug) would silently break every real
    // render, and only a positive case proves the negative one means something.
    const body = Buffer.concat([PDF_BYTES, Buffer.from('\n% tail\n', 'latin1')]);
    const fake = await startFakeBroker({
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
    try {
      const result = await fake.client.render(await jobSpec(), stagedTree());
      expect(result.outcome).toBe('ok');
      expect(result.artifact).toEqual(body);
      expect(result.byteSize).toBe(body.length);
      expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    } finally {
      await fake.close();
    }
  });

  it('still reports a MALFORMED digest as the contract violation it is, not as a mismatch', async () => {
    // The two faults keep separate reasons: "you sent no digest" and "your digest is a lie"
    // are different operator problems, and collapsing them would lose one of them.
    const fake = await startFakeBroker({ body: PDF_BYTES, sha256: 'not-a-digest' });
    try {
      const error = await fake.client.render(await jobSpec(), stagedTree()).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(BrokerClientError);
      expect((error as BrokerClientError).code).toBe('RENDER_ARTIFACT_INVALID');
      expect((error as BrokerClientError).reason).toBe('ARTIFACT_DIGEST_MISSING');
    } finally {
      await fake.close();
    }
  });

  it('the REAL broker still passes - the comparison costs nothing on the happy path', async () => {
    const harness = await startBroker(happyDocker());
    try {
      expect(harness.skipReason).toBeNull();
      const result = await harness.client.render(await jobSpec(), stagedTree());
      expect(result.outcome).toBe('ok');
      expect(result.sha256).toBe(createHash('sha256').update(PDF_BYTES).digest('hex'));
    } finally {
      await harness.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Raw POST, for the cases the client deliberately cannot express
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function rawPost(
  endpoint: { socketPath?: string; url?: string },
  token: string,
  body: Buffer,
  urlPath = BROKER_RENDER_PATH,
): Promise<RawResponse> {
  return rawPostTo(endpoint, token, body, urlPath);
}

function rawPostTo(
  endpoint: { socketPath?: string },
  token: string,
  body: Buffer,
  urlPath: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    };
    if (token !== '') headers[BROKER_TOKEN_HEADER] = token;
    const req = httpRequest(
      { socketPath: endpoint.socketPath, path: urlPath, method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.once('error', reject);
    req.write(body);
    req.end();
  });
}
