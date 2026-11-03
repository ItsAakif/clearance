// LaTeX is a SERVER-SIDE engine now - the guarantees that make that safe.
//
// POLICY REVERSAL (owner decision, 2026-10-31). This file REPLACES the T1042 version,
// which asserted the opposite: that there was no LaTeX runtime, that the broker refused
// engine `latex` with ENGINE_UNSUPPORTED, and that the render port refused a LaTeX
// template with `LATEX_COMPILE_NOT_SUPPORTED`. Those assertions were correct for the
// export-only product and are deliberately inverted here. The `.tex` EXPORT still exists
// and is unchanged; what changed is that the same document can now be compiled by a
// pinned, sandboxed pdflatex worker through the SAME broker path as Typst.
//
// The security properties are the Typst ones, engine for engine:
//   - the broker accepts exactly `typst` and `latex`, and each spec's
//     `expectedEngineVersion` must equal that engine's pin (`LATEX_PIN.version` = 2022);
//   - the container is chosen by engine (`clearance/latex-worker:2022`), and the compile
//     exec resolves the bare `pdflatex` name against `/opt/latex`;
//   - `LATEX_POLICY`'s argv carries `-no-shell-escape` and never an enable spelling;
//   - `openin_any`/`openout_any` are `p`, in both spellings;
//   - the staged name is `artifact.tex` and nothing else;
//   - the exporter remains a PURE serialiser: its only import is the shared dictionary.
//
// The real compile is covered two ways: `broker/latexWorkerLive.test.ts` compiles the
// exporter's output in the pinned image when it is present, and the HTTP transcript in
// `.planning/progress/latex-engine.md` renders the stored template end to end.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { ClaimStatus, ResumeUsage } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The port reaches the database through this module's default export. Every test here
// passes its own `db`, so no client is ever constructed - which is why this suite needs
// no DATABASE_URL and no daemon.
vi.mock('../lib/prisma.js', () => ({
  default: {},
  prisma: {},
  DB_POOL_DEFAULTS: {},
  buildPooledDatabaseUrl: (raw?: string) => raw,
  isTerminatedConnectionError: () => false,
  logTransientConnectionWarning: () => undefined,
  withDbRetry: async <T,>(operation: () => Promise<T>): Promise<T> => operation(),
  connectWithRetry: async () => undefined,
}));

import { canonicalJsonHash, X_CLEARANCE_KEY } from '../resume/json/jsonresume.js';
import { parseJobSpec, buildCompileExecArgs, resolveEngineBinary } from './broker/index.js';
import {
  RENDER_LATEX_WORKER_IMAGE,
  RENDER_WORKER_IMAGE,
  buildContainerCreateArgs,
  type BrokerJobSpec,
} from './broker/createArgs.js';
import { createRenderPort, type RenderBrokerLike, type RenderPortDb } from './renderPort.js';
import {
  LATEX_PIN,
  RENDER_ENGINES,
  RENDER_PATHS,
  RENDER_POLICY,
  TYPST_PIN,
  buildCompileArgs,
} from './sandbox.js';
import { stageRenderJobInMemory } from './stage.js';
import type { ArtifactStore } from './storage.js';
import type { TemplateRecord, TemplateRegistry } from './templates.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STAMP = 1_757_000_000;
const HOST_ROOT = '/srv/clearance/host-root';

/** A pinned UNIX second, never `Date.now()` (policy 7.4). */
const SPEC_LATEX: BrokerJobSpec = Object.freeze({
  jobId: 'job-latex-1',
  engine: 'latex',
  format: 'pdf',
  templateId: 'latex-ats-classic',
  templateVersion: '1.0.0',
  expectedEngineVersion: LATEX_PIN.version,
  creationTimestampUnix: STAMP,
  treeBytes: 0,
  treeFileCount: 1,
  userId: 'user-a',
  revisionId: 'rev-1',
});

function fakePdf(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'latin1'),
    Buffer.from('1 0 obj\n<< /Type /Page >>\nendobj\n', 'latin1'),
    Buffer.from('trailer\n%%EOF\n', 'latin1'),
  ]);
}

function validDocument(): Record<string, unknown> {
  return {
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer' },
    work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01' }],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 'test',
      sourceModelVersion: 2,
      profileId: 'profile-1',
      claimCount: 0,
      confirmedClaimCount: 0,
      unconfirmedClaimCount: 0,
      claims: [],
    },
  };
}

function revisionRow(): Record<string, unknown> {
  const resumeJson = validDocument();
  return {
    id: 'rev-1',
    resumeId: 'res-1',
    revisionNumber: 1,
    resumeJson,
    jsonHash: canonicalJsonHash(resumeJson),
    enginePins: {},
    createdBy: 'user',
    createdByUserId: 'user-1',
    reason: null,
    createdAt: new Date('2026-09-30T12:00:00.000Z'),
  };
}

function fakeDb() {
  const calls = { revision: 0, claim: 0, usage: 0, cacheLookup: 0, upsert: 0 };
  const upserts: Array<Record<string, unknown>> = [];
  const db = {
    resumeRevision: {
      findFirst: async () => {
        calls.revision += 1;
        return revisionRow();
      },
    },
    careerClaim: {
      findMany: async () => {
        calls.claim += 1;
        return [];
      },
    },
    resumeClaimUsage: {
      findMany: async () => {
        calls.usage += 1;
        return [];
      },
    },
    resumeDocument: {
      findFirst: async () => {
        calls.cacheLookup += 1;
        return null;
      },
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        calls.upsert += 1;
        upserts.push(create);
        return { id: 'doc-1', createdAt: new Date('2026-09-30T12:05:00.000Z'), ...create };
      },
    },
  };
  return { db: db as unknown as RenderPortDb, calls, upserts };
}

function countingStore() {
  const calls = { head: 0, put: 0 };
  const store = {
    head: async () => {
      calls.head += 1;
      return null;
    },
    put: async (request: { key: string; byteSize: number; sha256: string; contentType: string }) => {
      calls.put += 1;
      return {
        key: request.key,
        byteSize: request.byteSize,
        sha256: request.sha256,
        contentType: request.contentType,
      };
    },
    open: async () => null,
    remove: async () => undefined,
    describe: () => ({ kind: 'fs' as const, root: '/nonexistent' }),
  };
  return { store: store as unknown as ArtifactStore, calls };
}

/** A broker that records every spec and returns a REAL PDF with its REAL digest. */
function recordingBroker() {
  const state = { specs: [] as Array<Record<string, unknown>>, trees: [] as unknown[] };
  const artifact = fakePdf();
  const sha256 = createHash('sha256').update(artifact).digest('hex');
  const broker = {
    render: async (spec: Record<string, unknown>, tree: unknown) => {
      state.specs.push(spec);
      state.trees.push(tree);
      return {
        outcome: 'ok' as const,
        sha256,
        byteSize: artifact.length,
        mimeType: 'application/pdf',
        durationMs: 5,
        artifact,
      };
    },
  };
  return { broker: broker as unknown as RenderBrokerLike, state };
}

function registryWithLatex(engine: string = 'latex'): TemplateRegistry {
  const record = Object.freeze({
    id: 'latex-fixture',
    dir: '/nonexistent/latex-fixture',
    version: '1.0.0',
    templatePath: '/nonexistent/latex-fixture/template.tex',
    assets: Object.freeze([] as readonly string[]),
    metadata: Object.freeze({
      id: 'latex-fixture',
      version: '1.0.0',
      name: 'latex fixture',
      category: 'professional',
      engine,
      engineVersionPins: Object.freeze({ latex: LATEX_PIN.version }),
      pageSize: 'a4',
      columns: 1,
      maxPages: 2,
      supportedSections: Object.freeze(['contact']),
      requiredDictKeys: Object.freeze(['contact']),
      fonts: Object.freeze([]),
      packages: Object.freeze([]),
      licence: 'Apache-2.0',
      attribution: 'Clearance',
      atsProfile: Object.freeze({ singleColumn: true, tablesAllowed: false, iconFonts: false }),
      thumbnail: null,
    }),
  }) as unknown as TemplateRecord;
  return {
    templates: Object.freeze([record]),
    get: (requested: string): TemplateRecord => {
      if (requested !== record.id) throw new Error('TEMPLATE_ID_UNKNOWN');
      return record;
    },
    lock: {} as TemplateRegistry['lock'],
    root: record.dir,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The policy reversal is a real, pinned engine
// ---------------------------------------------------------------------------

describe('1. LaTeX is a pinned server-side engine (the reversal)', () => {
  it('the engine set is the closed two, and LATEX_PIN carries a real TeX Live version', () => {
    expect([...RENDER_ENGINES]).toEqual(['typst', 'latex']);
    expect(RENDER_POLICY.engines).toEqual(['typst', 'latex']);
    // The value the worker image reports (`pdfTeX ... (TeX Live 2022/Debian)`).
    expect(LATEX_PIN.version).toBe('2022');
    expect(LATEX_PIN.version).not.toContain('deferred');
    expect(LATEX_PIN.binary).toBe('pdflatex');
    expect(LATEX_PIN.shellEscape).toBe('forbidden');
    expect(LATEX_PIN.openinAny).toBe('p');
    expect(LATEX_PIN.openoutAny).toBe('p');
    expect(LATEX_PIN.forbiddenBinaries).toEqual(['lualatex', 'xelatex', 'luatex', 'tectonic']);
  });

  it('the latex argv carries the required policy fragments and NEVER an enable spelling', () => {
    const argv = buildCompileArgs('latex', { creationTimestampUnix: STAMP }).argv;
    expect(argv[0]).toBe('pdflatex');
    for (const fragment of [
      '-no-shell-escape',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-recorder',
      '-output-directory=/out',
      '-jobname=artifact',
    ]) {
      expect(argv, `latex argv must contain ${fragment}`).toContain(fragment);
    }
    // The input is RELATIVE: `openin_any=p` refuses an absolute input outside
    // `$TEXMFOUTPUT`, so `/work/artifact.tex` cannot be opened. The cwd is `/work`.
    expect(argv[argv.length - 1]).toBe('artifact.tex');
    for (const forbidden of ['-shell-escape', '--shell-escape', '-enable-sh']) {
      expect(argv).not.toContain(forbidden);
    }
    for (const token of argv) {
      if (!/shell[-_\\]?escape/i.test(token)) continue;
      expect(token === '-no-shell-escape' || token.toLowerCase().includes('no-shell-escape')).toBe(true);
    }
    // No forbidden engine binary is selected anywhere in the argv.
    for (const binary of LATEX_PIN.forbiddenBinaries) {
      expect(argv).not.toContain(binary);
    }
  });

  it('the latex env pins paranoid openin/openout in both spellings, and shell escape off', () => {
    const env = buildCompileArgs('latex', { creationTimestampUnix: STAMP }).env;
    for (const key of ['openin_any', 'OPENIN_ANY', 'openout_any', 'OPENOUT_ANY']) {
      expect(env[key], `${key} must be the PARANOID level`).toBe('p');
    }
    expect(env.shell_escape).toBe('f');
    expect(env.SHELL_ESCAPE).toBe('f');
    expect(env.TEXMFOUTPUT).toBe('/out');
    expect(env.TEXMFHOME.startsWith('/work/')).toBe(true);
    expect(env.TEXMFCNF.startsWith('/work/')).toBe(true);
    expect(env.TEXMFVAR.startsWith('/work/')).toBe(true);
    expect(env.FORCE_SOURCE_DATE).toBe('1');
    expect(env.SOURCE_DATE_EPOCH).toBe(String(STAMP));
    expect(env.HOME).toBe('/nonexistent');
    expect(env.TZ).toBe('UTC');
    expect('TYPST_CERT' in env).toBe(false);
    expect('XDG_CACHE_HOME' in env).toBe(false);
  });

  it('the policy keeps the staged-name allowlist at exactly artifact.tex', () => {
    expect(RENDER_POLICY.allowedStageNames.latex).toEqual(['artifact.tex']);
    expect(RENDER_POLICY.allowedStageNames.latex).not.toContain('data.json');
    expect(RENDER_PATHS.names.latexTemplate).toBe('artifact.tex');
    expect(RENDER_PATHS.latexToolchain).toBe('/opt/latex');
  });

  it('the exporter remains a PURE serialiser (no broker, no stage, no compiler)', () => {
    const emitter = readFileSync(path.join(__dirname, 'latexExport.ts'), 'utf8');
    const specifiers = [
      ...emitter.matchAll(/(?:from|import|require)\(\s*'([^']+)'|(?:from|import)\s+'([^']+)'/g),
    ].map((match) => (match[1] ?? match[2]) as string);
    expect([...new Set(specifiers)]).toEqual(['./dict.js']);
    expect(emitter).not.toContain('buildCompileArgs');
    expect(emitter).not.toContain('stageRenderJob');
    expect(emitter).not.toContain('RenderBrokerClient');
  });
});

// ---------------------------------------------------------------------------
// 2. Broker engine selection
// ---------------------------------------------------------------------------

describe('2. the broker accepts latex and rejects a bad pin or unknown engine', () => {
  it('accepts a latex spec whose pin matches LATEX_PIN.version', () => {
    const parsed = parseJobSpec({ ...SPEC_LATEX });
    expect(parsed.engine).toBe('latex');
    expect(parsed.format).toBe('pdf');
    expect(parsed.expectedEngineVersion).toBe(LATEX_PIN.version);
  });

  it('rejects a latex spec with a mistyped pin as RENDER_TOOLCHAIN_MISMATCH', () => {
    expect(() =>
      parseJobSpec({ ...SPEC_LATEX, expectedEngineVersion: '2023' }),
    ).toThrow(/RENDER_TOOLCHAIN_MISMATCH.*ENGINE_VERSION_MISMATCH/);
  });

  it('rejects an unknown engine with ENGINE_UNSUPPORTED', () => {
    expect(() => parseJobSpec({ ...SPEC_LATEX, engine: 'xelatex' })).toThrow(/ENGINE_UNSUPPORTED/);
    expect(() => parseJobSpec({ ...SPEC_LATEX, engine: 'pdflatex' })).toThrow(/ENGINE_UNSUPPORTED/);
  });

  it('keeps Typst the default and unchanged', () => {
    const typstSpec = {
      ...SPEC_LATEX,
      engine: 'typst',
      expectedEngineVersion: TYPST_PIN.version,
      templateId: 'typst-ats-classic',
    };
    expect(parseJobSpec(typstSpec).engine).toBe('typst');
    expect(() =>
      parseJobSpec({ ...typstSpec, expectedEngineVersion: LATEX_PIN.version }),
    ).toThrow(/RENDER_TOOLCHAIN_MISMATCH/);
  });

  it('selects the image by engine: latex -> latex-worker, typst -> typst-worker', () => {
    const latexPlan = buildCompileArgs('latex', { creationTimestampUnix: STAMP });
    const latexArgs = buildContainerCreateArgs(latexPlan, SPEC_LATEX, HOST_ROOT);
    expect(latexArgs).toContain(RENDER_LATEX_WORKER_IMAGE);
    expect(RENDER_LATEX_WORKER_IMAGE).toBe(`clearance/latex-worker:${LATEX_PIN.version}`);
    expect(latexArgs).not.toContain(RENDER_WORKER_IMAGE);
    // Every isolation key is still emitted.
    expect(latexArgs).toContain('--network');
    expect(latexArgs[latexArgs.indexOf('--network') + 1]).toBe('none');
    expect(latexArgs).toContain('--read-only');
    expect(latexArgs).toContain('--user');
    expect(latexArgs[latexArgs.indexOf('--user') + 1]).toBe('65532:65532');
    expect(latexArgs).toContain('--cap-drop');
    expect(latexArgs[latexArgs.indexOf('--cap-drop') + 1]).toBe('ALL');

    const typstPlan = buildCompileArgs('typst', { creationTimestampUnix: STAMP });
    const typstSpec: BrokerJobSpec = {
      ...SPEC_LATEX,
      engine: 'typst',
      templateId: 'typst-ats-classic',
      expectedEngineVersion: TYPST_PIN.version,
    };
    const typstArgs = buildContainerCreateArgs(typstPlan, typstSpec, HOST_ROOT);
    expect(typstArgs).toContain(RENDER_WORKER_IMAGE);
    expect(typstArgs).not.toContain(RENDER_LATEX_WORKER_IMAGE);
  });

  it('resolves the latex binary against /opt/latex and passes the policy argv verbatim', () => {
    expect(resolveEngineBinary('pdflatex', 'latex')).toBe('/opt/latex/pdflatex');
    // The default form is the Typst path, so existing callers are unchanged.
    expect(resolveEngineBinary('typst')).toBe('/opt/typst/typst');

    const plan = buildCompileArgs('latex', { creationTimestampUnix: STAMP });
    const exec = buildCompileExecArgs(plan, 'container-1');
    const at = exec.indexOf('container-1');
    expect(exec[at + 1]).toBe('/opt/latex/pdflatex');
    expect(exec.slice(at + 2)).toEqual(plan.argv.slice(1));
    expect(exec).toContain('-no-shell-escape');
    for (const forbidden of ['-shell-escape', '--shell-escape', '-enable-sh']) {
      expect(exec).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The port: latex renders, unknown engines are refused
// ---------------------------------------------------------------------------

describe('3. the render port dispatches by the template engine', () => {
  it('renders an engine:"latex" template through the broker as a stored PDF', async () => {
    const { db, calls, upserts } = fakeDb();
    const { store, calls: storeCalls } = countingStore();
    const { broker, state } = recordingBroker();
    const port = createRenderPort({
      db,
      artifacts: store,
      broker,
      registry: registryWithLatex(),
      templateId: 'latex-fixture',
      now: () => STAMP * 1000,
      log: () => undefined,
    });

    const result = await port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' });
    expect(result.format).toBe('pdf');

    // The broker was asked for a LATEX job with the LaTeX pin.
    expect(state.specs).toHaveLength(1);
    expect(state.specs[0]).toMatchObject({
      engine: 'latex',
      format: 'pdf',
      expectedEngineVersion: LATEX_PIN.version,
      templateId: 'latex-fixture',
    });
    // The staged tree is exactly `artifact.tex`.
    const tree = state.trees[0] as { names: readonly string[] };
    expect([...tree.names]).toEqual(['artifact.tex']);

    // The artifact was stored as a PDF ResumeDocument, with the engine version recorded.
    expect(storeCalls.put).toBe(1);
    expect(calls.upsert).toBe(1);
    expect(upserts[0]).toMatchObject({
      format: 'pdf',
      templateId: 'latex-fixture',
      mimeType: 'application/pdf',
    });
    expect(String(upserts[0]?.engineVersion).startsWith(`${LATEX_PIN.version}|`)).toBe(true);
  });

  it('refuses an unknown engine with ENGINE_UNSUPPORTED and performs no side effect', async () => {
    const { db, calls } = fakeDb();
    const { store, calls: storeCalls } = countingStore();
    const { broker, state } = recordingBroker();
    const port = createRenderPort({
      db,
      artifacts: store,
      broker,
      registry: registryWithLatex('xelatex'),
      templateId: 'latex-fixture',
      now: () => STAMP * 1000,
      log: () => undefined,
    });

    await expect(
      port({ revisionId: 'rev-1', format: 'pdf', userId: 'user-1' }),
    ).rejects.toMatchObject({
      name: 'RenderPortError',
      code: 'render_template_unsupported',
      reason: 'ENGINE_UNSUPPORTED',
    });
    expect(state.specs).toHaveLength(0);
    expect(storeCalls.head).toBe(0);
    expect(storeCalls.put).toBe(0);
    expect(calls.cacheLookup).toBe(0);
    expect(calls.upsert).toBe(0);
  });

  it('the latex job stages only artifact.tex and REFUSES data.json (the allowlist is policy)', async () => {
    const tex = Buffer.from('\\documentclass{article}\\begin{document}Ada\\end{document}\n', 'utf8');
    const tree = await stageRenderJobInMemory({ engine: 'latex', templateBytes: tex });
    expect([...tree.names]).toEqual(['artifact.tex']);
    expect(tree.files.map((file) => file.name)).toEqual(['artifact.tex']);

    // The in-memory payload takes the same refusal as a file payload would: a LaTeX job
    // has no data channel.
    await expect(
      stageRenderJobInMemory({ engine: 'latex', templateBytes: tex, dataBytes: Buffer.from('{}') }),
    ).rejects.toMatchObject({ code: 'RENDER_INPUT_INVALID', reason: 'NAME_NOT_ALLOWLISTED' });
  });
});
