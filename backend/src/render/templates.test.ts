// Template registry - unit tests.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/render-sandbox-policy.md 8.3 (the registry
//                 gate), 5.1 (the staged payload), 8.1/8.2/8.4/8.6
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 4 and 6
// Task:         T1040
//
// THE SHIPPED TEMPLATES ARE THE POSITIVE CASE. The three real directories under
// backend/typst/templates are loaded and validated by the SAME code the render path
// uses, so a template that drifts from its own metadata fails here rather than in a
// render. Every negative case is a fixture tree in a temp directory, built by copying the
// real one and mutating one thing - so a negative test cannot accidentally assert on a
// different template than the one it names.
//
// NOTHING HERE NEEDS A DOCKER DAEMON. The live compile of all three templates against a
// real data.json is in `.planning/progress/T1040-typst-renderer-registry.md`.

import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { RESUME_DICT_SECTIONS } from './dict.js';
import { LATEX_PIN, TYPST_PIN } from './sandbox.js';
import {
  RENDER_DEFAULT_TEMPLATE_ID,
  TEMPLATE_COLUMN_COUNTS,
  TEMPLATE_ID_PATTERN,
  TEMPLATE_PAGE_SIZES,
  TEMPLATE_REJECTION_CODES,
  TEMPLATE_REJECTION_REASONS,
  TEMPLATE_REQUIRED_FILES,
  TEMPLATE_RESERVED_IDS,
  TemplateRejectionError,
  defaultTemplatesRoot,
  loadTemplateRegistry,
  packageImportsIn,
  resolveTemplateForRender,
  type TemplateMetadata,
} from './templates.js';

// __dirname is available both compiled to CJS and under vitest (repo convention:
// see src/ats/promptLoader.ts:8).
const HERE = __dirname;
const SRC = path.resolve(HERE, '..');
const TYPST_ROOT = path.resolve(SRC, '..', 'typst');
const REAL_TEMPLATES_ROOT = path.join(TYPST_ROOT, 'templates');
const SHIPPED_TEMPLATE_IDS = ['typst-ats-classic', 'typst-compact-two-col', 'typst-modern-cards'];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Per-TEST temp trees. Removed after each test, as before. */
const created: string[] = [];
/** Per-RUN temp trees (the pristine template bases). Removed once, after all tests. */
const runScoped: string[] = [];

afterEach(async () => {
  for (const dir of created.reverse()) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  created.length = 0;
});

afterAll(async () => {
  for (const dir of runScoped.reverse()) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  runScoped.length = 0;
  pristineBases.clear();
  pristineRoot = undefined;
});

/**
 * A pristine copy of ONE template directory, built once per template id per run, plus the
 * list of files it holds.
 *
 * WHY THIS EXISTS. Every negative case is a fixture tree, and the wrong-type matrix builds
 * 23 of them. The first version of this file made each one by copying the WHOLE shipped
 * templates root (all three template directories) and then `rm -rf`-ing the two it did not
 * need: measured on this host that is 18.2ms of fs work PER FIXTURE (~140 file operations
 * plus ~46 recursive removals on Windows), and the matrix blew vitest's 5s budget the
 * moment T1031's broker tests made the parallel suite heavier - a load-sensitive test, not
 * a slow-but-correct one.
 *
 * Copying the four files out of a per-id base is 4.8ms per fixture here, and the base is
 * built once per id, so a fixture's cost no longer scales with the number of shipped
 * templates. `copyFile` per file is used rather than `cp(..., { recursive: true })`
 * (7.2ms measured) because `fs.cp`'s recursive walk is the expensive part, and the FILE
 * LIST comes from the base rather than being restated here, so a fifth file in a template
 * is copied without this helper being edited.
 *
 * The base is NEVER mutated: `makeTree` copies out of it into a fresh per-test root, so a
 * fixture can still "copy the real template and change one thing" - the only difference is
 * that the pristine bytes are copied once instead of 23 times. The cache holds PROMISES, so
 * two fixtures that race for the same id build the base once between them rather than
 * copying two trees into the same path.
 */
interface PristineTemplate {
  readonly dir: string;
  readonly files: readonly string[];
}

const pristineBases = new Map<string, Promise<PristineTemplate>>();
let pristineRoot: string | undefined;

function pristineTemplate(templateId: string): Promise<PristineTemplate> {
  const cached = pristineBases.get(templateId);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<PristineTemplate> => {
    if (pristineRoot === undefined) {
      pristineRoot = await mkdtemp(path.join(tmpdir(), 'clearance-template-base-'));
      runScoped.push(pristineRoot);
    }
    const dir = path.join(pristineRoot, templateId);
    await cp(path.join(REAL_TEMPLATES_ROOT, templateId), dir, { recursive: true });
    return { dir, files: (await readdir(dir)).sort() };
  })();
  pristineBases.set(templateId, pending);
  return pending;
}

/**
 * A throwaway template tree with the real shared lockfile beside it.
 *
 * `root/packages.lock` is the SHARED record (the vendored set) and `root/templates/<id>/`
 * holds the ONE template under test. Copying the real lockfile is what makes a font
 * "vendored" in a fixture without the test having to restate the digests.
 *
 * The signature and the returned shape are unchanged from the first version of this file,
 * so every call site is unaffected: it still returns a tree carrying exactly one template
 * (the other two were deleted immediately after being copied, so no fixture could ever
 * depend on them) and still patches `metadata.json` and the extra files in place.
 */
async function makeTree(
  templateId: string,
  overrides: {
    metadata?: Record<string, unknown>;
    /** Keys whose value REPLACES rather than deep-merges (a partial object is a fixture). */
    replace?: readonly string[];
    files?: Record<string, string>;
  } = {},
): Promise<{ templatesRoot: string; typstRoot: string; dir: string; metadataPath: string; lockPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'clearance-templates-'));
  created.push(root);
  const templatesDir = path.join(root, 'templates');
  // ONE template directory, file by file out of its pristine per-id base. No copy-all,
  // no delete-two-afterwards, and `readdir` of the fixture is never needed.
  const base = await pristineTemplate(templateId);
  const dir = path.join(templatesDir, templateId);
  await mkdir(dir, { recursive: true });
  for (const name of base.files) {
    await copyFile(path.join(base.dir, name), path.join(dir, name));
  }
  await copyFile(path.join(TYPST_ROOT, 'packages.lock'), path.join(root, 'packages.lock'));

  const metadataPath = path.join(dir, 'metadata.json');
  const lockPath = path.join(dir, 'packages.lock');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
  const patch = overrides.metadata ?? {};
  const merged: Record<string, unknown> = { ...deepMerge(metadata, patch) };
  for (const key of overrides.replace ?? []) {
    if (key in patch) merged[key] = patch[key];
  }
  await writeFile(metadataPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  for (const [name, contents] of Object.entries(overrides.files ?? {})) {
    await writeFile(path.join(dir, name), contents, 'utf8');
  }
  // `templatesRoot` is what `loadTemplateRegistry({ root })` takes: the registry reads
  // the shared lockfile from its PARENT, which is the whole reason a fixture is built
  // as a typst root with a `templates/` child rather than as a bare directory.
  return { templatesRoot: templatesDir, typstRoot: root, dir, metadataPath, lockPath };
}

/**
 * Create a link at `linkPath`, degrading to a directory junction where the platform refuses
 * a file symlink (Windows without Developer Mode). Copied from `symlinkAny()` in
 * `storage.test.ts` - the same pattern and the same reason; a test file cannot be imported
 * for one helper without running its suite. Both forms are `isSymbolicLink() === true` under
 * `lstat`, which is the property the registry's guard keys on.
 */
async function symlinkAny(target: string, linkPath: string, dir = false): Promise<void> {
  const types: Array<'file' | 'dir' | 'junction'> =
    process.platform === 'win32' ? (dir ? ['junction'] : ['file', 'junction']) : dir
      ? ['dir']
      : ['file'];
  let last: unknown;
  for (const type of types) {
    try {
      await symlink(target, linkPath, type);
      return;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(
    `this host cannot create symlinks at all (${String(last)}); the symlink guard cannot be proven here`,
  );
}

/**
 * Can this host create a FILE symlink? Probed once per run, in its own temp directory.
 *
 * Windows refuses a file symlink with EPERM unless Developer Mode (or an elevated shell)
 * is on, and a hard EPERM in a test is a red suite on an open-source contributor's machine
 * and on CI. The probe is what lets the symlink test below keep its strongest form where
 * that is constructible and still ASSERT something true - never nothing - where it is not.
 */
let fileSymlinkSupport: Promise<boolean> | undefined;

function hostCreatesFileSymlinks(): Promise<boolean> {
  fileSymlinkSupport ??= (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clearance-symlink-probe-'));
    runScoped.push(dir);
    const file = path.join(dir, 'probe.txt');
    await writeFile(file, 'probe');
    try {
      await symlink(file, path.join(dir, 'probe-link.txt'), 'file');
      return true;
    } catch {
      return false;
    }
  })();
  return fileSymlinkSupport;
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The machine code + reason of a rejection, as a comparable object. */
function rejectionOf(run: () => unknown): { code: string; reason: string; message: string } {
  try {
    run();
  } catch (err) {
    if (err instanceof TemplateRejectionError) {
      return { code: err.code, reason: err.reason, message: err.message };
    }
    throw err;
  }
  throw new Error('expected a TemplateRejectionError');
}

async function rejectionOfAsync(run: () => Promise<unknown>): Promise<{
  code: string;
  reason: string;
  message: string;
}> {
  try {
    await run();
  } catch (err) {
    if (err instanceof TemplateRejectionError) {
      return { code: err.code, reason: err.reason, message: err.message };
    }
    throw err;
  }
  throw new Error('expected a TemplateRejectionError');
}

// ---------------------------------------------------------------------------
// Acceptance: the three shipped templates load and resolve
// ---------------------------------------------------------------------------

describe('the three shipped Typst templates (plus the five LaTeX peers)', () => {
  it('load, and the default resolves for format pdf', async () => {
    const registry = await loadTemplateRegistry();
    // The registry now spans BOTH engine roots: the three Typst templates and the five
    // LaTeX peers, sorted by id. This is the deliberate policy reversal (2026-10-31): LaTeX
    // is no longer export-only.
    expect(registry.templates.map((record) => record.id)).toEqual([
      ...SHIPPED_TEMPLATE_IDS,
      'latex-ats-classic',
      'latex-awesome-sans',
      'latex-jakes-compact',
      'latex-moderncv-classic',
      'latex-medium-professional',
    ].sort());
    expect(registry.root).toBe(path.resolve(REAL_TEMPLATES_ROOT));
    expect(RENDER_DEFAULT_TEMPLATE_ID).toBe('typst-ats-classic');

    const resolved = resolveTemplateForRender(registry, { format: 'pdf' });
    expect(resolved.id).toBe(RENDER_DEFAULT_TEMPLATE_ID);
    // The version a record resolves with is the one the template DIRECTORY records, read
    // here rather than restated: a template source edit must bump it (policy 10.4), and a
    // pinned literal in this file would rot the first time one did.
    const shippedLock = await readFile(
      path.join(REAL_TEMPLATES_ROOT, RENDER_DEFAULT_TEMPLATE_ID, 'packages.lock'),
      'utf8',
    );
    expect(resolved.version).toBe(/template\.version\s+=\s+(\S+)/.exec(shippedLock)?.[1]);
    expect(path.basename(resolved.dir)).toBe(resolved.id);
    expect(path.basename(resolved.templatePath)).toBe('template.typ');
    expect(resolved.assets).toEqual([]);
  });

  it('the LaTeX peer loads from its own root, with its own pin and template.tex', async () => {
    const registry = await loadTemplateRegistry();
    const record = registry.get('latex-ats-classic');
    expect(record.metadata.engine).toBe('latex');
    expect(record.metadata.engineVersionPins.latex).toBe(LATEX_PIN.version);
    expect(record.metadata.engineVersionPins.typst).toBeUndefined();
    expect(path.basename(record.dir)).toBe('latex-ats-classic');
    expect(path.basename(record.templatePath)).toBe('template.tex');
    expect(resolveTemplateForRender(registry, { templateId: 'latex-ats-classic', format: 'pdf' }).id).toBe(
      'latex-ats-classic',
    );
    // A LaTeX template's lockfile records the engine, not a vendored font set.
    const lock = await readFile(path.join(record.dir, 'packages.lock'), 'utf8');
    expect(lock).toContain(`engine.latex.version = ${LATEX_PIN.version}`);
    expect(record.metadata.fonts).toEqual([]);
    expect(record.metadata.packages).toEqual([]);
  });

  it('the registry lists all five LaTeX templates with the pinned toolchain and a variant', async () => {
    const registry = await loadTemplateRegistry();
    const latex = registry.templates.filter((entry) => entry.metadata.engine === 'latex');
    expect(latex).toHaveLength(5);
    expect(latex.map((entry) => entry.id).sort()).toEqual([
      'latex-ats-classic',
      'latex-awesome-sans',
      'latex-jakes-compact',
      'latex-medium-professional',
      'latex-moderncv-classic',
    ]);
    for (const record of latex) {
      expect(record.metadata.engineVersionPins.latex).toBe(LATEX_PIN.version);
      expect(record.metadata.engineVersionPins.typst).toBeUndefined();
      expect(path.basename(record.templatePath)).toBe('template.tex');
      // Every shipped LaTeX peer now names the serialiser variant it renders with; the
      // serialiser falls back to `ats-classic`, but an explicit value is what keeps the
      // metadata and the emitted layout from drifting apart.
      expect(typeof record.metadata.variant).toBe('string');
      expect(record.metadata.description?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('each resolves for format pdf BY ITS OWN ID, and each carries a4, a valid columns value and an atsProfile consistent with its own layout', async () => {
    const registry = await loadTemplateRegistry();
    for (const id of SHIPPED_TEMPLATE_IDS) {
      const record = resolveTemplateForRender(registry, { templateId: id, format: 'pdf' });
      const metadata: TemplateMetadata = record.metadata;
      expect(metadata.id).toBe(id);
      expect(metadata.pageSize).toBe('a4');
      expect(TEMPLATE_PAGE_SIZES as readonly string[]).toContain(metadata.pageSize);
      expect(TEMPLATE_COLUMN_COUNTS as readonly number[]).toContain(metadata.columns);
      expect(metadata.atsProfile.singleColumn).toBe(metadata.columns === 1);
      // All three: no icon font, no table, and the one-column claim matches the geometry.
      expect(metadata.atsProfile.iconFonts).toBe(false);
      expect(metadata.atsProfile.tablesAllowed).toBe(false);
      // The two-column template is the only one that is not single column.
      expect(metadata.atsProfile.singleColumn).toBe(id !== 'typst-compact-two-col');
      expect(metadata.columns).toBe(id === 'typst-compact-two-col' ? 2 : 1);
      // ADR-044 D5 / ruling 2: the thumbnail stays null.
      expect(metadata.thumbnail).toBeNull();
      expect(metadata.maxPages).toBe(2);
    }
  });

  it('every shipped Typst template declares the vendored font set and ZERO packages', async () => {
    const registry = await loadTemplateRegistry();
    // The ruling: adding a font or a package requires a lockfile change, a LICENSES.md
    // entry, a fetch-assets change and a re-run of the spike, all in one change.
    expect(registry.lock.thirdPartyPackages).toBe(0);
    for (const record of registry.templates.filter((entry) => entry.metadata.engine === 'typst')) {
      expect(record.metadata.packages).toEqual([]);
      expect(record.metadata.fonts).toHaveLength(1);
      expect(record.metadata.fonts[0]?.family).toBe('Source Serif 4');
      expect(record.metadata.fonts[0]?.files).toEqual([
        'SourceSerif4-Regular.ttf',
        'SourceSerif4-Semibold.ttf',
        'SourceSerif4-Bold.ttf',
      ]);
      expect(record.metadata.fonts[0]?.licence).toBe('OFL-1.1');
      expect(record.metadata.licence).toBe('Apache-2.0');
      expect(record.metadata.engineVersionPins.typst).toBe(TYPST_PIN.version);
    }
  });

  it('every shipped template supports exactly the seven dictionary sections', async () => {
    const registry = await loadTemplateRegistry();
    for (const record of registry.templates) {
      expect([...record.metadata.supportedSections].sort()).toEqual([...RESUME_DICT_SECTIONS].sort());
      // required is a subset of supported: a template cannot require a section it refuses.
      for (const key of record.metadata.requiredDictKeys) {
        expect(record.metadata.supportedSections).toContain(key);
      }
      expect(record.metadata.requiredDictKeys.length).toBeGreaterThan(0);
    }
  });

  it('every shipped template source reads data.json, iterates data.sections, and uses no denied surface', async () => {
    // A source-level restatement of the module gate, independent of the module, so a
    // weakened gate in templates.ts cannot make this pass.
    for (const id of SHIPPED_TEMPLATE_IDS) {
      const source = await readFile(path.join(REAL_TEMPLATES_ROOT, id, 'template.typ'), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      expect(code).toContain('json("data.json")');
      expect(code).toContain('data.sections');
      expect(code).not.toMatch(/\beval\s*\(/);
      expect(code).not.toMatch(/\bread\s*\(/);
      expect(code).not.toMatch(/\.wasm\b/);
      expect(code).not.toMatch(/https?:\/\//);
      expect(code).not.toMatch(/\b(?:try|catch)\b/);
      expect(code).not.toMatch(/(?:^|[\n;])\s*#?(?:import|include)\s+["']/);
      // No table element anywhere, because `tablesAllowed` is false for all three.
      expect(code).not.toMatch(/\btable\s*\(/);
      // The vendored font is named explicitly, because the font set is closed.
      expect(code).toContain('font: "Source Serif 4"');
      // A4 is declared, not approximated.
      expect(code).toContain('paper: "a4"');
      // No package import at all, and the module agrees.
      expect(packageImportsIn(source)).toEqual([]);
    }
  });

  it('the two-column template really declares two columns, and the others really declare one', async () => {
    const twoCol = await readFile(
      path.join(REAL_TEMPLATES_ROOT, 'typst-compact-two-col', 'template.typ'),
      'utf8',
    );
    expect(twoCol).toMatch(/columns:\s*2/);
    for (const id of ['typst-ats-classic', 'typst-modern-cards']) {
      const source = await readFile(path.join(REAL_TEMPLATES_ROOT, id, 'template.typ'), 'utf8');
      expect(source).not.toMatch(/columns:\s*2/);
    }
  });

  it('the modern template differentiates by LAYOUT: it uses a stroked block and no table', async () => {
    const source = await readFile(
      path.join(REAL_TEMPLATES_ROOT, 'typst-modern-cards', 'template.typ'),
      'utf8',
    );
    const code = source.replace(/\/\/[^\n]*/g, ' ');
    expect(code).toMatch(/stroke:/);
    expect(code).toMatch(/inset:/);
    expect(code).not.toMatch(/\btable\s*\(/);
  });

  it("each shipped template's own packages.lock agrees with its metadata and the shared lock", async () => {
    // The registry already enforces this; the test names the specific fact so a future
    // change to one file has to be justified here too.
    const registry = await loadTemplateRegistry();
    for (const record of registry.templates) {
      const lockText = await readFile(path.join(record.dir, 'packages.lock'), 'utf8');
      expect(lockText).toContain(`template.id          = ${record.id}`);
      expect(lockText).toContain(`template.version     = ${record.version}`);
      expect(lockText).toContain('thirdPartyPackages.count = 0');
      expect(lockText).toContain('packages.count = 0');
      for (const font of record.metadata.fonts) {
        for (const file of font.files) {
          expect(lockText).toContain(file);
        }
      }
    }
  });

  it('every shipped template carries the four required files, and a fifth would be a review', async () => {
    for (const id of SHIPPED_TEMPLATE_IDS) {
      for (const name of TEMPLATE_REQUIRED_FILES) {
        await expect(readFile(path.join(REAL_TEMPLATES_ROOT, id, name), 'utf8')).resolves.toBeTruthy();
      }
    }
    // `preview.png` is deliberately absent: policy 6.1/6.3 allows exactly one artifact.
    await expect(readFile(path.join(REAL_TEMPLATES_ROOT, SHIPPED_TEMPLATE_IDS[0] as string, 'preview.png'))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Acceptance: the four negative LICENCE fixtures, each with a machine code + reason
// ---------------------------------------------------------------------------

describe('acceptance: a missing licence is a rejection, not a warning', () => {
  it('FIXTURE 1 of 4 - an UNRECORDED font licence (blank) fails with RENDER_TEMPLATE_LICENCE_MISSING', async () => {
    const tree = await makeTree('typst-ats-classic', {
      metadata: { fonts: [{ family: 'Source Serif 4', files: ['SourceSerif4-Regular.ttf'], licence: '' }] },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_LICENCE_MISSING');
    expect(rejection.reason).toBe('FONT_LICENCE_MISSING');
  });

  it("FIXTURE 2 of 4 - the template's own licence is blank fails with RENDER_TEMPLATE_LICENCE_MISSING", async () => {
    const tree = await makeTree('typst-ats-classic', { metadata: { licence: '   ' } });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_LICENCE_MISSING');
    expect(rejection.reason).toBe('TEMPLATE_LICENCE_MISSING');
  });

  it('FIXTURE 3 of 4 - a font file ABSENT from packages.lock fails with RENDER_TEMPLATE_LICENCE_MISSING', async () => {
    const tree = await makeTree('typst-ats-classic', {
      metadata: {
        fonts: [
          { family: 'Source Serif 4', files: ['SourceSerif4-Regular.ttf', 'NotVendored.ttf'], licence: 'OFL-1.1' },
        ],
      },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_LICENCE_MISSING');
    expect(rejection.reason).toBe('FONT_NOT_VENDORED');
    // And no path, no file name and no canary reaches the message (policy 9.3/9.4).
    expect(rejection.message).not.toContain('NotVendored');
    expect(rejection.message).not.toContain(tree.templatesRoot);
  });

  it('FIXTURE 4 of 4 - a declared PACKAGE absent from packages.lock fails with RENDER_TEMPLATE_PACKAGE_UNRECORDED', async () => {
    const tree = await makeTree('typst-ats-classic', {
      metadata: { packages: [{ spec: '@preview/absent:9.9.9', licence: 'MIT' }] },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_PACKAGE_UNRECORDED');
    expect(rejection.reason).toBe('PACKAGE_NOT_RECORDED');
    expect(rejection.message).not.toContain('absent');
    expect(rejection.message).not.toContain('preview');
  });

  it('a declared package whose licence disagrees with the vendored record is refused too', async () => {
    const tree = await makeTree('typst-ats-classic', {
      metadata: { packages: [{ spec: '@clearance/spike-probe:1.0.0', licence: 'GPL-3.0-only' }] },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_PACKAGE_UNRECORDED');
    expect(rejection.reason).toBe('PACKAGE_LICENCE_MISSING');
  });

  it('a template lockfile that claims a font the metadata does not is refused', async () => {
    // The version is patched in BOTH halves to the same non-shipped value, so the two
    // halves still agree and the font drift is the only disagreement - which is what this
    // fixture is for. A literal copied from the shipped metadata would rot on the next
    // template bump and the version gate would fire first, naming a different cause.
    const tree = await makeTree('typst-ats-classic', {
      metadata: { version: '9.9.8' },
      files: {
        'packages.lock': [
          'template.id          = typst-ats-classic',
          'template.version     = 9.9.8',
          'engine.typst.version       = 0.15.1',
          'engine.typst.asset.sha256  = a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c',
          'engine.typst.binary.sha256 = 29273eaa04f6d00edd0c2bec578f565fc9c65be856bfbffc894567c68ed0b237',
          'engine.typst.license       = Apache-2.0',
          'thirdPartyPackages.count = 0',
          'packages.count = 0',
          'font.license              = OFL-1.1',
          'font.faces.0.file         = SourceSerif4-Regular.ttf',
          'font.faces.0.sha256       = e5a4ee6a3d87bb9024796be390c6771e2a0eb1883dae25effaf57ca01668e24b',
        ].join('\n'),
      },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('TEMPLATE_LOCKFILE_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// Acceptance: a requested section the template does not support, and a column
// mismatch, both fail with a machine-readable reason
// ---------------------------------------------------------------------------

describe('acceptance: a mismatch is a rejection, never a silent degrade', () => {
  it('a section the template does not support fails with RENDER_TEMPLATE_SECTION_UNKNOWN', async () => {
    // A template that supports everything except projects, built by narrowing the
    // declared list. The template SOURCE still has a projects branch, so this is exactly
    // the dishonest declaration the gate exists to catch.
    const supported = RESUME_DICT_SECTIONS.filter((section) => section !== 'projects');
    const tree = await makeTree('typst-ats-classic', {
      metadata: { supportedSections: [...supported], requiredDictKeys: ['contact', 'summary'] },
    });
    const registry = await loadTemplateRegistry({ root: tree.templatesRoot });
    const rejection = rejectionOf(() =>
      resolveTemplateForRender(registry, { format: 'pdf', sections: ['projects'] }),
    );
    expect(rejection.code).toBe('RENDER_TEMPLATE_SECTION_UNKNOWN');
    expect(rejection.reason).toBe('SECTION_NOT_SUPPORTED');
    // The supported ones still resolve: the rejection is about the one that does not.
    expect(resolveTemplateForRender(registry, { format: 'pdf', sections: ['contact', 'skills'] }).id).toBe(
      'typst-ats-classic',
    );
  });

  it('a section OUTSIDE the dictionary vocabulary fails with RENDER_TEMPLATE_SECTION_UNKNOWN', async () => {
    const registry = await loadTemplateRegistry();
    for (const section of ['languages', 'awards', 'interests', 'publications', 'references', 'volunteer']) {
      const rejection = rejectionOf(() => resolveTemplateForRender(registry, { format: 'pdf', sections: [section] }));
      expect(rejection.code).toBe('RENDER_TEMPLATE_SECTION_UNKNOWN');
      expect(rejection.reason).toBe('SECTION_UNKNOWN');
    }
  });

  it('a template that DECLARES a section outside the vocabulary is rejected at load', async () => {
    // The registry never claims a section the canonical model cannot emit.
    for (const section of ['languages', 'awards', 'volunteer']) {
      const tree = await makeTree('typst-ats-classic', {
        metadata: { supportedSections: [...RESUME_DICT_SECTIONS, section] },
      });
      const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
      expect(rejection.code).toBe('RENDER_TEMPLATE_SECTION_UNKNOWN');
      expect(rejection.reason).toBe('SECTION_UNKNOWN');
      expect(rejection.message).not.toContain(section);
    }
  });

  it('a requiredDictKey outside supportedSections is RENDER_TEMPLATE_SECTION_UNKNOWN', async () => {
    const tree = await makeTree('typst-ats-classic', {
      metadata: { supportedSections: ['contact', 'summary'], requiredDictKeys: ['contact', 'skills'] },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_SECTION_UNKNOWN');
    expect(rejection.reason).toBe('REQUIRED_KEY_NOT_SUPPORTED');
  });

  it('columns=2 against a ONE-column template fails, and does not render in one column silently', async () => {
    const registry = await loadTemplateRegistry();
    const rejection = rejectionOf(() =>
      resolveTemplateForRender(registry, { format: 'pdf', columns: 2 }),
    );
    expect(rejection.code).toBe('RENDER_TEMPLATE_CAPABILITY_MISMATCH');
    expect(rejection.reason).toBe('COLUMNS_NOT_SUPPORTED');
    // The right column count for the same template resolves.
    expect(resolveTemplateForRender(registry, { format: 'pdf', columns: 1 }).id).toBe('typst-ats-classic');
    // And the two-column template accepts two.
    expect(
      resolveTemplateForRender(registry, { templateId: 'typst-compact-two-col', format: 'pdf', columns: 2 }).id,
    ).toBe('typst-compact-two-col');
  });

  it('columns=1 against the TWO-column template fails too: the rule is exact match', async () => {
    const registry = await loadTemplateRegistry();
    const rejection = rejectionOf(() =>
      resolveTemplateForRender(registry, { templateId: 'typst-compact-two-col', format: 'pdf', columns: 1 }),
    );
    expect(rejection.code).toBe('RENDER_TEMPLATE_CAPABILITY_MISMATCH');
    expect(rejection.reason).toBe('COLUMNS_NOT_SUPPORTED');
  });
});

// ---------------------------------------------------------------------------
// Acceptance: an engineVersionPins mismatch is RENDER_TOOLCHAIN_MISMATCH
// ---------------------------------------------------------------------------

describe('acceptance: a toolchain pin mismatch is RENDER_TOOLCHAIN_MISMATCH', () => {
  it('a metadata engineVersionPins that is not the pinned engine is refused', async () => {
    const tree = await makeTree('typst-ats-classic', { metadata: { engineVersionPins: { typst: '0.16.0' } } });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TOOLCHAIN_MISMATCH');
    expect(rejection.reason).toBe('ENGINE_PIN_MISMATCH');
    // The pin value is not in the message, and the module is not degraded onto another
    // engine: the load fails.
    expect(rejection.message).not.toContain('0.16.0');
  });

  it('an ABSENT pin for the declared engine is the same refusal', async () => {
    // The schema allows `{}` because the ENGINE decides which pin is mandatory (a Typst
    // template carries `typst`, a LaTeX template carries `latex`). The gate is therefore
    // what names the missing pin, with the same code as a wrong one.
    const tree = await makeTree('typst-ats-classic', {
      metadata: { engineVersionPins: {} },
      replace: ['engineVersionPins'],
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TOOLCHAIN_MISMATCH');
    expect(rejection.reason).toBe('ENGINE_PIN_MISMATCH');
  });

  it("a template lockfile that pins a different engine is refused even when metadata does not", async () => {
    const tree = await makeTree('typst-ats-classic', {
      files: {
        'packages.lock': (await readFile(path.join(REAL_TEMPLATES_ROOT, 'typst-ats-classic', 'packages.lock'), 'utf8'))
          .replace('engine.typst.version       = 0.15.1', 'engine.typst.version       = 0.14.2'),
      },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TOOLCHAIN_MISMATCH');
    expect(rejection.reason).toBe('ENGINE_PIN_MISMATCH');
    expect(rejection.message).not.toContain('0.14.2');
  });

  it('the pin compared against is the one sandbox.ts carries', async () => {
    expect(TYPST_PIN.version).toBe('0.15.1');
    const registry = await loadTemplateRegistry();
    expect(registry.lock.engine.version).toBe(TYPST_PIN.version);
    for (const record of registry.templates.filter((entry) => entry.metadata.engine === 'typst')) {
      expect(record.metadata.engineVersionPins.typst).toBe(registry.lock.engine.version);
    }
  });
});

// ---------------------------------------------------------------------------
// Acceptance: metadata.json with an unknown key, a wrong type, or a disagreeing version
// ---------------------------------------------------------------------------

describe('acceptance: a malformed metadata.json is a rejection, not a strip', () => {
  it('an UNKNOWN key is RENDER_TEMPLATE_SCHEMA, not a silently stripped key', async () => {
    const tree = await makeTree('typst-ats-classic', { metadata: { previewPng: 'preview.png' } });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('METADATA_SCHEMA');
    // Zod's default is to strip, which is why this test exists: if someone drops
    // `.strict()`, this fixture would load and the capability nobody reviewed would ship.
    expect(rejection.message).not.toContain('previewPng');
  });

  it(
    'a WRONG TYPE is RENDER_TEMPLATE_SCHEMA',
    async () => {
      // Each entry is `[patch, keysToReplace]`. A key listed in the second element has its
      // value written VERBATIM instead of deep-merged, because the interesting wrong-type
      // fixtures are PARTIAL objects (`atsProfile` with one key missing) and a merge would
      // silently complete them into a valid document.
      const cases: Array<[Record<string, unknown>, readonly string[]]> = [
        [{ columns: '2' }, []],
        [{ columns: 3 }, []],
        [{ maxPages: '2' }, []],
        [{ maxPages: 0 }, []],
        [{ pageSize: 'legal' }, []],
        [{ version: 'v1' }, []],
        [{ version: 1 }, []],
        [{ engine: 'xelatex' }, []],
        [{ supportedSections: 'contact' }, []],
        [{ supportedSections: [1] }, []],
        [{ supportedSections: [''] }, []],
        // An empty requiredDictKeys is a rejection: a template that requires nothing has
        // not declared what it reads (policy 8.1 scopes its reads to the listed keys).
        [{ requiredDictKeys: [] }, []],
        [{ fonts: [{ family: 'X' }] }, []],
        [{ fonts: [{ family: 'X', files: [], licence: 'OFL-1.1' }] }, []],
        [{ packages: [{ spec: '@a/b:1.0.0' }] }, []],
        [{ atsProfile: { singleColumn: true } }, ['atsProfile']],
        [{ atsProfile: { singleColumn: 'yes', tablesAllowed: false, iconFonts: false } }, ['atsProfile']],
        [{ atsProfile: { singleColumn: true, tablesAllowed: false, iconFonts: false, extra: 1 } }, ['atsProfile']],
        [{ thumbnail: 'preview.png' }, []],
        [{ engineVersionPins: { typst: '' } }, ['engineVersionPins']],
        // The schema now accepts `typst` and/or `latex`, so the wrong-type case is an
        // UNKNOWN key inside the pin object (still rejected by `.strict()`), not the
        // two-known-keys object this matrix used before the engine was added.
        [{ engineVersionPins: { typst: '0.15.1', unexpected: 'x' } }, ['engineVersionPins']],
        [{ name: '' }, []],
        [{ category: '' }, []],
        [{ attribution: '' }, []],
      ];
      for (const [patch, replace] of cases) {
        const tree = await makeTree('typst-ats-classic', { metadata: patch, replace });
        const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
        // The patch is named so a failure says WHICH case regressed.
        expect(rejection.reason, `for patch: ${JSON.stringify(patch)}`).toBe('METADATA_SCHEMA');
        expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
      }
    },
    // A 23-case fixture matrix: 23 throwaway trees, 23 registry loads, all of it fs work
    // on Windows. The fixture itself is now ~3.8x cheaper per tree (see `pristineTemplate`),
    // which takes this test from "over the 5s default under a loaded suite" to ~1.0s in
    // isolation - but a 23-case fs matrix is the heaviest thing in this file by
    // construction, and it runs in parallel with 136 other files, so it gets a budget of
    // its own rather than the 5s default. This is a BELT over the fixture fix, not the
    // fix: mutation evidence in the round-3 note puts the old fixture shape back over 5s
    // under the same load, and a regression that pushes this past 30s is a real one.
    30_000,
  );

  it('metadata that is not JSON at all is RENDER_TEMPLATE_SCHEMA / METADATA_NOT_JSON', async () => {
    const tree = await makeTree('typst-ats-classic', { files: { 'metadata.json': '{ not json' } });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('METADATA_NOT_JSON');
  });

  it('a `version` that disagrees with the template dir\'s RECORDED version is refused', async () => {
    // The recorded version is the template's own packages.lock, so a template edited
    // without a version bump fails the registry rather than serving a stale artifact
    // from the determinism cache (policy 10.4). `9.9.9` is a disagreement with any
    // shipped version, which is the point: the fixture must not go stale when a
    // template is bumped.
    const tree = await makeTree('typst-ats-classic', { metadata: { version: '9.9.9' } });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('TEMPLATE_VERSION_MISMATCH');
    expect(rejection.message).not.toContain('9.9.9');
  });

  it('a caller-supplied template version that disagrees is refused, and agreement resolves', async () => {
    const registry = await loadTemplateRegistry();
    // The agreement half reads the SHIPPED version rather than restating a literal, so it
    // cannot rot when a template is bumped (a template source edit must bump its version,
    // and this test is what proves the two halves still agree after the bump).
    const shipped = registry.get(RENDER_DEFAULT_TEMPLATE_ID).version;
    expect(resolveTemplateForRender(registry, { format: 'pdf', templateVersion: shipped }).id).toBe(
      RENDER_DEFAULT_TEMPLATE_ID,
    );
    const rejection = rejectionOf(() =>
      resolveTemplateForRender(registry, { format: 'pdf', templateVersion: '0.9.0' }),
    );
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('TEMPLATE_VERSION_MISMATCH');
    expect(rejection.message).not.toContain('0.9.0');
  });
});

// ---------------------------------------------------------------------------
// The rest of the gate: identity, files, ids, imports, capability
// ---------------------------------------------------------------------------

describe('the rest of the gate', () => {
  it('a metadata id that is not the directory id is refused', async () => {
    const tree = await makeTree('typst-ats-classic', { metadata: { id: 'typst-other' } });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('TEMPLATE_ID_MISMATCH');
  });

  it('an illegal template directory id is refused', async () => {
    const tree = await makeTree('typst-ats-classic');
    await cp(tree.dir, path.join(tree.typstRoot, 'templates', 'Not A Legal Id'), { recursive: true });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('TEMPLATE_ID_INVALID');
    expect(TEMPLATE_ID_PATTERN.test('typst-ats-classic')).toBe(true);
    expect(TEMPLATE_ID_PATTERN.test('Not A Legal Id')).toBe(false);
  });

  it('a RESERVED id can never be a real template, and never resolves', async () => {
    // `none` is how a `.tex`/`.json` export row says "no template", so a real template
    // named `none` would make those two meanings indistinguishable (ruling 4).
    expect([...TEMPLATE_RESERVED_IDS]).toEqual(['none']);
    const tree = await makeTree('typst-ats-classic');
    await cp(tree.dir, path.join(tree.typstRoot, 'templates', 'none'), { recursive: true });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('TEMPLATE_ID_RESERVED');

    // And asking for it resolves to nothing, never to the default template.
    const registry = await loadTemplateRegistry();
    const resolveRejection = rejectionOf(() =>
      resolveTemplateForRender(registry, { templateId: 'none', format: 'pdf' }),
    );
    expect(resolveRejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(resolveRejection.reason).toBe('TEMPLATE_ID_RESERVED');
  });

  it('each of the four required files is load-bearing', async () => {
    for (const name of TEMPLATE_REQUIRED_FILES) {
      const tree = await makeTree('typst-ats-classic');
      await rm(path.join(tree.dir, name), { force: true });
      const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
      expect(rejection.code).toBe('RENDER_TEMPLATE_FILE_MISSING');
      expect(rejection.reason).toBe('TEMPLATE_FILE_MISSING');
      expect(rejection.message).not.toContain(name);
    }
  });

  it('a SYMLINKED required file is refused, not read through', async () => {
    // `stat` FOLLOWS a symlink, so `metadata.json -> ../../somewhere/valid.json` passes
    // `isFile()` and the registry would validate a file that lives outside the reviewed
    // template directory - and git stores symlinks, so that is a PR-shaped hole rather
    // than a theoretical one. The gate uses `lstat` and refuses before reading anything.
    //
    // A FILE symlink needs Developer Mode (or elevation) on Windows and is refused with
    // EPERM without it, which is a red suite on a contributor's machine and on CI. So the
    // strongest form is used where the platform can build it, and where it cannot, the
    // test still asserts the true weaker half with a directory JUNCTION rather than
    // skipping into a silent no-op - and says which direction that leaves uncovered.
    const canLinkFiles = await hostCreatesFileSymlinks();
    for (const name of TEMPLATE_REQUIRED_FILES) {
      const tree = await makeTree('typst-ats-classic');
      const target = path.join(tree.dir, name);
      // A byte-identical, VALID file parked outside the template directory. If the gate
      // read through the link, this tree would LOAD and the assertion below would fail.
      const elsewhere = path.join(tree.typstRoot, 'not-a-template', name);
      await mkdir(path.dirname(elsewhere), { recursive: true });
      await copyFile(target, elsewhere);
      await rm(target);
      if (canLinkFiles) {
        await symlinkAny(elsewhere, target);
      } else {
        // A junction is the one link Windows always allows, and `lstat` reports it as
        // `isSymbolicLink() === true` - so the guard is still exercised against a LINK at
        // the required-file path. What this host cannot show is the discriminating case:
        // `stat` following a link to a REGULAR file, because the platform forbids building
        // one here. The pre-fix gate is caught by mutation evidence on a host that can.
        await symlinkAny(path.dirname(elsewhere), target, true);
      }
      // The path really is a link, so this test cannot pass by the link never being made.
      expect((await lstat(target)).isSymbolicLink(), `${name} must be a link for this test to mean anything`).toBe(
        true,
      );

      const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
      expect(rejection.code, `a symlinked ${name} must be refused`).toBe('RENDER_TEMPLATE_FILE_MISSING');
      expect(rejection.reason, `a symlinked ${name} must be refused`).toBe('TEMPLATE_FILE_MISSING');
      // No caller data: neither the name nor the tree leaks into the message.
      expect(rejection.message).not.toContain(name);
      expect(rejection.message).not.toContain(tree.typstRoot);
    }
  });

  it('a required file that is a DIRECTORY is refused as surely as a symlink is', async () => {
    // The other half of "not a regular file": the gate is `isFile()`, so a directory named
    // `LICENSE` cannot satisfy it either.
    const tree = await makeTree('typst-ats-classic');
    const target = path.join(tree.dir, 'LICENSE');
    await rm(target, { force: true });
    await mkdir(target);
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_FILE_MISSING');
    expect(rejection.reason).toBe('TEMPLATE_FILE_MISSING');
  });

  it('a missing templates ROOT is RENDER_TEMPLATE_FILE_MISSING, not an fs error', async () => {
    const rejection = await rejectionOfAsync(() =>
      loadTemplateRegistry({ root: path.join(tmpdir(), 'clearance-no-such-templates-4b1e') }),
    );
    expect(rejection.code).toBe('RENDER_TEMPLATE_FILE_MISSING');
    expect(rejection.reason).toBe('TEMPLATE_ROOT_MISSING');
  });

  it('a missing shared lockfile is RENDER_TEMPLATE_FILE_MISSING', async () => {
    const tree = await makeTree('typst-ats-classic');
    await rm(path.join(tree.typstRoot, 'packages.lock'), { force: true });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_FILE_MISSING');
    expect(rejection.reason).toBe('TEMPLATE_FILE_MISSING');
  });

  it('an UNDECLARED import in template.typ is RENDER_TEMPLATE_IMPORT_UNDECLARED', async () => {
    const tree = await makeTree('typst-ats-classic', {
      files: { 'template.typ': '#import "@preview/cetz:0.3.1": *\n#let data = json("data.json")\n' },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_IMPORT_UNDECLARED');
    expect(rejection.reason).toBe('IMPORT_UNDECLARED');
    // Neither the spec nor the namespace reaches the message.
    expect(rejection.message).not.toContain('cetz');
    expect(rejection.message).not.toContain('preview');
  });

  it('a DECLARED import that is not vendored is still refused, on the vendored set not the source', async () => {
    const tree = await makeTree('typst-ats-classic', {
      files: { 'template.typ': '#import "@preview/cetz:0.3.1": *\n' },
      metadata: { packages: [{ spec: '@preview/cetz:0.3.1', licence: 'LGPL-3.0-or-later' }] },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_PACKAGE_UNRECORDED');
    expect(rejection.reason).toBe('PACKAGE_NOT_RECORDED');
  });

  it('a declared import of a VENDORED package passes the import gate (declared-vs-used, both directions)', async () => {
    const tree = await makeTree('typst-ats-classic', {
      files: { 'template.typ': '#import "@clearance/spike-probe:1.0.0": *\n' },
      metadata: { packages: [{ spec: '@clearance/spike-probe:1.0.0', licence: 'Apache-2.0' }] },
    });
    // The template's own lockfile still declares zero packages, so the two halves
    // disagree - which is the check that stops a template adding a dependency in one file.
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_PACKAGE_UNRECORDED');
    expect(rejection.reason).toBe('PACKAGE_NOT_RECORDED');
  });

  it('a URL inside a STRING is still caught: the comment stripper is string-aware', async () => {
    // A regex-only stripper removes the `//` inside the string, truncating it to
    // `"https:` and letting the URL through. That is a one-character edit to any
    // reviewed template, so the stripper tracks string literals.
    const tree = await makeTree('typst-ats-classic', {
      files: { 'template.typ': '#let x = "https://example.org/a"\n' },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_CAPABILITY_MISMATCH');
    expect(rejection.reason).toBe('SOURCE_NETWORK_FORBIDDEN');
  });

  it('a denied surface named inside a COMMENT is prose, not a hit', async () => {
    // The other direction, and the reason the stripper exists at all: the three shipped
    // templates DOCUMENT every denied surface in their headers, in prose.
    const source = [
      '// This template must never call eval() or read() a file.',
      '/* A block comment mentioning eval( too. */',
      '#let data = json("data.json")',
    ].join('\n');
    const tree = await makeTree('typst-ats-classic', { files: { 'template.typ': source } });
    const registry = await loadTemplateRegistry({ root: tree.templatesRoot });
    expect(registry.templates).toHaveLength(1);
  });

  it('packageImportsIn finds the specs in source and ignores comments', () => {
    expect(packageImportsIn('#import "@preview/a:1.0.0": *\n#import "@b/c:2.3.4": *\n')).toEqual([
      '@b/c:2.3.4',
      '@preview/a:1.0.0',
    ]);
    // A comment is prose, not an import, and a mention without a version is not a spec.
    expect(packageImportsIn('// would have been @preview/gone:1.0.0\n#let x = "@not/an/import"')).toEqual([]);
  });

  it('the denied source surfaces are each refused with their own reason', async () => {
    const cases: Array<[string, string]> = [
      ['#let x = eval("1+1")', 'SOURCE_EVAL_FORBIDDEN'],
      ['#let x = read("other.typ")', 'SOURCE_FILE_READ_FORBIDDEN'],
      ['#let x = "plugin.wasm"', 'SOURCE_WASM_FORBIDDEN'],
      ['#let x = "https://example.org/a"', 'SOURCE_NETWORK_FORBIDDEN'],
      ['#let f() = { try { 1 } catch { 2 } }', 'SOURCE_TRY_FORBIDDEN'],
      ['#import "sibling.typ": *', 'SOURCE_RELATIVE_IMPORT_FORBIDDEN'],
    ];
    for (const [source, reason] of cases) {
      const tree = await makeTree('typst-ats-classic', { files: { 'template.typ': source } });
      const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
      // The source is named in the assertion so a failure says WHICH surface regressed.
      expect(rejection.reason, `for source: ${source}`).toBe(reason);
      expect(rejection.code).toBe('RENDER_TEMPLATE_CAPABILITY_MISMATCH');
    }
  });

  it('an atsProfile that contradicts the template geometry is refused', async () => {
    const tree = await makeTree('typst-ats-classic', {
      metadata: { atsProfile: { singleColumn: false, tablesAllowed: false, iconFonts: false } },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_CAPABILITY_MISMATCH');
    expect(rejection.reason).toBe('ATS_PROFILE_MISMATCH');
  });

  it('a template claiming an icon font is refused: none is vendored (policy 8.2 B13)', async () => {
    const tree = await makeTree('typst-ats-classic', {
      metadata: { atsProfile: { singleColumn: true, tablesAllowed: false, iconFonts: true } },
    });
    const rejection = await rejectionOfAsync(() => loadTemplateRegistry({ root: tree.templatesRoot }));
    expect(rejection.code).toBe('RENDER_TEMPLATE_CAPABILITY_MISMATCH');
    expect(rejection.reason).toBe('ICON_FONTS_NOT_VENDORED');
  });

  it('an unknown template id is refused, and does NOT fall back to the default', async () => {
    const registry = await loadTemplateRegistry();
    const rejection = rejectionOf(() =>
      resolveTemplateForRender(registry, { templateId: 'typst-does-not-exist', format: 'pdf' }),
    );
    expect(rejection.code).toBe('RENDER_TEMPLATE_SCHEMA');
    expect(rejection.reason).toBe('TEMPLATE_ID_UNKNOWN');
    expect(rejection.message).not.toContain('typst-does-not-exist');
  });

  it('an unknown format is refused', async () => {
    const registry = await loadTemplateRegistry();
    for (const format of ['docx', 'typ', 'html', '']) {
      const rejection = rejectionOf(() => resolveTemplateForRender(registry, { format }));
      expect(rejection.code).toBe('RENDER_TEMPLATE_CAPABILITY_MISMATCH');
      expect(rejection.reason).toBe('FORMAT_NOT_SUPPORTED');
    }
  });

  it('a malformed request is refused rather than throwing a raw TypeError', async () => {
    const registry = await loadTemplateRegistry();
    expect(rejectionOf(() => resolveTemplateForRender(registry, null as never)).reason).toBe('REQUEST_INVALID');
    expect(rejectionOf(() => resolveTemplateForRender(registry, {} as never)).reason).toBe('FORMAT_NOT_SUPPORTED');
    expect(
      rejectionOf(() => resolveTemplateForRender(registry, { format: 'pdf', columns: 1.5 })).reason,
    ).toBe('REQUEST_INVALID');
    expect(
      rejectionOf(() => resolveTemplateForRender(registry, { format: 'pdf', templateId: 7 as never })).reason,
    ).toBe('REQUEST_INVALID');
  });

  it('get() refuses an unknown id, and the registry is otherwise a plain frozen read', async () => {
    const registry = await loadTemplateRegistry();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.templates)).toBe(true);
    expect(registry.get('typst-modern-cards').id).toBe('typst-modern-cards');
    expect(rejectionOf(() => registry.get('nope')).reason).toBe('TEMPLATE_ID_UNKNOWN');
    expect(rejectionOf(() => registry.get(null as never)).reason).toBe('REQUEST_INVALID');
  });

  it('a template record is frozen, so a caller cannot rewrite what was validated', async () => {
    const registry = await loadTemplateRegistry();
    const record = registry.templates[0];
    expect(record).toBeDefined();
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record?.metadata)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The vocabularies are closed and every reason has a fixed message
// ---------------------------------------------------------------------------

describe('the vocabularies are closed and every reason has a fixed message', () => {
  it('the code set is exactly the eight the plan names', () => {
    expect([...TEMPLATE_REJECTION_CODES]).toEqual([
      'RENDER_TEMPLATE_SCHEMA',
      'RENDER_TOOLCHAIN_MISMATCH',
      'RENDER_TEMPLATE_SECTION_UNKNOWN',
      'RENDER_TEMPLATE_LICENCE_MISSING',
      'RENDER_TEMPLATE_PACKAGE_UNRECORDED',
      'RENDER_TEMPLATE_FILE_MISSING',
      'RENDER_TEMPLATE_IMPORT_UNDECLARED',
      'RENDER_TEMPLATE_CAPABILITY_MISMATCH',
    ]);
  });

  it('every reason has a distinct fixed message with no caller data in it', () => {
    const texts = new Set<string>();
    for (const code of TEMPLATE_REJECTION_CODES) {
      for (const reason of TEMPLATE_REJECTION_REASONS) {
        const err = new TemplateRejectionError(code, reason);
        expect(err.reason).toBe(reason);
        expect(err.name).toBe('TemplateRejectionError');
        expect(err.message.startsWith(`${code}: `)).toBe(true);
        texts.add(err.message);
        // No host path, no template id, no value, no canary (policy 9.3/9.4).
        expect(err.message).not.toContain('C:\\');
        expect(err.message).not.toContain('typst-');
        expect(err.message).not.toContain('CLEARANCE_CANARY');
      }
    }
    expect(texts.size).toBe(TEMPLATE_REJECTION_CODES.length * TEMPLATE_REJECTION_REASONS.length);
  });

  it('the default root is derived from the module location, so it is right compiled and from source', () => {
    expect(defaultTemplatesRoot()).toBe(path.resolve(REAL_TEMPLATES_ROOT));
  });
});
