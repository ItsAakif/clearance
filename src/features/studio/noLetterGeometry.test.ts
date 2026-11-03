// No Letter geometry anywhere in the new tree (T1050).
//
// The acceptance item names the grep, so this file IS the grep - and it is a test rather than a
// one-off command because a grep someone remembers to run is a grep that stops being run.
// `.planning/tasks/T1050-resume-studio-ui.md`: "no Letter geometry exists anywhere in the new
// tree (grep for 11in/8.5in/Letter)".
//
// WHY IT MATHS. A page size in the frontend is a second layout authority. The A4 layout truth
// belongs to the typesetter (`render-sandbox-policy.md` sec. 5, `Resume.pageSize` default `a4`),
// and the frozen V1 builder is the thing that hard-codes US Letter
// (`resume-builder/templates/DocumentEditor.tsx:98-99`). A number typed into this tree would be
// the first step back toward "the browser decides the page".
//
// THE PATTERNS, and what each one is for. The page size may now be NAMED as either of the
// registry's two values (`a4` or `letter`), so its name is NOT a pattern - a word is not
// geometry. `11in`/`8.5in` (with or without a space) and the quoted forms catch the two
// dimensions; `792`/`612` are the point values Letter is defined at (11 x 72, 8.5 x 72), which
// is how a dimension sneaks in as a "font size". A bare `in` is NOT a pattern - it is an
// English word, and a pattern that fires on prose is a pattern that gets disabled.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..', '..');
const STUDIO_TREE = path.join(REPO, 'src', 'features', 'studio');
const STUDIO_SOURCES = [
  path.join(REPO, 'src', 'pages', 'Studio.tsx'),
  path.join(REPO, 'src', 'services', 'api', 'studio.ts'),
];

const PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: '11in', pattern: /\b11\s*in\b/i },
  { name: '8.5in', pattern: /\b8\.5\s*in\b/i },
  { name: '11 inches quoted', pattern: /11\s*("|inch)/i },
  { name: '8.5 inches quoted', pattern: /8\.5\s*("|inch)/i },
  { name: 'the Letter height in points', pattern: /\b792\b/ },
  { name: 'the Letter width in points', pattern: /\b612\b/ },
];

function newTreeFiles(): Array<{ name: string; source: string }> {
  const files = readdirSync(STUDIO_TREE)
    // This file is excluded, and ONLY this file: it has to spell the patterns out to grep for
    // them, so including it would make the grep always fail on its own source.
    .filter((name) => /\.(ts|tsx|css)$/.test(name) && !name.endsWith('.test.ts'))
    .map((name) => ({
      name: `src/features/studio/${name}`,
      source: readFileSync(path.join(STUDIO_TREE, name), 'utf8'),
    }));
  for (const file of STUDIO_SOURCES) {
    files.push({
      name: path.relative(REPO, file).split(path.sep).join('/'),
      source: readFileSync(file, 'utf8'),
    });
  }
  return files;
}

describe('no Letter geometry exists anywhere in the Studio tree', () => {
  const files = newTreeFiles();

  it('the tree is not empty - a grep over nothing passes for the wrong reason', () => {
    assert.ok(files.length >= 8, `expected the whole Studio tree, found ${files.length} files`);
    const names = files.map((file) => file.name);
    for (const required of [
      'src/features/studio/PagePreview.tsx',
      'src/features/studio/TemplateSwitch.tsx',
      'src/features/studio/blockModel.ts',
      'src/pages/Studio.tsx',
    ]) {
      assert.ok(names.includes(required), `${required} is missing from the scan`);
    }
  });

  it('finds zero hits for every Letter pattern, in every file', () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const { name, pattern } of PATTERNS) {
        if (pattern.test(file.source)) hits.push(`${file.name}: ${name}`);
      }
    }
    // One assertion listing every hit, so a failure names the file and the pattern.
    assert.deepEqual(hits, []);
  });

  it('the page size is named as a WORD, never as a dimension', () => {
    // The page geometry the Studio speaks of is the word "A4" or "Letter", which it READS
    // from the registry rather than measuring: `pageSizeLabel` in
    // `features/studio/templates.ts`.
    const source = readFileSync(path.join(STUDIO_TREE, 'templates.ts'), 'utf8');
    assert.match(source, /pageSizeLabel/);
    assert.match(source, /'a4' \? 'A4'/);
    assert.match(source, /'letter' \? 'Letter'/);
    // Every template in the mirror declares one of the registry's two NAMES, and
    // `templateSwitch.test.ts` cross-checks that against each registry `metadata.json`.
    assert.equal(/pageSize:\s*'(?!a4'|letter')/.test(source), false);
  });

  it('the preview has no page dimensions of its own, because it embeds the artifact', () => {
    const source = readFileSync(path.join(STUDIO_TREE, 'PagePreview.tsx'), 'utf8');
    // A height in `vh` sizes the VIEWPORT the PDF is shown in; it is not a page dimension,
    // and it is the only sizing the preview needs.
    assert.equal(/style=\{\{[^}]*\b(width|height)\s*:/.test(source), false);
    assert.equal(/@page|size:\s*A4|page-break/.test(source), false);
  });
});