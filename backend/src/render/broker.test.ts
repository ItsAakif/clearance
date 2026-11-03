// Render broker - unit tests.
//
// NORMATIVE DOC: .planning/decisions/ADR-042-*.md D2/D4
//                .planning/decisions/ADR-044-*.md D1
//                .planning/specs/clearance-v2/render-sandbox-policy.md sec. 4, 6, 9, 10.2
//                .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 3, sec. 9
// Task:         T1031
//
// EVERY ACCEPTANCE BULLET IN THE TASK CONTRACT HAS A NAMED TEST HERE, and the names say
// which. The bullets, verbatim from `.planning/tasks/T1031-render-broker-service.md`:
//
//   A1  buildContainerCreateArgs output equals policy 4.7
//   A2  the JobSpec schema rejects ... (incl. the pin, with RENDER_TOOLCHAIN_MISMATCH)
//   A3  admission arithmetic: 3rd host job and 2nd per-user job queue; 9th queued is 429
//   A4  TERM -> 2 s grace -> KILL -> rm -f order, RENDER_TIMEOUT; non-zero -> COMPILE_ERROR;
//       a spool over 20 MiB -> RENDER_ARTIFACT_INVALID
//   A5  a missing worker image fails the BOOT preflight and no request reaches docker
//   A6  redaction: a canary and an unnamed absolute path both disappear; the artifact bytes
//       are unchanged; the API-visible body carries no diagnostics
//   A7  (the real-socket half lives in brokerClient.test.ts)
//
// THE FAKE RUNNER IS THE POINT. `DockerRunner` is a port, so the whole per-job sequence -
// admission, create, stage, compile, kill order, extract, validate, cleanup - is provable
// with no Docker daemon, which is what ADR-044 D1's "so the broker is unit-testable on a
// host without Docker" asks for. `FakeDocker` records the EXACT subcommand sequence, so the
// kill order is an assertion on observed calls rather than on intent.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RENDER_CONTAINER,
  RENDER_LIMITS,
  RENDER_OUTCOME_CODES,
  RENDER_PATHS,
  REQUIRED_COMPOSE_KEYS,
  REQUIRED_TMPFS,
  RENDER_QUOTA,
  TYPST_PIN,
  buildCompileArgs,
  type CompilePlan,
} from './sandbox.js';
import {
  MIN_CALLER_DATA_LEN,
  RENDER_WORKER_IMAGE,
  UNREPRESENTABLE_COMPOSE_KEYS,
  assertBindUnderHostRoot,
  assertCreateArgsInvariants,
  assertHostRoot,
  buildContainerCreateArgs,
  classifyComposeKey,
  hostBindSource,
  isAbsoluteHostPath,
  type BrokerJobSpec,
} from './broker/createArgs.js';
import { createDockerCliRunner, DEFAULT_CAPTURE_BYTES, type DockerRunOptions, type DockerRunResult, type DockerRunner } from './broker/dockerRunner.js';
import {
  REDACT_MAX_BYTES,
  REDACTED_LABELS,
  assertNoPathShapedToken,
  redactDiagnostics,
  redactPathShapes,
  redactStagedContent,
} from './broker/redact.js';
import { SPOOL_MAX_BYTES, createSpool, extractUstarToDir, stagedTextCandidates, SpoolOverflowError } from './broker/spool.js';
import {
  AdmissionController,
  BROKER_ENV_KEYS,
  BROKER_QUOTA,
  BROKER_RESPONSE_HEADERS,
  BROKER_TRANSPORT_CODES,
  Broker,
  BrokerBusyError,
  DEFAULT_HOST_ROOT,
  NODE_SOCKET_PATH_FS,
  OUTCOME_MESSAGES,
  SOCKET_PATH_REFUSAL_REASONS,
  SocketPathError,
  assertPlanEnvOnExec,
  buildCompileExecArgs,
  classifyCompileExit,
  createFrameReader,
  main,
  parseJobSpec,
  prepareSocketPath,
  releaseSocketPath,
  resolveEngineBinary,
  type BrokerQuota,
  type JobLog,
  type SocketPathFs,
  type SocketPathStat,
} from './broker/index.js';
import { openStageTreeStream, type StageTree } from './stage.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STAMP = 1_757_000_000;

/**
 * The repository root AS THE DOCKER DAEMON SEES IT (T1040 ruling 10).
 *
 * A POSIX-shaped absolute path, because that is the form the compose service supplies on a
 * Linux host and inside the Docker Desktop VM. It is a FIXTURE, not a default: the deployed
 * broker is given the real one through `RENDER_HOST_TYPST_ROOT`, and `main()` refuses to
 * boot without it (asserted by A5.5). The property every bind assertion below turns on is
 * that this is ABSOLUTE - a relative root is the defect ruling 10 exists to remove, and
 * A1.11 pins the refusal.
 */
const HOST_ROOT = '/srv/clearance/host-root';

/** The Windows spelling, asserted separately so the two forms cannot be conflated. */
const HOST_ROOT_WINDOWS = 'E:\\Projects\\Webd+AI\\Clearance';

const SPEC: BrokerJobSpec = Object.freeze({
  jobId: 'job-0001',
  engine: 'typst',
  format: 'pdf',
  templateId: 'typst-resume-classic',
  templateVersion: '1',
  expectedEngineVersion: TYPST_PIN.version,
  creationTimestampUnix: STAMP,
  treeBytes: 0,
  treeFileCount: 2,
  userId: 'user-a',
  revisionId: 'rev-1',
});

function plan(): CompilePlan {
  return buildCompileArgs('typst', { creationTimestampUnix: STAMP, format: 'pdf' });
}

/** A minimal but REAL PDF: the magic bytes policy 6.3.6 checks, plus a real trailer. */
const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.7\n', 'latin1'),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1'),
  Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
]);

/** An in-memory staged tree with the two names policy 5.1 mandates for typst. */
function stagedTree(
  overrides: { data?: string; template?: string; extra?: Array<{ name: string; bytes: string }> } = {},
): StageTree {
  const files = [
    { name: RENDER_PATHS.names.typstTemplate, bytes: Buffer.from(overrides.template ?? '#set page(width: "A4")\n', 'utf8') },
    { name: RENDER_PATHS.names.data, bytes: Buffer.from(overrides.data ?? '{"name":"Ada Lovelace"}', 'utf8') },
    ...(overrides.extra ?? []).map((file) => ({
      name: file.name,
      bytes: Buffer.from(file.bytes, 'utf8'),
    })),
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

/** The frame the broker reads: `4-byte BE L | L bytes JSON | the ustar tree`. */
async function frame(spec: Partial<BrokerJobSpec> = {}, tree = stagedTree()): Promise<Buffer> {
  const tar = await treeBytesOf(tree);
  const merged = { ...SPEC, treeBytes: tar.length, ...spec };
  const json = Buffer.from(JSON.stringify(merged), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json, tar]);
}

// ---------------------------------------------------------------------------
// The fake runner
// ---------------------------------------------------------------------------

type Handler = (argv: readonly string[], options: DockerRunOptions) => DockerRunResult | Promise<DockerRunResult>;

interface FakeDocker extends DockerRunner {
  readonly calls: Array<{ argv: readonly string[]; options: DockerRunOptions }>;
  readonly subcommands: string[][];
  handler: Handler;
}

const ok: DockerRunResult = { code: 0, stdout: '', stderr: '', signaled: false };

function fakeDocker(handler: Handler = () => ok): FakeDocker {
  const calls: Array<{ argv: readonly string[]; options: DockerRunOptions }> = [];
  const subcommands: string[][] = [];
  const runner: FakeDocker = {
    binary: 'fake-docker',
    calls,
    subcommands,
    handler,
    async run(argv: readonly string[], options: DockerRunOptions = {}): Promise<DockerRunResult> {
      calls.push({ argv: [...argv], options });
      subcommands.push([...argv]);
      return await runner.handler(argv, options);
    },
  };
  return runner;
}

/** The default happy-path handler: create prints a container id, tar -c writes a real PDF. */
function happyHandler(
  overrides: Partial<{
    compile: DockerRunResult;
    stage: DockerRunResult;
    create: DockerRunResult;
    outTar: Buffer | null;
  }> = {},
): Handler {
  const outTar = overrides.outTar === undefined ? null : overrides.outTar;
  return (argv, options) => {
    if (argv[0] === 'create') return overrides.create ?? { ...ok, stdout: 'c0ffee123456\n' };
    if (argv[0] === 'start' || argv[0] === 'rm' || argv[0] === 'kill') return ok;
    if (argv[0] === 'exec' && argv.includes('tar') && argv.includes('-x')) {
      return overrides.stage ?? ok;
    }
    if (argv[0] === 'exec' && argv.includes('tar') && argv.includes('-c')) {
      if (outTar === null) {
        // A `tar -c` of a directory holding exactly one artifact: the header, the bytes,
        // the padding, then the two zero terminator blocks.
        const tar = ustarOf('artifact.pdf', PDF_BYTES);
        if (options.stdoutTo !== undefined) {
          options.stdoutTo.write(tar);
          options.stdoutTo.end();
        }
        return ok;
      }
      if (options.stdoutTo !== undefined) {
        options.stdoutTo.write(outTar);
        options.stdoutTo.end();
      }
      return ok;
    }
    if (argv[0] === 'exec') return overrides.compile ?? ok;
    return ok;
  };
}

/** One ustar header block, checksum included. The shared builder for every archive fixture. */
function tarHeaderBlock(name: string, size: number, type: string, mode: number): Buffer {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, 'latin1');
  header.write(mode.toString(8).padStart(7, '0'), 100, 8, 'latin1');
  header.write('0000000', 108, 8, 'latin1');
  header.write('0000000', 116, 8, 'latin1');
  header.write(size.toString(8).padStart(11, '0'), 124, 12, 'latin1');
  header.write('00000000000', 136, 12, 'latin1');
  header.write(type, 156, 1, 'latin1');
  header.write('ustar\0', 257, 6, 'latin1');
  header.write('00', 263, 2, 'latin1');
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'latin1');
  header[154] = 0x00;
  header[155] = 0x20;
  return header;
}

/** Build a one-entry ustar archive. The same layout `stage.ts` writes, so the reader is
 *  exercised against the format the real producer emits rather than a convenient variant. */
function ustarOf(name: string, body: Buffer): Buffer {
  const blocks: Buffer[] = [tarHeaderBlock(name, body.length, '0', 0o600), body];
  const pad = body.length % 512;
  if (pad !== 0) blocks.push(Buffer.alloc(512 - pad, 0));
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

// ---------------------------------------------------------------------------
// Broker harness
// ---------------------------------------------------------------------------

let spoolRoot = '';
let logSink: JobLog[] = [];

function makeBroker(
  docker: DockerRunner,
  extra: { delay?: (ms: number) => Promise<void>; hostRoot?: string } = {},
): Broker {
  return new Broker({
    docker,
    now: () => Date.now(),
    log: (...args: unknown[]) => {
      for (const arg of args) {
        if (arg !== null && typeof arg === 'object' && (arg as JobLog).event === 'render.job') {
          logSink.push(arg as JobLog);
        }
      }
    },
    token: 'shared-secret-token',
    spoolRoot,
    // The host root the create argv is built against (F1). Every broker test therefore
    // exercises the host-absolute bind shape, and none of them can pass by accident on a
    // relative source.
    hostRoot: extra.hostRoot ?? HOST_ROOT,
    delay: extra.delay ?? instantBelowWallClock,
  });
}

/**
 * The default test clock: SHORT waits resolve at once, the 10 s WALL BUDGET never resolves.
 *
 * Both halves are needed. The wall budget must not expire on its own, or the happy-path
 * tests would race it; the 2 s kill grace must not be waited for, or every failure test
 * would take two seconds and the suite would time out. Splitting on the magnitude is the
 * blunt way to say "the wall budget is the only thing that must not fire", and the values
 * come from `RENDER_LIMITS` rather than from literals.
 */
function instantBelowWallClock(ms: number): Promise<void> {
  if (ms >= RENDER_LIMITS.wallClockMs) return new Promise<void>(() => undefined);
  return Promise.resolve();
}

/**
 * The INVERSE clock, for the disconnect race (F5): the wall budget is waited for REAL and
 * the 2 s kill grace is not.
 *
 * A stub that resolved the 10 s budget instantly made the clock win every race by
 * construction, which is why the disconnect test could not tell "prompt" from "eventually".
 * With a real budget, a disconnect that is not an arm of the race costs the full 10 s.
 */
function realWallClockOnly(ms: number): Promise<void> {
  if (ms < RENDER_LIMITS.wallClockMs) return Promise.resolve();
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeEach(() => {
  spoolRoot = mkdtempSync(path.join(os.tmpdir(), 'broker-test-'));
  logSink = [];
});

afterEach(() => {
  if (spoolRoot !== '') rmSync(spoolRoot, { recursive: true, force: true });
});

// ===========================================================================
// A1 - buildContainerCreateArgs equals policy 4.7
// ===========================================================================

describe('render/broker A1 - buildContainerCreateArgs output equals policy 4.7', () => {
  it('A1.1 asserts the create argv against REQUIRED_COMPOSE_KEYS and REQUIRED_TMPFS', () => {
    const args = buildContainerCreateArgs(plan(), SPEC, HOST_ROOT);
    const at = (flag: string): number => args.indexOf(flag);
    const value = (flag: string): string | undefined => args[at(flag) + 1];

    // 4.1 network. Not asserted as a literal 'none' copied here: the flag is READ OUT OF
    // the policy table, so the two cannot drift.
    expect(at('--network')).toBeGreaterThanOrEqual(0);
    expect(value('--network')).toBe(REQUIRED_COMPOSE_KEYS.network_mode);
    // 4.3 filesystem
    expect(args).toContain('--read-only');
    expect(value('--ipc')).toBe('none');
    // 4.2 identity
    expect(value('--user')).toBe(RENDER_CONTAINER.user);
    expect(args[at('--cap-drop') + 1]).toBe('ALL');
    expect(args[at('--security-opt') + 1]).toBe('no-new-privileges:true');
    // 4.6 caps
    expect(value('--pids-limit')).toBe(String(RENDER_LIMITS.pids));
    expect(value('--memory')).toBe('1073741824');
    expect(value('--memory-swap')).toBe('1073741824');
    expect(value('--cpus')).toBe('1');
    expect(value('--stop-timeout')).toBe('5');
    // 4.4 tmpfs, taken verbatim from the policy table.
    const tmpfs = args.filter((_token, index) => args[index - 1] === '--tmpfs');
    expect(tmpfs).toEqual([...REQUIRED_TMPFS]);
  });

  it('A1.2 has EXACTLY three read-only binds, all HOST-ABSOLUTE under the host root, and no socket or host path', () => {
    const args = buildContainerCreateArgs(plan(), SPEC, HOST_ROOT);
    const mounts = args.filter((_token, index) => args[index - 1] === '--mount');
    expect(mounts).toHaveLength(3);
    for (const mount of mounts) {
      expect(mount.startsWith('type=bind,')).toBe(true);
      expect(mount).toContain('readonly');
      const source = /source=([^,]+)/.exec(mount)?.[1] as string;
      const target = /target=([^,]+)/.exec(mount)?.[1] as string;
      // F1. The source is a path the DOCKER DAEMON can resolve, not a `./`-relative string
      // the CLI would expand against its own CWD - which, inside the broker container, is
      // `/app` and holds no repository, so `docker create` failed on every job.
      expect(isAbsoluteHostPath(source)).toBe(true);
      expect(source.startsWith('./')).toBe(false);
      expect(source.startsWith(`${HOST_ROOT}/`)).toBe(true);
      expect(source).toContain('/backend/typst/');
      expect(source).not.toContain('..');
      expect(source).not.toContain('docker.sock');
      expect(target).not.toContain('docker.sock');
      expect(RENDER_CONTAINER.forbiddenBindTargets).not.toContain(target);
    }
    // The full argv carries no docker socket and no pgdata anywhere, as a raw string search.
    const joined = args.join('|');
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toContain('pgdata');
    expect(joined).not.toContain('/etc');
    expect(joined).not.toContain('/proc');
    // And NO relative mount path remains anywhere in the argv, in either spelling.
    for (const token of args) {
      if (token.startsWith('source=')) expect(isAbsoluteHostPath(token.slice('source='.length))).toBe(true);
    }
  });

  it('A1.3 is not privileged and opens no stdin or tty', () => {
    const args = buildContainerCreateArgs(plan(), SPEC, HOST_ROOT);
    expect(args).not.toContain('--privileged');
    expect(args).not.toContain('-i');
    expect(args).not.toContain('--interactive');
    expect(args).not.toContain('-t');
    expect(args).not.toContain('--tty');
    expect(args).not.toContain('--restart');
  });

  it('A1.4 every policy key is classified, and an UNCLASSIFIED key is refused', () => {
    // Partition: every key is either emitted as a flag or declared unrepresentable.
    for (const key of Object.keys(REQUIRED_COMPOSE_KEYS)) {
      const kind = classifyComposeKey(key).kind;
      expect(['flag', 'absent']).toContain(kind);
    }
    expect(Object.keys(UNREPRESENTABLE_COMPOSE_KEYS).sort()).toEqual([
      'oom_kill_disable',
      'privileged',
      'restart',
      'stdin_open',
      'tty',
    ]);
    // And the third kind is REACHABLE, so the partition above is not vacuous: a policy key
    // nobody classified throws rather than being silently unenforced. The policy table is
    // frozen, so the synthetic key is the only way to demonstrate the branch.
    expect(classifyComposeKey('brand_new_policy_key')).toEqual({ kind: 'unclassified' });
  });

  it('A1.5 the create environment is EXACTLY plan.env - never merged with an ambient one', () => {
    const compilePlan = plan();
    const args = buildContainerCreateArgs(compilePlan, SPEC, HOST_ROOT);
    const envPairs = args
      .map((token, index) => (args[index - 1] === '--env' ? token : undefined))
      .filter((token): token is string => token !== undefined);
    expect(envPairs.sort()).toEqual(
      Object.entries(compilePlan.env)
        .map(([key, value]) => `${key}=${value}`)
        .sort(),
    );
    // XDG_CACHE_HOME is the mandated ABSENCE (policy 3.4), so it must not appear at all -
    // not even as an empty value.
    expect(args).not.toContain('XDG_CACHE_HOME=');
    expect(envPairs.every((pair) => !pair.startsWith('TYPST_CERT='))).toBe(true);
    expect(envPairs.every((pair) => !pair.startsWith('HOME=') || pair === 'HOME=/nonexistent')).toBe(true);
  });

  it('A1.6 the image is the pin, the entrypoint is the PID-1 holder, and it is last-but-two', () => {
    const args = buildContainerCreateArgs(plan(), SPEC, HOST_ROOT);
    expect(args[args.length - 2]).toBe(RENDER_WORKER_IMAGE);
    expect(RENDER_WORKER_IMAGE).toBe(`clearance/typst-worker:${TYPST_PIN.version}`);
    expect(args[args.length - 1]).toBe('infinity');
    expect(args[args.length - 4]).toBe('--entrypoint');
    expect(args[args.length - 3]).toBe('/bin/sleep');
    expect(args).toContain('--workdir');
    expect(args[args.indexOf('--workdir') + 1]).toBe(RENDER_PATHS.work);
  });

  it('A1.7 no caller-supplied value appears anywhere in the create argv', () => {
    const args = buildContainerCreateArgs(plan(), {
      ...SPEC,
      jobId: 'ZZjobZZ',
      userId: 'ZZuserZZ',
      revisionId: 'ZZrevZZ',
      templateId: 'ZZtplZZ',
      templateVersion: 'ZZverZZ',
    }, HOST_ROOT);
    const joined = args.join('|');
    for (const marker of ['ZZjobZZ', 'ZZuserZZ', 'ZZrevZZ', 'ZZtplZZ', 'ZZverZZ']) {
      expect(joined).not.toContain(marker);
    }
  });

  it('A1.7b a short caller value (templateVersion "1") is not a false positive', () => {
    // The caller-data assertion is a substring search with a floor, because `1` collides with
    // the `--cpus 1` policy value byte for byte. A floor that ignored this would make the
    // assertion unsatisfiable, and an unsatisfiable assertion is not a control.
    expect(() => buildContainerCreateArgs(plan(), { ...SPEC, templateVersion: '1' }, HOST_ROOT)).not.toThrow();
    expect(MIN_CALLER_DATA_LEN).toBe(4);
  });

  it('A1.8 the builder is PURE: the same inputs produce an identical argv', () => {
    const first = buildContainerCreateArgs(plan(), SPEC, HOST_ROOT);
    const second = buildContainerCreateArgs(plan(), SPEC, HOST_ROOT);
    expect([...first]).toEqual([...second]);
    // Purity includes the host root being a PARAMETER rather than an environment read: a
    // builder that read `process.env` itself would produce a different argv in the container
    // than in a test, which is the class of difference this whole mechanism exists to remove.
    const other = buildContainerCreateArgs(plan(), SPEC, '/somewhere/else');
    expect([...other]).not.toEqual([...first]);
  });

  it('A1.9 a pin mismatch is refused by the builder itself, not only by the plan builder', () => {
    expect(() =>
      buildContainerCreateArgs(plan(), { ...SPEC, expectedEngineVersion: '0.0.1' }, HOST_ROOT),
    ).toThrow(/^RENDER_TOOLCHAIN_MISMATCH/);
  });

  it('A1.10 MUTATION TARGETS: a weakened argv is refused by assertCreateArgsInvariants', () => {
    const good = [...buildContainerCreateArgs(plan(), SPEC, HOST_ROOT)];
    const mutate = (fn: (argv: string[]) => string[]): string[] => fn([...good]);

    // Each of these is a plausible future edit, and each must throw.
    const mutations: Array<[string, string[]]> = [
      ['drop --read-only', mutate((argv) => argv.filter((token) => token !== '--read-only'))],
      ['widen the network', mutate((argv) => replaceValue(argv, '--network', 'host'))],
      ['add --privileged', mutate((argv) => [...argv.slice(0, 2), '--privileged', ...argv.slice(2)])],
      [
        'add a fourth bind (the docker socket)',
        mutate((argv) => [
          ...argv,
          '--mount',
          'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly',
        ]),
      ],
      [
        'add a host-path bind',
        mutate((argv) => [
          ...argv,
          '--mount',
          'type=bind,source=/etc,target=/etc,readonly',
        ]),
      ],
      [
        'add a pgdata bind',
        mutate((argv) => [
          ...argv,
          '--mount',
          `type=bind,source=${HOST_ROOT}/pgdata,target=/pgdata,readonly`,
        ]),
      ],
      [
        // F1's shape, as a mutation: a bind that is ABSOLUTE but sits OUTSIDE the host root.
        // This is the case containment exists for, and it is a real edit - widening the
        // toolchain bind to "whatever the operator has checked out".
        'repoint a bind outside the host root',
        mutate((argv) =>
          argv.map((token) =>
            token.startsWith('type=bind,source=') ? token.replace(`${HOST_ROOT}/backend`, '/opt/somewhere-else/backend') : token,
          ),
        ),
      ],
      [
        // ...and its sibling: a source that is no longer absolute at all, i.e. the pre-ruling
        // behaviour. The docker CLI would expand it against its own CWD.
        'restore a repo-relative bind source',
        mutate((argv) =>
          argv.map((token) =>
            token.startsWith('type=bind,source=') ? token.replace(/source=[^,]+/, 'source=./backend/typst/toolchain') : token,
          ),
        ),
      ],
      ['relax the pids limit', mutate((argv) => replaceValue(argv, '--pids-limit', '4096'))],
      ['lift the memory cap', mutate((argv) => replaceValue(argv, '--memory', '2147483648'))],
      ['add swap escape', mutate((argv) => replaceValue(argv, '--memory-swap', '4294967296'))],
      ['widen the tmpfs', mutate((argv) => replaceValue(argv, '--tmpfs', '/work:rw,size=1g'))],
      ['drop cap_drop', mutate((argv) => withoutPair(argv, '--cap-drop', 'ALL'))],
      [
        'add an ambient env key (TYPST_CERT)',
        mutate((argv) => [...argv, '--env', 'TYPST_CERT=/etc/passwd']),
      ],
      [
        'override the image entrypoint',
        mutate((argv) => replaceValue(argv, '--entrypoint', '/opt/typst/typst')),
      ],
      [
        'duplicate the network flag',
        mutate((argv) => [...argv.slice(0, 2), '--network', 'bridge', ...argv.slice(2)]),
      ],
      [
        'short-form volume (no read_only expressible)',
        mutate((argv) => [...argv.slice(0, 2), '-v', './x:/x', ...argv.slice(2)]),
      ],
    ];

    for (const [name, mutated] of mutations) {
      expect(`${name}: ${(() => { try { assertCreateArgsInvariants(mutated, plan(), SPEC, HOST_ROOT); return 'accepted'; } catch { return 'refused'; } })()}`).toBe(
        `${name}: refused`,
      );
    }
    // And the unmutated argv is still accepted, so the assertions above are not vacuous.
    expect(() => assertCreateArgsInvariants(good, plan(), SPEC, HOST_ROOT)).not.toThrow();
  });

  it('A1.11 MUTATION TARGET: a bind OUTSIDE the host root, or a relative root, is refused', () => {
    // The negative half of F1, and the assertion the ruling names: all three binds must be
    // underneath the supplied host root and read-only, and no relative mount path may remain.
    const good = [...buildContainerCreateArgs(plan(), SPEC, HOST_ROOT)];
    const host = assertHostRoot(HOST_ROOT);

    // (a) containment, as a unit: a source that climbs out with `..`, and one that is simply
    //     somewhere else on the host. Both are refused with the containment message.
    for (const outside of [
      `${HOST_ROOT}/../secrets`,
      '/etc',
      '/var/run/docker.sock',
      `${HOST_ROOT}-evil/backend/typst/toolchain`,
      HOST_ROOT,
    ]) {
      expect(`${outside}: ${(() => { try { assertBindUnderHostRoot(outside, host); return 'accepted'; } catch { return 'refused'; } })()}`).toBe(
        `${outside}: refused`,
      );
    }
    // The REASON is asserted, not just the refusal: "that path is not under the root you
    // configured" and "a bind may not be the root itself or escape it" are different operator
    // stories, and asserting the message is what makes each guard separately killable in the
    // mutation table instead of one guard silently covering for the other.
    expect(() =>
      assertBindUnderHostRoot(`${HOST_ROOT}-evil/backend/typst/toolchain`, host),
    ).toThrow(/must live under the host repository root/);
    expect(() => assertBindUnderHostRoot(`${HOST_ROOT}/../secrets`, host)).toThrow(
      /may not be the host root itself or escape it/,
    );
    expect(() => assertBindUnderHostRoot(HOST_ROOT, host)).toThrow(
      /must live under the host repository root/,
    );
    // (b) a relative source is refused even though it is "inside" the repo conceptually: this
    //     is the pre-ruling argv and the exact shape that made the compose service fail.
    for (const relative of ['./backend/typst/toolchain', 'backend/typst/toolchain']) {
      expect(isAbsoluteHostPath(relative)).toBe(false);
      expect(() => assertBindUnderHostRoot(relative, host), relative).toThrow(/may not be relative/);
    }
    // (c) the builder itself refuses a host root that is not absolute - so the defect cannot
    //     be reintroduced by configuration, and there is deliberately no relative fallback.
    for (const bad of ['', '.', './backend', 'backend', 'relative/root', '..', `${HOST_ROOT}/..`, '/root,source=/etc', '/root=evil']) {
      expect(`${bad}: ${(() => { try { buildContainerCreateArgs(plan(), SPEC, bad); return 'accepted'; } catch { return 'refused'; } })()}`).toBe(
        `${bad}: refused`,
      );
    }
    // The message, for the two refusal classes: "you gave me a relative path" and "that value
    // could inject a field into the --mount string I build" are different deploy-time fixes.
    expect(() => buildContainerCreateArgs(plan(), SPEC, 'relative/root')).toThrow(
      /must be an absolute path/,
    );
    expect(() => buildContainerCreateArgs(plan(), SPEC, '/root,source=/etc')).toThrow(
      /NUL, a comma or an equals sign/,
    );
    expect(() => buildContainerCreateArgs(plan(), SPEC, '/root/../root')).toThrow(/".." segment/);
    // (d) the containment check is re-derived on the argv, so a HAND-MUTATED argv is held to
    //     the same rule - not merely the builder that produced it.
    const repointed = good.map((token) =>
      token.startsWith('type=bind,source=')
        ? token.replace(/source=[^,]+/, 'source=/opt/typst/elsewhere')
        : token,
    );
    expect(() => assertCreateArgsInvariants(repointed, plan(), SPEC, HOST_ROOT)).toThrow(
      /RENDER_POLICY_VIOLATION/,
    );
    // (e) the Windows spelling produces a Windows-shaped source, never a mixed-separator one.
    const win = buildContainerCreateArgs(plan(), SPEC, HOST_ROOT_WINDOWS);
    const winSource = (win.find((_t, i) => win[i - 1] === '--mount') as string).match(/source=([^,]+)/)?.[1] as string;
    expect(winSource).toBe(`${HOST_ROOT_WINDOWS}\\backend\\typst\\toolchain`);
    expect(winSource).not.toContain('/');
    // (f) the expansion is exactly the policy's repo-relative path under the root - the policy
    //     table is untouched, only the expansion is explicit.
    expect(hostBindSource(host, './backend/typst/fonts')).toBe(`${HOST_ROOT}/backend/typst/fonts`);
    expect(() => hostBindSource(host, '/backend/typst/fonts')).toThrow(/RENDER_POLICY_VIOLATION/);
    expect(DEFAULT_HOST_ROOT.startsWith('/')).toBe(true);
  });
});

function replaceValue(argv: string[], flag: string, value: string): string[] {
  const at = argv.indexOf(flag);
  if (at === -1) return argv;
  const copy = [...argv];
  copy[at + 1] = value;
  return copy;
}

function withoutPair(argv: string[], flag: string, value: string): string[] {
  const at = argv.indexOf(flag);
  if (at === -1) return argv;
  return [...argv.slice(0, at), ...argv.slice(at + 2)].filter((token) => token !== value);
}

// ===========================================================================
// A2 - the JobSpec schema
// ===========================================================================

describe('render/broker A2 - the JobSpec schema is closed', () => {
  it('A2.1 accepts the canonical spec and freezes it', () => {
    const parsed = parseJobSpec({ ...SPEC, treeBytes: 1000 });
    expect(parsed.engine).toBe('typst');
    expect(parsed.format).toBe('pdf');
    expect(parsed.expectedEngineVersion).toBe(TYPST_PIN.version);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('A2.2 rejects an unknown engine with ENGINE_UNSUPPORTED', () => {
    expect(() => parseJobSpec({ ...SPEC, engine: 'xelatex' })).toThrow(/ENGINE_UNSUPPORTED/);
  });

  it('A2.3 rejects a non-pdf format with FORMAT_UNSUPPORTED', () => {
    expect(() => parseJobSpec({ ...SPEC, format: 'svg' })).toThrow(/FORMAT_UNSUPPORTED/);
    expect(() => parseJobSpec({ ...SPEC, format: 'typ' })).toThrow(/FORMAT_UNSUPPORTED/);
  });

  it('A2.4 rejects a missing or non-integer creationTimestampUnix', () => {
    const { creationTimestampUnix: _drop, ...missing } = SPEC;
    expect(() => parseJobSpec(missing)).toThrow(/SPEC_MISSING_KEY/);
    expect(() => parseJobSpec({ ...SPEC, creationTimestampUnix: 1.5 })).toThrow(/SPEC_FIELD_TYPE/);
    expect(() => parseJobSpec({ ...SPEC, creationTimestampUnix: '1757000000' })).toThrow(/SPEC_FIELD_TYPE/);
    expect(() => parseJobSpec({ ...SPEC, creationTimestampUnix: -1 })).toThrow(/TIMESTAMP_INVALID/);
  });

  it('A2.5 rejects treeBytes over 8 MiB with RENDER_INPUT_TOO_LARGE', () => {
    expect(RENDER_LIMITS.inputTotalBytes).toBe(8_388_608);
    expect(() => parseJobSpec({ ...SPEC, treeBytes: 8_388_608 })).not.toThrow();
    const error = catchJobSpecError({ ...SPEC, treeBytes: 8_388_609 });
    expect(error.code).toBe('RENDER_INPUT_TOO_LARGE');
    expect(error.reason).toBe('TREE_BYTES_OUT_OF_RANGE');
  });

  it('A2.6 rejects treeFileCount over 5 with RENDER_INPUT_TOO_LARGE', () => {
    expect(RENDER_LIMITS.inputFileCount).toBe(5);
    expect(() => parseJobSpec({ ...SPEC, treeFileCount: 5 })).not.toThrow();
    const error = catchJobSpecError({ ...SPEC, treeFileCount: 6 });
    expect(error.code).toBe('RENDER_INPUT_TOO_LARGE');
    expect(error.reason).toBe('TREE_FILE_COUNT_OUT_OF_RANGE');
  });

  it('A2.7 a typst pin mismatch is RENDER_TOOLCHAIN_MISMATCH', () => {
    const error = catchJobSpecError({ ...SPEC, expectedEngineVersion: '0.14.0' });
    expect(error.code).toBe('RENDER_TOOLCHAIN_MISMATCH');
    expect(error.reason).toBe('ENGINE_VERSION_MISMATCH');
  });

  it('A2.8 an unknown key is a rejection, not a strip', () => {
    expect(() => parseJobSpec({ ...SPEC, surprise: 1 })).toThrow(/SPEC_UNKNOWN_KEY/);
  });

  it('A2.9 a control character in an id field is refused (log-injection shape)', () => {
    expect(() => parseJobSpec({ ...SPEC, templateId: 'a\nb' })).toThrow(/SPEC_FIELD_TYPE/);
  });

  it('A2.10 the transport vocabulary is DISJOINT from the policy outcome set', () => {
    for (const code of BROKER_TRANSPORT_CODES) {
      expect((RENDER_OUTCOME_CODES as readonly string[])).not.toContain(code);
    }
  });

  it('A2.11 RENDER_OUTCOME_CODES is UNCHANGED - no new outcome code was added', () => {
    expect([...RENDER_OUTCOME_CODES]).toEqual([
      'ok',
      'RENDER_COMPILE_ERROR',
      'RENDER_TIMEOUT',
      'RENDER_RESOURCE_LIMIT',
      'RENDER_ARTIFACT_INVALID',
      'RENDER_INPUT_TOO_LARGE',
      'RENDER_TOOLCHAIN_MISMATCH',
      'RENDER_BUSY',
    ]);
  });

  it('A2.12 every user-facing message is a FIXED policy 9.2 string, with no interpolation', () => {
    expect(OUTCOME_MESSAGES.RENDER_COMPILE_ERROR).toBe(
      'This template could not be rendered. Check your content and try again.',
    );
    expect(OUTCOME_MESSAGES.RENDER_TIMEOUT).toBe('Rendering took too long and was stopped.');
    expect(OUTCOME_MESSAGES.RENDER_RESOURCE_LIMIT).toBe(
      'This document is too large or complex to render.',
    );
    expect(OUTCOME_MESSAGES.RENDER_INPUT_TOO_LARGE).toBe('This document is too large to render.');
    expect(OUTCOME_MESSAGES.RENDER_TOOLCHAIN_MISMATCH).toBe(
      'This template needs a different rendering engine version.',
    );
    for (const message of Object.values(OUTCOME_MESSAGES)) {
      expect(message).not.toContain('/');
      expect(message).not.toContain('%');
      expect(message).not.toMatch(/\{\{|\$\{/);
    }
  });
});

function catchJobSpecError(input: unknown): { code: string; reason: string } {
  try {
    parseJobSpec(input);
  } catch (error) {
    return error as { code: string; reason: string };
  }
  throw new Error('expected the spec to be rejected');
}

// ===========================================================================
// A3 - admission arithmetic
// ===========================================================================

describe('render/broker A3 - admission arithmetic (policy 10.2)', () => {
  it('A3.1 the policy defaults are host 2 / per-user 1 / queue 8', () => {
    expect(BROKER_QUOTA).toEqual({
      concurrentPerHost: 2,
      concurrentPerUser: 1,
      queueDepth: 8,
    });
    expect(BROKER_QUOTA.concurrentPerHost).toBe(RENDER_QUOTA.concurrentPerHost);
    expect(BROKER_QUOTA.concurrentPerUser).toBe(RENDER_QUOTA.concurrentPerUser);
    expect(BROKER_QUOTA.queueDepth).toBe(RENDER_QUOTA.queueDepth);
  });

  it('A3.2 a 3rd concurrent HOST job QUEUES rather than being refused', async () => {
    const quota: BrokerQuota = { concurrentPerHost: 2, concurrentPerUser: 1, queueDepth: 8 };
    const controller = new AdmissionController(quota);
    await controller.acquire('u1');
    await controller.acquire('u2');
    let third = 'pending';
    const queued = controller.acquire('u3').then(() => {
      third = 'granted';
    });
    await flush();
    expect(controller.running).toBe(2);
    expect(controller.queued).toBe(1);
    expect(third).toBe('pending');

    controller.release('u1');
    await queued;
    expect(third).toBe('granted');
    expect(controller.running).toBe(2);
    expect(controller.queued).toBe(0);
  });

  it('A3.3 a 2nd concurrent PER-USER job queues while a slot is free on the host', async () => {
    const controller = new AdmissionController({
      concurrentPerHost: 2,
      concurrentPerUser: 1,
      queueDepth: 8,
    });
    await controller.acquire('same');
    expect(controller.running).toBe(1);
    expect(controller.isRunning('same')).toBe(true);
    let granted = false;
    const queued = controller.acquire('same').then(() => {
      granted = true;
    });
    await flush();
    expect(granted).toBe(false);
    expect(controller.queued).toBe(1);
    expect(controller.running).toBe(1);

    controller.release('same');
    await queued;
    expect(granted).toBe(true);
    expect(controller.queued).toBe(0);
  });

  it('A3.4 the 9th QUEUED job is refused with RENDER_BUSY', async () => {
    const controller = new AdmissionController({
      concurrentPerHost: 2,
      concurrentPerUser: 1,
      queueDepth: 8,
    });
    await controller.acquire('running-1');
    await controller.acquire('running-2');
    const queued: Array<Promise<void>> = [];
    for (let index = 0; index < 8; index += 1) {
      queued.push(controller.acquire(`queued-${index}`));
    }
    await flush();
    expect(controller.running).toBe(2);
    expect(controller.queued).toBe(8);

    // The 9th queued job: refused, not queued.
    const refused = await controller.acquire('queued-9').then(
      () => 'granted',
      (error: unknown) => (error instanceof BrokerBusyError ? error.code : 'other'),
    );
    expect(refused).toBe('RENDER_BUSY');
    expect(controller.queued).toBe(8);
    void queued;
  });

  it('A3.4b a free host slot does NOT let a new job leapfrog the queue (fairness)', async () => {
    // The `waiters.length === 0` clause in `acquire` exists for exactly this shape, and it is
    // the one arithmetic rule a mutation can remove while leaving A3.1-A3.4 green: a DIFFERENT
    // user is waiting (the per-user limit held them), the host still has a free slot, and a
    // brand-new job for a THIRD user arrives. `fits()` says yes; the queue-empty clause says
    // wait. FIFO is part of the contract, not a nicety - a job that can leapfrog a queue can
    // starve one indefinitely.
    const controller = new AdmissionController({
      concurrentPerHost: 2,
      concurrentPerUser: 1,
      queueDepth: 8,
    });
    await controller.acquire('busy-user');
    // A second job for the SAME user queues on the per-user limit, with a free host slot.
    const waiting = controller.acquire('busy-user');
    await flush();
    expect(controller.running).toBe(1);
    expect(controller.queued).toBe(1);

    // A newcomer for a DIFFERENT user fits the host right now.
    let ranImmediately = false;
    const newcomer = controller.acquire('newcomer').then(() => {
      ranImmediately = true;
    });
    await flush();
    expect(ranImmediately).toBe(false);
    expect(controller.queued).toBe(2);
    expect(controller.running).toBe(1);

    // Draining proves FIFO, not merely "eventually runs".
    controller.release('busy-user');
    await waiting;
    await newcomer;
    expect(ranImmediately).toBe(true);
    expect(controller.queued).toBe(0);
  });

  it('A3.5 a busy host returns 429 RENDER_BUSY and creates NO container', async () => {
    // Two real jobs pinned on the compile step, so the third is a real request through the
    // real `handle` rather than a controller unit call. They carry DIFFERENT user ids,
    // because the per-user limit of 1 is a separate control (A3.3) and using one user here
    // would test that control instead of the host one.
    const docker = fakeDocker((argv, options) => {
      if (argv[0] === 'create') return { ...ok, stdout: `c${docker.calls.length}\n` };
      if (isCompileExec(argv)) {
        return new Promise<DockerRunResult>(() => undefined);
      }
      return happyHandler()(argv, options);
    });
    const broker = makeBroker(docker);

    const pinned = [
      broker.handle({
        token: 'shared-secret-token',
        body: Readable.from(await frame({ userId: 'user-1' })),
      }),
      broker.handle({
        token: 'shared-secret-token',
        body: Readable.from(await frame({ userId: 'user-2' })),
      }),
    ];
    expect(pinned).toHaveLength(2);
    await waitFor(() => broker.quota.running === 2);
    // Fill the queue to its policy depth of 8. These requests are genuinely pending, which is
    // the behaviour being demonstrated: a queued job is not a dropped job.
    const queued: Array<Promise<unknown>> = [];
    for (let index = 0; index < 8; index += 1) {
      queued.push(
        broker.handle({
          token: 'shared-secret-token',
          body: Readable.from(await frame({ userId: `queued-${index}` })),
        }),
      );
    }
    await waitFor(() => broker.quota.queued === 8);

    // The 9th queued job: refused, before any container exists.
    const ninth = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame({ userId: 'queued-9' })),
    });
    expect(ninth.status).toBe(429);
    expect(JSON.parse(ninth.body.toString('utf8')).code).toBe('RENDER_BUSY');
    // Two `create` calls (one per pinned job) and no more: the refusal happened BEFORE the
    // container step, which is the whole point of taking the slot first.
    expect(docker.calls.filter((call) => call.argv[0] === 'create')).toHaveLength(2);
    expect(broker.quota.queued).toBe(8);
    expect(queued).toHaveLength(8);
  });

  it('A3.6 MUTATION TARGET: with queueDepth 9 the 9th queued job would be accepted', async () => {
    // The refusal is arithmetic, not a hard-coded "8", so this is the falsifying shape.
    const relaxed = new AdmissionController({
      concurrentPerHost: 2,
      concurrentPerUser: 1,
      queueDepth: 9,
    });
    await relaxed.acquire('r1');
    await relaxed.acquire('r2');
    const queued: Array<Promise<void>> = [];
    for (let index = 0; index < 9; index += 1) queued.push(relaxed.acquire(`q${index}`));
    await flush();
    expect(relaxed.queued).toBe(9);
    expect(await relaxed.acquire('q9').then(() => 'granted', () => 'refused')).toBe('refused');
    void queued;
  });

  it('A3.7 MUTATION TARGET: a full queue is 429 WITHOUT the tree ever being read', async () => {
    // T1040 ruling 12. The order is the whole claim: the spec is read (bounded at 64 KiB),
    // admission is taken on the strength of its `userId`, and the TREE is read only by a job
    // that holds a slot. Read the other way round, N concurrent authenticated requests would
    // each buffer up to 8 MiB before any of them was run, queued or refused - so the
    // concurrency and queue-depth controls would bound nothing at all, and a 429 would cost
    // the broker as much memory as a render.
    const pinned = fakeDocker((argv, options) => {
      if (argv[0] === 'create') return { ...ok, stdout: `c${pinned.calls.length}\n` };
      if (isCompileExec(argv)) return new Promise<DockerRunResult>(() => undefined);
      return happyHandler()(argv, options);
    });
    const broker = makeBroker(pinned);
    const running = [
      broker.handle({ token: 'shared-secret-token', body: Readable.from(await frame({ userId: 'u1' })) }),
      broker.handle({ token: 'shared-secret-token', body: Readable.from(await frame({ userId: 'u2' })) }),
    ];
    await waitFor(() => broker.quota.running === 2);
    const queued: Array<Promise<unknown>> = [];
    for (let index = 0; index < 8; index += 1) {
      queued.push(
        broker.handle({ token: 'shared-secret-token', body: Readable.from(await frame({ userId: `q${index}` })) }),
      );
    }
    await waitFor(() => broker.quota.queued === 8);

    // The 9th job, with a body that COUNTS what the broker pulled off it. The spec is two
    // chunks; the tree is sixteen, so "the tree was read" is an unambiguous sixteen-chunk
    // difference rather than a byte-count guess.
    const refusedBody = chunkedProbeBody(await frame({ userId: 'q9' }), 16);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: refusedBody,
    });
    expect(response.status).toBe(429);
    expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({
      code: 'RENDER_BUSY',
      reason: 'ADMISSION_QUEUE_FULL',
    });
    // ONLY the prefix and the spec were pulled. Not one tree chunk.
    expect(refusedBody.pulled).toBe(2);
    expect(pinned.calls.filter((call) => call.argv[0] === 'create')).toHaveLength(2);
    void running;
    void queued;
  });

  it('A3.7b the same body IS read in full when the queue has room (the probe is not inert)', async () => {
    const docker = fakeDocker(happyHandler());
    const broker = makeBroker(docker);
    const admitted = chunkedProbeBody(await frame(), 16);
    const response = await broker.handle({ token: 'shared-secret-token', body: admitted });
    expect(response.status).toBe(201);
    // 1 prefix + 1 spec + 16 tree chunks: the counting is real, so A3.7's `2` means something.
    expect(admitted.pulled).toBe(18);
  });

  it('A3.8 MUTATION TARGET: drain() does NOT decrement the host counter', async () => {
    // A queued waiter has not been granted a slot - `take()` runs in `pump()`. Releasing "on
    // its behalf" made `running` read 0 while the granted jobs were still executing, so the
    // counter lied for the length of a shutdown.
    const controller = new AdmissionController({
      concurrentPerHost: 2,
      concurrentPerUser: 1,
      queueDepth: 8,
    });
    await controller.acquire('u1');
    await controller.acquire('u2');
    const queued: Array<Promise<void>> = [];
    for (let index = 0; index < 4; index += 1) queued.push(controller.acquire(`q${index}`));
    await flush();
    expect(controller.running).toBe(2);
    expect(controller.queued).toBe(4);
    controller.drain();
    await flush();
    expect(controller.queued).toBe(0);
    expect(controller.running).toBe(2);
    void queued;
  });
});

/**
 * A frame delivered as N+2 chunks, counting how many the CONSUMER actually pulled.
 *
 * A `Readable.from(buffer)` cannot be used for this: it hands the whole body over in one
 * chunk, so "did the broker stop reading early" would be unobservable. This source is a
 * paused `Readable` that pushes exactly one chunk per `_read`, so `pulled` is the number of
 * chunks the broker's async iterator asked for - which is the property A3.7 is about.
 */
function chunkedProbeBody(frame: Buffer, treeChunks: number): Readable & { pulled: number } {
  const specLength = frame.readUInt32BE(0);
  const parts: Buffer[] = [
    frame.subarray(0, 4),
    frame.subarray(4, 4 + specLength),
  ];
  const tree = frame.subarray(4 + specLength);
  const size = Math.max(1, Math.ceil(tree.length / Math.max(1, treeChunks)));
  for (let at = 0; at < tree.length; at += size) {
    parts.push(tree.subarray(at, Math.min(tree.length, at + size)));
  }
  const probe = new Readable({
    read() {
      const chunk = parts[probe.pulled];
      if (chunk === undefined) {
        this.push(null);
        return;
      }
      probe.pulled += 1;
      this.push(chunk);
    },
  }) as Readable & { pulled: number };
  probe.pulled = 0;
  return probe;
}

/**
 * Is this `docker exec` the COMPILE?
 *
 * Identified by what it is NOT: a staging exec carries `tar -x`, an extraction exec carries
 * `tar -c`, and the compile carries the engine's own subcommand. Matching on the engine
 * BINARY NAME was the obvious alternative and it silently broke the moment the binary became
 * an absolute path (see `resolveEngineBinary`), which is exactly the kind of coupling this
 * helper exists to avoid.
 */
function isCompileExec(argv: readonly string[]): boolean {
  return argv[0] === 'exec' && !argv.includes('tar');
}
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Let every already-scheduled tick, and Node's unhandled-rejection check, run.
 *
 * `setImmediate` twice is the smallest thing that reliably gets past the `process.nextTick`
 * queue (where a `Writable`'s `'error'` is emitted), past the `setImmediate` queue (where a
 * real `docker` child delivers stdout), and past the end-of-turn sweep in which Node reports
 * a promise that is still rejected with no handler.
 */
async function settle(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** `waitForSink` without the import: the test only needs "the sink is finished". */
async function waitForSinkQuiet(sink: { once: (event: string, listener: () => void) => unknown }): Promise<void> {
  if ((sink as { writableFinished?: boolean }).writableFinished === true) return;
  await new Promise<void>((resolve) => {
    sink.once('close', () => resolve());
    sink.once('finish', () => resolve());
    sink.once('error', () => resolve());
  });
}

/**
 * A PROCESS-level `unhandledRejection` tripwire.
 *
 * The defect F2 is about is invisible from inside a test: an unobserved `Writable` 'error'
 * and an unobserved rejected promise are both reported by Node to the process, not to the
 * stream, and a promise that rejects one turn later can be observed by nobody at all. A
 * retry or a re-assertion would not catch either, so the assertion has to be on the process
 * and the reading has to be taken after the event loop has had a turn to report.
 */
function installUnhandledRejectionTripwire(): { read: () => string[]; remove: () => void } {
  const seen: string[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
  };
  process.on('unhandledRejection', listener);
  return { read: () => [...seen], remove: () => process.off('unhandledRejection', listener) };
}

// ===========================================================================
// A4 - the per-job sequence, the kill order and the spool bound
// ===========================================================================

describe('render/broker A4 - per-job sequence, kill order and the spool bound', () => {
  it('A4.1 a successful render walks the whole sequence and leaves nothing behind', async () => {
    const docker = fakeDocker(happyHandler());
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    // A non-201 here is always a broker-side exception; surface the reason rather than
    // making the reader reverse-engineer a status code.
    if (response.status !== 201) {
      throw new Error(
        `expected 201, got ${response.status}: ${response.body.toString('utf8')} :: ${JSON.stringify(logSink)}`,
      );
    }
    expect(response.status).toBe(201);
    expect(response.headers[BROKER_RESPONSE_HEADERS.outcome]).toBe('ok');
    expect(response.headers[BROKER_RESPONSE_HEADERS.mime]).toBe('application/pdf');
    expect(response.headers[BROKER_RESPONSE_HEADERS.bytes]).toBe(String(PDF_BYTES.length));
    expect(response.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(response.body).toEqual(PDF_BYTES);

    expect(docker.subcommands.map((argv) => argv[0])).toEqual([
      'create',
      'start',
      'exec',
      'exec',
      'exec',
      'rm',
    ]);
    // (6) the staging exec is the exec-based transport, never docker cp.
    const stage = docker.calls[2];
    expect(stage.argv).toEqual(['exec', '-i', 'c0ffee123456', 'tar', '-x', '-C', '/work']);
    expect(stage.options.stdin).toBeDefined();
    expect(stage.options.maxStdinBytes).toBeGreaterThan(0);
    // (7) the compile exec carries the plan argv verbatim and -w /work.
    const compile = docker.calls[3];
    expect(compile.argv.slice(0, 3)).toEqual(['exec', '-w', '/work']);
    expect(compile.argv[compile.argv.length - 1]).toBe('/out/artifact.pdf');
    // (9) the extraction exec streams to the spool sink, not into a string.
    const extract = docker.calls[4];
    expect(extract.argv).toEqual(['exec', 'c0ffee123456', 'tar', '-c', '-C', '/out', '.']);
    expect(extract.options.stdoutTo).toBeDefined();

    // (10) the spool is gone and the slot is released.
    expect(readdirSync(spoolRoot)).toEqual([]);
    expect(broker.quota.running).toBe(0);
  });

  it('A4.2 a runaway job is TERM -> 2 s grace -> KILL -> rm -f, and is RENDER_TIMEOUT', async () => {
    const docker = fakeDocker((argv, options) => {
      if (argv[0] === 'create') return { ...ok, stdout: 'runaway\n' };
      if (isCompileExec(argv)) {
        return new Promise<DockerRunResult>(() => undefined);
      }
      return happyHandler()(argv, options);
    });
    // `delay` resolves immediately for everything, so the wall budget expires
    // deterministically and the grace is not actually waited for.
    const broker = makeBroker(docker, { delay: async () => undefined });
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });

    expect(response.status).toBe(504);
    expect(JSON.parse(response.body.toString('utf8')).code).toBe('RENDER_TIMEOUT');

    const tail = docker.subcommands.slice(-3);
    expect(tail[0]).toEqual(['kill', '-s', 'TERM', 'runaway']);
    expect(tail[1]).toEqual(['kill', '-s', 'KILL', 'runaway']);
    expect(tail[2]).toEqual(['rm', '-f', 'runaway']);
    // The compile exec is the call immediately before the kill sequence: nothing else can
    // be interleaved, so "TERM first, then the grace, then KILL, then rm" is observable.
    expect(docker.subcommands[docker.subcommands.length - 4][0]).toBe('exec');
    expect(readdirSync(spoolRoot)).toEqual([]);
  });

  it('A4.3 the grace between TERM and KILL is RENDER_LIMITS.killGraceMs (2 s)', async () => {
    const docker = fakeDocker((argv, options) => {
      if (argv[0] === 'create') return { ...ok, stdout: 'runaway\n' };
      if (isCompileExec(argv)) {
        return new Promise<DockerRunResult>(() => undefined);
      }
      return happyHandler()(argv, options);
    });
    const delays: number[] = [];
    const broker = new Broker({
      docker,
      now: () => Date.now(),
      log: () => undefined,
      token: 'shared-secret-token',
      spoolRoot,
      delay: async (ms) => {
        delays.push(ms);
      },
    });
    await broker.handle({ token: 'shared-secret-token', body: Readable.from(await frame()) });
    expect(delays).toEqual([RENDER_LIMITS.wallClockMs, RENDER_LIMITS.killGraceMs]);
    expect(RENDER_LIMITS.killGraceMs).toBe(2_000);
  });

  it('A4.4 a non-zero compile exit is RENDER_COMPILE_ERROR, and /out is discarded', async () => {
    const docker = fakeDocker(
      happyHandler({
        compile: {
          code: 1,
          stdout: '',
          stderr: 'error: unknown variable: nmae',
          signaled: false,
        },
      }),
    );
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body.toString('utf8')) as { code: string };
    expect(body.code).toBe('RENDER_COMPILE_ERROR');
    expect(docker.calls.filter((call) => call.argv.includes('-c'))).toHaveLength(0);
    expect(readdirSync(spoolRoot)).toEqual([]);
  });

  it('A4.5 an OOM-killed compile is RENDER_RESOURCE_LIMIT, not a compile error', () => {
    expect(classifyCompileExit(137, '', 'Killed')).toBe('RENDER_RESOURCE_LIMIT');
    expect(classifyCompileExit(1, '', 'memory allocation failed')).toBe('RENDER_RESOURCE_LIMIT');
    expect(classifyCompileExit(1, '', 'write /out/artifact.pdf: no space left on device')).toBe(
      'RENDER_RESOURCE_LIMIT',
    );
    expect(classifyCompileExit(1, '', 'fork: Resource temporarily unavailable')).toBe(
      'RENDER_RESOURCE_LIMIT',
    );
    expect(classifyCompileExit(1, 'error: unknown variable', '')).toBe('RENDER_COMPILE_ERROR');
    expect(classifyCompileExit(0, '', '')).toBe('ok');
  });

  it('A4.6 a spool over 20 MiB is aborted and is RENDER_ARTIFACT_INVALID', async () => {
    // 20 MiB + one byte of ustar, so the CAPTURE SINK is the control that fires.
    const oversized = ustarOf('artifact.pdf', Buffer.alloc(SPOOL_MAX_BYTES + 1, 0x25));
    const docker = fakeDocker(happyHandler({ outTar: oversized }));
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body.toString('utf8')) as { code: string; reason: string };
    expect(body.code).toBe('RENDER_ARTIFACT_INVALID');
    expect(body.reason).toBe('SPOOL_BOUND_EXCEEDED');
    // The container is still destroyed.
    expect(docker.subcommands[docker.subcommands.length - 1]).toEqual(['rm', '-f', 'c0ffee123456']);
    expect(readdirSync(spoolRoot)).toEqual([]);
  });

  it('A4.6d MUTATION TARGET: an over-bound spool on the REAL transport order is a machine-readable outcome, not a crash', async () => {
    // F2. `happyHandler` writes and ends the sink SYNCHRONOUSLY inside `run`, so the
    // `'error'` is emitted on a `process.nextTick` and the `await` continuation that reaches
    // `waitForSink` - a promise microtask - gets to attach its listener first. That is why
    // A4.6 was green while the real transport was not: `dockerRunner` writes from an I/O
    // 'data' callback while the `run` promise is STILL PENDING, so the tick fires with
    // nothing attached, a Node `Writable` that emits 'error' unobserved terminates the
    // process, and `waitForSink` - which attaches when `run` RETURNS - is too late to see
    // the error at all. This test reproduces that ordering (the child is still running when
    // the bound is passed) and adds an `unhandledRejection` TRIPWIRE so the failure mode is
    // an assertion rather than a vitest crash report.
    const oversized = ustarOf('artifact.pdf', Buffer.alloc(SPOOL_MAX_BYTES + 1, 0x25));
    const tripwire = installUnhandledRejectionTripwire();
    try {
      const inner = happyHandler();
      const docker = fakeDocker((argv, options) => {
        if (argv[0] === 'exec' && argv.includes('tar') && argv.includes('-c') && options.stdoutTo !== undefined) {
          // stdout arrives while the child is still running; the exec itself returns later.
          setImmediate(() => options.stdoutTo?.write(oversized));
          return new Promise<DockerRunResult>((resolve) => {
            setTimeout(() => resolve(ok), 25);
          });
        }
        return inner(argv, options);
      });
      const broker = makeBroker(docker);
      const response = await broker.handle({
        token: 'shared-secret-token',
        body: Readable.from(await frame()),
      });
      // Give the microtask queue, and the unhandled-rejection check that runs after it, a
      // chance to fire before the assertion.
      await settle();
      expect(response.status).toBe(422);
      const body = JSON.parse(response.body.toString('utf8')) as { code: string; reason: string };
      // The contract's reason, not some other artifact failure discovered by reading a
      // truncated archive: the broker was handed more than the policy allows.
      expect(body.code).toBe('RENDER_ARTIFACT_INVALID');
      expect(body.reason).toBe('SPOOL_BOUND_EXCEEDED');
      expect(tripwire.read()).toEqual([]);
      expect(docker.subcommands[docker.subcommands.length - 1]).toEqual(['rm', '-f', 'c0ffee123456']);
      expect(readdirSync(spoolRoot)).toEqual([]);
    } finally {
      tripwire.remove();
    }
  });

  it('A4.6d2 MUTATION TARGET: the REAL runner cannot kill the process through a caller sink', async () => {
    // The transport half of F2, with no fake anywhere: `createDockerCliRunner` really spawns
    // a child, the child really floods stdout, and the bounded sink really refuses. The sink
    // here has NO error listener of its own on purpose - it models a caller who forgot - so
    // the guarantee being asserted is the transport's: a caller-supplied `Writable` can never
    // be the thing that takes the broker down. `node` is the child, not `docker`: the property
    // under test is the sink/write path, which is identical for both, and spawning a real
    // docker container to prove it would cost a container per test run.
    const tripwire = installUnhandledRejectionTripwire();
    const crashes: string[] = [];
    const onUncaught = (error: unknown): void => {
      crashes.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    };
    process.on('uncaughtException', onUncaught);
    const runner = createDockerCliRunner({ binary: process.execPath });
    const spool = await createSpool(spoolRoot);
    const sink = spool.openCapture(1024);
    try {
      const result = await runner.run(
        ['-e', 'process.stdout.write(Buffer.alloc(64 * 1024, 1))'],
        { stdoutTo: sink, timeoutMs: 20_000 },
      );
      expect(result.code).toBe(0);
      // The sink was destroyed by its own bound, and nothing was reported to the process.
      expect(sink.destroyed).toBe(true);
      await settle();
      expect(crashes).toEqual([]);
      expect(tripwire.read()).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
      sink.destroy();
      await spool.dispose();
    }
  });

  it('A4.6e-a the teardown of a failing sink raises NO unhandled rejection', async () => {
    // The `out.tar` teardown race, as a test. Two rejection surfaces are involved and they
    // are separate: the sink's own `'error'` event, and the INTERNAL promise chain in
    // `createBoundedCapture`, which `destroy()` re-assigned while it was already rejected.
    // The second one has no consumer at all, so it surfaces as a process-level unhandled
    // rejection - which is why the tripwire below is on the PROCESS, not on the stream.
    const tripwire = installUnhandledRejectionTripwire();
    try {
      const spool = await createSpool(spoolRoot);
      const sink = spool.openCapture(16);
      // The real ordering, and the order the broker's own over-bound path produces: the sink
      // raises on an async tick, `waitForSink` rejects, and the broker THEN calls
      // `destroy()` on a sink whose internal promise chain is already rejected.
      const errored = new Promise<Error>((resolve) => {
        sink.once('error', resolve);
        setImmediate(() => sink.write(Buffer.alloc(17, 1)));
      });
      expect(((await errored) as { code?: string }).code).toBe('RENDER_ARTIFACT_INVALID');
      sink.destroy();
      await settle();
      expect(tripwire.read()).toEqual([]);
      await spool.dispose();
      await settle();
      expect(tripwire.read()).toEqual([]);
    } finally {
      tripwire.remove();
    }
  });

  it('A4.6e-b a capture whose open() rejects raises NO unhandled rejection either', async () => {
    // The other live shape: `open(archivePath, 'wx')` fails - a leftover file, a full spool
    // volume, a read-only mount - so the internal chain is rejected from its very first
    // promise and every later write is chained onto a rejected base.
    const tripwire = installUnhandledRejectionTripwire();
    try {
      const spool = await createSpool(spoolRoot);
      const first = spool.openCapture(1024);
      first.end(Buffer.from('a'));
      await waitForSinkQuiet(first);
      // Same path, second open: `O_EXCL` refuses it, which is the point of `O_EXCL`.
      const second = spool.openCapture(1024);
      const refused = new Promise<Error>((resolve) => {
        second.once('error', resolve);
        second.end(Buffer.from('b'));
      });
      expect(await refused).toBeInstanceOf(Error);
      await settle();
      second.destroy();
      await settle();
      expect(tripwire.read()).toEqual([]);
      await spool.dispose();
      await settle();
      expect(tripwire.read()).toEqual([]);
    } finally {
      tripwire.remove();
    }
  });

  it('A4.6b MUTATION TARGET: the extractor refuses an over-bound archive even with a loose sink', async () => {
    const oversized = ustarOf('artifact.pdf', Buffer.alloc(1024, 0x25));
    const dir = path.join(spoolRoot, 'extractor-case');
    const extraction = extractUstarToDir(Readable.from(oversized), dir, 512);
    await expect(extraction).rejects.toThrow(/RENDER_ARTIFACT_INVALID/);
  });

  it('A4.6c MUTATION TARGET: raising the capture bound above the policy cap is refused', async () => {
    // The bound is CHECKED, not clamped, so a caller cannot quietly widen it. (A clamp
    // would also be safe; refusing makes the violation loud, which is what the mutation
    // table is for.)
    const spool = await createSpool(spoolRoot);
    try {
      expect(() => spool.openCapture(SPOOL_MAX_BYTES + 1)).toThrow(/positive integer no larger than/);
      expect(() => spool.openCapture(0)).toThrow(/positive integer no larger than/);
      expect(() => spool.openCapture(-1)).toThrow(/positive integer no larger than/);
      expect(() => spool.openCapture(1.5)).toThrow(/positive integer no larger than/);
      expect(() => spool.openCapture(SPOOL_MAX_BYTES)).not.toThrow();
    } finally {
      await spool.dispose();
    }
  });

  it('A4.7 an artifact whose content is not a PDF is RENDER_ARTIFACT_INVALID', async () => {
    const docker = fakeDocker(
      happyHandler({ outTar: ustarOf('artifact.pdf', Buffer.from('not a pdf at all', 'utf8')) }),
    );
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body.toString('utf8')) as { code: string; reason: string };
    expect(body.code).toBe('RENDER_ARTIFACT_INVALID');
    expect(body.reason).toBe('ARTIFACT_BAD_MAGIC');
  });

  it('A4.8 an /out holding a SECOND file is RENDER_ARTIFACT_INVALID (policy 6.1)', async () => {
    const two = Buffer.concat([
      ustarOf('artifact.pdf', PDF_BYTES).subarray(0, -1024),
      ustarOf('extra.txt', Buffer.from('surprise', 'utf8')).subarray(0, -1024),
      Buffer.alloc(1024, 0),
    ]);
    const docker = fakeDocker(happyHandler({ outTar: two }));
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body.toString('utf8')).code).toBe('RENDER_ARTIFACT_INVALID');
  });

  it('A4.9 a SYMLINK in /out is refused, not extracted (upstream #5454 class)', async () => {
    const evil = buildEvilUstar('artifact.pdf', 'L', '/etc/clearance-spike-canary.txt');
    const docker = fakeDocker(happyHandler({ outTar: evil }));
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body.toString('utf8')).code).toBe('RENDER_ARTIFACT_INVALID');
  });

  it('A4.10 a `../` entry in /out is refused (policy 6.3.4)', async () => {
    const traversal = buildEvilUstar('../escape.pdf', '0', PDF_BYTES);
    const docker = fakeDocker(happyHandler({ outTar: traversal }));
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body.toString('utf8')) as { code: string; reason: string };
    expect(body.code).toBe('RENDER_ARTIFACT_INVALID');
    // The REASON is the traversal one, not the generic "unexpected entry": the name was
    // understood and refused, which is a different operator story and policy 6.3.4's own
    // wording.
    expect(body.reason).toBe('ARTIFACT_OUTSIDE_OUT');
  });

  it('A4.11 a wrong token is 401 and no container is created', async () => {
    const docker = fakeDocker();
    const broker = makeBroker(docker);
    for (const token of [undefined, '', 'wrong-token', 'shared-secret-toke']) {
      const response = await broker.handle({
        token,
        body: Readable.from(await frame()),
      });
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body.toString('utf8')).code).toBe('RENDER_UNAUTHORIZED');
    }
    expect(docker.calls).toHaveLength(0);
    expect(readdirSync(spoolRoot)).toEqual([]);
  });

  it('A4.12 a truncated tar frame aborts BEFORE a container exists', async () => {
    const docker = fakeDocker();
    const broker = makeBroker(docker);
    const full = await frame();
    // Cut the tree short: the declared size no longer matches what was sent.
    const truncated = full.subarray(0, full.length - 1024);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(truncated),
    });
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body.toString('utf8')) as { code: string; reason: string };
    expect(body.code).toBe('RENDER_REQUEST_INVALID');
    expect(body.reason).toBe('TREE_TRUNCATED');
    expect(docker.calls).toHaveLength(0);
  });

  it('A4.13 the spec prefix longer than 64 KiB is refused before any parse', async () => {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(1024 * 1024, 0);
    const docker = fakeDocker();
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(Buffer.concat([prefix, Buffer.alloc(16)])),
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body.toString('utf8')).reason).toBe('SPEC_TOO_LARGE');
    expect(docker.calls).toHaveLength(0);
  });

  it('A4.14 a client disconnect takes the same kill path, PROMPTLY', async () => {
    // F5. The previous version of this test fired the listener synchronously inside the
    // compile handler and passed `delay: async () => undefined`, so the 10 s wall budget was
    // an instant win of the race and `aborted` was merely ALREADY true by the time it was
    // read: it could not tell "the disconnect was noticed" from "the disconnect was noticed
    // only after the clock ran out". So the wall clock here is REAL, the compile stays
    // pending after the disconnect, and the elapsed time is asserted - if the abort is not an
    // arm of the race, the response arrives ~10 s later with `WALL_CLOCK_EXCEEDED` and this
    // test times out.
    let fire: (() => void) | undefined;
    const docker = fakeDocker((argv, options) => {
      if (argv[0] === 'create') return { ...ok, stdout: 'disconnect\n' };
      if (isCompileExec(argv)) {
        // The compile hangs, and the client walks away a tick later - after `run` has been
        // entered, so the only way to observe it is the race.
        setTimeout(() => fire?.(), 0);
        return new Promise<DockerRunResult>(() => undefined);
      }
      return happyHandler()(argv, options);
    });
    const broker = makeBroker(docker, { delay: realWallClockOnly });
    const started = Date.now();
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
      onAbort: (listener) => {
        fire = listener;
        return () => {
          fire = undefined;
        };
      },
    });
    const elapsed = Date.now() - started;
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body.toString('utf8')).reason).toBe('CLIENT_DISCONNECTED');
    // The wall budget is 10 s. Anything near it means the clock won the race.
    expect(elapsed).toBeLessThan(2_000);
    expect(docker.subcommands).toContainEqual(['kill', '-s', 'TERM', 'disconnect']);
    expect(docker.subcommands).toContainEqual(['kill', '-s', 'KILL', 'disconnect']);
    expect(docker.subcommands[docker.subcommands.length - 1]).toEqual(['rm', '-f', 'disconnect']);
  });

  it('A4.14b the wall clock still wins when nothing disconnects', async () => {
    // The other half of the same assertion: adding an arm to a race must not make the
    // original arm unreachable. Same real clock, no disconnect.
    const docker = fakeDocker((argv, options) => {
      if (argv[0] === 'create') return { ...ok, stdout: 'runaway\n' };
      if (isCompileExec(argv)) return new Promise<DockerRunResult>(() => undefined);
      return happyHandler()(argv, options);
    });
    // A real, SHORT wall clock: the same `raceWallClock` code path with a deadline the test
    // can afford to wait for.
    const broker = makeBroker(docker, {
      delay: (ms) =>
        ms >= RENDER_LIMITS.wallClockMs
          ? new Promise<void>((resolve) => {
              setTimeout(resolve, 25);
            })
          : Promise.resolve(),
    });
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(504);
    expect(JSON.parse(response.body.toString('utf8')).reason).toBe('WALL_CLOCK_EXCEEDED');
  });

  it('A4.15 the exec env is the plan env, key for key, and the plan argv is verbatim', () => {
    const compilePlan = plan();
    const args = buildCompileExecArgs(compilePlan, 'abc123');
    expect(args.slice(0, 3)).toEqual(['exec', '-w', RENDER_PATHS.work]);
    const envPairs = args
      .map((token, index) => (args[index - 1] === '--env' ? token : undefined))
      .filter((token): token is string => token !== undefined);
    expect(envPairs.sort()).toEqual(
      Object.entries(compilePlan.env)
        .map(([key, value]) => `${key}=${value}`)
        .sort(),
    );
    // argv[0] is qualified against the toolchain mount; everything after it is verbatim.
    expect(args.slice(-compilePlan.argv.length)[0]).toBe(
      `${RENDER_PATHS.toolchain}/${compilePlan.argv[0] as string}`,
    );
    expect(args.slice(-compilePlan.argv.length + 1)).toEqual([...compilePlan.argv.slice(1)]);
    expect(() => assertPlanEnvOnExec(args, compilePlan)).not.toThrow();
  });

  it('A4.15b the engine binary is qualified against the POLICY toolchain mount', () => {
    // Only a live run reveals why this exists: the image sets no `PATH` (policy 3.4/4.7:
    // the compile env is complete and never merged) and the broker replaces the entrypoint
    // the bare name would otherwise resolve through, so `docker exec` needs an absolute
    // path - and the only absolute path a policy constant provides is `RENDER_PATHS`.
    expect(resolveEngineBinary('anything')).toBe('/opt/typst/anything');
    expect(resolveEngineBinary('anything')).toContain(RENDER_PATHS.toolchain);
    // A path-shaped or escaping name is refused rather than resolved: the name is
    // plan-derived, and the read-only bind is all that stands between it and execution.
    for (const bad of ['/bin/sh', '../sh', 'a/b', 'a\\b', '']) {
      expect(() => resolveEngineBinary(bad), bad).toThrow(/RENDER_POLICY_VIOLATION/);
    }
  });

  it('A4.16 MUTATION TARGET: a stale or ambient key on the exec is refused', () => {
    const compilePlan = plan();
    const good = buildCompileExecArgs(compilePlan, 'abc123');
    // Drop a REAL pair: filtering a token that is not there would make this vacuous, and
    // `XDG_CACHE_HOME` is the mandated ABSENCE so there is nothing to drop.
    const at = good.indexOf('TYPST_ROOT=/work');
    const dropped = [...good.slice(0, at - 1), ...good.slice(at + 1)];
    const withAmbient = [...good, '--env', 'TYPST_CERT=/etc/passwd'];
    const widened = good.map((token) => (token === 'TYPST_ROOT=/work' ? 'TYPST_ROOT=/' : token));
    for (const mutated of [dropped, withAmbient, widened]) {
      expect(() => assertPlanEnvOnExec(mutated, compilePlan)).toThrow(/RENDER_POLICY_VIOLATION/);
    }
  });

  it('A4.17 a container-create failure is 503, not a render outcome', async () => {
    const docker = fakeDocker(
      happyHandler({
        create: { code: 125, stdout: '', stderr: 'Unable to find image', signaled: false },
      }),
    );
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body.toString('utf8')).code).toBe('RENDER_BROKER_UNAVAILABLE');
    expect(broker.quota.running).toBe(0);
  });
});

/** Build a ustar archive with a hostile typeflag or name, for the refusal tests. */
function buildEvilUstar(name: string, type: string, body: Buffer | string): Buffer {
  const payload = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
  const blocks: Buffer[] = [tarHeaderBlock(name, payload.length, type, 0o600), payload];
  const pad = payload.length % 512;
  if (pad !== 0) blocks.push(Buffer.alloc(512 - pad, 0));
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

// ===========================================================================
// A5 - the boot preflight
// ===========================================================================

describe('render/broker A5 - the BOOT preflight', () => {
  it('A5.1 a missing worker image fails the preflight with a non-zero code and ONE log line', async () => {
    const docker = fakeDocker((argv) => {
      if (argv[0] === 'image' && argv[1] === 'inspect') {
        return { code: 1, stdout: '', stderr: 'Error: No such image', signaled: false };
      }
      return ok;
    });
    const lines: unknown[] = [];
    const broker = new Broker({
      docker,
      now: () => Date.now(),
      log: (...args: unknown[]) => lines.push(args),
      token: 'shared-secret-token',
      spoolRoot,
    });
    const preflight = await broker.preflight();
    expect(preflight.ok).toBe(false);
    expect(preflight.code).toBe(1);
    expect(preflight.message).toMatch(/RENDER_BROKER_PREFLIGHT_FAILED/);
    expect(docker.subcommands).toEqual([['image', 'inspect', RENDER_WORKER_IMAGE]]);
  });

  it('A5.2 a broker that failed its preflight serves NOTHING: every request is 503', async () => {
    const docker = fakeDocker((argv) => {
      if (argv[0] === 'image') {
        return { code: 1, stdout: '', stderr: 'no such image', signaled: false };
      }
      return ok;
    });
    const broker = makeBroker(docker);
    const preflight = await broker.preflight();
    expect(preflight.ok).toBe(false);
    // `broker.close()` is what the entry point does when the preflight fails: the listener
    // is never opened, so no request can reach docker.
    broker.close();
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(503);
    expect(docker.calls.filter((call) => call.argv[0] === 'create')).toHaveLength(0);
  });

  it('A5.3 an inspect failure is preflight FAILURE, not a throw', async () => {
    const docker = fakeDocker(() => {
      throw new Error('docker CLI could not be started');
    });
    const broker = makeBroker(docker);
    const preflight = await broker.preflight();
    expect(preflight.ok).toBe(false);
    expect(preflight.code).toBe(1);
  });

  it('A5.4 a present image passes, and no new outcome code was needed for the failure', () => {
    expect(RENDER_OUTCOME_CODES).not.toContain('RENDER_IMAGE_MISSING');
    expect(RENDER_OUTCOME_CODES).not.toContain('RENDER_TOOLCHAIN_MISSING');
  });

  it('A5.5 MUTATION TARGET: a broker without RENDER_HOST_TYPST_ROOT fails BOOT (F1/ESC-1)', async () => {
    // The compose service CANNOT infer the host root: a relative bind source is expanded by
    // the docker CLI against the CLI's own CWD, which inside the broker container is `/app`
    // and holds no repository. So the key is required, exactly like the token, and its
    // absence is a boot failure with one line and a non-zero exit rather than a service that
    // starts and then fails every `docker create` with `CONTAINER_CREATE_FAILED`.
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    try {
      const docker = fakeDocker();
      const base = {
        [BROKER_ENV_KEYS.token]: 'a-token',
        [BROKER_ENV_KEYS.socket]: '\\\\.\\pipe\\clearance-t1031-absent-root',
      } as NodeJS.ProcessEnv;
      const missingRoot = await main(base);
      expect(missingRoot).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(BROKER_ENV_KEYS.hostRoot);
      // No docker call at all: the config is refused before the preflight.
      expect(docker.calls).toHaveLength(0);

      // The same, for the token, so the two boot requirements are not accidentally the same
      // branch.
      lines.length = 0;
      expect(
        await main({ [BROKER_ENV_KEYS.hostRoot]: HOST_ROOT } as NodeJS.ProcessEnv),
      ).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(BROKER_ENV_KEYS.token);
    } finally {
      console.error = originalError;
    }
  });
});

// ===========================================================================
// A5b - the socket path at boot: a stale socket is reclaimed, anything else
//        is refused. NO daemon, no network, no privileged filesystem.
// ===========================================================================

/**
 * A filesystem that plants ONE entry and reports its stat, for the socket-path decision.
 *
 * The `unlink` is the REAL one, always. Only the STAT is injectable, and only because the
 * decision hinges on `isSocket()` alone: a real `AF_UNIX` socket inode cannot be created on
 * Windows (a filesystem path is rejected with EACCES there; a named pipe is a different kind
 * of object entirely), so on a Windows dev box the stale-socket branch is reached by
 * injecting the stat while the REMOVAL - the part that can destroy something - stays real.
 */
function plantedFs(
  socketPath: string,
  answer: 'socket' | 'file' | 'directory',
): { fs: SocketPathFs; unlinked: string[] } {
  const unlinked: string[] = [];
  return {
    unlinked,
    fs: {
      async lstat(target: string): Promise<SocketPathStat> {
        return { isSocket: () => answer === 'socket' && target === socketPath };
      },
      async unlink(target: string): Promise<void> {
        unlinked.push(target);
        unlinkSync(target);
      },
    },
  };
}

/** A real socket inode left behind by a killed process, when the platform allows one. */
function supportsRealUnixSockets(): boolean {
  return process.platform !== 'win32';
}

describe('render/broker A5b - the socket path at boot (stale reclaim, fail closed)', () => {
  let socketRoot = '';
  let logLines: string[] = [];

  beforeEach(() => {
    socketRoot = mkdtempSync(path.join(os.tmpdir(), 'broker-socket-'));
    logLines = [];
  });

  afterEach(() => {
    if (socketRoot !== '') rmSync(socketRoot, { recursive: true, force: true });
  });

  const socketAt = (name = 'broker.sock'): string => path.join(socketRoot, name);

  it('A5b.1 an ABSENT path proceeds and touches nothing', async () => {
    const prepared = await prepareSocketPath(socketAt('never-bound.sock'));
    expect(prepared.kind).toBe('absent');
    expect(existsSync(socketAt('never-bound.sock'))).toBe(false);
  });

  it('A5b.2 MUTATION TARGET: a STALE socket is unlinked and the boot proceeds', async () => {
    // The planted file stands in for the inode a killed broker left in the shared volume.
    // Without the reclaim the bind that follows fails EADDRINUSE and the render path stays
    // down until an operator deletes the file by hand - the defect this fixes.
    const planted = socketAt();
    writeFileSync(planted, 'stale-socket-stand-in');
    const { fs, unlinked } = plantedFs(planted, 'socket');
    const prepared = await prepareSocketPath(planted, fs);
    expect(prepared.kind).toBe('stale-removed');
    expect(unlinked).toEqual([planted]);
    expect(existsSync(planted)).toBe(false);
  });

  it('A5b.3 a REGULAR FILE is refused and is NOT unlinked', async () => {
    // Fail CLOSED, and the mutation target for "unlink unconditionally": if the reclaim did
    // not check `isSocket()` first, this file would be deleted on a boot.
    const planted = socketAt();
    writeFileSync(planted, 'operator data');
    const { fs, unlinked } = plantedFs(planted, 'file');
    await expect(prepareSocketPath(planted, fs)).rejects.toThrow(SocketPathError);
    await expect(prepareSocketPath(planted, fs)).rejects.toThrow(/RENDER_BROKER_SOCKET_PATH/);
    expect(unlinked).toEqual([]);
    expect(existsSync(planted)).toBe(true);
    expect(readFileSync(planted, 'utf8')).toBe('operator data');
  });

  it('A5b.4 a DIRECTORY is refused and is NOT removed', async () => {
    const planted = socketAt();
    mkdirSync(planted);
    writeFileSync(path.join(planted, 'inner'), 'x');
    const { fs, unlinked } = plantedFs(planted, 'directory');
    const failure = await prepareSocketPath(planted, fs).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SocketPathError);
    expect((failure as SocketPathError).reason).toBe('NOT_A_SOCKET');
    expect((failure as SocketPathError).socketPath).toBe(planted);
    expect(unlinked).toEqual([]);
    expect(existsSync(planted)).toBe(true);
    expect(readdirSync(planted)).toEqual(['inner']);
  });

  it('A5b.5 a real socket inode at the path is the stale case, and the live socket replaces it', async () => {
    // The end-to-end half, on a platform that can create a real `AF_UNIX` socket. A server is
    // bound and then abandoned WITHOUT closing it, which is exactly the state an unclean stop
    // leaves behind: the inode exists, nobody is bound to serve it, and `lstat` says SOCKET.
    if (!supportsRealUnixSockets()) {
      // Windows cannot create a socket inode at all; A5b.2 covers the branch through the port.
      expect(prepareSocketPath).toBeTypeOf('function');
      return;
    }
    const planted = socketAt();
    const abandoned = createServer();
    await new Promise<void>((resolve, reject) => {
      abandoned.once('error', reject);
      abandoned.listen(planted, resolve);
    });
    // No `close()`: the file is left behind while nothing is listening on it.
    abandoned.unref();
    expect(lstatSync(planted).isSocket()).toBe(true);

    const prepared = await prepareSocketPath(planted);
    expect(prepared.kind).toBe('stale-removed');
    expect(existsSync(planted)).toBe(false);

    // ...and the path can be bound again immediately, which is the whole point.
    const live = createServer();
    await new Promise<void>((resolve, reject) => {
      live.once('error', reject);
      live.listen(planted, resolve);
    });
    expect(lstatSync(planted).isSocket()).toBe(true);
    await new Promise<void>((resolve) => live.close(() => resolve()));
  });

  it('A5b.6 a stat that FAILS is refused, not assumed absent', async () => {
    // A path this broker cannot even inspect is a path it cannot prove it owns, so it takes
    // the same fail-closed branch as a regular file rather than proceeding to bind.
    const planted = socketAt();
    const fs: SocketPathFs = {
      lstat: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
      unlink: async () => undefined,
    };
    const failure = await prepareSocketPath(planted, fs).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SocketPathError);
    expect((failure as SocketPathError).reason).toBe('NOT_A_SOCKET');
    expect((failure as SocketPathError).message).toContain('EACCES');
  });

  it('A5b.7 a stale socket that cannot be removed is a REFUSAL, not a silent bind', async () => {
    const planted = socketAt();
    const fs: SocketPathFs = {
      lstat: async () => ({ isSocket: () => true }),
      unlink: async () => {
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      },
    };
    const failure = await prepareSocketPath(planted, fs).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SocketPathError);
    expect((failure as SocketPathError).reason).toBe('UNLINK_FAILED');
    expect((failure as SocketPathError).message).toMatch(/EBUSY/);
  });

  it('A5b.8 the shutdown path unlinks the socket it bound', async () => {
    const planted = socketAt();
    const { fs, unlinked } = plantedFs(planted, 'socket');
    writeFileSync(planted, 'the-socket-this-process-bound');
    await releaseSocketPath(planted, (...args: unknown[]) => logLines.push(args.join(' ')), fs);
    expect(unlinked).toEqual([planted]);
    expect(existsSync(planted)).toBe(false);
    expect(logLines).toEqual([]);
  });

  it('A5b.9 a shutdown unlink that FAILS is logged, never thrown', async () => {
    const planted = socketAt();
    const fs: SocketPathFs = {
      lstat: async () => ({ isSocket: () => true }),
      unlink: async () => {
        throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
      },
    };
    await expect(
      releaseSocketPath(planted, (...args: unknown[]) => logLines.push(args.join(' ')), fs),
    ).resolves.toBeUndefined();
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('RENDER_BROKER_SOCKET_RELEASE');
    expect(logLines[0]).toContain('EROFS');
  });

  it('A5b.10 a shutdown unlink of an ALREADY-ABSENT path is silent', async () => {
    // ENOENT is the state the unlink was trying to reach, so it is not a failure worth a line.
    const fs: SocketPathFs = {
      lstat: async () => ({ isSocket: () => true }),
      unlink: async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      },
    };
    await releaseSocketPath(
      socketAt(),
      (...args: unknown[]) => logLines.push(args.join(' ')),
      fs,
    );
    expect(logLines).toEqual([]);
  });

  it('A5b.11 a shutdown with no socket path (the TCP fallback) unlinks nothing', async () => {
    let unlinkCalls = 0;
    const fs: SocketPathFs = {
      lstat: async () => ({ isSocket: () => true }),
      unlink: async () => {
        unlinkCalls += 1;
      },
    };
    await releaseSocketPath(undefined, () => undefined, fs);
    await releaseSocketPath('', () => undefined, fs);
    expect(unlinkCalls).toBe(0);
  });

  it('A5b.12 MUTATION TARGET: main() RECLAIMS a stale socket and logs it, BEFORE the preflight', async () => {
    // The wiring, through the entry point, with no daemon and no network: the fake runner
    // fails the image inspect, so the boot stops at the preflight - and the reclaim, which
    // runs BEFORE it, has already removed the planted socket. That ordering is itself the
    // property: a refusal has to be reportable on a host with no Docker at all, and the
    // reclaim has to happen even on a boot that never reaches the bind.
    const planted = socketAt();
    writeFileSync(planted, 'stale-socket-stand-in');
    const { fs, unlinked } = plantedFs(planted, 'socket');
    const lines: string[] = [];
    const code = await main(
      {
        [BROKER_ENV_KEYS.token]: 'shared-secret-token',
        [BROKER_ENV_KEYS.hostRoot]: HOST_ROOT,
        [BROKER_ENV_KEYS.socket]: planted,
      } as NodeJS.ProcessEnv,
      {
        docker: fakeDocker(() => ({ code: 1, stdout: '', stderr: 'no such image', signaled: false })),
        log: (...args: unknown[]) => {
          lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
        },
        socketPathFs: fs,
      },
    );
    expect(code).toBe(1);
    expect(unlinked).toEqual([planted]);
    expect(existsSync(planted)).toBe(false);
    // Exactly two lines, in this order: the reclaim, then the preflight that stopped the boot.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('RENDER_BROKER_SOCKET_RECLAIMED');
    expect(lines[0]).toContain(planted);
    expect(lines[1]).toContain('RENDER_BROKER_PREFLIGHT_FAILED');
  });

  it('A5b.13 MUTATION TARGET: main() REFUSES a planted regular file, leaves it, and exits non-zero', async () => {
    const planted = socketAt();
    writeFileSync(planted, 'not a socket');
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      logLines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    };
    let code: number;
    try {
      code = await main(
        {
          [BROKER_ENV_KEYS.token]: 'shared-secret-token',
          [BROKER_ENV_KEYS.hostRoot]: HOST_ROOT,
          [BROKER_ENV_KEYS.socket]: planted,
        } as NodeJS.ProcessEnv,
        {
          log: (...args: unknown[]) => {
            logLines.push(
              args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '),
            );
          },
        },
      );
    } finally {
      console.error = originalError;
    }
    expect(code).toBe(1);
    // EXACTLY one line, and it is the refusal. A boot failure that also logged the preflight
    // would be a second, misleading diagnosis.
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('RENDER_BROKER_SOCKET_PATH');
    expect(logLines[0]).toContain(planted);
    // The refusal is the whole point: the file is still there.
    expect(existsSync(planted)).toBe(true);
    expect(readFileSync(planted, 'utf8')).toBe('not a socket');
  });

  it('A5b.14 the refusal reason vocabulary is closed and the message carries a code', () => {
    expect(SOCKET_PATH_REFUSAL_REASONS).toEqual(['NOT_A_SOCKET', 'UNLINK_FAILED']);
    const refusal = new SocketPathError('/run/x/broker.sock', 'NOT_A_SOCKET', 'because');
    expect(refusal.message).toBe('RENDER_BROKER_SOCKET_PATH: because');
    // No new RENDER_* outcome code: this is a boot failure, not a render outcome.
    expect(RENDER_OUTCOME_CODES).not.toContain('RENDER_BROKER_SOCKET_PATH');
  });
});

// ===========================================================================
// A6 - redaction (policy 9.4)
// ===========================================================================

const CANARY = 'CLEARANCE_CANARY_T1005_7f3a91c4';
/** A path the broker has NO constant for - the case T1013 measured and widened 9.4 for. */
const UNNAMED_PATH = '/etc/clearance-spike-canary.txt';

describe('render/broker A6 - policy 9.4 redaction', () => {
  it('A6.1 known constants are substituted FIRST, so they read as themselves', () => {
    const input = [
      `wrote ${RENDER_PATHS.work}/template.typ`,
      `to ${RENDER_PATHS.out}/artifact.pdf`,
      `cache ${RENDER_PATHS.packageCache}`,
      `fonts ${RENDER_PATHS.fonts}`,
      `packages ${RENDER_PATHS.packages}`,
      `toolchain ${RENDER_PATHS.toolchain}`,
      'tmp /tmp/x',
      'home /nonexistent',
    ].join(' and ');
    const output = redactDiagnostics(input);
    expect(output).toContain(REDACTED_LABELS.workdir);
    expect(output).toContain(REDACTED_LABELS.out);
    expect(output).toContain(REDACTED_LABELS.packageCache);
    expect(output).toContain(REDACTED_LABELS.fonts);
    expect(output).toContain(REDACTED_LABELS.packages);
    expect(output).toContain(REDACTED_LABELS.toolchain);
    expect(output).toContain(REDACTED_LABELS.tmp);
    expect(output).toContain(REDACTED_LABELS.home);
    // The long constants must not be eaten by the short ones they start with.
    expect(output).not.toContain('</packages>');
    expect(output).not.toContain('</fonts>');
  });

  it('A6.2 EVERY absolute-path-SHAPED token becomes <path>, known or not', () => {
    const input = [
      `posix ${UNNAMED_PATH}`,
      'windows C:\\Users\\someone\\resume.typ',
      'forward D:/data/x.json',
      'unc \\\\fileserver\\share\\resume.typ',
      `inside ${RENDER_PATHS.work}/template.typ`,
    ].join(' | ');
    const output = redactPathShapes(input);
    expect(output).toContain(REDACTED_LABELS.path);
    expect(output).not.toContain(UNNAMED_PATH);
    expect(output).not.toContain('C:');
    expect(output).not.toContain('D:');
    expect(output).not.toContain('resume.typ');
    expect(() => assertNoPathShapedToken(redactDiagnostics(input))).not.toThrow();
  });

  it('A6.3 a canary the broker never named is gone from the log', async () => {
    // WHY THE CANARY IS STAGED CONTENT, stated so this test is not read as a weaker claim
    // than it looks. Policy 9.4 has exactly three substitutions: known constants, tokens
    // shaped like an absolute path, and STAGED CONTENT. A bare string that appears in
    // neither of the latter two shapes is not something 9.4 removes - and inventing a
    // fourth rule (a deny-list of "sensitive-looking" tokens) is precisely the kind of
    // un-pinnable list policy 9.4's own rationale rejects. So the fixture is the honest one:
    // the template echoes a string it was GIVEN, and the `<content>` rule removes it, while
    // the path it also quotes is removed by the shape rule because no staged-content rule
    // could reach it.
    const staged = stagedTree({ extra: [{ name: 'canary.txt', bytes: CANARY }] });
    const docker = fakeDocker(
      happyHandler({
        compile: {
          code: 1,
          stdout: '',
          stderr: `error: could not read ${CANARY} at ${UNNAMED_PATH}`,
          signaled: false,
        },
      }),
    );
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame({}, staged)),
    });
    expect(response.status).toBe(422);
    const logged = JSON.stringify(logSink);
    expect(logged).not.toContain(CANARY);
    expect(logged).not.toContain(UNNAMED_PATH);
    expect(logged).toContain(REDACTED_LABELS.content);
    expect(logged).toContain(REDACTED_LABELS.path);
    expect(logged).not.toMatch(/\/[A-Za-z]/);
    expect(logged).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('A6.4 the API-visible body carries NO diagnostics', async () => {
    const docker = fakeDocker(
      happyHandler({
        compile: {
          code: 1,
          stdout: 'stdout canary ' + CANARY,
          stderr: 'stderr canary ' + UNNAMED_PATH,
          signaled: false,
        },
      }),
    );
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    const text = response.body.toString('utf8') + JSON.stringify(response.headers);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain(UNNAMED_PATH);
    expect(text).not.toContain('canary');
    const body = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'reason']);
    expect(body.message).toBe(OUTCOME_MESSAGES.RENDER_COMPILE_ERROR);
  });

  it('A6.5 staged content is replaced with <content>, longest first', () => {
    const staged = ['Ada Lovelace', 'Ada Lovelace\nSenior Engineer'];
    const output = redactStagedContent('template echoed Ada Lovelace\nSenior Engineer', staged);
    // Longest first: the two-blob phrase is consumed whole, so no partial tail survives.
    expect(output).toBe(`template echoed ${REDACTED_LABELS.content}`);
  });

  it('A6.6 a blob too short to be a phrase is not substituted (a 1-byte file would eat the log)', () => {
    const output = redactStagedContent('aaa bbb aaa', ['a']);
    expect(output).toBe('aaa bbb aaa');
  });

  it('A6.7 the artifact bytes are UNCHANGED by redaction (policy 9.4.3)', async () => {
    // The redaction is applied to diagnostics only. The strongest statement of that is a
    // render whose artifact CONTAINS a path and a canary: the bytes must come back exactly
    // as the container produced them.
    const payload = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.from(`% ${UNNAMED_PATH} ${CANARY} /work/template.typ\n`, 'latin1'),
      Buffer.from('%%EOF\n', 'latin1'),
    ]);
    const docker = fakeDocker(happyHandler({ outTar: ustarOf('artifact.pdf', payload) }));
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from(await frame()),
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(payload);
    expect(response.body.toString('latin1')).toContain(UNNAMED_PATH);
    expect(response.body.toString('latin1')).toContain(CANARY);
  });

  it('A6.8 the log is truncated to 64 KiB, and the marker says so', () => {
    const input = 'x'.repeat(REDACT_MAX_BYTES * 2);
    const output = redactDiagnostics(input);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(REDACT_MAX_BYTES);
    expect(output).toContain('truncated at');
  });

  it('A6.9 redaction never splits a multi-byte character at the bound', () => {
    const input = 'é'.repeat(REDACT_MAX_BYTES);
    const output = redactDiagnostics(input, { maxBytes: 100 });
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(100);
    expect(output).not.toContain('�');
  });

  it('A6.10 MUTATION TARGET: removing the shape rule lets an unnamed path through', () => {
    // The falsifying half: the known-constant table alone is NOT sufficient, which is
    // exactly what T1013 measured and why 9.4 was widened.
    const input = `error at ${UNNAMED_PATH} and ${RENDER_PATHS.work}/template.typ`;
    const knownOnly = input
      .replace(new RegExp(RENDER_PATHS.work, 'g'), REDACTED_LABELS.workdir)
      .replace(new RegExp(RENDER_PATHS.out, 'g'), REDACTED_LABELS.out);
    expect(knownOnly).toContain(UNNAMED_PATH);
    expect(redactPathShapes(knownOnly)).not.toContain(UNNAMED_PATH);
  });

  it('A6.11 the empty string and a non-string are handled without throwing', () => {
    expect(redactDiagnostics('')).toBe('');
    expect(() => redactDiagnostics('x', { maxBytes: 0 })).toThrow(/RENDER_POLICY_VIOLATION/);
  });
});

// ===========================================================================
// The spool, the frame reader and the redaction candidates
// ===========================================================================

describe('render/broker - the spool, the frame and the redaction candidates', () => {
  it('S1 the spool is private, per job, and disposable', async () => {
    const spool = await createSpool(spoolRoot);
    expect(path.basename(spool.dir)).toMatch(/^job-[0-9a-f]{16}$/);
    expect(spool.dir).not.toContain('job-0001');
    expect(readdirSync(spoolRoot)).toEqual([path.basename(spool.dir)]);
    const sink = spool.openCapture(1024);
    sink.end(Buffer.from('abc'));
    await waitFor(() => readdirSync(spool.dir).length === 1);
    await spool.dispose();
    expect(readdirSync(spoolRoot)).toEqual([]);
    // Idempotent, and never throws.
    await expect(spool.dispose()).resolves.toBeUndefined();
  });

  it('S2 the extractor refuses a destination that already exists', async () => {
    const spool = await createSpool(spoolRoot);
    mkdirSync(spool.outDir, { recursive: true });
    await expect(
      extractUstarToDir(Readable.from(ustarOf('artifact.pdf', PDF_BYTES)), spool.outDir),
    ).rejects.toThrow(/RENDER_ARTIFACT_INVALID/);
    await spool.dispose();
  });

  it('S3b the extractor accepts the `./`-PREFIXED shape real `tar -c -C /out .` produces', async () => {
    // Not a synthetic shape: this is byte-for-byte what the extraction exec returns, and
    // getting it wrong makes the broker refuse every real artifact while every unit test
    // built on `stage.ts`'s writer still passes. The live half found it.
    const blocks: Buffer[] = [tarHeaderBlock('./', 0, '5', 0o700)];
    const body = Buffer.from('%PDF-1.7\nlive\n%%EOF\n', 'latin1');
    blocks.push(tarHeaderBlock('./artifact.pdf', body.length, '0', 0o600), body);
    blocks.push(Buffer.alloc(1024, 0));
    const spool = await createSpool(spoolRoot);
    const extraction = await extractUstarToDir(Readable.from(Buffer.concat(blocks)), spool.outDir);
    // The root entry is metadata: it is counted, and NOTHING is created for it.
    expect(extraction.dirCount).toBe(1);
    expect(extraction.fileCount).toBe(1);
    expect(extraction.names).toEqual(['artifact.pdf']);
    expect(readdirSync(spool.outDir)).toEqual(['artifact.pdf']);
    await spool.dispose();
  });

  it('S3c a `./`-prefixed PATH is still refused after the prefix is stripped', async () => {
    for (const hostile of ['./../escape.pdf', './a/b.pdf', './sub/../escape.pdf']) {
      const spool = await createSpool(spoolRoot);
      const blocks = [
        tarHeaderBlock(hostile, 3, '0', 0o600),
        Buffer.from('abc'),
        Buffer.alloc(1024, 0),
      ];
      await expect(
        extractUstarToDir(Readable.from(Buffer.concat(blocks)), spool.outDir),
        hostile,
      ).rejects.toThrow(/RENDER_ARTIFACT_INVALID/);
      await spool.dispose();
    }
  });

  it('S3 the extractor round-trips the archive stage.ts writes', async () => {
    const tree = stagedTree();
    const tar = await treeBytesOf(tree);
    const spool = await createSpool(spoolRoot);
    const extraction = await extractUstarToDir(Readable.from(tar), spool.outDir);
    expect(extraction.fileCount).toBe(2);
    expect(extraction.dirCount).toBe(1);
    expect(extraction.names).toContain('data.json');
    expect(extraction.names).toContain('template.typ');
    expect(extraction.totalBytes).toBe(tree.totalBytes);
    await spool.dispose();
  });

  it('S4 a corrupt header checksum is refused before an entry is created', async () => {
    const corrupt = ustarOf('artifact.pdf', PDF_BYTES);
    corrupt[150] = 0x39; // scribble on the checksum field
    const spool = await createSpool(spoolRoot);
    await expect(
      extractUstarToDir(Readable.from(corrupt), spool.outDir),
    ).rejects.toThrow(/RENDER_ARTIFACT_INVALID/);
    await spool.dispose();
  });

  it('S5 the frame reader reads the spec and hands back the tree', async () => {
    const body = await frame();
    const reader = createFrameReader(Readable.from(body));
    const read = await reader.readSpec();
    expect(parseJobSpec(read.spec).jobId).toBe(SPEC.jobId);
    const tree = await reader.readTree(body.length - 4 - read.specJson.length);
    expect(tree).toEqual(body.subarray(4 + read.specJson.length));
  });

  it('S5b MUTATION TARGET: a spec split across chunks is framed correctly, not FRAME_TRUNCATED', async () => {
    // F4. The reader used to carry ONE `accepted` byte counter across both phases and never
    // re-based it when it moved onto the spec, so a spec arriving as 148 + 148 bytes after a
    // 4-byte prefix was measured against a total that already included the prefix: it stopped
    // 4 bytes early and refused a perfectly well-formed frame. `brokerClient` never hit it
    // because it writes the whole frame in one `write()`; any chunked writer, any proxy,
    // any socket with a small MTU would.
    const body = await frame();
    const specLength = body.readUInt32BE(0);
    const specJson = body.subarray(4, 4 + specLength);
    const tree = body.subarray(4 + specLength);
    // The hostile shape: the prefix alone, then the spec in two uneven halves, then the tree
    // in one chunk. Half the spec is the exact split the single counter mishandled.
    const source = Readable.from([
      body.subarray(0, 4),
      specJson.subarray(0, Math.floor(specJson.length / 2)),
      specJson.subarray(Math.floor(specJson.length / 2)),
      tree,
    ]);
    const reader = createFrameReader(source);
    const read = await reader.readSpec();
    expect(parseJobSpec(read.spec).jobId).toBe(SPEC.jobId);
    const readTree = await reader.readTree(tree.length);
    expect(readTree).toEqual(tree);

    // And the same split through the real request path, because a unit-level reader is not
    // where the framing is load-bearing.
    const docker = fakeDocker(happyHandler());
    const broker = makeBroker(docker);
    const response = await broker.handle({
      token: 'shared-secret-token',
      body: Readable.from([
        body.subarray(0, 4),
        specJson.subarray(0, 1),
        specJson.subarray(1, 2),
        specJson.subarray(2),
        tree,
      ]),
    });
    expect(response.status).toBe(201);
    expect(response.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('S5c an over-long tree is refused mid-stream and a short one on the way out', async () => {
    // The two halves of the declared-length bound, which is what makes the buffered tree
    // consistent with the policy's staging caps: the reader never holds more than the spec
    // declared, however much the client sends.
    const body = await frame();
    const specLength = body.readUInt32BE(0);
    const tree = body.subarray(4 + specLength);
    const over = createFrameReader(Readable.from(body));
    await over.readSpec();
    await expect(over.readTree(tree.length - 1)).rejects.toThrow(/TREE_EXCEEDED/);
    const under = createFrameReader(Readable.from(body));
    await under.readSpec();
    await expect(under.readTree(tree.length + 1)).rejects.toThrow(/TREE_TRUNCATED/);
  });

  it('S6 the staged-content candidates come from the tree, and a malformed tree yields none', async () => {
    const tree = stagedTree({ data: '{"name":"Ada Lovelace"}' });
    const candidates = await stagedTextCandidates(await treeBytesOf(tree));
    expect(candidates).toContain('{"name":"Ada Lovelace"}');
    expect(await stagedTextCandidates(Buffer.from('not a tar at all, really not'))).toEqual([]);
  });

  it('S7 the capture sink is what refuses an over-bound stream', async () => {
    const spool = await createSpool(spoolRoot);
    const sink = spool.openCapture(16);
    sink.write(Buffer.alloc(16, 1));
    const error = await new Promise<Error>((resolve) => {
      sink.once('error', resolve);
      sink.write(Buffer.alloc(1, 1));
    });
    expect(error).toBeInstanceOf(SpoolOverflowError);
    expect((error as SpoolOverflowError).code).toBe('RENDER_ARTIFACT_INVALID');
    await spool.dispose();
  });
});

// ===========================================================================
// The repository grep gates
// ===========================================================================

describe('render/broker - the repository grep gates', () => {
  it('G1 no docker client and no subprocess spawn outside backend/src/render/broker', () => {
    // The pattern is ASSEMBLED rather than written out, and that is not a trick: the
    // contract's own gate is a repo-wide `Select-String` over every `.ts` file, so a gate
    // written in a plain literal would make the gate itself a hit. The same applies to this
    // file. The assembled pattern is byte-identical to the contract's.
    //
    // The gate is CODE-ONLY and the exclusion is a PATH SEGMENT. Both are load-bearing and
    // both were wrong in the contract's own text (T1040 ruling 13): a text scan counts
    // `sandbox.ts`'s comment - a line that says the module does NOT use `child_process` - and
    // the substring `render\broker` also exempts `render/brokerClient.ts`, which is the file
    // that most needs checking. G1b pins the exclusion itself so neither can regress.
    const forbidden = ['docker' + 'ode', 'docker-' + 'modem', 'child_' + 'process'];
    const pattern = new RegExp(forbidden.join('|'));
    const srcRoot = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (isBrokerExcluded(path.relative(srcRoot, full))) continue;
        if (pattern.test(stripComments(readFileSync(full, 'utf8')))) offenders.push(full);
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it('G1b MUTATION TARGET: the gate exclusion is a PATH SEGMENT, not a substring', () => {
    // The pre-ruling gate matched `render\broker` anywhere in the path, which exempts
    // `render/brokerClient.ts` - the ONE file the contract's second half is about ("the
    // backend process imports no Docker client"), so the weakest form of the gate excluded
    // the most important file. These are the four cases that discriminate.
    expect(isBrokerExcluded(path.join('render', 'broker', 'index.ts'))).toBe(true);
    expect(isBrokerExcluded(path.join('render', 'broker', 'createArgs.ts'))).toBe(true);
    expect(isBrokerExcluded(path.join('render', 'brokerClient.ts'))).toBe(false);
    expect(isBrokerExcluded(path.join('render', 'brokerClient.test.ts'))).toBe(false);
    expect(isBrokerExcluded(path.join('render', 'brokerFake.ts'))).toBe(false);
    expect(isBrokerExcluded(path.join('routes', 'render', 'broker.ts'))).toBe(false);
    // ...and the client is therefore actually scanned by G1, so this is not a formality: if a
    // docker client were ever imported there, the two gates below would catch it.
    const clientCode = stripComments(readFileSync(path.join(__dirname, 'brokerClient.ts'), 'utf8'));
    for (const token of ['docker' + 'ode', 'docker-' + 'modem', 'child_' + 'process']) {
      expect(clientCode).not.toContain(token);
    }
  });

  it('G2 the broker contains NO hand-written typesetter argv', () => {
    // Three checks, each aimed at a different way the rule could be broken, because one
    // blunt "the string never appears" check is impossible to satisfy honestly: the broker
    // MUST name the engine to call the single argv builder, and MUST name the LaTeX binary
    // nowhere at all.
    //   (a) no argv FRAGMENT the builder owns may appear in the broker's code;
    //   (b) the engine name may never be the first element of an array literal (which is
    //       what a hand-built argv would look like);
    //   (c) the other engine's binary may not appear at all.
    const argvFragments = ['--root', '--format', '--font-path', '--package-path', '--package-cache-path', '--ignore-system-fonts', '--jobs', '--diagnostic-format'];
    const engine = ['typ', 'st'].join('');
    const otherBinary = ['pdf', 'latex'].join('');
    const brokerDir = path.resolve(__dirname, 'broker');
    const offenders: string[] = [];
    for (const entry of readdirSync(brokerDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      const code = stripComments(readFileSync(path.join(brokerDir, entry.name), 'utf8'));
      for (const fragment of argvFragments) {
        if (code.includes(fragment)) offenders.push(`${entry.name}: argv fragment ${fragment}`);
      }
      if (code.includes(otherBinary)) offenders.push(`${entry.name}: other-engine binary`);
      if (new RegExp(`\\[[ \\t\\r\\n]*'${engine}'`).test(code)) {
        offenders.push(`${entry.name}: engine literal as an argv element`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('G3 the runner never sets shell: true', () => {
    const code = stripComments(readFileSync(path.join(__dirname, 'broker', 'dockerRunner.ts'), 'utf8'));
    expect(code).toContain('shell: false');
    expect(code).not.toContain('shell: true');
  });

  it('G4 the broker builds its plan through the ONE argv builder', () => {
    const code = stripComments(readFileSync(path.join(__dirname, 'broker', 'index.ts'), 'utf8'));
    // The engine is chosen from the validated spec (policy reversal 2026-10-31), so the
    // call site names `spec.engine` rather than a literal. The property the gate is about
    // is unchanged: every plan comes from `buildCompileArgs`, never from a hand-built argv.
    expect(code).toContain('buildCompileArgs(spec.engine');
    expect(code).not.toContain('Docker(');
  });

  it('G5 the capture bound and the redaction bound are the same 64 KiB', () => {
    expect(DEFAULT_CAPTURE_BYTES).toBe(64 * 1024);
    expect(REDACT_MAX_BYTES).toBe(64 * 1024);
  });

  it('G6 the backend client reaches Docker through the socket and nothing else', () => {
    const forbidden = ['docker' + 'ode', 'docker-' + 'modem', 'child_' + 'process'];
    const code = stripComments(readFileSync(path.join(__dirname, 'brokerClient.ts'), 'utf8'));
    for (const token of forbidden) {
      expect(code).not.toContain(token);
    }
    expect(code).toContain("from './stage.js'");
  });
});

/**
 * Is this file inside the ONE directory the gate exempts?
 *
 * The exemption is anchored to the `render/broker/` SEGMENT. Written as a substring
 * (`path.includes('render\\broker')`) it also exempts `render/brokerClient.ts` and
 * `render/brokerFake.ts` - the first of which is the file the contract's rule exists to
 * police (ADR-042 D2: the API process must not be able to reach Docker), and the second of
 * which is a name nobody has written yet. Exported from the test's own scope so the rule is
 * asserted directly rather than only through the scan that uses it.
 */
function isBrokerExcluded(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/).filter((segment) => segment.length > 0);
  const at = segments.indexOf('render');
  return at >= 0 && segments[at + 1] === 'broker';
}

/**
 * Comment lines, removed.
 *
 * The grep gates are about CODE, not prose: a module whose doc comment has to NAME the
 * libraries it forbids would otherwise fail its own gate, and so would the gate's own source
 * when the contract's check is a repo-wide text search. A line-based strip is enough and is
 * deliberately not a parser - it only has to be conservative, and a code line never begins
 * with `//` or `*` in this repository's style.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}
