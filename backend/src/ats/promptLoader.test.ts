// ats/promptLoader.test.ts - the prompt loader AND the prompt assets shipping with the build.
//
// WHY THE SECOND HALF OF THIS FILE EXISTS. `promptLoader.ts` resolves a prompt as
// `join(__dirname, 'prompts', name)`, and `__dirname` is not one place:
//
//   - run from source (`tsx watch src/index.ts`, and every test) -> `backend/src/ats`
//   - compiled and run (`node dist/index.js`, which is what the Docker image's CMD is)
//     -> `backend/dist/ats`
//
// So the prompts must be present at `backend/dist/ats/prompts/*.jinja` for the packaged
// backend to load ANY of them. `tsc` copies no non-TypeScript file into `dist/`, and it
// does not know a `.jinja` is loadable code - so the built output carried zero prompts.
// Every AI stage (`jd_requirements_v1`, `match_contextual_v1`, `tailor_ops_v1`,
// `evaluation_criteria`, `evaluation_system`) then failed at runtime with `ENOENT` in
// production while passing in dev, where the source tree happens to be present. That is
// the worst possible shape for a missing asset: a test suite is green and the deployed
// image is broken.
//
// So the tests below assert the resolved file exists in BOTH layouts, and that the
// build step which creates the second layout is wired into `npm run build` (which is
// what `backend/Dockerfile` runs, so the image needs no separate `COPY`).
//
// NOT A PATH CHANGE. `promptLoader.ts` is unchanged: `join(__dirname, 'prompts')` is
// already the right resolution for both layouts, and the fix is to make the built layout
// match it rather than to teach the loader a second location.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadAndRender, renderTemplate } from './promptLoader.js';

/**
 * `backend/src/ats` - the SOURCE layout. Derived from this file's own location, so it is
 * correct whether the suite runs from source or from a compiled `dist`.
 */
const SOURCE_PROMPTS_DIR = path.join(__dirname, 'prompts');

/**
 * `backend/dist/ats/prompts` - the BUILT layout, i.e. what `node dist/index.js` reads.
 *
 * `__dirname` is `backend/src/ats` here, so `..`, `..` is `backend` and the built tree
 * hangs off it. This is the exact directory `loadAndRender` resolves against once the
 * process is running compiled code, so a file missing here is a file the packaged
 * backend cannot load.
 */
const BUILT_PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'dist', 'ats', 'prompts');

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');
const COPY_SCRIPT = path.join(BACKEND_ROOT, 'scripts', 'copy-assets.js');

/**
 * The copy step's own module, loaded IN-PROCESS.
 *
 * NOT by spawning `node scripts/copy-assets.js`: `broker.test.ts`'s repo-wide grep gate (G1)
 * forbids `child_process` anywhere under `src/` outside `render/broker`, and that gate is
 * right - a build step does not belong in a unit test's import graph. The script therefore
 * exports `copyAssets` and only self-executes when it IS the entry point, so calling it
 * here exercises the real copy with the real file list.
 */
const copyAssets = createRequire(__filename)(COPY_SCRIPT) as {
  copyAssets: (distRoot: string, log?: boolean) => { count: number; written: string[] };
  copyAssetDir: (relativeDir: string, distRoot: string) => string[];
  ASSET_DIRS: readonly string[];
};

/** Every prompt file name in a prompts directory, `.jinja` suffixed, sorted. */
function promptNamesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jinja'))
    .map((entry) => entry.name)
    .sort();
}

/** How the loader resolves a name, reimplemented here so the pin is on the PATH. */
function resolvedSourcePath(name: string): string {
  return path.join(SOURCE_PROMPTS_DIR, name.endsWith('.jinja') ? name : `${name}.jinja`);
}

describe('renderTemplate', () => {
  it('substitutes {{ var }}, tolerating the spaced form, and blanks what it does not know', () => {
    expect(renderTemplate('a {{x}} b {{ y }} c', { x: '1', y: '2' })).toBe('a 1 b 2 c');
    // An unknown variable is blanked rather than throwing: optional context must not be
    // able to fail a prompt.
    expect(renderTemplate('{{ missing }}kept', {})).toBe('kept');
    // `null` is blanked too; `0` and `''` are real values and are rendered.
    expect(renderTemplate('{{ a }}{{ b }}{{ c }}', { a: 0 as never, b: null as never, c: '' as never })).toBe('0');
  });
});

describe('the prompt assets resolve in the SOURCE layout', () => {
  it('every prompt on disk is loadable, and loads the file this test points at', () => {
    const names = promptNamesIn(SOURCE_PROMPTS_DIR);
    // The V2 set plus the two older ATS templates. Named explicitly because "the
    // directory is non-empty" would still pass with one template left in it.
    expect(names).toEqual([
      // T1021: the Career Interview prompts. `career_interview_v1` is the SYSTEM message -
      // the stage's framing, carrying no answer content - and `claim_extract_v1` is the USER
      // message that holds the answers as data and names the output shape.
      'career_interview_v1.jinja',
      'claim_extract_v1.jinja',
      'evaluation_criteria.jinja',
      'evaluation_system.jinja',
      // T1090: the interview-prep prompts. The risk brief may only SHARPEN a risk the server
      // derived; the question prompt may only ANSWER a question the server derived, under the
      // entity post-check. Neither can create either.
      'interview_question_v1.jinja',
      'interview_risk_v1.jinja',
      'jd_requirements_v1.jinja',
      'match_contextual_v1.jinja',
      // T1100: the project-candidate prompt. It may PROPOSE a candidate for a gap the server
      // already selected, and the server's feasibility screen and anti-copy guard judge it
      // exactly as they judge a deterministically derived one - so a proposal cannot widen the
      // envelope, invent a gap, or reimplement a reference.
      'project_candidate_v1.jinja',
      'tailor_ops_v1.jinja',
    ]);
    for (const name of names) {
      const resolved = resolvedSourcePath(name);
      expect(existsSync(resolved), `prompt file missing at ${resolved}`).toBe(true);
      // Byte-identical to the file at the path this test derived, which is what pins the
      // loader's own resolution: a loader pointed somewhere else returns something else.
      expect(loadAndRender(name)).toBe(renderTemplate(readFileSync(resolved, 'utf-8'), {}));
    }
  });

  it('a name with no suffix resolves to the same file', () => {
    expect(loadAndRender('jd_requirements_v1')).toBe(loadAndRender('jd_requirements_v1.jinja'));
  });

  it('the V2 prompts render their substitutions rather than leaving the placeholders', () => {
    const rendered = loadAndRender('jd_requirements_v1.jinja', { job_description: 'THE_JD' });
    expect(rendered).toContain('THE_JD');
    expect(rendered).not.toContain('{{ job_description }}');
  });
});

describe('the prompt assets ship with the BUILD', () => {
  it('npm run build runs the asset copy, so the packaged backend is covered too', () => {
    // `backend/Dockerfile` runs `npm run build` and starts `node dist/index.js`. If the
    // copy step is not in that script, the image has no prompts no matter what any test
    // says - so the wiring itself is a pin, and it is what makes "drop the prompt copy"
    // fail deterministically whether or not a `dist/` happens to be lying around.
    const pkg = JSON.parse(readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const build = pkg.scripts?.build ?? '';
    expect(build).toContain('scripts/copy-assets.js');
    // `tsc` alone is the defect; the copy must be part of the same command, not a step
    // somebody has to remember.
    expect(build).toMatch(/tsc/);
  });

  it('the copy step moves every source prompt into the dist layout, bytes intact', () => {
    // Run for real, into a throwaway directory, so this asserts the SCRIPT's behaviour
    // rather than the contents of whatever `npm run build` last left behind. `log: false`
    // keeps five lines of build output out of the test run; the script's own argument is
    // `copyAssets(distRoot)` and `npm run build` uses exactly that.
    const out = mkdtempSync(path.join(tmpdir(), 'clearance-prompts-'));
    try {
      const result = copyAssets.copyAssets(out, false);
      expect(result.count).toBe(promptNamesIn(SOURCE_PROMPTS_DIR).length);
      // Every destination is the `src/` -> `dist/` mapping of its source, relative to the
      // root the caller asked for. That relative path IS the contract `join(__dirname,
      // 'prompts')` depends on, so an off-by-one directory here is a packaged backend that
      // cannot load a single prompt.
      expect(result.written).toEqual(
        promptNamesIn(SOURCE_PROMPTS_DIR).map((name) => `ats/prompts/${name}`),
      );
      const copied = promptNamesIn(path.join(out, 'ats', 'prompts'));
      expect(copied).toEqual(promptNamesIn(SOURCE_PROMPTS_DIR));
      for (const name of copied) {
        expect(readFileSync(path.join(out, 'ats', 'prompts', name), 'utf-8')).toBe(
          readFileSync(resolvedSourcePath(name), 'utf-8'),
        );
      }
      // And the copy landed INSIDE the requested root: the script honours its argument
      // rather than writing to the real `dist/` as a side effect of being tested.
      expect(existsSync(path.join(out, 'ats', 'prompts'))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('the copy step REFUSES rather than silently shipping nothing', () => {
    // A silent zero-file copy is exactly how this defect comes back: a build that
    // "succeeds" while the image has no prompts. A missing source asset directory throws.
    const out = mkdtempSync(path.join(tmpdir(), 'clearance-prompts-empty-'));
    try {
      expect(() => copyAssets.copyAssetDir('ats/there-is-no-such-dir', out)).toThrowError(
        /does not exist/,
      );
      // Nothing was created for it, so a partially-applied table cannot look like a success.
      expect(existsSync(path.join(out, 'ats', 'there-is-no-such-dir'))).toBe(false);
      // The real one still works after the failure - the throw is per-tree, not a poison.
      expect(copyAssets.copyAssetDir('ats/prompts', out)).toHaveLength(
        promptNamesIn(SOURCE_PROMPTS_DIR).length,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('the BUILT layout holds every prompt the source layout holds', () => {
    // The `dist/...` assertion the defect was about. It is skipped when `dist/` has never
    // been built - a fresh clone runs `npx vitest run` without a build, and failing there
    // would be a failure about the checkout, not about the code. When `dist/` DOES exist
    // (any local build, any built image unpacked on disk) the assertion is absolute, and
    // "drop the copy step and rebuild" fails here.
    if (!existsSync(path.join(BACKEND_ROOT, 'dist'))) {
      expect(
        existsSync(BUILT_PROMPTS_DIR),
        'backend/dist exists but backend/dist/ats/prompts does not: the build copied no prompts',
      ).toBe(true);
      return;
    }
    expect(existsSync(BUILT_PROMPTS_DIR), `missing ${BUILT_PROMPTS_DIR} after a build`).toBe(true);
    const built = promptNamesIn(BUILT_PROMPTS_DIR);
    expect(built).toEqual(promptNamesIn(SOURCE_PROMPTS_DIR));
    for (const name of built) {
      expect(readFileSync(path.join(BUILT_PROMPTS_DIR, name), 'utf-8')).toBe(
        readFileSync(resolvedSourcePath(name), 'utf-8'),
      );
    }
  });

  it('the asset table covers EVERY non-TypeScript file under src/', () => {
    // The `copy-assets.js` table is the second thing to keep in step with the tree (the
    // first is `promptLoader`'s `join(__dirname, 'prompts')`). This walks `src/` and fails
    // if a `.jinja` - or any other asset - now lives somewhere the table does not copy,
    // which is how the next one would go missing from the image the same way.
    expect(copyAssets.ASSET_DIRS).toContain('ats/prompts');
    const orphans: string[] = [];
    const walkSrc = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkSrc(full);
        else if (!/\.tsx?$/.test(entry.name) && !full.startsWith(SOURCE_PROMPTS_DIR)) {
          orphans.push(path.relative(path.join(BACKEND_ROOT, 'src'), full).split(path.sep).join('/'));
        }
      }
    };
    walkSrc(path.join(BACKEND_ROOT, 'src'));
    expect(orphans).toEqual([]);
  });
});