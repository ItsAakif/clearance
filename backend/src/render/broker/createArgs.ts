// The container-creation argv builder - the ONE place a render container is described.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md sec. 4 (the whole
//                section: 4.1 network, 4.2 identity, 4.3 filesystem, 4.4 tmpfs, 4.5 the
//                three read-only binds, 4.6 caps, 4.7 the compose skeleton)
//                .planning/decisions/ADR-042-*.md D2/D4
//                .planning/decisions/ADR-044-*.md D1
//                .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 3
// Task:         T1031
//
// WHY A SEPARATE MODULE, AND WHY IT IS PURE
//   `sandbox.ts` owns the COMPILE policy (argv + env). This module owns the CONTAINER
//   policy, which is the third place a render constant can drift (ADR-044 D1: "the render
//   path now has a THIRD place where a policy constant must not drift"). The mitigation
//   ADR-044 names is that this file is ASSERTED AGAINST `REQUIRED_COMPOSE_KEYS` /
//   `REQUIRED_TMPFS` rather than hand-copying the values - and that is literally what
//   happens below: the flags are DERIVED from those tables, so editing the policy table
//   changes the emitted argv, and a policy key with no docker-CLI representation has to be
//   DECLARED unrepresentable or the builder throws. Nothing here is a hardcoded literal
//   except the PID-1 holder, which is an exec-transport fact (ADR-042 D4), not a policy
//   value.
//
// PURE: no I/O, no clock, no environment, no `process`. The same (plan, spec, hostRoot)
// triple always produces byte-identical argv, which is what makes the assertions in
// `broker.test.ts` meaningful rather than incidental.
//
// THE THREE BINDS ARE HOST-ABSOLUTE, AND THAT IS THE WHOLE POINT OF `hostRoot` (T1040
// ruling 10). The policy table in `sandbox.ts` names them REPO-RELATIVE
// (`./backend/typst/toolchain`), which is the right way for a policy table to be written and
// the wrong way for a `--mount source=` to be handed to a daemon: the docker CLI expands a
// relative bind source CLIENT-SIDE, against the CWD of the CLI process. Inside the broker
// container that CWD is `/app` with no repo mounted, so `./backend/typst/toolchain` became
// `/app/backend/typst/toolchain`, which exists neither in the image nor on the host, and
// every `docker create` failed. The LIVE half missed it precisely because it was HOST-run
// from the compose project root, where the same relative string expanded correctly - a
// different process graph, so a defect of this class is invisible to it.
//
// So the builder takes the repository root AS THE DAEMON SEES IT (`RENDER_HOST_TYPST_ROOT`,
// supplied by compose, passed in by the caller so this function stays pure) and emits
// `hostRoot + <the policy's repo-relative path>`. The policy table is unchanged; only the
// expansion is explicit. `assertCreateArgsInvariants` then RE-DERIVES that every one of the
// three sources is absolute, read-only, and underneath that root - so the containment
// property is asserted on the emitted argv, not merely intended by the code that built it.
//
// THE ARGV IS AN ARRAY, AND NEVER A SHELL STRING (policy 5.4). There is no `sh -c` in the
// compile path: the runner spawns argv[0] with an argument vector, so a template name, a
// template version, a revision id or a user id can never be parsed as a flag, and none of
// them is even PRESENT here (see `assertNoCallerDataInArgv`).
//
// NO CALLER DATA REACHES THE CREATE ARGV. `spec` is consumed for two things only: the
// toolchain-pin assertion (`spec.expectedEngineVersion` must be the pin) and the tree
// assertions the caller already made. Every token emitted below comes from a policy
// constant, from `plan.env`, or from the three bind allowlist entries. `templateId`,
// `templateVersion`, `userId` and `revisionId` are therefore structurally unable to appear
// in a container's `docker inspect` output (policy 10.1 item 4 asks for exactly that).

import {
  LATEX_PIN,
  RENDER_CONTAINER,
  RENDER_ENGINES,
  RENDER_PATHS,
  REQUIRED_COMPOSE_KEYS,
  REQUIRED_TMPFS,
  TYPST_PIN,
  type CompilePlan,
  type RenderEngine,
} from '../sandbox.js';

// ---------------------------------------------------------------------------
// The job spec (the wire schema's TYPE half; the validator lives in ./index.ts)
// ---------------------------------------------------------------------------

/**
 * One render request, as it crosses the broker socket.
 *
 * `userId` is for ADMISSION ONLY (policy 10.2's per-user concurrency and the per-minute
 * limiter) and is never argv, never env, never a file name and never a container label.
 * The same is true of `revisionId`; `templateId`/`templateVersion` travel in the job log
 * (policy 10.5) and in the storage/cache key, not in the container.
 *
 * `engine` and `format` are the NARROW literals the broker accepts. The broker serves
 * `typst` and `latex`, both only as `pdf`: `format: 'png' | 'svg'` would mean a second
 * output shape, which policy 6.1/6.3's "exactly one artifact" rule and the `--pages`
 * ban (B10) make a separate decision. Any other engine is `ENGINE_UNSUPPORTED`.
 */
export interface BrokerJobSpec {
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

/** The Typst worker image, derived from the pin and never from configuration. */
export const RENDER_WORKER_IMAGE = `clearance/typst-worker:${TYPST_PIN.version}`;

/** The LaTeX worker image, derived from the LaTeX pin the same way. */
export const RENDER_LATEX_WORKER_IMAGE = `clearance/latex-worker:${LATEX_PIN.version}`;

/** The pinned image for one engine. The ONLY place the image is selected. */
export function workerImageFor(engine: RenderEngine): string {
  return engine === 'latex' ? RENDER_LATEX_WORKER_IMAGE : RENDER_WORKER_IMAGE;
}

/** The toolchain pin an engine's job must declare. */
export function enginePinFor(engine: RenderEngine): string {
  return engine === 'latex' ? LATEX_PIN.version : TYPST_PIN.version;
}

/**
 * The PID-1 holder (ADR-042 D2, measured). A tmpfs `/work` does not exist before the
 * container starts, so `docker cp` cannot reach it; and under `read_only: true` the
 * container's root filesystem is read-only, so `docker cp` fails against a running
 * container too. The image's own ENTRYPOINT is the pinned typst binary, which would exit
 * immediately and take the container with it - so the container's entrypoint is replaced
 * with `sleep infinity` and EVERY real action is a `docker exec`.
 */
export const PID1_HOLDER = Object.freeze({
  entrypoint: '/bin/sleep',
  arg: 'infinity',
});

// ---------------------------------------------------------------------------
// REQUIRED_COMPOSE_KEYS -> docker CLI flags
// ---------------------------------------------------------------------------

/** How a mapped compose key reaches the docker CLI. */
type FlagMode = 'boolean-true' | 'value';

/**
 * The exact translation table. A key present here is emitted from `REQUIRED_COMPOSE_KEYS`
 * and NEVER from a literal, so the two cannot diverge.
 */
const COMPOSE_KEY_FLAGS: Readonly<Record<string, readonly [string, FlagMode]>> = Object.freeze({
  // 4.1 Network. The ONLY acceptable value, and the enforcement point for R6/R8.
  network_mode: ['--network', 'value'],
  // 4.3 Filesystem. Boolean: emitted as the bare flag because the table says 'true'.
  read_only: ['--read-only', 'boolean-true'],
  // 4.3. The table quotes the value ('"none"'); the quotes are compose notation, not part
  // of the value, so they are stripped rather than passed to the CLI.
  ipc: ['--ipc', 'value'],
  // 4.2 Identity and privileges.
  user: ['--user', 'value'],
  cap_drop: ['--cap-drop', 'value'],
  security_opt: ['--security-opt', 'value'],
  // 4.6 Resource caps. The classic top-level key family; policy 4.6 also mandates the
  // Swarm-style `deploy.resources.limits` mirror, which the compose skeleton carries by
  // hand because a flat key/value table has no way to express a nested key (policy 4.6
  // "Machine-encoding status").
  pids_limit: ['--pids-limit', 'value'],
  mem_limit: ['--memory', 'value'],
  memswap_limit: ['--memory-swap', 'value'],
  cpus: ['--cpus', 'value'],
  // 4.6 / 9.1. `stop_grace_period: 5s` is the compose-level backstop for the kill budget;
  // the docker CLI spells it in SECONDS, so the trailing `s` is stripped.
  stop_grace_period: ['--stop-timeout', 'value'],
});

/**
 * The policy keys the docker CLI has NO way to express - and, critically, every one of
 * them is a key whose value is already the DANGEROUS one, so the flag does not exist
 * because the CLI cannot turn it on:
 *
 *   privileged        false - `--privileged` only ever SETS it true. Its ABSENCE is the
 *                                setting, so a create argv that carries `--privileged`
 *                                is rejected by `assertCreateArgsInvariants`.
 *   oom_kill_disable  false - no CLI flag exists to enable it; the kernel default is the
 *                                mandated value, and disabling the OOM killer was never
 *                                available here.
 *   restart           "no"  - a per-job one-shot container is never restarted. There is no
 *                                `--restart` on `docker create`; `--rm`-style lifecycle is
 *                                the broker's `rm -f` in the `finally`.
 *   stdin_open        false - `-i`/`--interactive` only ever OPENS stdin on a created
 *                                container; the compile exec is the only place stdin is
 *                                used, and it is created and destroyed inside the job.
 *   tty               false - `-t`/`--tty` only ever allocates one.
 *
 * The list is exported so `broker.test.ts` can assert that it partitions
 * `Object.keys(REQUIRED_COMPOSE_KEYS)` EXACTLY against `COMPOSE_KEY_FLAGS`: a policy key
 * added to `sandbox.ts` and not classified here makes `buildContainerCreateArgs` throw,
 * so a future policy edit cannot silently ship an unenforced key.
 */
export const UNREPRESENTABLE_COMPOSE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  privileged: 'no CLI flag can only ever set it true; absence is the mandated value',
  oom_kill_disable: 'no CLI flag exists; the kernel default is the mandated false',
  restart: 'a one-shot job container is never restarted; lifecycle is the rm -f in finally',
  stdin_open: '-i/--interactive only ever opens stdin; absence is the mandated value',
  tty: '-t/--tty only ever allocates a tty; absence is the mandated value',
});

/** Strip compose's quoting notation. `'none'` and `none` are the same value. */
function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** `5s` (compose duration) -> `5` (docker CLI seconds). */
function composeDurationSeconds(value: string): string {
  const match = /^(\d+)s$/.exec(value);
  if (match === null) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: stop_grace_period must be a whole number of seconds, got "${value}"`,
    );
  }
  return match[1] as string;
}

/** How a policy key reaches the docker CLI, or that it cannot. */
export type ComposeKeyKind =
  | { readonly kind: 'flag'; readonly flag: string; readonly mode: FlagMode }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unclassified' };

/**
 * Classify one `REQUIRED_COMPOSE_KEYS` key.
 *
 * Exported (and the single thing `pushComposeFlags` calls per key) so the test can prove the
 * UNCLASSIFIED branch is reachable with a synthetic key. That matters: an unclassified key
 * is a policy value the broker silently does not enforce, and the only way to show the
 * refusal is not dead code is to hand the function a key the table does not know. The policy
 * table is frozen, so it cannot be the vehicle for that experiment.
 */
export function classifyComposeKey(key: string): ComposeKeyKind {
  const mapped = COMPOSE_KEY_FLAGS[key];
  if (mapped !== undefined) {
    return { kind: 'flag', flag: mapped[0], mode: mapped[1] };
  }
  if (Object.prototype.hasOwnProperty.call(UNREPRESENTABLE_COMPOSE_KEYS, key)) {
    return { kind: 'absent' };
  }
  return { kind: 'unclassified' };
}

/**
 * Emit one flag per mapped `REQUIRED_COMPOSE_KEYS` entry.
 *
 * The loop is over the POLICY TABLE, never over the translation table, so a key added to
 * the policy and forgotten here is an error rather than an omission. A value that
 * contradicts the flag's own shape (a boolean key that is not 'true', a duration that is
 * not `Ns`) throws instead of being coerced.
 */
function pushComposeFlags(argv: string[]): void {
  for (const [key, raw] of Object.entries(REQUIRED_COMPOSE_KEYS)) {
    const classification = classifyComposeKey(key);
    if (classification.kind === 'unclassified') {
      throw new Error(
        `RENDER_POLICY_VIOLATION: compose key "${key}" has no docker CLI representation and is not declared in UNREPRESENTABLE_COMPOSE_KEYS`,
      );
    }
    if (classification.kind === 'absent') continue;
    const { flag, mode } = classification;
    if (mode === 'boolean-true') {
      if (unquote(raw) !== 'true') {
        throw new Error(`RENDER_POLICY_VIOLATION: compose key "${key}" must be "true"`);
      }
      argv.push(flag);
      continue;
    }
    const value = key === 'stop_grace_period' ? composeDurationSeconds(unquote(raw)) : unquote(raw);
    argv.push(flag, value);
  }
}

// ---------------------------------------------------------------------------
// The bind allowlist (policy 4.5) - exactly three, all inside the repo
// ---------------------------------------------------------------------------

/** A host path the policy allows: repo-relative, no separator escape, no traversal. */
function assertRepoRelativeHostPath(host: string): void {
  if (!host.startsWith('./')) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: a bind host path must be repo-relative ("./..."), got "${host}"`,
    );
  }
  if (host.includes('..')) {
    throw new Error('RENDER_POLICY_VIOLATION: a bind host path may not contain ".."');
  }
  if (host.includes('\\')) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: a bind host path must use POSIX separators, got "${host}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// The host-visible repository root (T1040 ruling 10)
// ---------------------------------------------------------------------------

/** A validated host root, plus the separator to join it with the policy's POSIX sub-path. */
export interface HostRoot {
  /** The root with any trailing separator removed. Never a relative path. */
  readonly root: string;
  /** `\` on a Windows-style root, `/` on a POSIX one - so the emitted source is not mixed. */
  readonly separator: string;
}

/** Is this an ABSOLUTE path in either spelling the daemon accepts? */
export function isAbsoluteHostPath(candidate: string): boolean {
  return candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate);
}

/**
 * Validate the host-visible repository root.
 *
 * The value is operator configuration, not caller data, and every failure message here is a
 * FIXED string with nothing interpolated: a diagnostic that quoted a host path would be one
 * more path shape for the redaction rules to catch, and the redaction rules exist for
 * reasons that have nothing to do with a config typo.
 *
 * Refused, and each refusal is a distinct failure worth naming:
 *   - empty / not a string: the broker is deployed without the key. A BOOT failure, not a
 *     per-job one, for the same reason the token is (see `main()` in ./index.ts);
 *   - a NUL, a comma or an equals sign: `--mount` is a COMMA-separated field list, so any of
 *     the three would let a config value inject a fourth field (`readonly,source=...`) into
 *     the mount this policy controls;
 *   - relative: the defect this whole mechanism exists to fix;
 *   - a `..` segment: a root that walks out of itself is a root whose containment check is
 *     meaningless.
 */
export function assertHostRoot(hostRoot: string): HostRoot {
  if (typeof hostRoot !== 'string' || hostRoot.length === 0) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: a host-visible repository root is required (RENDER_HOST_TYPST_ROOT)',
    );
  }
  if (/[\0,=]/.test(hostRoot)) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: the host repository root may not contain a NUL, a comma or an equals sign',
    );
  }
  const windowsStyle = /^[A-Za-z]:[\\/]/.test(hostRoot);
  if (!windowsStyle && !hostRoot.startsWith('/')) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: the host repository root must be an absolute path the docker daemon can resolve',
    );
  }
  const root = hostRoot.replace(/[\\/]+$/, '');
  if (root.length === 0) {
    throw new Error('RENDER_POLICY_VIOLATION: the host repository root is empty once its separators are trimmed');
  }
  if (root.split(/[\\/]/).includes('..')) {
    throw new Error('RENDER_POLICY_VIOLATION: the host repository root may not contain a ".." segment');
  }
  return Object.freeze({ root, separator: windowsStyle ? '\\' : '/' });
}

/**
 * Expand ONE policy bind against the host root, and assert the result is where it must be.
 *
 * The expansion is the whole change of behaviour and it is deliberately mechanical: the
 * policy's repo-relative path, minus its mandated `./`, joined onto the host root. Nothing
 * else about the bind is touched - the target, the `type=bind` and the `readonly` are
 * untouched, so the read-only guarantee is exactly as strong as it was.
 */
export function hostBindSource(hostRoot: HostRoot, bindHost: string): string {
  assertRepoRelativeHostPath(bindHost);
  // The policy's sub-path is POSIX (the policy table mandates it, and
  // `assertRepoRelativeHostPath` refuses a backslash), so it is TRANSLATED rather than
  // pasted: `E:\repo` + `./backend/typst/fonts` must not become `E:\repo\backend/typst/fonts`.
  // A mixed-separator path is a path whose meaning depends on who parses it, and the parser
  // here is a daemon on a different operating system.
  const relative = bindHost.slice('./'.length).split('/').join(hostRoot.separator);
  const source = `${hostRoot.root}${hostRoot.separator}${relative}`;
  assertBindUnderHostRoot(source, hostRoot);
  return source;
}

/** Containment: a bind source must be absolute, must live under the host root, and must not
 *  climb out of it. Called on the way out of the builder AND by the argv re-check, so a
 *  hand-mutated argv is held to the same rule the builder was. */
export function assertBindUnderHostRoot(source: string, hostRoot: HostRoot): void {
  if (!isAbsoluteHostPath(source)) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: a bind source may not be relative; the docker CLI would resolve it against its own CWD',
    );
  }
  const prefix = `${hostRoot.root}${hostRoot.separator}`;
  if (!source.startsWith(prefix)) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: every bind source must live under the host repository root',
    );
  }
  const relative = source.slice(prefix.length);
  if (relative.length === 0 || relative.split(/[\\/]/).includes('..')) {
    throw new Error('RENDER_POLICY_VIOLATION: a bind source may not be the host root itself or escape it');
  }
}

function pushBinds(argv: string[], hostRoot: HostRoot): void {
  const binds = RENDER_CONTAINER.readOnlyBinds;
  if (binds.length !== 3) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: the read-only bind allowlist is exactly three mounts, got ${binds.length}`,
    );
  }
  for (const bind of binds) {
    if (RENDER_CONTAINER.forbiddenBindTargets.includes(bind.target)) {
      throw new Error(`RENDER_POLICY_VIOLATION: forbidden bind target "${bind.target}"`);
    }
    const source = hostBindSource(hostRoot, bind.host);
    // The LONG form (`--mount type=bind,...,readonly`) is what compose uses and what the
    // policy mandates; a short `- src:dst` without `,readonly` is a review failure.
    argv.push('--mount', `type=bind,source=${source},target=${bind.target},readonly`);
  }
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Build the complete `docker create` argv for ONE render job.
 *
 * Shape: `<policy flags> IMAGE infinity`, i.e. the PID-1 holder. The image's own
 * entrypoint (the pinned typst binary) is replaced, so the container stays alive for the
 * staging exec, the compile exec and the extraction exec, and is then destroyed.
 *
 * The compile environment is set HERE, at CREATE, as a COMPLETE map: `plan.env` is
 * emitted as `--env KEY=VALUE` for every key it has, and nothing else is added, so the
 * container's environment is exactly the policy environment. It is never merged over the
 * broker's own environment, and a `--env` flag is emitted only for a key the plan carries
 * - which is why `XDG_CACHE_HOME` (policy 3.4's mandated ABSENCE) cannot appear: the plan
 * has no such key, and `assertPolicyInvariants` would already have rejected a plan that
 * did. The broker re-asserts the same map per key on the exec (`./index.ts`), because a
 * per-exec environment that silently fell back to the container's would be a second,
 * weaker source of truth.
 *
 * ONE MEASURED CAVEAT, recorded because "exactly" should not be overstated. The live run in
 * `.planning/progress/T1031-render-broker-service.md` shows the daemon adding
 * `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` to `Config.Env` - it
 * does that for every container whether or not any `--env` was passed, and no flag turns it
 * off. So the container's environment is `plan.env` PLUS docker's image-default `PATH`, and
 * never anything from the BROKER's environment, which is the property that actually matters
 * (a broker deployed with `TYPST_ROOT=/` or `HOME=/root` cannot reach a compile). The
 * default `PATH` is also why `resolveEngineBinary()` exists in `./index.ts`: the compile
 * cannot rely on a bare binary name resolving.
 *
 * Throws, always with a fixed message and no caller data interpolated: a policy key with
 * no CLI representation, a value that contradicts its flag's shape, a host root that is not
 * an absolute path the daemon can resolve, a bind outside that root, or a bind target on the
 * forbidden list.
 *
 * `hostRoot` is the repository root AS THE DOCKER DAEMON SEES IT, and it is a PARAMETER
 * rather than an environment read so this function stays pure and testable (T1040 ruling
 * 10). Compose supplies it as `RENDER_HOST_TYPST_ROOT`; `main()` in ./index.ts fails boot
 * when it is absent rather than falling back to a relative path, because the relative form
 * is precisely what cannot work from inside the broker container.
 */
export function buildContainerCreateArgs(
  plan: CompilePlan,
  spec: BrokerJobSpec,
  hostRoot: string,
): readonly string[] {
  if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.argv)) {
    throw new Error('RENDER_POLICY_VIOLATION: a compile plan is required');
  }
  if (spec === null || typeof spec !== 'object') {
    throw new Error('RENDER_INPUT_INVALID: a job spec is required');
  }
  const host = assertHostRoot(hostRoot);
  // The pin is checked HERE as well as in `buildCompileArgs`, because this is the module
  // that decides which image runs. A mismatch must be impossible to reach, not merely
  // unlikely (RENDER_TOOLCHAIN_MISMATCH). The engine selects BOTH the pin and the image.
  if (spec.engine !== plan.engine) {
    throw new Error('RENDER_POLICY_VIOLATION: the job spec engine must match the compile plan');
  }
  const pinnedVersion = enginePinFor(plan.engine);
  if (spec.expectedEngineVersion !== pinnedVersion) {
    throw new Error(
      `RENDER_TOOLCHAIN_MISMATCH: template expects engine ${spec.expectedEngineVersion}, pinned engine is ${pinnedVersion}`,
    );
  }

  const argv: string[] = [];

  pushComposeFlags(argv);

  // Policy 4.4: writable locations are tmpfs ONLY. The three entries are taken from
  // `REQUIRED_TMPFS` verbatim, so the size caps and the nosuid/nodev/noexec/uid/gid
  // options are the policy's, not this file's.
  for (const tmpfs of REQUIRED_TMPFS) {
    argv.push('--tmpfs', tmpfs);
  }

  pushBinds(argv, host);

  // The COMPLETE compile environment, sorted for a deterministic argv.
  for (const key of Object.keys(plan.env).sort()) {
    argv.push('--env', `${key}=${plan.env[key] as string}`);
  }

  // Policy 3.3 / 4.7: the work dir is the project root and it is always the tmpfs.
  argv.push('--workdir', RENDER_PATHS.work);

  argv.push('--entrypoint', PID1_HOLDER.entrypoint);
  argv.push(workerImageFor(plan.engine));
  argv.push(PID1_HOLDER.arg);

  assertCreateArgsInvariants(argv, plan, spec, hostRoot);
  return Object.freeze(argv);
}

// ---------------------------------------------------------------------------
// Invariant re-check - callable on a MUTATED argv, which is the point
// ---------------------------------------------------------------------------

/**
 * Flags that only ever WIDEN the sandbox, so `docker create` must never carry one.
 *
 * Every entry is a flag with no safe value here at all: `--privileged` and `--cap-add`
 * grant privilege, `--device`/`--pid`/`--userns`/`--ipc` change the isolation boundary,
 * `--volume`/`-v` is the SHORT bind form that cannot express `read_only` (policy 4.5
 * rejects it by name), `--restart` would resurrect a job container, and `-i`/`-t` open a
 * stdin/tty on a container whose whole lifecycle is the broker's `rm -f`.
 *
 * Note what is NOT here: `--network` and `--ipc`. Both are MANDATED by policy 4.1/4.3, so
 * forbidding the token would forbid the policy. They are constrained by VALUE and by
 * OCCURRENCE COUNT instead (a second `--network host` would otherwise override the first).
 */
const FORBIDDEN_CREATE_TOKENS: readonly string[] = Object.freeze([
  '--privileged',
  '--cap-add',
  '--device',
  '--userns',
  '--pid',
  '--security-opt=seccomp=unconfined',
  '--security-opt=apparmor=unconfined',
  '--volume',
  '-v',
  '--restart',
  '-i',
  '--interactive',
  '-t',
  '--tty',
  '--entrypoint=/opt/typst/typst',
]);

/** Every token in this argv must be a flag this module emits, a value of one, or the
 *  image. Anything else is an unvetted surface, so the list is closed and checked. */
const ALLOWED_CREATE_FLAGS: readonly string[] = Object.freeze([
  ...new Set([
    ...Object.values(COMPOSE_KEY_FLAGS).map(([flag]) => flag),
    '--tmpfs',
    '--mount',
    '--env',
    '--workdir',
    '--entrypoint',
  ]),
]);

/** The value-taking flags whose OCCURRENCE must be exactly one, because docker applies
 *  the last occurrence and a duplicate is therefore an unvetted override. */
const SINGLETON_FLAGS: readonly string[] = Object.freeze([
  '--network',
  '--ipc',
  '--user',
  '--workdir',
  '--entrypoint',
]);

/**
 * Re-derive every non-negotiable of policy section 4 from the emitted argv.
 *
 * This is deliberately a SEPARATE, EXPORTED function rather than an inline tail of the
 * builder: the builder calls it on its own output (so an incorrect argv can never be
 * returned), and the tests call it on hand-mutated argv (so a mutation - dropping
 * `--read-only`, adding a fourth bind, adding a docker socket - is a failing test rather
 * than a silent weakening). See `.planning/progress/T1031-render-broker-service.md` for the
 * mutation table.
 */
export function assertCreateArgsInvariants(
  argv: readonly string[],
  plan: CompilePlan,
  spec: BrokerJobSpec,
  hostRoot: string,
): void {
  if (!Array.isArray(argv)) {
    throw new Error('RENDER_POLICY_VIOLATION: the create argv must be an array');
  }
  const host = assertHostRoot(hostRoot);
  const tokens: string[] = argv;
  if (tokens.length === 0 || tokens.some((token) => typeof token !== 'string' || token.length === 0)) {
    throw new Error('RENDER_POLICY_VIOLATION: the create argv must be an array of non-empty strings');
  }

  // --- 0. The flag vocabulary is CLOSED. Any flag outside it is an unvetted surface, and
  //        it is rejected whether or not a later check would have complained about it.
  for (const token of tokens) {
    if (token.startsWith('-') && !ALLOWED_CREATE_FLAGS.includes(token)) {
      throw new Error(`RENDER_POLICY_VIOLATION: forbidden create flag "${token}"`);
    }
    if (FORBIDDEN_CREATE_TOKENS.includes(token)) {
      throw new Error(`RENDER_POLICY_VIOLATION: forbidden create token "${token}"`);
    }
  }
  // A duplicate of a value-taking flag is a last-occurrence override, so each of these
  // must appear exactly once.
  for (const flag of SINGLETON_FLAGS) {
    const occurrences = tokens.filter((token) => token === flag).length;
    if (occurrences !== 1) {
      throw new Error(
        `RENDER_POLICY_VIOLATION: ${flag} must appear exactly once, got ${occurrences}`,
      );
    }
  }

  // --- 1. Every REQUIRED_COMPOSE_KEYS entry is present with its policy value.
  for (const [key, raw] of Object.entries(REQUIRED_COMPOSE_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(UNREPRESENTABLE_COMPOSE_KEYS, key)) {
      // Asserted by ABSENCE, which is how the docker CLI encodes "false"/"no". The
      // closed flag vocabulary above is what makes the absence an assertion rather than
      // a hope: `--privileged`, `-i`, `-t` and `--restart` cannot appear at all.
      continue;
    }
    const mapped = classifyComposeKey(key);
    if (mapped.kind === 'unclassified') {
      throw new Error(`RENDER_POLICY_VIOLATION: compose key "${key}" has no docker CLI representation`);
    }
    if (mapped.kind === 'absent') {
      throw new Error(`RENDER_POLICY_VIOLATION: compose key "${key}" is declared absent but was reached`);
    }
    const { flag, mode } = mapped;
    const expected =
      key === 'stop_grace_period' ? composeDurationSeconds(unquote(raw)) : unquote(raw);
    const at = tokens.indexOf(flag);
    if (at === -1) {
      throw new Error(`RENDER_POLICY_VIOLATION: the create argv is missing ${flag} (${key})`);
    }
    if (mode === 'boolean-true') continue;
    if (tokens[at + 1] !== expected) {
      throw new Error(
        `RENDER_POLICY_VIOLATION: ${flag} must be "${expected}" (${key}), got "${String(tokens[at + 1])}"`,
      );
    }
  }

  // --- 3. tmpfs: exactly the three mandated entries, in policy order, no more.
  const tmpfsTokens = tokens.filter((_token, index) => tokens[index - 1] === '--tmpfs');
  if (tmpfsTokens.length !== REQUIRED_TMPFS.length) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: exactly ${REQUIRED_TMPFS.length} tmpfs mounts are required, got ${tmpfsTokens.length}`,
    );
  }
  if (!sameStrings(tmpfsTokens, REQUIRED_TMPFS)) {
    throw new Error('RENDER_POLICY_VIOLATION: the tmpfs mounts must be the mandated entries');
  }

  // --- 4. Binds: EXACTLY three, all read-only, all HOST-ABSOLUTE and underneath the host
  //        root, and none of them the docker socket or a host path (policy 4.5's complete
  //        allowlist).
  const mounts = tokens.filter((_token, index) => tokens[index - 1] === '--mount');
  if (mounts.length !== 3) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: exactly three read-only binds are required, got ${mounts.length}`,
    );
  }
  const seenTargets: string[] = [];
  for (const mount of mounts) {
    const fields = mount.split(',');
    const source = fields.find((field) => field.startsWith('source='))?.slice('source='.length);
    const target = fields.find((field) => field.startsWith('target='))?.slice('target='.length);
    if (source === undefined || target === undefined) {
      throw new Error('RENDER_POLICY_VIOLATION: every bind must be a long-form type=bind mount');
    }
    if (fields[0] !== 'type=bind') {
      throw new Error('RENDER_POLICY_VIOLATION: every bind must be type=bind');
    }
    if (!fields.includes('readonly')) {
      throw new Error(`RENDER_POLICY_VIOLATION: bind "${target}" must be read-only`);
    }
    if (RENDER_CONTAINER.forbiddenBindTargets.includes(target)) {
      throw new Error(`RENDER_POLICY_VIOLATION: forbidden bind target "${target}"`);
    }
    // Containment, re-derived from the EMITTED argv rather than trusted from the builder: a
    // relative source would be expanded by the docker CLI against its own CWD, and a source
    // outside the host root would be a host path the policy's allowlist does not contain.
    assertBindUnderHostRoot(source, host);
    // And the source must be exactly this policy bind under that root - not merely somewhere
    // under it. Without this, a fourth read-only path inside the repo (a `.env`, a private
    // key directory) would satisfy containment and still widen what the engine can read.
    const allowed = RENDER_CONTAINER.readOnlyBinds.map((bind) => hostBindSource(host, bind.host));
    if (!allowed.includes(source)) {
      throw new Error(
        'RENDER_POLICY_VIOLATION: a bind source must be one of the three policy binds under the host root',
      );
    }
    // The single most consequential assertion in the file: a docker socket here would
    // turn a Typst RCE into host takeover (policy 4.5, R13).
    if (source.includes('docker.sock') || target.includes('docker.sock')) {
      throw new Error('RENDER_POLICY_VIOLATION: a docker socket may never be bind-mounted');
    }
    seenTargets.push(target);
  }
  if (new Set(seenTargets).size !== seenTargets.length) {
    throw new Error('RENDER_POLICY_VIOLATION: the bind targets must be distinct');
  }

  // --- 5. The environment is COMPLETE and equal to the plan's, key for key. This is what
  //        makes "never merged with the broker's own environment" checkable: the set of
  //        --env keys IS plan.env's key set, no more and no fewer. The walk is by INDEX
  //        (not `indexOf` on the token), so a duplicated `KEY=value` cannot be mis-counted.
  const envPairs: Array<readonly [string, string]> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== '--env') continue;
    const pair = tokens[index + 1];
    if (pair === undefined) {
      throw new Error('RENDER_POLICY_VIOLATION: --env requires a KEY=value argument');
    }
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error('RENDER_POLICY_VIOLATION: --env arguments must be KEY=value');
    }
    envPairs.push([pair.slice(0, eq), pair.slice(eq + 1)]);
  }
  if (!sameStrings(envPairs.map((pair) => pair[0]).sort(), Object.keys(plan.env).sort())) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: the create environment must be exactly the plan environment, never merged with an ambient one',
    );
  }
  for (const [key, value] of Object.entries(plan.env)) {
    const present = envPairs.some((pair) => pair[0] === key && pair[1] === value);
    if (!present) {
      throw new Error(
        `RENDER_POLICY_VIOLATION: the create environment is missing "${key}=${value}"`,
      );
    }
  }

  // --- 6. The PID-1 holder and the pinned image, at the END of the argv (docker's
  //        `[OPTIONS] IMAGE [COMMAND] [ARG...]` grammar). The image is selected by the
  //        PLAN's engine, so a latex plan cannot be run on the Typst worker (or the
  //        reverse) without this check failing.
  const pinnedImage = workerImageFor(plan.engine);
  const imageAt = tokens.indexOf(pinnedImage);
  if (imageAt === -1) {
    throw new Error(`RENDER_POLICY_VIOLATION: the create argv must name the pinned image ${pinnedImage}`);
  }
  if (tokens[imageAt + 1] !== PID1_HOLDER.arg || imageAt + 2 !== tokens.length) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: the image must be followed by exactly "${PID1_HOLDER.arg}"`,
    );
  }
  if (tokens[imageAt - 2] !== '--entrypoint' || tokens[imageAt - 1] !== PID1_HOLDER.entrypoint) {
    throw new Error(
      `RENDER_POLICY_VIOLATION: the container entrypoint must be replaced with ${PID1_HOLDER.entrypoint}`,
    );
  }
  if (tokens.lastIndexOf(pinnedImage) !== imageAt) {
    throw new Error('RENDER_POLICY_VIOLATION: the pinned image must appear exactly once');
  }
  // A worker image for a DIFFERENT engine must not appear either. This is the check that
  // catches a stale `RENDER_WORKER_IMAGE` left in a latex argv.
  for (const engine of RENDER_ENGINES) {
    const other = workerImageFor(engine);
    if (other !== pinnedImage && tokens.includes(other)) {
      throw new Error('RENDER_POLICY_VIOLATION: the create argv names a worker image for another engine');
    }
  }

  // --- 7. The workdir is the policy tmpfs and the project root.
  if (tokens[tokens.indexOf('--workdir') + 1] !== RENDER_PATHS.work) {
    throw new Error(`RENDER_POLICY_VIOLATION: --workdir must be ${RENDER_PATHS.work}`);
  }

  // --- 8. No caller-supplied value is present anywhere in the argv. The fields that
  //        carry caller data are compared literally, so a future edit that started
  //        interpolating one of them fails here rather than in `docker inspect`.
  assertNoCallerDataInArgv(tokens, spec);
}

/** Element-wise string-array equality. Written out rather than a `join` so that a
 *  separator character can never make two different arrays compare equal. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/**
 * Assert that none of the caller-data fields appears in the create argv.
 *
 * This is a defence-in-depth assertion, not the primary control: the builder never reads
 * those fields, so there is nothing for it to interpolate. It exists because a later edit
 * that "helpfully" added `--label clearance.job=${spec.jobId}` would be policy-legal on its
 * face (`jobId` is an opaque id, not content) and would quietly make every job id visible in
 * `docker ps` on a shared host - so the refusal is written down.
 *
 * The comparison is a SUBSTRING search over the joined argv, and a field shorter than
 * `MIN_CALLER_DATA_LEN` is skipped. Both details are forced by reality rather than chosen:
 * a substring search is what catches an interpolation that produced `KEY=value` rather than a
 * bare token, and a four-character floor is needed because a legitimate caller value -
 * `templateVersion: '1'` is entirely normal - collides byte-for-byte with policy values like
 * `--cpus 1`, so treating any match as a violation would make the assertion unsatisfiable and
 * therefore worthless.
 */
export const MIN_CALLER_DATA_LEN = 4;

export function assertNoCallerDataInArgv(argv: readonly string[], spec: BrokerJobSpec): void {
  const joined = argv.join(' ');
  for (const field of [spec.jobId, spec.templateId, spec.templateVersion, spec.userId, spec.revisionId]) {
    if (typeof field !== 'string' || field.length < MIN_CALLER_DATA_LEN) continue;
    if (joined.includes(field)) {
      throw new Error('RENDER_POLICY_VIOLATION: caller-supplied data must never appear in the create argv');
    }
  }
}
