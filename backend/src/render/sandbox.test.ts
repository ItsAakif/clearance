// Render sandbox policy - unit tests.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md
// Task:         T1006 (the module encodes the policy T1005 must satisfy)
//
// These tests cover policy assertions V25-V32 (section 12.6 of the policy doc) plus the
// four acceptance items in the task contract:
//   - shell escape is always disabled
//   - the root is always the temp dir
//   - network is always disabled
//   - an unknown engine throws
//
// Container-level assertions (V1-V23) are proven by `docker compose run` in T1005, not
// here, and this file deliberately asserts nothing about them.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LATEX_PIN,
  REQUIRED_COMPOSE_KEYS,
  REQUIRED_TMPFS,
  RENDER_CONTAINER,
  RENDER_ENGINES,
  RENDER_FORMATS,
  RENDER_LIMITS,
  RENDER_OUTCOME_CODES,
  RENDER_PATHS,
  RENDER_POLICY,
  RENDER_QUOTA,
  TYPST_PIN,
  assertPolicyInvariants,
  assertSafeStageName,
  buildCompileArgs,
  type CompilePlan,
  type EnginePolicy,
  type RenderEngine,
} from './sandbox.js';

const STAMP = 1_757_000_000; // a pinned UNIX second, never Date.now()

// __dirname is available both compiled to CJS and under vitest (repo convention: see
// src/ats/promptLoader.ts:8 and src/config/flags.test.ts:21).
const HERE = __dirname;
const REPO_ROOT = path.resolve(HERE, '../../..');
/**
 * The normative document, READ FROM DISK. The T1013 review found that the test named
 * "V32 doc/code drift guard" only asserted hardcoded literals and never opened the
 * `.md`, so editing the document could not fail anything (the same pattern
 * `src/config/flags.test.ts:130` uses for `.env.example`).
 */
const POLICY_MD = readFileSync(path.join(REPO_ROOT, RENDER_POLICY.spec), 'utf8');

function plan(engine: RenderEngine, extra: Partial<Parameters<typeof buildCompileArgs>[1]> = {}): CompilePlan {
  return buildCompileArgs(engine, { creationTimestampUnix: STAMP, ...extra });
}

/** Every engine x every format x a few timestamp shapes: the full cross product a
 *  caller can legally reach. */
const ALL_PLANS: CompilePlan[] = RENDER_ENGINES.flatMap((engine) =>
  RENDER_FORMATS.map((format) => plan(engine, { format })),
);

// ---------------------------------------------------------------------------

describe('render/sandbox - task contract acceptance', () => {
  it('shell escape is ALWAYS disabled, for every engine and format (V26)', () => {
    const affirmative = /shell[-_\\]?escape/i;
    const denyValues = ['f', 'false', '0', 'no', 'off', ''];

    for (const p of ALL_PLANS) {
      for (const token of p.argv) {
        if (!affirmative.test(token)) continue;
        // Only an explicit deny may mention shell escape at all.
        expect(token === '-no-shell-escape' || token.toLowerCase().includes('no-shell-escape')).toBe(true);
      }
      for (const [key, value] of Object.entries(p.env)) {
        if (!affirmative.test(key) && !affirmative.test(value)) continue;
        expect(denyValues).toContain(value.toLowerCase());
      }
    }

    // And specifically: the LaTeX engine always carries the explicit deny flag.
    for (const format of RENDER_FORMATS) {
      expect(plan('latex', { format }).argv).toContain('-no-shell-escape');
      expect(plan('latex', { format }).env.shell_escape).toBe('f');
      expect(plan('latex', { format }).env.SHELL_ESCAPE).toBe('f');
    }

    // Typst has no shell escape affordance at all, so nothing may mention it.
    for (const format of RENDER_FORMATS) {
      const argv = plan('typst', { format }).argv.join(' ');
      const env = JSON.stringify(plan('typst', { format }).env);
      expect(argv.toLowerCase()).not.toContain('shell');
      expect(env.toLowerCase()).not.toContain('shell');
    }
  });

  it('the root is ALWAYS the temp dir and is not caller-overridable (V27)', () => {
    for (const p of ALL_PLANS) {
      expect(p.cwd).toBe(RENDER_PATHS.work);
      expect(RENDER_PATHS.work).toBe('/work');
      expect(p.inputPath.startsWith(`${RENDER_PATHS.work}/`)).toBe(true);
      expect(p.outputPath.startsWith(`${RENDER_PATHS.out}/`)).toBe(true);
      if (p.engine === 'typst') {
        const i = p.argv.indexOf('--root');
        expect(i).toBeGreaterThan(-1);
        expect(p.argv[i + 1]).toBe('/work');
        expect(p.env.TYPST_ROOT).toBe('/work');
      }
    }

    // There is no option through which a caller can supply a different root: the
    // builder signature accepts only creationTimestampUnix/format/expectedEngineVersion,
    // and stray keys are ignored rather than honoured.
    const withStrayRoot = buildCompileArgs('typst', {
      creationTimestampUnix: STAMP,
      root: '/',
      workDir: '/host',
      outputDir: '/etc',
    } as unknown as Parameters<typeof buildCompileArgs>[1]);
    expect(withStrayRoot.cwd).toBe('/work');
    expect(withStrayRoot.argv).toContain('/work');
    expect(withStrayRoot.argv.join(' ')).not.toContain('/host');
    expect(withStrayRoot.argv.join(' ')).not.toContain('/etc');
  });

  it('network is ALWAYS disabled (V28)', () => {
    for (const p of ALL_PLANS) {
      expect(p.network).toBe('none');
      // No network-enabling CLI affordance, ever.
      expect(p.argv).not.toContain('--cert');
      expect(p.argv.some((t) => t.includes('http://') || t.includes('https://'))).toBe(false);
      expect('TYPST_CERT' in p.env).toBe(false);
      expect('TYPST_FEATURES' in p.env).toBe(false);
    }
    expect(RENDER_POLICY.network).toBe('none');
    expect(RENDER_CONTAINER.networkMode).toBe('none');
    expect(REQUIRED_COMPOSE_KEYS.network_mode).toBe('none');
  });

  it('an unknown engine throws (V29)', () => {
    for (const bad of ['pdflatex', 'tectonic', 'lualatex', 'xelatex', 'chromium', '', 'TYPST', 'pdftex']) {
      expect(() =>
        buildCompileArgs(bad as RenderEngine, { creationTimestampUnix: STAMP }),
      ).toThrow(/RENDER_ENGINE_UNKNOWN/);
    }
    expect(() => buildCompileArgs(undefined as unknown as RenderEngine, { creationTimestampUnix: STAMP })).toThrow();
    expect(() => buildCompileArgs(42 as unknown as RenderEngine, { creationTimestampUnix: STAMP })).toThrow();
    expect(() => buildCompileArgs(null as unknown as RenderEngine, { creationTimestampUnix: STAMP })).toThrow();
    expect(() => RENDER_POLICY.enginePolicy('pdflatex' as RenderEngine)).toThrow(/RENDER_ENGINE_UNKNOWN/);
    // The set is closed at exactly two.
    expect([...RENDER_ENGINES]).toEqual(['typst', 'latex']);
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - determinism (V3, V30)', () => {
  it('a missing creation timestamp throws rather than defaulting (V30)', () => {
    for (const engine of RENDER_ENGINES) {
      expect(() => buildCompileArgs(engine, {} as never)).toThrow(/creationTimestampUnix is required/);
      expect(() =>
        buildCompileArgs(engine, { creationTimestampUnix: undefined as never }),
      ).toThrow(/creationTimestampUnix is required/);
      expect(() =>
        buildCompileArgs(engine, { creationTimestampUnix: Date.now() / 1000 }),
      ).toThrow(/creationTimestampUnix is required/); // non-integer
      expect(() =>
        buildCompileArgs(engine, { creationTimestampUnix: -1 }),
      ).toThrow(/creationTimestampUnix is required/);
      expect(() =>
        buildCompileArgs(engine, { creationTimestampUnix: '0' as never }),
      ).toThrow(/creationTimestampUnix is required/);
    }
  });

  it('pins SOURCE_DATE_EPOCH, TZ and locale in every plan (V3, risk R14)', () => {
    for (const p of ALL_PLANS) {
      expect(p.env.SOURCE_DATE_EPOCH).toBe(String(STAMP));
      expect(p.env.TZ).toBe('UTC');
      expect(p.env.LC_ALL).toBe('C.UTF-8');
      expect(p.env.LANG).toBe('C.UTF-8');
      expect(p.env.HOME).toBe('/nonexistent');
    }
  });

  it('UNSETS XDG_CACHE_HOME in every plan (policy 3.4, M4)', () => {
    for (const p of ALL_PLANS) {
      // The mandate is "unsets", so the faithful encoding is ABSENCE of the
      // key, not an empty value. `in` (not a truthiness check) is deliberate:
      // `XDG_CACHE_HOME: ''` is a SET value and would change the semantics.
      expect('XDG_CACHE_HOME' in p.env).toBe(false);
      expect(p.env).not.toHaveProperty('XDG_CACHE_HOME');
      // Every engine's forbidden-key list names it, so the invariant can reject
      // a plan that reintroduces it.
      for (const engine of RENDER_ENGINES) {
        expect(RENDER_POLICY.enginePolicy(engine).forbiddenEnvKeys).toContain(
          'XDG_CACHE_HOME',
        );
      }
    }
  });

  it('pins typst --jobs 1 and a closed font set (V3, risk R14)', () => {
    for (const format of RENDER_FORMATS) {
      const argv = plan('typst', { format }).argv;
      const i = argv.indexOf('--jobs');
      expect(argv[i + 1]).toBe('1');
      expect(argv).toContain('--ignore-system-fonts');
      expect(argv).toContain('--font-path');
      expect(argv[argv.indexOf('--font-path') + 1]).toBe('/opt/typst-fonts');
      const env = plan('typst', { format }).env;
      // 'true', not '1': typst 0.15.1 reads these as clap booleans and REJECTS '1'
      // (T1005 D1/OI-7, measured):
      //   error: invalid value '1' for '--ignore-system-fonts'
      //     [possible values: true, false]
      // A plan carrying '1' would hand the worker an argv it cannot parse, so the
      // worker would never render at all. Asserted here, in the invariant, and by
      // the V32 drift test against the compose skeleton.
      expect(env.TYPST_IGNORE_SYSTEM_FONTS).toBe('true');
      expect(env.TYPST_IGNORE_EMBEDDED_FONTS).toBe('true');
      for (const key of ['TYPST_IGNORE_SYSTEM_FONTS', 'TYPST_IGNORE_EMBEDDED_FONTS']) {
        expect(env[key], `${key} must be a value typst's clap accepts`).not.toBe('1');
        expect(['true', 'false']).toContain(env[key]);
      }
      expect(env.TYPST_FONT_PATHS).toBe('/opt/typst-fonts');
    }
  });

  it('two builds with the same inputs produce identical plans (byte-stability proxy)', () => {
    for (const engine of RENDER_ENGINES) {
      const a = plan(engine);
      const b = plan(engine);
      expect(a.argv).toEqual(b.argv);
      expect(a.env).toEqual(b.env);
      expect(a.outputPath).toBe(b.outputPath);
      // A DIFFERENT timestamp is the only thing that changes, and it changes only env.
      const c = plan(engine, { creationTimestampUnix: STAMP + 1 });
      expect(c.argv).toEqual(a.argv);
      expect(c.env.SOURCE_DATE_EPOCH).toBe(String(STAMP + 1));
    }
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - banned CLI affordances (V13)', () => {
  it('never emits --open, --pages, --cert, --no-pdf-tags or a non-compile subcommand', () => {
    const banned = ['--open', '--pages', '--no-pdf-tags', '--cert', 'watch', 'update', 'init', 'eval'];
    for (const p of ALL_PLANS) {
      for (const token of banned) {
        expect(p.argv).not.toContain(token);
      }
      // typst must be `typst compile`, and the output must be the policy artifact path.
      if (p.engine === 'typst') {
        expect(p.argv.slice(0, 2)).toEqual(['typst', 'compile']);
      }
    }
  });

  it('uses --diagnostic-format short so logs stay compact (risk R13)', () => {
    for (const format of RENDER_FORMATS) {
      const argv = plan('typst', { format }).argv;
      expect(argv[argv.indexOf('--diagnostic-format') + 1]).toBe('short');
    }
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - supply chain (V9, V10, V12)', () => {
  it('pins the typst binary to an exact version and sha256 (V9)', () => {
    expect(TYPST_PIN.version).toMatch(/^\d+\.\d+\.\d+$/); // exact, never a range
    expect(TYPST_PIN.version).not.toContain('x');
    expect(TYPST_PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(TYPST_PIN.asset).toContain('musl'); // musl for a scratch image
    expect(TYPST_PIN.license).toBe('Apache-2.0');
  });

  it('resolves packages only from the vendored read-only tree (V12)', () => {
    for (const format of RENDER_FORMATS) {
      const argv = plan('typst', { format }).argv;
      expect(argv[argv.indexOf('--package-path') + 1]).toBe('/opt/typst-packages');
      // The cache is on the tmpfs, so an unvendored import fails as a NETWORK error.
      expect(argv[argv.indexOf('--package-cache-path') + 1]).toBe('/work/.pkgcache');
      expect(plan('typst', { format }).env.TYPST_PACKAGE_PATH).toBe('/opt/typst-packages');
      expect(plan('typst', { format }).env.TYPST_PACKAGE_CACHE_PATH).toBe('/work/.pkgcache');
    }
  });

  it('records an exact engineVersion on every plan (V9)', () => {
    expect(plan('typst').engineVersion).toBe(TYPST_PIN.version);
    expect(plan('latex').engineVersion).toBe(LATEX_PIN.version);
  });

  it('rejects an engine pin mismatch with RENDER_TOOLCHAIN_MISMATCH', () => {
    expect(() => plan('typst', { expectedEngineVersion: '0.14.2' })).toThrow(/RENDER_TOOLCHAIN_MISMATCH/);
    expect(() => plan('typst', { expectedEngineVersion: '0.15.1' })).not.toThrow();
    expect(() => plan('typst', { expectedEngineVersion: 'latest' })).toThrow(/RENDER_TOOLCHAIN_MISMATCH/);
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - LaTeX path (V14, V15, policy section 11)', () => {
  it('uses only pdfLaTeX (lua/xe/tectonic are forbidden)', () => {
    expect(LATEX_PIN.binary).toBe('pdflatex');
    expect(LATEX_PIN.forbiddenBinaries).toContain('lualatex');
    expect(plan('latex').argv[0]).toBe('pdflatex');
  });

  it('sets openin_any and openout_any to the PARANOID level p (V15)', () => {
    const env = plan('latex').env;
    expect(LATEX_PIN.openinAny).toBe('p');
    expect(env.openin_any).toBe('p');
    expect(env.OPENIN_ANY).toBe('p');
    expect(env.openout_any).toBe('p');
    expect(env.OPENOUT_ANY).toBe('p');
    // The weaker/weirder levels must never appear.
    for (const forbidden of ['a', 's', 'n', 'r']) {
      expect(env.openin_any).not.toBe(forbidden);
      expect(env.OPENIN_ANY).not.toBe(forbidden);
    }
  });

  it('pins every mutable TEXMF location onto the tmpfs (V16, risk R3)', () => {
    const env = plan('latex').env;
    for (const key of ['TEXMFHOME', 'TEXMFCNF', 'TEXMFVAR', 'TEXMFOUTPUT']) {
      expect(env[key]).toBeDefined();
      expect(env[key].startsWith('/work/') || env[key].startsWith('/out')).toBe(true);
    }
    expect(env.TEXMFOUTPUT).toBe('/out');
    expect(env.FORCE_SOURCE_DATE).toBe('1');
  });

  it('passes the deterministic LaTeX flags', () => {
    const argv = plan('latex').argv;
    expect(argv).toContain('-interaction=nonstopmode');
    expect(argv).toContain('-halt-on-error');
    expect(argv).toContain('-file-line-error');
    expect(argv).toContain('-output-directory=/out');
    expect(argv).toContain('-jobname=artifact');
    expect(argv[argv.length - 1]).toBe('artifact.tex');
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - output contract (V22, policy section 6)', () => {
  it('writes exactly one artifact to the policy path for each format', () => {
    expect(plan('typst').outputPath).toBe('/out/artifact.pdf');
    expect(plan('typst', { format: 'png' }).outputPath).toBe('/out/artifact.png');
    expect(plan('typst', { format: 'svg' }).outputPath).toBe('/out/artifact.svg');
    // The basename never carries caller data.
    for (const p of ALL_PLANS) {
      expect(p.outputPath).toBe(RENDER_PATHS.artifact[p.format]);
      expect(p.outputPath.split('/').pop()).toMatch(/^artifact\.(pdf|png|svg)$/);
    }
  });

  it('rejects an unknown format', () => {
    for (const bad of ['docx', 'tex', 'typ', 'json', 'html', 'epub']) {
      expect(() =>
        plan('typst', { format: bad as never }),
      ).toThrow(/RENDER_FORMAT_UNKNOWN/);
    }
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - stage-name validation (V25, policy section 5.2)', () => {
  it('accepts ordinary template and data names', () => {
    for (const good of ['template.typ', 'data.json', 'artifact.tex', 'a', 'A_b-c.1', 'x'.repeat(64)]) {
      expect(assertSafeStageName(good)).toBe(good);
    }
  });

  it('rejects traversal, separators, absolute paths, arg-injection and control bytes', () => {
    const bad: unknown[] = [
      '',
      '..',
      '.',
      '../x',
      '../../etc/passwd',
      'a/b',
      'a\\b',
      '/abs',
      '/etc/passwd',
      '-x',
      '--root',
      '-',
      '.hidden',
      '.env',
      'a b',
      'a;rm -rf /',
      'a$(id)',
      'a`id`',
      "a'b",
      'a"b',
      'a\nb',
      'a\rb',
      'a\tb',
      'a\u0000b',
      'x'.repeat(65),
      'C:\\Windows\\x',
      'a:b',
      '*',
      'a?b',
      'a|b',
      // Windows reserved device names: they satisfy the character allowlist and have
      // no leading `-` or `.`, so nothing else in this function refused them. On
      // Windows `NUL`, `nul.txt` and `NUL.` all resolve to the null device, and a staged
      // asset with such a name failed LATER as `NOT_REGULAR` (a character device on the
      // destination) - a confusing reason for a legal-looking declared name. The
      // rejection is POSIX-harmless: there they are ordinary files.
      'NUL',
      'nul',
      'CON',
      'aux',
      'PRN',
      'COM1',
      'com9',
      'LPT1',
      'lpt9',
      'CLOCK$',
      'NUL.png',
      'COM1.json',
      'NUL.',
      null,
      undefined,
      42,
      {},
      [],
      { toString: () => 'template.typ' },
    ];
    for (const name of bad) {
      expect(() => assertSafeStageName(name), `expected rejection of ${String(name)}`).toThrow(
        /RENDER_INPUT_INVALID/,
      );
    }
    // The positive control: names that merely START with a device-ish prefix are legal,
    // so the rule is not a blanket ban on the letters.
    for (const good of ['NULL', 'CONS', 'com10', 'lpt', 'NULA', 'COM0', 'aNUL', 'NUL2', 'nu.png']) {
      expect(assertSafeStageName(good), good).toBe(good);
    }
  });

  it('never interpolates the rejected value into the error message', () => {
    const canary = 'CLEARANCE_CANARY_leak';
    try {
      assertSafeStageName(`${canary}/../x`);
      throw new Error('expected a throw');
    } catch (err) {
      expect(String(err)).not.toContain(canary);
      expect(String(err)).toContain('RENDER_INPUT_INVALID');
    }
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - limits and quota travel with the plan (V31)', () => {
  it('exposes the exact policy caps on every plan', () => {
    for (const p of ALL_PLANS) {
      expect(p.limits).toBe(RENDER_LIMITS);
      expect(p.limits.wallClockMs).toBe(10_000);
      expect(p.limits.killGraceMs).toBe(2_000);
      expect(p.limits.memoryBytes).toBe(1_073_741_824);
      expect(p.limits.swapBytes).toBe(1_073_741_824);
      expect(p.limits.cpuCores).toBe(1);
      expect(p.limits.pids).toBe(64);
      expect(p.limits.inputFileBytes).toBe(1_048_576);
      expect(p.limits.dataFileBytes).toBe(4_194_304);
      expect(p.limits.inputTotalBytes).toBe(8_388_608);
      expect(p.limits.outputBytes).toBe(20_971_520);
      expect(p.timeoutMs).toBe(10_000);
      expect(p.killGraceMs).toBe(2_000);
    }
  });

  it('keeps the kernel-side tmpfs bound stricter than the policy-side output bound', () => {
    // Two independent bounds: /out is 16 MiB, the supervisor also asserts <= 20 MiB.
    expect(RENDER_LIMITS.outTmpfsBytes).toBe(16_777_216);
    expect(RENDER_LIMITS.outTmpfsBytes).toBeLessThan(RENDER_LIMITS.outputBytes);
  });

  it('documents the bounded-worker quota with no queue infrastructure', () => {
    expect(RENDER_QUOTA).toEqual({
      concurrentPerHost: 2,
      concurrentPerUser: 1,
      queueDepth: 8,
      rendersPerMinutePerUser: 10,
    });
  });

  it('freezes the policy object so a caller cannot loosen a cap at runtime', () => {
    expect(Object.isFrozen(RENDER_POLICY)).toBe(true);
    expect(Object.isFrozen(RENDER_LIMITS)).toBe(true);
    expect(Object.isFrozen(RENDER_PATHS)).toBe(true);
    expect(Object.isFrozen(RENDER_CONTAINER)).toBe(true);
    expect(Object.isFrozen(TYPST_PIN)).toBe(true);
    expect(RENDER_POLICY.shellEscape).toBe('forbidden');
    expect(RENDER_POLICY.isolation).toBe('one-container-per-compile');
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - container identity (policy section 4)', () => {
  it('mandates the exact compose keys', () => {
    expect(REQUIRED_COMPOSE_KEYS).toEqual({
      network_mode: 'none',
      read_only: 'true',
      user: '65532:65532',
      cap_drop: 'ALL',
      security_opt: 'no-new-privileges:true',
      privileged: 'false',
      pids_limit: '64',
      mem_limit: '1073741824',
      memswap_limit: '1073741824',
      cpus: '1',
      oom_kill_disable: 'false',
      // Policy 4.6 / 9.1-9.3: the compose-level kill-budget backstop.
      stop_grace_period: '5s',
      restart: '"no"',
      stdin_open: 'false',
      tty: 'false',
      ipc: '"none"',
    });
  });

  it('mandates exactly three tmpfs mounts and exactly three read-only binds', () => {
    expect(REQUIRED_TMPFS).toHaveLength(3);
    expect(REQUIRED_TMPFS[0]).toContain('/work:');
    expect(REQUIRED_TMPFS[1]).toContain('/out:');
    expect(REQUIRED_TMPFS[2]).toContain('/tmp:');
    for (const spec of REQUIRED_TMPFS) {
      expect(spec).toMatch(/rw,/);
      expect(spec).toContain('nosuid');
      expect(spec).toContain('nodev');
      expect(spec).toContain('noexec');
      expect(spec).toMatch(/size=\d+m/);
    }
    // /work and /out are SEPARATE mounts so "produced" vs "allowed to see" is separable.
    expect(REQUIRED_TMPFS.filter((s) => s.startsWith('/out:'))).toHaveLength(1);

    expect(RENDER_CONTAINER.readOnlyBinds).toHaveLength(3);
    expect(RENDER_CONTAINER.readOnlyBinds.map((b) => b.target)).toEqual([
      '/opt/typst',
      '/opt/typst-packages',
      '/opt/typst-fonts',
    ]);
    for (const bind of RENDER_CONTAINER.readOnlyBinds) {
      expect(bind.host.startsWith('./backend/typst/')).toBe(true);
      expect(RENDER_CONTAINER.forbiddenBindTargets).not.toContain(bind.target);
    }
    // No docker socket, no host paths.
    expect(RENDER_CONTAINER.forbiddenBindTargets).toContain('/var/run/docker.sock');
    expect(RENDER_CONTAINER.forbiddenBindTargets).toContain('/etc');
    expect(RENDER_CONTAINER.forbiddenBindTargets).toContain('/proc');
  });

  it('drops ALL capabilities and forbids privilege gain', () => {
    expect(RENDER_CONTAINER.capDrop).toEqual(['ALL']);
    expect(RENDER_CONTAINER.securityOpt).toEqual(['no-new-privileges:true']);
    expect(RENDER_CONTAINER.readOnlyRootFilesystem).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - invariant self-check (V32)', () => {
  const typstPolicy: EnginePolicy = RENDER_POLICY.enginePolicy('typst');
  const latexPolicy: EnginePolicy = RENDER_POLICY.enginePolicy('latex');

  function tamper(base: CompilePlan, patch: Partial<CompilePlan>): CompilePlan {
    return { ...base, ...patch };
  }

  it('accepts an untampered plan', () => {
    expect(() => assertPolicyInvariants(plan('typst'), typstPolicy)).not.toThrow();
    expect(() => assertPolicyInvariants(plan('latex'), latexPolicy)).not.toThrow();
  });

  it('rejects a widened root', () => {
    expect(() =>
      assertPolicyInvariants(tamper(plan('typst'), { cwd: '/' }), typstPolicy),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('typst'), { argv: plan('typst').argv.map((a) => (a === '/work' ? '/' : a)) }),
        typstPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
  });

  it('rejects an enabled shell escape', () => {
    for (const enable of ['-shell-escape', '--shell-escape', '-enable-sh']) {
      const argv = [...plan('latex').argv, enable];
      expect(() => assertPolicyInvariants(tamper(plan('latex'), { argv }), latexPolicy)).toThrow(
        /RENDER_POLICY_VIOLATION/,
      );
    }
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('latex'), { env: { ...plan('latex').env, shell_escape: 'true' } }),
        latexPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
    // Dropping the explicit deny is also a violation.
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('latex'), {
          argv: plan('latex').argv.filter((a) => a !== '-no-shell-escape'),
        }),
        latexPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
  });

  it('rejects re-enabled network', () => {
    expect(() => assertPolicyInvariants(tamper(plan('typst'), { network: 'bridge' as never }), typstPolicy)).toThrow(
      /RENDER_POLICY_VIOLATION/,
    );
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('typst'), { argv: [...plan('typst').argv, '--cert', '/ca.pem'] }),
        typstPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('typst'), { env: { ...plan('typst').env, TYPST_CERT: '/ca.pem' } }),
        typstPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
  });

  it('rejects a weakened openin_any level in EITHER spelling', () => {
    for (const key of ['openin_any', 'OPENIN_ANY', 'openout_any', 'OPENOUT_ANY']) {
      for (const level of ['a', 'r', 's', 'n']) {
        expect(() =>
          assertPolicyInvariants(
            tamper(plan('latex'), { env: { ...plan('latex').env, [key]: level } }),
            latexPolicy,
          ),
          `expected rejection of ${key}=${level}`,
        ).toThrow(/RENDER_POLICY_VIOLATION/);
      }
    }
  });

  it('rejects a weakened typst policy env value, not just a missing key', () => {
    const cases: Array<[string, string]> = [
      ['TYPST_ROOT', '/'],
      ['TYPST_PACKAGE_PATH', '/tmp/pkg'],
      ['TYPST_PACKAGE_CACHE_PATH', '/var/cache/typst'],
      ['TYPST_FONT_PATHS', '/usr/share/fonts'],
      ['TYPST_IGNORE_SYSTEM_FONTS', '0'],
      ['TYPST_IGNORE_EMBEDDED_FONTS', '0'],
      // '1' is not merely weaker, it is INVALID: typst 0.15.1's clap rejects it and the
      // worker would fail to parse its own argv (T1013 correction of T1005 OI-7).
      ['TYPST_IGNORE_SYSTEM_FONTS', '1'],
      ['TYPST_IGNORE_EMBEDDED_FONTS', '1'],
      ['TZ', 'America/New_York'],
      ['HOME', '/root'],
    ];
    for (const [key, badValue] of cases) {
      expect(() =>
        assertPolicyInvariants(
          tamper(plan('typst'), { env: { ...plan('typst').env, [key]: badValue } }),
          typstPolicy,
        ),
        `expected rejection of ${key}=${badValue}`,
      ).toThrow(/RENDER_POLICY_VIOLATION/);
    }
  });

  it('rejects a widened texmf output dir and a re-enabled shell_escape in env', () => {
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('latex'), { env: { ...plan('latex').env, TEXMFOUTPUT: '/out/../etc' } }),
        latexPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('latex'), { env: { ...plan('latex').env, SHELL_ESCAPE: '1' } }),
        latexPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('latex'), { env: { ...plan('latex').env, TEXMFHOME: '/usr/share/texmf' } }),
        latexPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
  });

  it('rejects an output path outside /out and one that is not the artifact constant', () => {
    expect(() =>
      assertPolicyInvariants(tamper(plan('typst'), { outputPath: '/tmp/artifact.pdf' }), typstPolicy),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('typst'), { outputPath: '/out/../../etc/evil.pdf' }),
        typstPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('typst'), { outputPath: '/out/CLEARANCE_CANARY.pdf' }),
        typstPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
  });

  it('rejects custom limits and a swap escape', () => {
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('typst'), { limits: { ...RENDER_LIMITS, memoryBytes: 1 << 40 } }),
        typstPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
    expect(() =>
      assertPolicyInvariants(
        tamper(plan('typst'), { limits: { ...RENDER_LIMITS, swapBytes: 1 << 40 } }),
        typstPolicy,
      ),
    ).toThrow(/RENDER_POLICY_VIOLATION/);
  });

  it('rejects a missing SOURCE_DATE_EPOCH and a non-deterministic --jobs', () => {
    const env = { ...plan('typst').env };
    delete (env as Record<string, string>).SOURCE_DATE_EPOCH;
    expect(() => assertPolicyInvariants(tamper(plan('typst'), { env }), typstPolicy)).toThrow(
      /RENDER_POLICY_VIOLATION/,
    );
    const argv = [...plan('typst').argv];
    argv[argv.indexOf('1')] = '4'; // weaken --jobs
    expect(() => assertPolicyInvariants(tamper(plan('typst'), { argv }), typstPolicy)).toThrow(
      /RENDER_POLICY_VIOLATION/,
    );
  });

  it('rejects a missing required env key and a forbidden one', () => {
    const env = { ...plan('typst').env };
    delete (env as Record<string, string>).TYPST_PACKAGE_PATH;
    expect(() => assertPolicyInvariants(tamper(plan('typst'), { env }), typstPolicy)).toThrow(
      /RENDER_POLICY_VIOLATION/,
    );
    const env2 = { ...plan('typst').env, TYPST_FEATURES: 'html' };
    expect(() => assertPolicyInvariants(tamper(plan('typst'), { env: env2 }), typstPolicy)).toThrow(
      /RENDER_POLICY_VIOLATION/,
    );
  });

  it('rejects a plan that reintroduces XDG_CACHE_HOME, for BOTH engines (policy 3.4)', () => {
    // A supervisor that merged the built env over the ambient environment is the
    // realistic leak path, so the invariant has to bite on the merged shape too.
    for (const [engine, policy] of [
      ['typst', typstPolicy],
      ['latex', latexPolicy],
    ] as const) {
      for (const value of ['', '/home/runner/.cache', '/root/.cache']) {
        const env = { ...plan(engine).env, XDG_CACHE_HOME: value };
        expect(
          () => assertPolicyInvariants(tamper(plan(engine), { env }), policy),
          `${engine} must reject XDG_CACHE_HOME=${JSON.stringify(value)}`,
        ).toThrow(/XDG_CACHE_HOME/);
      }
      // The unmodified plan still passes: the mandate is absence, and absence
      // is what the module produces.
      expect(() => assertPolicyInvariants(plan(engine), policy)).not.toThrow();
    }
  });

  it('rejects a forbidden latex binary', () => {
    const argv = ['lualatex', ...plan('latex').argv.slice(1)];
    expect(() => assertPolicyInvariants(tamper(plan('latex'), { argv }), latexPolicy)).toThrow(
      /RENDER_POLICY_VIOLATION/,
    );
  });

  it('rejects a null/undefined engine policy instead of silently defaulting', () => {
    // `undefined` as a second argument legitimately triggers the default parameter, so
    // `null` is the value that must be rejected rather than silently resolved.
    expect(() => assertPolicyInvariants(plan('typst'), null as unknown as EnginePolicy)).toThrow(
      /RENDER_ENGINE_UNKNOWN/,
    );
    // Omitting it resolves the default and must succeed.
    expect(() => assertPolicyInvariants(plan('typst'))).not.toThrow();
    expect(() => assertPolicyInvariants(plan('latex'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('render/sandbox - doc/code drift guard (V32)', () => {
  /**
   * These literals are copied from the policy document. The NEXT test is what makes that
   * statement true: it reads the document from disk and compares the two. This one pins
   * the module side, so a failure in either test names the side that moved.
   */
  it('matches the literal fragments quoted in policy sections 4.7, 7.1 and 11.2', () => {
    // Section 4.7 compose skeleton.
    expect(REQUIRED_TMPFS).toEqual([
      '/work:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=65532,gid=65532',
      '/out:rw,nosuid,nodev,noexec,size=16m,mode=0700,uid=65532,gid=65532',
      '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',
    ]);
    expect(RENDER_PATHS.work).toBe('/work');
    expect(RENDER_PATHS.out).toBe('/out');
    expect(RENDER_PATHS.toolchain).toBe('/opt/typst');
    expect(RENDER_PATHS.packages).toBe('/opt/typst-packages');
    expect(RENDER_PATHS.fonts).toBe('/opt/typst-fonts');
    expect(RENDER_PATHS.packageCache).toBe('/work/.pkgcache');

    // Section 7.1 pin.
    expect(TYPST_PIN.version).toBe('0.15.1');
    expect(TYPST_PIN.asset).toBe('typst-x86_64-unknown-linux-musl.tar.xz');
    expect(TYPST_PIN.sha256).toBe(
      'a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c',
    );

    // Section 11.2 LaTeX argv and env.
    const latex = plan('latex');
    expect(latex.argv).toEqual([
      'pdflatex',
      '-no-shell-escape',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-recorder',
      '-output-directory=/out',
      '-jobname=artifact',
      'artifact.tex',
    ]);
    expect(latex.env.openin_any).toBe('p');
    expect(latex.env.openout_any).toBe('p');
    expect(latex.env.shell_escape).toBe('f');

    // Section 4.7 compose skeleton, environment block. The two TYPST_IGNORE_* values
    // are 'true' because typst 0.15.1's clap REJECTS '1'; T1013 corrected both this
    // document's skeleton and sandbox.ts, and these assertions are what keeps the two
    // in step (the worker cannot parse its argv with '1', so it never renders).
    expect(plan('typst').env.TYPST_IGNORE_SYSTEM_FONTS).toBe('true');
    expect(plan('typst').env.TYPST_IGNORE_EMBEDDED_FONTS).toBe('true');
    expect(RENDER_POLICY.enginePolicy('typst').requiredEnvValues.TYPST_IGNORE_SYSTEM_FONTS).toBe(
      'true',
    );
    expect(RENDER_POLICY.enginePolicy('typst').requiredEnvValues.TYPST_IGNORE_EMBEDDED_FONTS).toBe(
      'true',
    );

    // Section 9.2 outcome codes are a closed set.
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

    // Section 13.1: the module points at the normative document.
    expect(RENDER_POLICY.spec).toBe('.planning/specs/clearance-v2/render-sandbox-policy.md');
    expect(RENDER_POLICY.task).toBe('T1006');
    expect(RENDER_POLICY.allowedStageNames.typst).toEqual(['template.typ', 'data.json']);
    expect(RENDER_POLICY.allowedStageNames.latex).toEqual(['artifact.tex']);
  });

  it('really reads the policy document: editing one side alone now fails this test', () => {
    // The point of the guard above. Everything here is compared against the TEXT of
    // `.planning/specs/clearance-v2/render-sandbox-policy.md`, read from disk at module
    // load, so a one-sided edit of the document or of `sandbox.ts` fails.
    expect(POLICY_MD.length).toBeGreaterThan(10_000);

    // Section 4.4 table: each REQUIRED_TMPFS entry must be the mount, size and options
    // the document states. This is the tmpfs-vs-host-bind contract (policy 3.1, 4.4), so
    // it is checked per mount rather than by substring over the whole file.
    for (const entry of REQUIRED_TMPFS) {
      const separator = entry.indexOf(':');
      const mount = entry.slice(0, separator);
      const rest = entry.slice(separator + 1);
      const size = /\bsize=(\d+)m/.exec(rest)?.[1];
      const options = rest.replace(/\bsize=\d+m,?/, '');
      expect(size, `no size in ${entry}`).toBeDefined();
      // The document's 4.4 row: | `/work` | `32m` | `rw,nosuid,...` |
      const row = new RegExp(`\\| \`${mount.replace('/', '\\/')}\` \\| \`(\\d+)m\` \\| \`([^\`]+)\` \\|`);
      const match = row.exec(POLICY_MD);
      expect(match, `policy 4.4 has no tmpfs row for ${mount}`).not.toBeNull();
      expect(`${match?.[1]}m`, `tmpfs size for ${mount}`).toBe(`${size}m`);
      expect(match?.[2], `tmpfs options for ${mount}`).toBe(options);
    }

    // Section 4.7 compose skeleton: the tmpfs lines appear verbatim, and so do the
    // required read-only bind targets.
    for (const entry of REQUIRED_TMPFS) {
      expect(POLICY_MD, `compose skeleton tmpfs ${entry}`).toContain(`- ${entry}`);
    }
    for (const bind of RENDER_CONTAINER.readOnlyBinds) {
      expect(POLICY_MD, `bind source ${bind.host}`).toContain(bind.host);
      expect(POLICY_MD, `bind target ${bind.target}`).toContain(bind.target);
    }
    for (const key of Object.keys(REQUIRED_COMPOSE_KEYS)) {
      expect(POLICY_MD, `compose key ${key}`).toContain(key);
    }

    // Section 4.7 environment block: the two TYPST_IGNORE_* values are quoted as the
    // module sets them. With "1" typst 0.15.1 cannot parse its own argv (T1005 OI-7,
    // T1013 correction), so a one-sided edit here is a total render failure, not a
    // cosmetic drift.
    const typstPolicy = RENDER_POLICY.enginePolicy('typst');
    for (const [key, value] of Object.entries(typstPolicy.requiredEnvValues)) {
      expect(plan('typst').env[key], `built env ${key}`).toBe(value);
    }
    // The keys the 4.7 skeleton actually quotes, compared against the document. (The
    // skeleton does not list every env key - `TZ` is set by the image, not here - so
    // this is an explicit list, not a loop over the whole set.) The two TYPST_IGNORE_*
    // values are in it because with "1" typst 0.15.1 cannot parse its own argv
    // (T1005 OI-7, T1013 correction), so a one-sided edit is a total render failure.
    for (const key of [
      'TYPST_ROOT',
      'TYPST_PACKAGE_PATH',
      'TYPST_PACKAGE_CACHE_PATH',
      'TYPST_FONT_PATHS',
      'TYPST_IGNORE_SYSTEM_FONTS',
      'TYPST_IGNORE_EMBEDDED_FONTS',
      'SOURCE_DATE_EPOCH',
      'HOME',
    ]) {
      const value = typstPolicy.requiredEnvValues[key];
      if (value === undefined) {
        // SOURCE_DATE_EPOCH is a per-job value, not a policy constant; the skeleton
        // documents the shell substitution instead.
        expect(POLICY_MD, `compose env ${key}`).toContain(`${key}:`);
        continue;
      }
      // The YAML skeleton may or may not quote the value; both spellings must agree
      // with the module, so a one-sided edit of either is caught.
      const quoted = POLICY_MD.includes(`${key}: ${value}`);
      expect(quoted || POLICY_MD.includes(`${key}: "${value}"`), `compose env ${key}`).toBe(true);
    }
    // The pin (section 7.1) and the paths (4.4/4.5) are quoted in the document too.
    expect(POLICY_MD).toContain(TYPST_PIN.version);
    expect(POLICY_MD).toContain(TYPST_PIN.asset);
    expect(POLICY_MD).toContain(TYPST_PIN.sha256);
    for (const containerPath of [
      RENDER_PATHS.work,
      RENDER_PATHS.out,
      RENDER_PATHS.toolchain,
      RENDER_PATHS.packages,
      RENDER_PATHS.fonts,
      RENDER_PATHS.packageCache,
    ]) {
      expect(POLICY_MD, `path ${containerPath}`).toContain(containerPath);
    }
    // Section 9.2 outcome codes and the 5.1 stage-name allowlist.
    for (const code of RENDER_OUTCOME_CODES) {
      expect(POLICY_MD, `outcome code ${code}`).toContain(code);
    }
    for (const engine of RENDER_ENGINES) {
      for (const name of RENDER_POLICY.allowedStageNames[engine]) {
        expect(POLICY_MD, `stage name ${name}`).toContain(name);
      }
    }
    // Section 5.2.4 names the site that actually enforces `assertSafeStageName`. The
    // review found the document claiming `buildCompileArgs()` calls it, which it cannot
    // (it receives no staged name) and never did; a reader could have deleted the real
    // guards on the strength of that sentence. Both enforcement sites must be named,
    // and neither may be attributed to the argv builder.
    expect(POLICY_MD).toContain('assertSafeStageName');
    const item = POLICY_MD.slice(POLICY_MD.indexOf('exports `assertSafeStageName()`'));
    const paragraph = item.slice(0, item.indexOf('\n\n'));
    expect(paragraph).toContain('stage.ts');
    expect(paragraph.match(/render\/stage\.ts/g)?.length).toBe(2);
    expect(paragraph).not.toMatch(/buildCompileArgs\(\)` calls it/);
    expect(paragraph).not.toMatch(/`buildCompileArgs\(\)` calls/);
  });

  it('keeps the typst argv exactly as documented (compile + pinned flags only)', () => {
    expect(plan('typst').argv).toEqual([
      'typst',
      'compile',
      '--root',
      '/work',
      '--format',
      'pdf',
      '--package-path',
      '/opt/typst-packages',
      '--package-cache-path',
      '/work/.pkgcache',
      '--font-path',
      '/opt/typst-fonts',
      '--ignore-system-fonts',
      '--jobs',
      '1',
      '--diagnostic-format',
      'short',
      '/work/template.typ',
      '/out/artifact.pdf',
    ]);
  });

  it('never puts resume content on the command line (policy 5.4, V24 structural half)', () => {
    // The only inputs to argv are POLICY constants plus the format. There is no code
    // path by which user text could reach argv or env.
    const p = plan('typst');
    expect(p.argv.every((token) => typeof token === 'string' && token.length <= 32)).toBe(true);
    expect(p.argv).not.toContain('--input');
    for (const value of Object.values(p.env)) {
      expect(typeof value === 'string' && value.length <= 24).toBe(true);
    }
    expect(p.argv.join('\n')).not.toMatch(/@/); // no `@namespace/pkg` import strings
  });
});
