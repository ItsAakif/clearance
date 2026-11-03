/**
 * copy-assets.js - copy the RUNTIME ASSETS that `tsc` leaves behind into `dist/`.
 *
 * WHY THIS EXISTS. `ats/promptLoader.ts` resolves every AI prompt as
 * `join(__dirname, 'prompts', name)`. `__dirname` is `backend/src/ats` under `tsx` (dev)
 * and `backend/dist/ats` after `tsc` (the packaged backend, including the Docker image),
 * so the prompts have to be at `dist/ats/prompts/*.jinja` for the packaged process to
 * find them. `tsc` compiles `.ts` and NOTHING ELSE: it does not copy, it does not emit
 * assets, and it does not know that a `.jinja` file is loadable code. So the whole
 * prompt set - `jd_requirements_v1`, `match_contextual_v1`, `tailor_ops_v1` and the two
 * older `evaluation_*` templates - was absent from every built artifact, and the AI
 * stages passed in dev (where the source tree is present) and would have failed in
 * production with `ENOENT`.
 *
 * THIS IS THE STEP, NOT A NEW TOOLCHAIN. A `postbuild` npm hook or a `copyfiles`
 * dependency would do the same thing; a dependency is not added for it. Plain
 * `node:fs`, no arguments needed, wired into `package.json`'s `build` script so the
 * Docker image gets it too (`Dockerfile` runs `npm run build` and needs no change).
 *
 * `--dist <dir>` overrides the output root, which is how `src/ats/promptLoader.test.ts`
 * asserts the copy without depending on whatever `dist/` currently holds. It calls the
 * EXPORTED `copyAssets` in-process rather than shelling out, because `broker.test.ts`'s
 * repo-wide grep gate (G1) forbids `child_process` anywhere under `src/`.
 *
 * FAILS LOUDLY. A missing source asset directory, or a directory that yields no files,
 * is an error: silently copying nothing is exactly the defect this script was written to
 * remove, and a build that "succeeds" while shipping zero prompts is how it comes back.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(BACKEND_ROOT, 'src');
const DEFAULT_DIST_ROOT = path.join(BACKEND_ROOT, 'dist');

/**
 * The asset trees, relative to `src`. ONE list, so a new prompt directory is one line
 * here rather than a second copy rule somewhere else.
 *
 * `src/ats/prompts` is currently the ONLY non-TypeScript file under `src/` - it is listed
 * explicitly anyway, because "we will notice when a new one appears" is not a mechanism,
 * and `promptLoader.test.ts` asserts that this table covers every non-`.ts` file under
 * `src/`.
 */
const ASSET_DIRS = Object.freeze(['ats/prompts']);

/** `--dist <dir>`: read the destination root out of argv without a dependency. */
function distRootFrom(argv) {
  const index = argv.indexOf('--dist');
  if (index === -1) return DEFAULT_DIST_ROOT;
  const value = argv[index + 1];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('copy-assets: --dist needs a directory');
  }
  return path.resolve(process.cwd(), value);
}

/** Every file under `dir`, as paths relative to `dir`, sorted for a deterministic log. */
function filesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Copy ONE asset tree, relative to `src/`, into `distRoot`. Returns the relative paths it
 * wrote, relative to `distRoot`.
 *
 * THROWS rather than returning empty when the source directory is missing or holds no
 * files: silently copying nothing is exactly the defect this script was written to remove,
 * and a build that "succeeds" while shipping zero prompts is how it comes back.
 */
function copyAssetDir(relativeDir, distRoot) {
  const source = path.join(SRC_ROOT, relativeDir);
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    throw new Error(`copy-assets: asset directory src/${relativeDir} does not exist`);
  }
  const files = filesUnder(source);
  if (files.length === 0) {
    throw new Error(`copy-assets: asset directory src/${relativeDir} holds no files`);
  }
  // `path.join(distRoot, relativeDir)` keeps the `src/` -> `dist/` mapping one-to-one,
  // which is the whole contract `__dirname`-relative resolution depends on.
  const destination = path.join(distRoot, relativeDir);
  fs.mkdirSync(destination, { recursive: true });
  const written = [];
  for (const relativeFile of files) {
    const target = path.join(destination, relativeFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(source, relativeFile), target);
    written.push(`${relativeDir}/${relativeFile}`);
  }
  return written;
}

/**
 * Copy every asset tree into `distRoot`.
 *
 * EXPORTED, and self-execution deferred to `require.main`, so `promptLoader.test.ts` can
 * call this IN-PROCESS. A test that shelled out to `node scripts/copy-assets.js` would put
 * a `child_process` import inside `src/`, which fails `broker.test.ts`'s repo-wide grep
 * gate (G1: nothing outside `render/broker` may spawn a subprocess). Calling the function
 * directly proves the same behaviour and does not trip a gate that exists for a reason.
 */
function copyAssets(distRoot, log = true) {
  const written = [];
  for (const relativeDir of ASSET_DIRS) {
    for (const relativeFile of copyAssetDir(relativeDir, distRoot)) {
      if (log) {
        const shown = path.relative(BACKEND_ROOT, path.join(distRoot, relativeFile)).split(path.sep).join('/');
        process.stdout.write(`  ${relativeFile} -> ${shown}\n`);
      }
      written.push(relativeFile);
    }
  }
  return { count: written.length, written };
}

function main() {
  const distRoot = distRootFrom(process.argv.slice(2));
  process.stdout.write(`copy-assets: src -> ${distRoot}\n`);
  const { count } = copyAssets(distRoot);
  process.stdout.write(`copy-assets: ${count} asset file(s) copied\n`);
}

module.exports = { ASSET_DIRS, copyAssetDir, copyAssets, filesUnder };

// `require.main === module` rather than an unconditional call: importing this file to use
// `copyAssets` must not also copy into the real `dist/`.
if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`copy-assets: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}