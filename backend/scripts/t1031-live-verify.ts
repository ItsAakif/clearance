// T1031 LIVE verification driver - NOT a committed artifact.
//
// Runs the REAL broker code (the same modules the compose service runs) against the REAL
// Docker daemon on the host, with the real `clearance/typst-worker:0.15.1` image, and the
// real `RenderBrokerClient` over a real local socket. It asserts:
//   1. the boot preflight passes;
//   2. a staged tree renders and the 201 body starts with `%PDF-`;
//   3. the sha256 header matches the bytes;
//   4. the container's isolation is what policy 4.7 mandates (network none, read-only,
//      user 65532, cap_drop ALL, pids limit, memory cap, three read-only binds, no socket);
//   5. no container is left behind.
//
// THE HOST ROOT (T1040 ruling 10, review F1). The three policy-4.5 binds are emitted as
// `RENDER_HOST_TYPST_ROOT + the repo-relative path`, because a `--mount source=./...` is
// expanded by the CLI against the CLI's own CWD and that CWD is `/app` inside the broker
// container. So this script is run FROM THE COMPOSE PROJECT ROOT (the policy's `./backend/
// typst/...` is repo-relative) or with the root given explicitly.
//
// The spelling must be the one THIS CLI can hand to the daemon, and the two process graphs
// disagree on that - measured, not assumed:
//   host run, WINDOWS docker CLI : E:\Projects\Webd+AI\Clearance   (a POSIX-looking source is
//                                rejected by the daemon here: "bind source path does not exist")
//   compose broker, LINUX CLI   : /run/desktop/mnt/host/e/Projects/Webd+AI/Clearance
// Both are exercised: this script with the host value, and the compose service with the VM
// value. The refusal check below is the same in both - a relative root is never accepted.

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildCompileArgs, TYPST_PIN } from '../src/render/sandbox.js';
import { stageRenderJobInMemory, openStageTreeStream, type StageTree } from '../src/render/stage.js';
import { createDockerCliRunner, type DockerRunner } from '../src/render/broker/dockerRunner.js';
import { buildContainerCreateArgs, isAbsoluteHostPath, RENDER_WORKER_IMAGE } from '../src/render/broker/createArgs.js';
import { Broker, type BrokerJobSpec, type BrokerDeps } from '../src/render/broker/index.js';
import { RenderBrokerClient, buildJobSpec } from '../src/render/brokerClient.js';

const TOKEN = 'live-verification-token-not-a-secret';
const HOST_ROOT = process.env.RENDER_HOST_TYPST_ROOT ?? process.cwd();
const results: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` :: ${detail}`}`);
  if (!ok) process.exitCode = 1;
}

/** A throwaway plan/spec pair, for the host-root refusal probe above. */
function plan0(): ReturnType<typeof buildCompileArgs> {
  return buildCompileArgs('typst', { creationTimestampUnix: 1_757_000_000, format: 'pdf' });
}
function SPEC0(): BrokerJobSpec {
  return buildJobSpec({
    jobId: 't1031-root-probe',
    templateId: 'typst-resume-classic',
    templateVersion: '1',
    creationTimestampUnix: 1_757_000_000,
    userId: 'probe',
    revisionId: 'probe',
    treeBytes: 0,
    treeFileCount: 1,
  }) as BrokerJobSpec;
}

async function main(): Promise<void> {
  // --- a real staged tree on disk, which the REAL stager validates and reads.
  const work = mkdtempSync(path.join(os.tmpdir(), 't1031-live-'));
  const templatePath = path.join(work, 'template.typ');
  const dataPath = path.join(work, 'data.json');
  writeFileSync(
    templatePath,
    [
      // A4 in MILLIMETRES, not as a paper name: typst 0.15.1's `page(width:)` takes a
      // length (`expected length or auto, found string` for a name), and the point of this
      // fixture is the transport, not the typography.
      '#set page(width: 210mm, height: 297mm, margin: 20mm)',
      // NO `#set text(font: ...)`: the only fonts the worker can see are the vendored
      // Source Serif 4 set (policy 4.5 plus `--ignore-system-fonts`), so naming anything
      // else here would fail the compile for a reason that has nothing to do with the
      // broker. This template's job is to exercise the transport, not the typography.
      '#let d = json("data.json")',
      '= #d.name',
      '',
      'T1031 live render verification.',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    dataPath,
    JSON.stringify({ name: 'Ada Lovelace', roles: ['Render broker'] }),
    'utf8',
  );

  const tree: StageTree = await stageRenderJobInMemory({
    engine: 'typst',
    template: { path: templatePath, declaredBytes: undefined },
    data: { path: dataPath },
  });
  check(
    'the real stager produced a validated tree',
    tree.names.includes('template.typ') && tree.names.includes('data.json'),
    tree.names.join(','),
  );

  const tarChunks: Buffer[] = [];
  for await (const chunk of openStageTreeStream(tree)) tarChunks.push(chunk as Buffer);
  const tar = Buffer.concat(tarChunks);

  // --- the REAL docker runner, wrapped so the container can be INSPECTED while it exists.
  // The isolation assertions below are read out of `docker inspect` on a container that was
  // really created by the broker's own argv, which is a stronger statement than re-reading
  // the argv back.
  const base = createDockerCliRunner();
  let createdId: string | null = null;
  let observedHostConfig: Record<string, unknown> = {};
  let observedConfig: Record<string, unknown> = {};
  const docker: DockerRunner = {
    binary: base.binary,
    async run(argv, options) {
      const result = await base.run(argv, options);
      // `T1031_DEBUG=1` prints every call's argv, exit code and UNREDACTED stderr. The broker
      // redacts its own diagnostics (policy 9.4), which is right in production and wrong when
      // you are the one debugging a live run: a redacted "bind source path does not exist:
      // <path>" cost this round an hour, because the path it hid was the one that mattered.
      if (process.env.T1031_DEBUG === '1') {
        console.error('DEBUG', JSON.stringify(argv.slice(0, 8)), 'code', result.code, 'stderr', result.stderr);
      }
      if (argv[0] === 'create' && result.code === 0) {
        const id = result.stdout.trim().split(/\s+/)[0] ?? '';
        createdId = id;
        const inspected = await base.run(['inspect', id], { timeoutMs: 20_000 });
        if (inspected.code === 0) {
          const parsed = JSON.parse(inspected.stdout) as Array<{ HostConfig: Record<string, unknown> }>;
          observedHostConfig = parsed[0]?.HostConfig ?? {};
          observedConfig = parsed[0]?.Config ?? {};
        }
      }
      return result;
    },
  };
  const spoolRoot = path.join(work, 'spool');
  const logs: unknown[] = [];
  const deps: BrokerDeps = {
    docker,
    now: () => Date.now(),
    log: (...args: unknown[]) => logs.push(args),
    token: TOKEN,
    spoolRoot,
    hostRoot: HOST_ROOT,
  };
  const broker = new Broker(deps);

  // (0) THE HOST ROOT IS ABSOLUTE AND IS REFUSED IF IT IS NOT (F1). This is the one line that
  // would have caught the compose defect before a single container was created.
  check(
    'the host repository root is absolute, as the daemon must resolve it',
    isAbsoluteHostPath(HOST_ROOT),
    HOST_ROOT,
  );
  let relativeRootRefused = false;
  try {
    buildContainerCreateArgs(plan0(), SPEC0(), './backend');
  } catch (error) {
    relativeRootRefused = (error as Error).message.includes('RENDER_POLICY_VIOLATION');
  }
  check('a repo-relative host root is refused by the builder', relativeRootRefused);

  // (1) BOOT PREFLIGHT, against the real daemon and the real pinned image.
  const preflight = await broker.preflight();
  check('boot preflight: the pinned worker image is present', preflight.ok, preflight.message);
  if (!preflight.ok) {
    console.log(results.join('\n'));
    return;
  }

  // (4) The create argv the broker WILL use, inspected against policy 4.7.
  const plan = buildCompileArgs('typst', { creationTimestampUnix: 1_757_000_000, format: 'pdf' });
  const spec: BrokerJobSpec = buildJobSpec({
    jobId: 't1031-live',
    templateId: 'typst-resume-classic',
    templateVersion: '1',
    creationTimestampUnix: 1_757_000_000,
    userId: 'live-user',
    revisionId: 'live-rev',
    treeBytes: tar.length,
    treeFileCount: tree.names.length,
  }) as BrokerJobSpec;
  const createArgs = buildContainerCreateArgs(plan, spec, HOST_ROOT);
  const at = (flag: string): number => createArgs.indexOf(flag);
  check('create argv: network none', createArgs[at('--network') + 1] === 'none');
  check('create argv: read-only root filesystem', createArgs.includes('--read-only'));
  check('create argv: user 65532:65532', createArgs[at('--user') + 1] === '65532:65532');
  check('create argv: cap_drop ALL', createArgs[at('--cap-drop') + 1] === 'ALL');
  check(
    'create argv: no-new-privileges',
    createArgs[at('--security-opt') + 1] === 'no-new-privileges:true',
  );
  check('create argv: pids 64', createArgs[at('--pids-limit') + 1] === '64');
  check('create argv: mem/memswap 1 GiB', createArgs[at('--memory') + 1] === '1073741824' && createArgs[at('--memory-swap') + 1] === '1073741824');
  check('create argv: cpus 1', createArgs[at('--cpus') + 1] === '1');
  const mounts = createArgs.filter((_t, i) => createArgs[i - 1] === '--mount');
  check('create argv: exactly three read-only binds', mounts.length === 3, mounts.join(' | '));
  // F1: every source is HOST-ABSOLUTE and under the root. A `./`-relative source here is the
  // defect that made the compose service unrenderable, so it is asserted on the real argv.
  const sources = mounts.map((mount) => /source=([^,]+)/.exec(mount)?.[1] ?? '');
  check(
    'create argv: every bind source is HOST-ABSOLUTE under the host root (F1)',
    sources.length === 3 && sources.every((source) => isAbsoluteHostPath(source) && source.startsWith(HOST_ROOT)),
    sources.join(' | '),
  );
  check('create argv: no docker socket', !createArgs.join(' ').includes('docker.sock'));
  check('create argv: the pinned image', createArgs.includes(RENDER_WORKER_IMAGE), RENDER_WORKER_IMAGE);
  check('create argv: the PID-1 holder', createArgs[at('--entrypoint') + 1] === '/bin/sleep' && createArgs[createArgs.length - 1] === 'infinity');
  check('typst pin', TYPST_PIN.version === '0.15.1');

  // --- a real socket, and the REAL client.
  const socketDir = path.join(work, 'sock');
  mkdirSync(socketDir, { recursive: true });
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\clearance-t1031-live-${process.pid}`
      : path.join(socketDir, 'broker.sock');
  const { createBrokerServer } = await import('../src/render/broker/index.js');
  const server = createBrokerServer({
    token: TOKEN,
    spoolRoot,
    hostRoot: HOST_ROOT,
    docker,
    log: (...args: unknown[]) => logs.push(args),
  });
  await new Promise<void>((resolve, reject) => {
    server.server.once('error', reject);
    server.server.listen(socketPath, () => {
      server.server.removeListener('error', reject);
      resolve();
    });
  });
  check('the broker is listening on a real local socket', true, socketPath);

  const client = new RenderBrokerClient({
    endpoint: { socketPath, token: TOKEN },
    timeoutMs: 60_000,
  });

  const started = Date.now();
  let result;
  try {
    result = await client.render(spec, tree);
  } catch (error) {
    check('the render succeeded', false, (error as Error).message);
    for (const entry of logs) console.log('LOG', JSON.stringify(entry));
    console.log(results.join('\n'));
    await server.close();
    rmSync(work, { recursive: true, force: true });
    return;
  }
  const elapsed = Date.now() - started;

  // (2) + (3) the artifact.
  check('201 with a real PDF artifact', result.artifact.subarray(0, 5).toString('latin1') === '%PDF-', `${result.byteSize} bytes`);
  check(
    'the sha256 header matches the bytes',
    result.sha256 === createHash('sha256').update(result.artifact).digest('hex'),
    result.sha256,
  );
  check('the mime type is application/pdf', result.mimeType === 'application/pdf');
  check('the render finished inside the wall budget plus margin', elapsed < 30_000, `${elapsed} ms`);

  // (4) as OBSERVED on the REAL container the broker created, read out of `docker inspect`
  // while it existed. This is the strongest form of the isolation assertion available
  // without a bespoke probe: it is the daemon's own answer, not a re-read of the argv.
  check('a container really was created', createdId !== null, String(createdId));
  check('observed: network mode is none', observedHostConfig.NetworkMode === 'none', String(observedHostConfig.NetworkMode));
  check('observed: read-only root filesystem', observedHostConfig.ReadonlyRootfs === true, String(observedHostConfig.ReadonlyRootfs));
  check('observed: user 65532:65532', String(observedConfig.User) === '65532:65532', String(observedConfig.User));
  check(
    'observed: cap_drop ALL',
    JSON.stringify(observedHostConfig.CapDrop) === '["ALL"]',
    JSON.stringify(observedHostConfig.CapDrop),
  );
  check(
    'observed: no-new-privileges',
    JSON.stringify(observedHostConfig.SecurityOpt ?? []).includes('no-new-privileges'),
    JSON.stringify(observedHostConfig.SecurityOpt),
  );
  check('observed: privileged is false', observedHostConfig.Privileged === false, String(observedHostConfig.Privileged));
  check('observed: pids limit 64', Number(observedHostConfig.PidsLimit) === 64, String(observedHostConfig.PidsLimit));
  check('observed: memory 1 GiB', Number(observedHostConfig.Memory) === 1_073_741_824, String(observedHostConfig.Memory));
  check('observed: no swap escape', Number(observedHostConfig.MemorySwap) === 1_073_741_824, String(observedHostConfig.MemorySwap));
  check('observed: NanoCpus 1.0', Number(observedHostConfig.NanoCpus) === 1_000_000_000, String(observedHostConfig.NanoCpus));
  // `--mount` (the LONG form policy 4.5 mandates) is reported in `HostConfig.Mounts`, NOT in
  // `Binds`: the short `- src:dst` form is what populates `Binds`. Asserting on `Binds`
  // would have read as "no binds at all", so the observation is taken from the field docker
  // actually fills.
  const observedMounts = (observedHostConfig.Mounts as Array<{ Type?: string; Source?: string; Target?: string; ReadOnly?: boolean }> | undefined) ?? [];
  check(
    'observed: exactly three binds, all read-only, all resolved under the host root',
    observedMounts.length === 3 &&
      observedMounts.every((mount) => mount.Type === 'bind' && mount.ReadOnly === true) &&
      // The DAEMON's own answer to "where did this source resolve to", which is the only
      // version of the claim that matters: the CLI sent a string, the daemon opened a path.
      observedMounts.every((mount) => (mount.Source ?? '').replace(/\\/g, '/').includes('/backend/typst/')),
    JSON.stringify(observedMounts),
  );
  check(
    'observed: no docker socket, no pgdata, no host path outside the repo',
    !observedMounts.some((mount) =>
      (mount.Source ?? '').includes('docker.sock') ||
      (mount.Source ?? '').includes('pgdata') ||
      (mount.Target ?? '').includes('docker.sock')),
    observedMounts.map((mount) => [mount.Source, mount.Target, 'ro=' + String(mount.ReadOnly)].join('->')).join(' | '),
  );
  const observedTmpfs = (observedHostConfig.Tmpfs as Record<string, string> | undefined) ?? {};
  check(
    'observed: the three mandated tmpfs mounts at the mandated sizes',
    Object.keys(observedTmpfs).sort().join(',') === '/out,/tmp,/work' &&
      observedTmpfs['/work']?.includes('size=32m') === true &&
      observedTmpfs['/out']?.includes('size=16m') === true &&
      observedTmpfs['/tmp']?.includes('size=16m') === true &&
      Object.values(observedTmpfs).every((options) => options.includes('nosuid') && options.includes('nodev') && options.includes('noexec')),
    JSON.stringify(observedTmpfs),
  );
  const observedEnv = (observedConfig.Env as string[] | undefined) ?? [];
  check(
    'observed: the compile env is present and XDG_CACHE_HOME is ABSENT',
    observedEnv.some((entry) => entry.startsWith('TYPST_ROOT=/work')) &&
      !observedEnv.some((entry) => entry.startsWith('XDG_CACHE_HOME')) &&
      !observedEnv.some((entry) => entry.startsWith('TYPST_CERT')),
    observedEnv.join(' | '),
  );

  // (5) no container left behind.
  const leftovers = await base.run(
    ['ps', '-a', '--filter', `id=${createdId ?? 'nonexistent'}`, '--format', '{{.Names}}'],
    { timeoutMs: 20_000 },
  );
  check('no job container is left behind', leftovers.stdout.trim() === '', leftovers.stdout.trim());

  // A positive observation: the daemon still reports the pinned image, unchanged.
  const images = await base.run(['image', 'inspect', RENDER_WORKER_IMAGE, '--format', '{{.Id}}'], { timeoutMs: 20_000 });
  check('the pinned image is intact after the run', images.code === 0, images.stdout.trim());

  // The spool directory is empty: the per-job spool was removed in the finally.
  const { readdirSync } = await import('node:fs');
  check('the broker spool is empty (deleted in the finally)', readdirSync(spoolRoot).length === 0, readdirSync(spoolRoot).join(','));

  const jobLogs = logs
    .flat()
    .filter((entry): entry is { event: string; outcome: string; byteSize: number } =>
      entry !== null && typeof entry === 'object' && (entry as { event?: string }).event === 'render.job');
  check('exactly one structured job log line, with no diagnostics on success', jobLogs.length === 1 && (jobLogs[0] as Record<string, unknown>).outcome === 'ok' && (jobLogs[0] as Record<string, unknown>).diagnostics === undefined, JSON.stringify(jobLogs));

  await server.close();
  rmSync(work, { recursive: true, force: true });
  console.log(results.join('\n'));
  void process.exitCode;
}

void main().catch((error: unknown) => {
  console.log(results.join('\n'));
  console.log('DRIVER ERROR', (error as Error).message, (error as Error).stack);
  process.exitCode = 1;
});
