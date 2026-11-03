// Render sandbox policy - the single source of compile policy.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md
// Task:         T1006 (defines the policy that T1005 must satisfy)
//
// This module is PURE: no `fs`, no `child_process`, no `net`, no `process.env` read,
// no `Date.now()`. It is data plus a pure function, so every non-negotiable in the
// policy document is unit-testable (backend/vitest.config.ts includes `src/**/*.test.ts`).
//
// CONVENTION (policy section 13.2): `buildCompileArgs()` is the ONLY place in the
// repository where a typesetter's argv or environment is constructed. The single
// permitted exception is `backend/typst/Dockerfile`, whose ENTRYPOINT may pass an argv
// through but must not add, remove or reorder a policy flag. A repo-wide grep gate
// (`typst compile` / `pdflatex`) must return zero hits outside `backend/src/render/`
// and that Dockerfile.
//
// Background references (read 2026-09-30):
//   - ADR-038 decisions 4-5: isolated compile, network none, no shell escape ever.
//   - ADR-041 D2: render binaries are never stored in PostgreSQL.
//   - .planning/specs/clearance-v2/06-design.md E.9 mitigations 1-8.
//   - typst v0.15.1 source. crates/typst-cli/src/args.rs is the origin of every flag and
//     environment-variable name used below (WorldArgs, ProcessArgs, FontArgs,
//     PackageArgs). crates/typst-cli/src/compile.rs `fn pdf_options` defaults
//     `timestamp` to `chrono::Local::now()` when unset, and `ProcessArgs.jobs`
//     defaults to the CPU count - which is why `creationTimestampUnix` is REQUIRED and
//     why `--jobs 1` is emitted.

// ---------------------------------------------------------------------------
// Engines and formats
// ---------------------------------------------------------------------------

/** The closed set of render engines. Anything else throws (policy V29). */
export const RENDER_ENGINES = ['typst', 'latex'] as const;

export type RenderEngine = (typeof RENDER_ENGINES)[number];

/** Paged output formats the compile path emits. */
export const RENDER_FORMATS = ['pdf', 'png', 'svg'] as const;

export type RenderFormat = (typeof RENDER_FORMATS)[number];

function isRenderEngine(value: unknown): value is RenderEngine {
  return typeof value === 'string' && (RENDER_ENGINES as readonly string[]).includes(value);
}

function isRenderFormat(value: unknown): value is RenderFormat {
  return typeof value === 'string' && (RENDER_FORMATS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// In-container paths (policy sections 4.4 and 4.5)
//
// These are FIXED container paths, deliberately NOT caller parameters. Making the
// project root a constant is what makes "root is always the temp dir" true by
// construction rather than by convention (policy V27).
// ---------------------------------------------------------------------------

export const RENDER_PATHS = Object.freeze({
  /** The typst project root: tmpfs, rw,nosuid,nodev,noexec,size=32m. */
  work: '/work',
  /** The single-artifact output dir: a SEPARATE tmpfs, size=16m. */
  out: '/out',
  /** Read-only bind mount of the pinned toolchain. */
  toolchain: '/opt/typst',
  /**
   * LaTeX's binary path INSIDE its worker image. There is deliberately no host bind
   * here: the image ships the pinned TeX Live install, and `/opt/latex/pdflatex` is a
   * symlink to the distro binary created at image build time. Resolving the bare
   * `pdflatex` name against this constant gives the broker the absolute path it needs
   * without adding a second argv source.
   */
  latexToolchain: '/opt/latex',
  /** Read-only bind mount of the vendored, licence-recorded Typst Universe packages. */
  packages: '/opt/typst-packages',
  /** Read-only bind mount of the vendored font set (the ONLY font source). */
  fonts: '/opt/typst-fonts',
  /**
   * The package CACHE is redirected onto the tmpfs on purpose: an unvendored import
   * then fails with a NETWORK error rather than an EROFS error, which is a readable
   * diagnosis and also proves nothing can be cached persistently (policy 7.3).
   */
  packageCache: '/work/.pkgcache',
  /** Staged resume payload. Read by the template with `json("data.json")`. */
  data: '/work/data.json',
  /** Staged engine templates. */
  typstTemplate: '/work/template.typ',
  latexTemplate: '/work/artifact.tex',
  /** The one allowed artifact name per format. Never derived from caller content. */
  artifact: Object.freeze({
    pdf: '/out/artifact.pdf',
    png: '/out/artifact.png',
    svg: '/out/artifact.svg',
  }),
  /** LaTeX: every mutable TEXMF location lives on the tmpfs and dies with the job. */
  texmfHome: '/work/texmf-home',
  /**
   * kpathsea's config SEARCH LIST. The first entry is the tmpfs location the policy
   * mandates and is where a future entrypoint could write a job-local `texmf.cnf`; the
   * second is the image's own read-only TeX Live config. A single-directory value (the
   * pre-reversal shape) made kpathsea lose `TEXMFROOT` and abort with
   * "I can't find the format file `pdflatex.fmt'", so the fallback is load-bearing.
   * Nothing writable moves off the tmpfs: TEXMFHOME, TEXMFVAR and TEXMFOUTPUT below are
   * unchanged.
   */
  texmfCnf: '/work/texmf-cnf:/usr/share/texlive/texmf-dist/web2c',
  texmfVar: '/work/texmf-var',
  /** LaTeX: `\openout` may not escape the tmpfs output dir. */
  texmfOutput: '/out',
  /** Staged file BASENAMES (policy section 5.1). */
  names: Object.freeze({
    typstTemplate: 'template.typ',
    latexTemplate: 'artifact.tex',
    data: 'data.json',
  }),
});

// ---------------------------------------------------------------------------
// Limits (policy sections 4.6, 5.2, 6.2, 9.1)
// ---------------------------------------------------------------------------

export interface RenderLimits {
  /** Wall-clock budget per compile before the supervisor stops waiting. */
  wallClockMs: number;
  /** Grace between the soft stop and SIGKILL of the container. */
  killGraceMs: number;
  memoryBytes: number;
  /** Equal to memoryBytes on purpose: no swap escape, so the cap bites as an OOM kill. */
  swapBytes: number;
  cpuCores: number;
  pids: number;
  /** Per staged-asset cap. */
  inputFileBytes: number;
  /** data.json is the resume payload, so it gets its own larger cap. */
  dataFileBytes: number;
  inputTotalBytes: number;
  inputFileCount: number;
  /** Supervisor-side artifact cap. The 16 MiB /out tmpfs is the kernel-side bound. */
  outputBytes: number;
  workTmpfsBytes: number;
  outTmpfsBytes: number;
}

export const RENDER_LIMITS: Readonly<RenderLimits> = Object.freeze({
  wallClockMs: 10_000,
  killGraceMs: 2_000,
  memoryBytes: 1_073_741_824, // 1 GiB
  swapBytes: 1_073_741_824, // memswap_limit == mem_limit
  cpuCores: 1,
  pids: 64,
  inputFileBytes: 1_048_576, // 1 MiB
  dataFileBytes: 4_194_304, // 4 MiB
  inputTotalBytes: 8_388_608, // 8 MiB
  inputFileCount: 5, // template + data.json + up to 3 declared assets
  outputBytes: 20_971_520, // 20 MiB
  workTmpfsBytes: 33_554_432, // 32 MiB
  outTmpfsBytes: 16_777_216, // 16 MiB
});

/** Concurrency and queueing defaults (policy section 10.2). TUNABLE lower, never higher. */
export const RENDER_QUOTA = Object.freeze({
  concurrentPerHost: 2,
  concurrentPerUser: 1,
  queueDepth: 8,
  rendersPerMinutePerUser: 10,
});

// ---------------------------------------------------------------------------
// Container identity (policy section 4.2)
// ---------------------------------------------------------------------------

export const RENDER_CONTAINER = Object.freeze({
  user: '65532:65532',
  networkMode: 'none',
  readOnlyRootFilesystem: true,
  capDrop: Object.freeze(['ALL'] as const),
  securityOpt: Object.freeze(['no-new-privileges:true'] as const),
  /** The COMPLETE bind-mount allowlist (policy section 4.5). */
  readOnlyBinds: Object.freeze([
    Object.freeze({ host: './backend/typst/toolchain', target: RENDER_PATHS.toolchain }),
    Object.freeze({ host: './backend/typst/packages', target: RENDER_PATHS.packages }),
    Object.freeze({ host: './backend/typst/fonts', target: RENDER_PATHS.fonts }),
  ]),
  /** Explicitly forbidden, asserted so a future edit cannot add one silently. */
  forbiddenBindTargets: Object.freeze([
    '/var/run/docker.sock',
    '/run/docker.sock',
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/var/run',
  ]),
});

// ---------------------------------------------------------------------------
// Toolchain pins (policy section 7.1)
// ---------------------------------------------------------------------------

// Verified 2026-09-30 from the upstream release's own asset digest field:
//   https://api.github.com/repos/typst/typst/releases/latest  ->  tag_name v0.15.1
//   asset `typst-x86_64-unknown-linux-musl.tar.xz`, 17462992 bytes,
//   digest sha256:a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c
// `musl` (not `gnu`) is mandated for a scratch/distroless image. Apache-2.0.
// `typst:latest`, a distro `typst` package and `cargo install typst-cli` are all
// forbidden: each resolves a moving dependency tree.
export const TYPST_PIN = Object.freeze({
  version: '0.15.1',
  binary: 'typst',
  asset: 'typst-x86_64-unknown-linux-musl.tar.xz',
  assetBytes: 17_462_992,
  sha256: 'a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c',
  license: 'Apache-2.0',
});

/**
 * LaTeX is now a SERVER-SIDE compile engine (owner-requested policy reversal, 2026-10-31).
 * It used to be export-only (ADR-042 D1) and this pin was a historical placeholder. It is
 * now the TeX Live release the pinned worker image actually reports:
 *
 *   pdfTeX 3.141592653-2.6-1.40.24 (TeX Live 2022/Debian)
 *
 * The version string is the TeX Live YEAR ("2022"), not the pdfTeX build number: the
 * year is what moves when the Debian package set moves, so it is the right cache key
 * (`engineVersion`) and the right `expectedEngineVersion` on the wire.
 *
 * `openin_any = p` is kpathsea's PARANOID level: "as `r` and disallow going to parent
 * directories, and restrict absolute paths to be under $TEXMFOUTPUT", where `r` is
 * *restricted* (weaker). `p` is therefore stricter than `r` and is what is mandated -
 * see policy section 11.1.4 and open item OI-3.
 *
 * Consequence of `p`: the input document must be passed RELATIVE to the work dir
 * (`artifact.tex`, not `/work/artifact.tex`), because an absolute input path outside
 * `$TEXMFOUTPUT` is exactly what paranoid mode refuses. `latexArgv()` below does that.
 */
export const LATEX_PIN = Object.freeze({
  version: '2022',
  binary: 'pdflatex',
  shellEscape: 'forbidden',
  openinAny: 'p',
  openoutAny: 'p',
  /** LuaLaTeX is strictly more capable and is forbidden; so is shell-escaped Tectonic. */
  forbiddenBinaries: Object.freeze(['lualatex', 'xelatex', 'luatex', 'tectonic']),
});

// ---------------------------------------------------------------------------
// Per-engine policy
// ---------------------------------------------------------------------------

export interface EnginePolicy {
  readonly engine: RenderEngine;
  readonly binary: string;
  /**
   * Literal argv fragments that MUST appear in the built argv. Asserted by
   * `assertPolicyInvariants` and by the V32 doc/code drift test.
   */
  readonly requiredArgvFragments: readonly string[];
  /** Env keys that MUST be present in the built env. */
  readonly requiredEnvKeys: readonly string[];
  /**
   * Env keys whose VALUE is a policy constant. Presence is not enough: `openin_any` set
   * to `a` is present but catastrophic, so the level itself is asserted.
   */
  readonly requiredEnvValues: Readonly<Record<string, string>>;
  /**
   * argv tokens and env keys that MUST NEVER appear. `--open` spawns an external
   * program (`open::with_detached`), `--pages` implies `--no-pdf-tags` (accessibility)
   * plus a second output shape, `--cert` is typst's network affordance. `watch`,
   * `update` and `init` are separate subcommands that must never be reachable from a
   * compile; `watch` additionally starts an HTTP listener for html/bundle export.
   */
  readonly forbiddenArgvFragments: readonly string[];
  readonly forbiddenEnvKeys: readonly string[];
}

/** Anything that looks like shell escape must be an explicit DENY token, never an enable. */
const SHELL_ESCAPE_PATTERN = /shell[-_\\]?escape/i;
const SHELL_ESCAPE_DENY_TOKENS: readonly string[] = ['-no-shell-escape', 'shell_escape=f', 'SHELL_ESCAPE=f'];
const SHELL_ESCAPE_DENY_VALUES: readonly string[] = ['f', 'false', '0', 'no', 'off', ''];
/** typst's CLI affordances that would re-open a network path. */
const NETWORK_FORBIDDEN_TOKENS: readonly string[] = ['--cert', 'http://', 'https://'];

const TYPST_POLICY: EnginePolicy = Object.freeze({
  engine: 'typst',
  binary: TYPST_PIN.binary,
  requiredArgvFragments: Object.freeze([
    'compile',
    '--root',
    RENDER_PATHS.work,
    '--format',
    '--package-path',
    RENDER_PATHS.packages,
    '--package-cache-path',
    RENDER_PATHS.packageCache,
    '--font-path',
    RENDER_PATHS.fonts,
    '--ignore-system-fonts',
    '--jobs',
    '1',
    '--diagnostic-format',
    'short',
  ]),
  requiredEnvKeys: Object.freeze([
    'TYPST_ROOT',
    'TYPST_PACKAGE_PATH',
    'TYPST_PACKAGE_CACHE_PATH',
    'TYPST_FONT_PATHS',
    'TYPST_IGNORE_SYSTEM_FONTS',
    'TYPST_IGNORE_EMBEDDED_FONTS',
    'SOURCE_DATE_EPOCH',
    'TZ',
    'LC_ALL',
    'HOME',
  ]),
  requiredEnvValues: Object.freeze({
    TYPST_ROOT: RENDER_PATHS.work,
    TYPST_PACKAGE_PATH: RENDER_PATHS.packages,
    TYPST_PACKAGE_CACHE_PATH: RENDER_PATHS.packageCache,
    TYPST_FONT_PATHS: RENDER_PATHS.fonts,
    // T1013 correction (T1005 OI-7 / D1, measured on typst 0.15.1): these are clap
    // booleans and clap REJECTS '1':
    //   error: invalid value '1' for '--ignore-system-fonts'
    //     [possible values: true, false]
    // With '1' the worker cannot parse its own argv and never renders at all, so
    // 'true' is not a preference - it is the only value typst accepts. It is also
    // strictly more restrictive than the intent, and both settings are
    // independently present as explicit argv flags (which policy 4.7 calls
    // authoritative), so a bug that DROPS one of them still cannot WIDEN the sandbox.
    TYPST_IGNORE_SYSTEM_FONTS: 'true',
    TYPST_IGNORE_EMBEDDED_FONTS: 'true',
    TZ: 'UTC',
    HOME: '/nonexistent',
  }),
  forbiddenArgvFragments: Object.freeze([
    '--open',
    '--pages',
    '--no-pdf-tags',
    '--cert',
    'watch',
    'update',
    'init',
    'eval',
    'query',
    'completions',
    'info',
    'fonts',
  ]),
  // `XDG_CACHE_HOME` is listed here because policy section 3.4 mandates the
  // container UNSETS it, and the only faithful encoding of "unset" in a
  // key/value map is absence. Asserting absence (rather than `''`) means a
  // future edit that adds `XDG_CACHE_HOME: ''` to `sharedEnv` fails this
  // invariant instead of silently changing the mandated semantics.
  forbiddenEnvKeys: Object.freeze(['TYPST_CERT', 'TYPST_FEATURES', 'XDG_CACHE_HOME']),
});

const LATEX_POLICY: EnginePolicy = Object.freeze({
  engine: 'latex',
  binary: LATEX_PIN.binary,
  requiredArgvFragments: Object.freeze([
    '-no-shell-escape',
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    '-recorder',
    `-output-directory=${RENDER_PATHS.out}`,
    '-jobname=artifact',
  ]),
  requiredEnvKeys: Object.freeze([
    'shell_escape',
    'SHELL_ESCAPE',
    'openin_any',
    'OPENIN_ANY',
    'openout_any',
    'OPENOUT_ANY',
    'TEXMFOUTPUT',
    'TEXMFHOME',
    'TEXMFCNF',
    'TEXMFVAR',
    'SOURCE_DATE_EPOCH',
    'FORCE_SOURCE_DATE',
    'TZ',
    'LC_ALL',
    'HOME',
  ]),
  // Presence is not enough: `openin_any` set to `a` is present but catastrophic, so
  // the paranoid level itself is asserted, in both spellings.
  requiredEnvValues: Object.freeze({
    shell_escape: 'f',
    SHELL_ESCAPE: 'f',
    openin_any: LATEX_PIN.openinAny,
    OPENIN_ANY: LATEX_PIN.openinAny,
    openout_any: LATEX_PIN.openoutAny,
    OPENOUT_ANY: LATEX_PIN.openoutAny,
    TEXMFOUTPUT: RENDER_PATHS.texmfOutput,
    TEXMFHOME: RENDER_PATHS.texmfHome,
    TEXMFCNF: RENDER_PATHS.texmfCnf,
    TEXMFVAR: RENDER_PATHS.texmfVar,
    TZ: 'UTC',
    HOME: '/nonexistent',
  }),
  forbiddenArgvFragments: Object.freeze([
    '-shell-escape',
    '--shell-escape',
    '-enable-sh',
    ...LATEX_PIN.forbiddenBinaries,
  ]),
  forbiddenEnvKeys: Object.freeze([
    'shell_escape=true',
    'SHELL_ESCAPE=true',
    // Policy 3.4: unset, not empty. See the typst entry above.
    'XDG_CACHE_HOME',
  ]),
});

const ENGINE_POLICIES: Readonly<Record<RenderEngine, EnginePolicy>> = Object.freeze({
  typst: TYPST_POLICY,
  latex: LATEX_POLICY,
});

// ---------------------------------------------------------------------------
// The policy object
// ---------------------------------------------------------------------------

/** Internal outcome codes (policy section 9.2). Never surfaced verbatim to the user. */
export const RENDER_OUTCOME_CODES = Object.freeze([
  'ok',
  'RENDER_COMPILE_ERROR',
  'RENDER_TIMEOUT',
  'RENDER_RESOURCE_LIMIT',
  'RENDER_ARTIFACT_INVALID',
  'RENDER_INPUT_TOO_LARGE',
  'RENDER_TOOLCHAIN_MISMATCH',
  'RENDER_BUSY',
]);

export interface RenderPolicy {
  readonly spec: string;
  readonly task: string;
  readonly engines: readonly RenderEngine[];
  readonly formats: readonly RenderFormat[];
  readonly network: 'none';
  readonly shellEscape: 'forbidden';
  readonly isolation: 'one-container-per-compile';
  readonly paths: typeof RENDER_PATHS;
  readonly limits: Readonly<RenderLimits>;
  readonly quota: typeof RENDER_QUOTA;
  readonly container: typeof RENDER_CONTAINER;
  readonly typstPin: typeof TYPST_PIN;
  readonly latexPin: typeof LATEX_PIN;
  readonly enginePolicies: Readonly<Record<RenderEngine, EnginePolicy>>;
  readonly outcomeCodes: readonly string[];
  /** Staged basenames allowed per engine (policy section 5.1). */
  readonly allowedStageNames: Readonly<Record<RenderEngine, readonly string[]>>;
  readonly maxStageNameLength: number;
  enginePolicy(engine: RenderEngine): EnginePolicy;
}

export const RENDER_POLICY: Readonly<RenderPolicy> = Object.freeze({
  spec: '.planning/specs/clearance-v2/render-sandbox-policy.md',
  task: 'T1006',
  engines: RENDER_ENGINES,
  formats: RENDER_FORMATS,
  network: 'none',
  shellEscape: 'forbidden',
  isolation: 'one-container-per-compile',
  paths: RENDER_PATHS,
  limits: RENDER_LIMITS,
  quota: RENDER_QUOTA,
  container: RENDER_CONTAINER,
  typstPin: TYPST_PIN,
  latexPin: LATEX_PIN,
  enginePolicies: ENGINE_POLICIES,
  outcomeCodes: RENDER_OUTCOME_CODES,
  allowedStageNames: Object.freeze({
    typst: Object.freeze([RENDER_PATHS.names.typstTemplate, RENDER_PATHS.names.data]),
    latex: Object.freeze([RENDER_PATHS.names.latexTemplate]),
  }),
  maxStageNameLength: 64,
  enginePolicy(engine: RenderEngine): EnginePolicy {
    if (!isRenderEngine(engine)) {
      throw new Error(`RENDER_ENGINE_UNKNOWN: engine must be one of ${RENDER_ENGINES.join(', ')}`);
    }
    return ENGINE_POLICIES[engine];
  },
});

// ---------------------------------------------------------------------------
// Stage-name validation (policy section 5.2.4)
// ---------------------------------------------------------------------------

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
// C0 + DEL + C1 control characters.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
// Windows RESERVED DEVICE names, with or without an extension: `NUL`, `nul.txt` and
// `NUL.` all resolve to the null device on Windows, whatever the extension says. They
// satisfy SAFE_NAME, have no leading `-` or `.`, and would therefore be ACCEPTED by
// every other rule. On POSIX the same names are ordinary files, so the rejection is
// harmless there; the cost of allowing them is a legal-looking declared asset that
// fails later with a confusing `NOT_REGULAR` (a character device on the destination).
const RESERVED_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CLOCK\$)(\.|$)/i;

/**
 * Validate a staged file BASENAME. Accepts only `[A-Za-z0-9._-]+`, at most
 * `RENDER_POLICY.maxStageNameLength` characters. Rejects, with a fixed message and no
 * caller data interpolated:
 *   - non-strings and empty strings
 *   - any `/` or `\`                       (path separator)
 *   - any `..` segment, `.` or `..`         (parent-directory traversal)
 *   - absolute paths                        (leading `/` is a separator hit)
 *   - a leading `.`                         (dotfile)
 *   - a leading `-`                         (argv-injection vector, policy 5.4)
 *   - NUL or any C0/C1 control character
 *   - a Windows reserved device name        (`NUL`, `CON`, `COM1`, ..., with or
 *     without an extension), which satisfies the character allowlist but is not a file
 *   - anything else outside the allowlist   (spaces, quotes, `$`, backticks, ...)
 *
 * Size caps are NOT this function's job: they are enforced by the stager against
 * `RENDER_LIMITS` BEFORE the container starts (`RENDER_INPUT_TOO_LARGE`).
 */
export function assertSafeStageName(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('RENDER_INPUT_INVALID: stage name must be a non-empty string');
  }
  if (name.length > RENDER_POLICY.maxStageNameLength) {
    throw new Error('RENDER_INPUT_INVALID: stage name is too long');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('RENDER_INPUT_INVALID: stage name must not contain a path separator');
  }
  if (name === '.' || name === '..' || name.includes('..')) {
    throw new Error('RENDER_INPUT_INVALID: stage name must not contain a parent-directory segment');
  }
  if (name.startsWith('-')) {
    throw new Error('RENDER_INPUT_INVALID: stage name must not start with a dash');
  }
  if (name.startsWith('.')) {
    throw new Error('RENDER_INPUT_INVALID: stage name must not start with a dot');
  }
  if (CONTROL_CHARS.test(name)) {
    throw new Error('RENDER_INPUT_INVALID: stage name must not contain control characters');
  }
  if (RESERVED_DEVICE.test(name)) {
    throw new Error('RENDER_INPUT_INVALID: stage name is a reserved device name');
  }
  if (!SAFE_NAME.test(name)) {
    throw new Error('RENDER_INPUT_INVALID: stage name contains an unsupported character');
  }
  return name;
}

// ---------------------------------------------------------------------------
// Environment assembly
// ---------------------------------------------------------------------------

/** Env values shared by every engine (policy sections 4.5, 7.4, 8). */
function sharedEnv(creationTimestampUnix: number): Record<string, string> {
  return {
    // Determinism: a pinned value, NEVER wall clock.
    SOURCE_DATE_EPOCH: String(creationTimestampUnix),
    // Date formatting inside a template must not depend on the container's zone.
    TZ: 'UTC',
    // Locale-sensitive sorting/collation must not depend on the image.
    LC_ALL: 'C.UTF-8',
    LANG: 'C.UTF-8',
    // No per-job HOME state anywhere (policy 3.4).
    HOME: '/nonexistent',
    // Policy 3.4 also mandates the container UNSETS `XDG_CACHE_HOME`. The
    // mandated semantics is ABSENCE, so there is deliberately no key here: a
    // returned env map is the COMPLETE container environment and is never
    // merged over an ambient one, so a host cache path cannot leak in. The
    // absence is machine-enforced, not just documented - `XDG_CACHE_HOME` is in
    // each engine's `forbiddenEnvKeys`, so `assertPolicyInvariants` rejects any
    // plan that reintroduces the key (including as `''`).
  };
}

function typstEnv(creationTimestampUnix: number): Record<string, string> {
  return {
    ...sharedEnv(creationTimestampUnix),
    // Env locks mirroring the argv flags, so a bug that DROPS a flag still cannot
    // WIDEN the sandbox. argv is authoritative; these are the second, independent lock.
    TYPST_ROOT: RENDER_PATHS.work,
    TYPST_PACKAGE_PATH: RENDER_PATHS.packages,
    TYPST_PACKAGE_CACHE_PATH: RENDER_PATHS.packageCache,
    // Font set is the allowlist. `--font-path` is the only source (typst documents
    // `--ignore-system-fonts` as "unless explicitly included via --font-path"), system
    // fonts are refused, and embedded fonts are refused, so two hosts with different
    // installed fonts produce identical PDFs (policy 7.4, risk R14).
    TYPST_FONT_PATHS: RENDER_PATHS.fonts,
    // 'true', NOT '1': typst 0.15.1 parses these as clap booleans and rejects '1'
    // with `invalid value '1' for '--ignore-system-fonts'`, so a plan carrying '1'
    // would hand the worker an argv it cannot parse. See TYPST_POLICY below.
    TYPST_IGNORE_SYSTEM_FONTS: 'true',
    // Env, not a flag, on purpose: in typst's source `--ignore-embedded-fonts` is
    // gated behind the `embedded-fonts` cargo feature, so passing the flag to a build
    // without that feature would make the CLI fail to parse. An unrecognised env var is
    // ignored by clap, which fails toward "more fonts off", the safe direction.
    TYPST_IGNORE_EMBEDDED_FONTS: 'true',
  };
}

function latexEnv(creationTimestampUnix: number): Record<string, string> {
  return {
    ...sharedEnv(creationTimestampUnix),
    // Three independent shell-escape locks (policy 11.2):
    //   1. `-no-shell-escape` in argv (LATEX_POLICY.requiredArgvFragments)
    //   2. `shell_escape = f` here, in BOTH spellings, because kpathsea resolves its
    //      config variables from the environment and emitting both removes any
    //      case-convention doubt
    //   3. a `texmf.cnf` written into RENDER_PATHS.texmfCnf by the entrypoint
    // Any one failing still leaves the other two. `texmf.cnf` is authoritative.
    shell_escape: 'f',
    SHELL_ESCAPE: 'f',
    // `p` = kpathsea PARANOID ("as `r` and disallow going to parent directories, and
    // restrict absolute paths to be under $TEXMFOUTPUT"). `r` = restricted (weaker).
    openin_any: LATEX_PIN.openinAny,
    OPENIN_ANY: LATEX_PIN.openinAny,
    openout_any: LATEX_PIN.openoutAny,
    OPENOUT_ANY: LATEX_PIN.openoutAny,
    // `\openout` may not escape the tmpfs output dir.
    TEXMFOUTPUT: RENDER_PATHS.texmfOutput,
    // Every mutable TEXMF location is on the tmpfs and dies with the job, so a
    // compile-time package install cannot persist (policy 11.1.6, risk R3).
    TEXMFHOME: RENDER_PATHS.texmfHome,
    TEXMFCNF: RENDER_PATHS.texmfCnf,
    TEXMFVAR: RENDER_PATHS.texmfVar,
    // pdfTeX honours SOURCE_DATE_EPOCH only when this is set.
    FORCE_SOURCE_DATE: '1',
  };
}

// ---------------------------------------------------------------------------
// Argv assembly
// ---------------------------------------------------------------------------

function typstArgv(format: RenderFormat): string[] {
  return [
    TYPST_PIN.binary,
    'compile',
    '--root',
    RENDER_PATHS.work, // the project root is ALWAYS the ephemeral tmpfs work dir
    '--format',
    format,
    '--package-path',
    RENDER_PATHS.packages, // vendored only: no resolution, no download (policy 7.3)
    '--package-cache-path',
    RENDER_PATHS.packageCache, // on the tmpfs, so a miss fails as a NETWORK error
    '--font-path',
    RENDER_PATHS.fonts, // the ONLY font source
    '--ignore-system-fonts',
    '--jobs',
    '1', // the default is the CPU count; parallel float layout can then differ (R14)
    '--diagnostic-format',
    'short', // compact logs; host paths never reach the API surface anyway (R13)
    RENDER_PATHS.typstTemplate,
    RENDER_PATHS.artifact[format],
    // NOTE: `data.json` is deliberately NOT passed as `--input key=value`. Resume
    // content must never appear in argv or env (policy 5.4, risk R15, V24); the
    // template reads the staged file with `json("data.json")`.
  ];
}

function latexArgv(): string[] {
  return [
    LATEX_PIN.binary,
    '-no-shell-escape', // permanently forbidden to be anything else (policy 11.1.1)
    '-interaction=nonstopmode', // never block on `\!`; stdin is closed anyway
    '-halt-on-error',
    '-file-line-error',
    '-recorder', // writes only inside the tmpfs
    `-output-directory=${RENDER_PATHS.out}`,
    '-jobname=artifact',
    // RELATIVE on purpose. `openin_any=p` restricts ABSOLUTE input paths to be under
    // `$TEXMFOUTPUT` (`/out`), so `/work/artifact.tex` is refused by kpathsea. The
    // compile's cwd is `/work` (policy 13.x: always the tmpfs work root), so this
    // resolves to exactly `RENDER_PATHS.latexTemplate` while remaining a relative path.
    RENDER_PATHS.names.latexTemplate,
  ];
}

// ---------------------------------------------------------------------------
// The plan and the builder
// ---------------------------------------------------------------------------

/**
 * A complete, policy-locked compile plan. `argv` is an ARRAY: no caller may join it
 * into a shell string, and there is no `sh -c` anywhere in the compile path
 * (policy section 5.4).
 */
export interface CompilePlan {
  readonly engine: RenderEngine;
  readonly format: RenderFormat;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Always `RENDER_PATHS.work`, which is also the project root. */
  readonly cwd: string;
  /** Always the literal `'none'`, present so a caller cannot forget to set it. */
  readonly network: 'none';
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly limits: Readonly<RenderLimits>;
  /** The exact path the engine is permitted to read as its entry document. */
  readonly inputPath: string;
  /** The exact path the engine is permitted to write. */
  readonly outputPath: string;
  /** The pinned toolchain version that produced this plan. */
  readonly engineVersion: string;
}

export interface CompileOptions {
  /**
   * Pinned PDF creation timestamp as UNIX epoch SECONDS (reproducible-builds
   * `SOURCE_DATE_EPOCH`). REQUIRED: typst's `pdf_options` otherwise falls back to
   * `chrono::Local::now()`, which is embedded in the PDF and makes "two runs are
   * byte-identical" false (policy 7.4, risk R14, V30).
   */
  creationTimestampUnix: number;
  /** Defaults to `'pdf'`. */
  format?: RenderFormat;
  /**
   * The engine pin the caller believes is loaded. A mismatch is
   * `RENDER_TOOLCHAIN_MISMATCH` (policy 9.2), so a template can never silently render
   * against a different engine than its `metadata.json.engineVersionPins` declares.
   */
  expectedEngineVersion?: string;
}

/**
 * Build the complete compile plan for ONE render job.
 *
 * PURE: performs no I/O, reads no environment, calls no clock. The plan is handed to a
 * supervisor that creates the container described in policy section 4; this function
 * never spawns anything.
 *
 * Throws, always with a fixed message and no caller data interpolated:
 *   - unknown engine                                  (V29)
 *   - unknown format
 *   - missing/invalid creation timestamp              (V30)
 *   - engine pin mismatch                             (RENDER_TOOLCHAIN_MISMATCH)
 *   - an internal invariant violation                 (V32; should be unreachable)
 */
export function buildCompileArgs(engine: RenderEngine, opts: CompileOptions): CompilePlan {
  if (!isRenderEngine(engine)) {
    throw new Error(`RENDER_ENGINE_UNKNOWN: engine must be one of ${RENDER_ENGINES.join(', ')}`);
  }
  if (typeof opts !== 'object' || opts === null) {
    throw new Error('RENDER_INPUT_INVALID: compile options are required');
  }

  const format: RenderFormat = opts.format === undefined ? 'pdf' : opts.format;
  if (!isRenderFormat(format)) {
    throw new Error(
      `RENDER_FORMAT_UNKNOWN: format must be one of ${RENDER_FORMATS.join(', ')}`,
    );
  }

  const stamp = opts.creationTimestampUnix;
  if (typeof stamp !== 'number' || !Number.isInteger(stamp) || stamp < 0) {
    throw new Error(
      'RENDER_INPUT_INVALID: creationTimestampUnix is required (non-negative integer UNIX seconds)',
    );
  }

  const enginePolicy = ENGINE_POLICIES[engine];
  const engineVersion = engine === 'typst' ? TYPST_PIN.version : LATEX_PIN.version;
  if (opts.expectedEngineVersion !== undefined && opts.expectedEngineVersion !== engineVersion) {
    throw new Error(
      `RENDER_TOOLCHAIN_MISMATCH: template expects engine ${opts.expectedEngineVersion}, pinned engine is ${engineVersion}`,
    );
  }

  const plan: CompilePlan = {
    engine,
    format,
    argv: engine === 'typst' ? typstArgv(format) : latexArgv(),
    env: engine === 'typst' ? typstEnv(stamp) : latexEnv(stamp),
    cwd: RENDER_PATHS.work, // == the project root, always
    network: 'none',
    timeoutMs: RENDER_LIMITS.wallClockMs,
    killGraceMs: RENDER_LIMITS.killGraceMs,
    limits: RENDER_LIMITS,
    inputPath: engine === 'typst' ? RENDER_PATHS.typstTemplate : RENDER_PATHS.latexTemplate,
    outputPath: RENDER_PATHS.artifact[format],
    engineVersion,
  };

  // Re-check every non-negotiable before returning, so a weakened builder cannot ship
  // a plan that silently violates the policy document.
  assertPolicyInvariants(plan, enginePolicy);
  return plan;
}

// ---------------------------------------------------------------------------
// Invariant re-check
// ---------------------------------------------------------------------------

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * Re-check every non-negotiable on a built plan. Cheap and pure, and called from
 * `buildCompileArgs` itself so an incorrect plan can never be returned. `policy` is an
 * argument so this is independently callable in a test (V26-V31).
 */
export function assertPolicyInvariants(
  plan: CompilePlan,
  policy: EnginePolicy = ENGINE_POLICIES[plan.engine],
): void {
  const { engine, argv, env, cwd, network, limits } = plan;

  if (!policy || typeof policy !== 'object') {
    throw new Error(`RENDER_ENGINE_UNKNOWN: engine must be one of ${RENDER_ENGINES.join(', ')}`);
  }

  // --- 1. Shell escape is disabled. No token or env value may affirmatively enable it.
  for (const token of argv) {
    if (!SHELL_ESCAPE_PATTERN.test(token)) continue;
    if (SHELL_ESCAPE_DENY_TOKENS.includes(token)) continue;
    if (token.toLowerCase().includes('no-shell-escape')) continue;
    throw new Error(
      `RENDER_POLICY_VIOLATION: shell escape must never be enabled (${engine}): ${token}`,
    );
  }
  for (const [key, value] of Object.entries(env)) {
    if (!SHELL_ESCAPE_PATTERN.test(key) && !SHELL_ESCAPE_PATTERN.test(value)) continue;
    if (SHELL_ESCAPE_DENY_VALUES.includes(value.toLowerCase())) continue;
    if (SHELL_ESCAPE_DENY_TOKENS.includes(`${key}=${value}`)) continue;
    throw new Error(
      `RENDER_POLICY_VIOLATION: shell escape must never be enabled (${engine}): ${key}`,
    );
  }
  // The LaTeX path must carry the EXPLICIT deny, not merely the absence of an enable.
  if (engine === 'latex' && !argv.includes('-no-shell-escape')) {
    throw new Error('RENDER_POLICY_VIOLATION: latex must always pass -no-shell-escape');
  }

  // --- 2. The project root is always the ephemeral tmpfs work dir.
  if (cwd !== RENDER_PATHS.work) {
    throw new Error(`RENDER_POLICY_VIOLATION: cwd must be ${RENDER_PATHS.work}`);
  }
  if (engine === 'typst') {
    if (flagValue(argv, '--root') !== RENDER_PATHS.work) {
      throw new Error(`RENDER_POLICY_VIOLATION: --root must be ${RENDER_PATHS.work}`);
    }
    if (env.TYPST_ROOT !== RENDER_PATHS.work) {
      throw new Error(`RENDER_POLICY_VIOLATION: TYPST_ROOT must be ${RENDER_PATHS.work}`);
    }
  }
  if (!plan.inputPath.startsWith(`${RENDER_PATHS.work}/`)) {
    throw new Error('RENDER_POLICY_VIOLATION: the entry document must live inside the work dir');
  }
  if (!plan.outputPath.startsWith(`${RENDER_PATHS.out}/`)) {
    throw new Error(`RENDER_POLICY_VIOLATION: the output must live in ${RENDER_PATHS.out}`);
  }

  // --- 3. Network is always disabled.
  if (network !== 'none') {
    throw new Error('RENDER_POLICY_VIOLATION: network must be none');
  }
  for (const key of policy.forbiddenEnvKeys) {
    if (key in env) {
      throw new Error(`RENDER_POLICY_VIOLATION: env contains forbidden key "${key}"`);
    }
  }
  if ('TYPST_CERT' in env) {
    throw new Error('RENDER_POLICY_VIOLATION: TYPST_CERT is typst\'s network affordance and is forbidden');
  }
  for (const token of argv) {
    if (NETWORK_FORBIDDEN_TOKENS.some((frag) => token.includes(frag))) {
      throw new Error(`RENDER_POLICY_VIOLATION: network-affordance argv token "${token}"`);
    }
  }

  // --- 4. Required and forbidden fragments, per engine.
  for (const fragment of policy.requiredArgvFragments) {
    if (!argv.includes(fragment)) {
      throw new Error(
        `RENDER_POLICY_VIOLATION: ${engine} argv is missing required fragment "${fragment}"`,
      );
    }
  }
  for (const fragment of policy.forbiddenArgvFragments) {
    if (argv.includes(fragment)) {
      throw new Error(
        `RENDER_POLICY_VIOLATION: ${engine} argv contains forbidden fragment "${fragment}"`,
      );
    }
  }
  for (const key of policy.requiredEnvKeys) {
    if (!(key in env)) {
      throw new Error(`RENDER_POLICY_VIOLATION: ${engine} env is missing required key "${key}"`);
    }
  }
  // Presence is not enough for the policy-valued keys: `openin_any=a` is present and
  // catastrophic, so the VALUE is asserted, not just the key.
  for (const [key, expected] of Object.entries(policy.requiredEnvValues)) {
    if (env[key] !== expected) {
      throw new Error(
        `RENDER_POLICY_VIOLATION: ${engine} env "${key}" must be "${expected}", got "${env[key] ?? '<unset>'}"`,
      );
    }
  }

  // --- 5. The output path is a policy constant, never derived from caller content.
  if (plan.outputPath !== RENDER_PATHS.artifact[plan.format]) {
    throw new Error('RENDER_POLICY_VIOLATION: the output path must be the policy artifact path');
  }

  // --- 6. Caps travel with the plan so a caller cannot pass a looser one, and the
  //        kernel-side mount bound is always stricter than the policy-side bound.
  if (limits !== RENDER_LIMITS) {
    throw new Error('RENDER_POLICY_VIOLATION: a plan may not carry custom limits');
  }
  if (limits.swapBytes !== limits.memoryBytes) {
    throw new Error('RENDER_POLICY_VIOLATION: swap must equal memory (no swap escape)');
  }
  if (limits.outTmpfsBytes >= limits.outputBytes) {
    throw new Error(
      'RENDER_POLICY_VIOLATION: the tmpfs bound must be stricter than the policy bound',
    );
  }
  if (plan.timeoutMs !== limits.wallClockMs || plan.killGraceMs !== limits.killGraceMs) {
    throw new Error('RENDER_POLICY_VIOLATION: timeouts must match the policy limits');
  }

  // --- 7. Determinism: the creation timestamp must be present in env.
  if (!env.SOURCE_DATE_EPOCH) {
    throw new Error('RENDER_POLICY_VIOLATION: SOURCE_DATE_EPOCH must be pinned');
  }
  if (policy.engine === 'typst' && flagValue(argv, '--jobs') !== '1') {
    throw new Error('RENDER_POLICY_VIOLATION: typst must run with --jobs 1 for determinism');
  }

  // --- 8. Container identity cannot be relaxed from here.
  if (RENDER_CONTAINER.networkMode !== 'none') {
    throw new Error('RENDER_POLICY_VIOLATION: container network mode must be none');
  }
  if (!RENDER_CONTAINER.readOnlyRootFilesystem) {
    throw new Error('RENDER_POLICY_VIOLATION: container root filesystem must be read-only');
  }
  if (!RENDER_CONTAINER.capDrop.includes('ALL')) {
    throw new Error('RENDER_POLICY_VIOLATION: container must drop ALL capabilities');
  }
  if (!RENDER_CONTAINER.securityOpt.includes('no-new-privileges:true')) {
    throw new Error('RENDER_POLICY_VIOLATION: container must set no-new-privileges');
  }
  if (RENDER_CONTAINER.readOnlyBinds.length !== 3) {
    throw new Error('RENDER_POLICY_VIOLATION: the read-only bind allowlist is exactly three mounts');
  }
  for (const bind of RENDER_CONTAINER.readOnlyBinds) {
    if (RENDER_CONTAINER.forbiddenBindTargets.includes(bind.target)) {
      throw new Error(
        `RENDER_POLICY_VIOLATION: forbidden bind target "${bind.target}"`,
      );
    }
  }
  // LaTeX engines other than pdfLaTeX are forbidden outright.
  if (policy.engine === 'latex' && LATEX_PIN.forbiddenBinaries.includes(argv[0])) {
    throw new Error(`RENDER_POLICY_VIOLATION: forbidden latex binary "${argv[0]}"`);
  }
}

// ---------------------------------------------------------------------------
// Compose skeleton facts (policy section 4.7) - consumed by T1005's report and by the
// V32 drift test, so the document and this module cannot diverge silently.
// ---------------------------------------------------------------------------

/** The compose keys a worker MUST set. */
export const REQUIRED_COMPOSE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  network_mode: 'none',
  read_only: 'true',
  user: RENDER_CONTAINER.user,
  cap_drop: 'ALL',
  security_opt: 'no-new-privileges:true',
  privileged: 'false',
  pids_limit: String(RENDER_LIMITS.pids),
  mem_limit: String(RENDER_LIMITS.memoryBytes),
  memswap_limit: String(RENDER_LIMITS.swapBytes),
  cpus: String(RENDER_LIMITS.cpuCores),
  oom_kill_disable: 'false',
  // Policy sections 4.6 and 9.1/9.3: the compose-level backstop for the kill
  // budget. The primary control is the 10s wall + 2s SIGKILL in RENDER_LIMITS
  // (carried on every plan); this is what stops compose from escalating SIGKILL
  // to SIGKILL-with-another-SIGKILL on a wedged container.
  stop_grace_period: '5s',
  restart: '"no"',
  stdin_open: 'false',
  tty: 'false',
  ipc: '"none"',
});

/** The tmpfs table a worker MUST declare. */
export const REQUIRED_TMPFS: readonly string[] = Object.freeze([
  '/work:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=65532,gid=65532',
  '/out:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532',
  '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
]);

export default RENDER_POLICY;
