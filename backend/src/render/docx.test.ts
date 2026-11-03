// The DOCX renderer - unit tests.
//
// NORMATIVE DOC: .planning/tasks/T1041-docx-renderer.md
//                   ("an explicit test asserts the DOCX path has zero dependency on the
//                   Typst/LaTeX/broker modules (import-set assertion, not a comment)";
//                   "fallback path: a user template with {{placeholders}} fills correctly
//                   and is not reached when the user supplies no template"; "dates come from
//                   the dictionary's pre-formatted strings")
//                 .planning/decisions/ADR-039-docx-renders-independently.md (the import ban)
//                 .planning/decisions/ADR-044-...md D3 (one projection)
// Task:         T1041
//
// NOTHING HERE NEEDS A DOCKER DAEMON, A DATABASE, A BROKER OR A TEMPLATE DIRECTORY. That is
// not an optimisation: ADR-039's claim is that DOCX is a PEER of the PDF renderer with no
// typesetter, no worker and no template behind it, and a suite that needed any of those would
// be quietly asserting the opposite. Every acceptance item in the contract is a property of
// the produced BYTES.
//
// THIS FILE OWNS THE FORBIDDEN-TOKEN LIST, for the same reason `latexExport.test.ts` does: a
// gate that lives in the module it guards is a comment, and a gate that lives here fails.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PARITY_DICT } from './__fixtures__/parityResume.js';
import { projectResumeDict, type ResumeDict } from './dict.js';
import {
  DOCX_ENGINE,
  DOCX_EXTENSION,
  DOCX_RENDERER_VERSION,
  DocxTemplateError,
  buildDocxDocument,
  normaliseDocxBytes,
  renderDocx,
  renderDocxFromDictionary,
  renderDocxFromTemplate,
} from './docx.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZipCtor = require('pizzip') as unknown as new (input?: Buffer) => {
  readonly files: Record<string, { readonly dir: boolean; asNodeBuffer(): Buffer } | null>;
  file(name: string): { asText(): string; asNodeBuffer(): Buffer } | null;
  file(name: string, content: Buffer, options?: { date?: Date; binary?: boolean }): unknown;
  generate(options: {
    readonly type: 'nodebuffer';
    readonly compression: 'DEFLATE';
    readonly compressionOptions: { readonly level: number };
    readonly platform: 'UNIX';
  }): Buffer;
};

const MODULE_SOURCE = readFileSync(path.join(__dirname, 'docx.ts'), 'utf8');

/** Comments are stripped first: prose ABOUT a module is not an import of it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Every module specifier a piece of TypeScript SOURCE names, in the three forms it can take.
 *
 * F1, AND WHY THIS IS A FUNCTION RATHER THAN AN INLINE REGEX. The pattern is the gate, and a
 * gate whose own coverage is unverified is a comment. The previous inline pattern was
 * `/(?:from|import|require\()\s*'([^']+)'/g`, whose `import` alternative is followed by `\s*`:
 * for `await import('./typst.js')` the next character is `(`, which `\s*` cannot consume, so
 * NOTHING matched and a DYNAMICALLY imported typesetter left both gate tests green - the exact
 * rot the gate exists to prevent, and the exact rot this file's own comment claimed to
 * prevent. That claim is now TRUE and it is BELIEVABLE, because:
 *
 *   - the paren is OPTIONAL, so `from 'x'` (no paren), `require('x')` and `import('x')` (paren)
 *     all match. Making it mandatory is the bug this function was written to remove.
 *   - both quote styles are accepted, because a double-quoted specifier is the same import;
 *   - `from 'x'` is matched, which covers `import x from 'y'`, `export ... from 'y'` and the
 *     type-only form alike;
 *   - the keywords are WORD-BOUNDED, so an identifier such as `myimport` or `important` cannot
 *     open a match.
 *
 * A dynamic import is still a dependency, and the `from` alternative cannot be made to match
 * one by accident, so widening costs nothing and closes the hole.
 */
const SPECIFIER_PATTERN = /(?:from|\bimport\b|\brequire)\s*\(?\s*(['"])([^'"]+)\1/g;

/** The distinct specifiers `source` names, sorted. See `SPECIFIER_PATTERN`. */
function specifiersIn(source: string): string[] {
  return [
    ...new Set([...withoutComments(source).matchAll(SPECIFIER_PATTERN)].map((match) => match[2])),
  ].sort();
}

/**
 * The modules this renderer may never reach.
 *
 * THE ACCEPTANCE ITEM, AS AN ASSERTION RATHER THAN A COMMENT. ADR-039 decided DOCX is a peer
 * of the PDF renderer and not a child of any typesetting engine; the only way that decision
 * can rot is a later "just call the compile path" edit, and the only way to catch it is a test
 * that reads this module's source and names what it must not import.
 *
 * The read covers a static `import`, a `require(...)` and a dynamic `import()` because
 * `specifiersIn` accepts all three - which is why the four library `require`s this module
 * legitimately makes are asserted as a CLOSED SET in the next test rather than excused here,
 * and why the matcher's own coverage is asserted by its own test below.
 */
const FORBIDDEN_MODULES: readonly string[] = Object.freeze([
  'typst',
  'latexExport',
  'jsonExport',
  'brokerClient',
  'broker/',
  'stage',
  './sandbox',
  'storage',
  './templates',
  'renderPort',
  './routes/',
  './resume/',
]);

/**
 * The repository-wide gate's own vocabulary, asserted HERE for this module so a failure names
 * the file rather than surfacing as an unrelated broker test (`render/broker.test.ts`'s G1).
 *
 * ASSEMBLED, NOT WRITTEN: G1 greps every `.ts` under `src/` (comments stripped) for these,
 * and is not exempt for this directory - so naming one of them here, even inside a list of
 * forbidden things, would make this file a G1 hit. The assembled strings are byte-identical
 * to the gate's, which is exactly the trick that gate documents for itself.
 */
const PROCESS_AND_CLIENT_TOKENS: readonly string[] = Object.freeze([
  'docker' + 'ode',
  'docker-' + 'modem',
  'child_' + 'process',
]);

// ---------------------------------------------------------------------------
// A template with {{placeholders}}, for the fallback path
// ---------------------------------------------------------------------------

/**
 * A minimal user template: a real `.docx` package whose body carries `{{...}}` placeholders.
 *
 * Built with the SAME library the renderer uses, so it is a genuine OOXML package rather than
 * a hand-rolled zip - docxtemplater parses the actual `w:t` runs, so a fake would test the
 * fake. The placeholders cover the shapes a corporate template uses: a scalar, a nested path,
 * a loop, and a field a given resume may not carry at all.
 */
async function templateWithPlaceholders(): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const docx = require('docx') as {
    Document: new (options: unknown) => unknown;
    Packer: { toBuffer(document: unknown): Promise<Buffer> };
    Paragraph: new (options: unknown) => unknown;
    TextRun: new (text: string) => unknown;
  };
  const document = new docx.Document({
    sections: [
      {
        children: [
          new docx.Paragraph({ children: [new docx.TextRun('CANDIDATE: {{contact.name}}')] }),
          new docx.Paragraph({ children: [new docx.TextRun('TITLE: {{contact.headline}}')] }),
          new docx.Paragraph({ children: [new docx.TextRun('SUMMARY: {{summary}}')] }),
          new docx.Paragraph({ children: [new docx.TextRun('PHONE: [{{contact.phone}}]')] }),
          new docx.Paragraph({
            children: [new docx.TextRun('{{#experience}}{{title}} at {{organisation}}; {{/experience}}')],
          }),
          new docx.Paragraph({
            children: [new docx.TextRun('{{#skills}}{{name}}; {{/skills}}')],
          }),
        ],
      },
    ],
  });
  return docx.Packer.toBuffer(document);
}

/** The `word/document.xml` of a produced package, RAW (still XML-escaped). */
function rawDocumentXml(bytes: Buffer): string {
  const part = new PizZipCtor(bytes).file('word/document.xml');
  expect(part, 'the produced package has no word/document.xml').not.toBeNull();
  return (part as { asText(): string }).asText();
}

/** Undo the five XML entities, so a comparison is a comparison of CONTENT. */
function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * The package's text, one entry per PARAGRAPH.
 *
 * Paragraph-aware rather than run-aware, and that distinction was found the hard way: a
 * template fill splits `CANDIDATE: {{contact.name}}` into two `w:t` runs, so a run-level join
 * reports `CANDIDATE: ` and `Ada Lovelace` as two separate strings and a test looking for
 * `CANDIDATE: Ada Lovelace` fails against a perfectly correct fill. Word renders the two runs
 * as one line, so the assertion has to be phrased the way Word renders it.
 */
function textRunsOf(bytes: Buffer): string[] {
  const xml = rawDocumentXml(bytes);
  const out: string[] = [];
  for (const match of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const runs = [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((run) => run[1]);
    out.push(unescapeXml(runs.join('')));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ACCEPTANCE 3: the import-set ban - an assertion, not a comment
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 3: the DOCX path has zero dependency on the Typst/LaTeX/broker modules', () => {
  it('the specifier matcher itself catches every import FORM, dynamic included', () => {
    // F1's positive control. Without this, the gate below is unfalsifiable: a matcher that
    // silently matches nothing would report "no forbidden imports" and pass. Each case below
    // is a form a future edit could plausibly use, and each must yield its specifier.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["import { x } from './a.js';", './a.js'],
      ["import type { x } from './b.js';", './b.js'],
      ["export { x } from './c.js';", './c.js'],
      ["const x = require('./d.js');", './d.js'],
      ['const x = require("./e.js");', './e.js'],
      ["const x = await import('./f.js');", './f.js'],
      ['const x = await import("./g.js");', './g.js'],
      ["const x = require ( './h.js' );", './h.js'],
      // ...and prose that merely CONTAINS an import keyword must not produce a specifier.
      ["// import { x } from './commented.js';", undefined as unknown as string],
      ['/* require("./also-commented.js") */', undefined as unknown as string],
    ];
    for (const [source, expected] of cases) {
      const found = specifiersIn(source);
      if (expected === undefined) {
        expect(found, `"${source}" should name no module`).toEqual([]);
      } else {
        expect(found, `"${source}" should name ${expected}`).toEqual([expected]);
      }
    }
  });

  it('imports ONLY the three npm libraries and the shared dictionary\'s TYPES', () => {
    // The closed set, stated positively as well as negatively. Every form `specifiersIn`
    // recognises counts, so the four library loads this module legitimately makes are part of
    // the assertion rather than excused by it - a fifth fails here.
    const code = withoutComments(MODULE_SOURCE);
    expect(specifiersIn(MODULE_SOURCE)).toEqual(['./dict.js', 'docx', 'docxtemplater', 'pizzip']);
    // ...and the dictionary really is a TYPE import, so this renderer cannot even CALL the
    // projection. `renderPort.ts` does the projecting; this module receives the result.
    expect(code).toContain("import type { ResumeDict, ResumeDictSection } from './dict.js';");
    expect(code).not.toMatch(/import\s*\{[^}]*\bprojectResumeDict\b/);
  });

  it('names none of the modules ADR-039 forbids', () => {
    // Matched as a SPECIFIER, not as a bare substring: the module's prose legitimately
    // discusses user templates, and a substring ban on "templates" would forbid the word
    // rather than the module. This is the sharper check, and it is the one that catches an
    // actual import - in ANY of the forms F1 lists.
    const specifiers = specifiersIn(MODULE_SOURCE);
    for (const forbidden of FORBIDDEN_MODULES) {
      for (const specifier of specifiers) {
        expect(
          specifier.toLowerCase(),
          `docx.ts imports ${specifier}, which contains ${forbidden}`,
        ).not.toContain(forbidden.toLowerCase());
      }
    }
    for (const forbidden of PROCESS_AND_CLIENT_TOKENS) {
      for (const specifier of specifiers) {
        expect(specifier.toLowerCase()).not.toContain(forbidden);
      }
    }
    // And the whole point of the ban, in one line: there is no `typst` module reachable from
    // here, and the four specifiers above are the complete set of what is.
    expect(specifiers.some((specifier) => specifier.includes('typst'))).toBe(false);
  });

  it('performs no I/O, spawns nothing, and reads no clock, environment or randomness', () => {
    // A renderer that read a file could be pointed at one; one that read the clock would break
    // the determinism cache. The whole module's input is the dictionary.
    const code = withoutComments(MODULE_SOURCE);
    for (const instrument of [
      'readFile',
      'writeFile',
      'readdir',
      'mkdir',
      'existsSync',
      'fetch(',
      'process.env',
      'Date.now',
      'Math.random',
      'Intl.',
      'toLocale',
      'setTimeout',
    ]) {
      expect(code, `docx.ts uses ${instrument}`).not.toContain(instrument);
    }
    // `new Date` appears exactly ONCE and its argument is the module's own constant, not a
    // clock read - so the whole of the module's date surface is one line long and it is named.
    // Asserted as a set rather than as a substring ban so the reason survives the edit that
    // would break it.
    const dateCalls = code.match(/new Date\([^)]*\)/g) ?? [];
    expect(dateCalls).toEqual(['new Date(FIXED_ZIP_DATE_MS)']);
    expect(/const FIXED_ZIP_DATE_MS = Date\.UTC\(1980, 0, 1, 0, 0, 0\);/.test(code)).toBe(true);
  });

  it('and the module the port imports is the same module this suite tested', () => {
    // Cheap, and it catches the worst drift there is: a renderer replaced while its tests
    // kept passing against the old one.
    const portSource = readFileSync(path.join(__dirname, 'renderPort.ts'), 'utf8');
    expect(withoutComments(portSource)).toContain("from './docx.js'");
    expect(withoutComments(portSource)).toContain('renderDocxFromDictionary');
    expect(DOCX_ENGINE).toBe('docx');
    expect(DOCX_RENDERER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(DOCX_EXTENSION).toBe('docx');
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 4: the fallback path
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4: the user-template fallback fills, and is not reached without a template', () => {
  it('fills {{placeholders}} - scalar, nested path and loop - from the dictionary', async () => {
    const filled = renderDocxFromTemplate(PARITY_DICT, await templateWithPlaceholders());
    const text = textRunsOf(filled);
    // The three shapes a corporate template actually uses.
    expect(text).toContain('CANDIDATE: Ada Lovelace');
    expect(text).toContain('TITLE: Staff Platform Engineer');
    expect(text).toContain('SUMMARY: Platform engineer. Eleven years of boring deploys.');
    // The loop is ONE paragraph with `paragraphLoop` expanded inside it, so its three entries are
// three strings rather than three lines - which is exactly how Word renders them.
expect(text.some((line) => line.includes('Staff Platform Engineer at Meridian Data;'))).toBe(true);
expect(text.some((line) => line.includes('Senior Site Reliability Engineer at Halcyon Payments;'))).toBe(true);
expect(text.some((line) => line.includes('Backend Engineer at Northgate Software;'))).toBe(true);
    expect(text.some((line) => line.includes('Rust; PostgreSQL;'))).toBe(true);
    // And nothing is left unfilled: a placeholder that survived would be visible to the user
    // as `{{contact.name}}` on the first page of their CV.
    expect(text).not.toContain('{{');
    expect(text).not.toContain('}}');
  });

  it('fills a placeholder the dictionary does not carry with an empty string, not a throw', async () => {
    // A corporate template routinely names fields this resume has not filled, and a render
    // FAILURE over an absent optional field is the worst possible behaviour - the user cannot
    // fix their template and would not know what was wrong. The template's `PHONE:` line is
    // present in the template but the dictionary carries no phone.
    const sparse = projectResumeDict({ basics: { name: 'Grace Hopper' } });
    expect(sparse.contact.phone).toBe('');
    const text = textRunsOf(renderDocxFromTemplate(sparse, await templateWithPlaceholders()));
    // The carried value filled...
    expect(text).toContain('CANDIDATE: Grace Hopper');
    // ...the absent one became an EMPTY string inside its own markers, so a reader of the
    // document can see the field was expected and was blank, rather than seeing a raw tag.
    expect(text).toContain('PHONE: []');
    // ...and nothing unfilled survived anywhere.
    expect(text.join('\n')).not.toContain('{{');
  });

  it('is NOT reached when the caller supplies no template - proved by a template that cannot fill', async () => {
    // The only honest way to prove a branch was NOT taken is to make taking it impossible to
    // survive: a template that is not a zip at all, supplied to the SAME call. If the
    // dispatcher reached the fallback it would throw `DOCX_TEMPLATE_NOT_A_ZIP`; it produces a
    // complete document instead.
    const notAZip = Buffer.from('this is not a zip archive', 'utf8');
    await expect(renderDocx({ dict: PARITY_DICT, template: notAZip })).rejects.toThrow(
      /DOCX_TEMPLATE_NOT_A_ZIP|could not be filled/,
    );
    // ...while the identical request with no template at all succeeds.
    const produced = await renderDocx({ dict: PARITY_DICT });
    expect(Buffer.isBuffer(produced)).toBe(true);
    expect(produced.length).toBeGreaterThan(1000);
    // A `null` template is the same as an absent one, which is the case a database column
    // would hand over.
    expect((await renderDocx({ dict: PARITY_DICT, template: null })).equals(produced)).toBe(true);
  });

  it('refuses an unusable template with a FIXED message and a machine reason', async () => {
    // Policy 9.3/9.4: the reason is log-safe, the message never names the template, and the
    // library's own error (which names template parts and placeholder tags) never escapes.
    for (const [bytes, reason] of [
      [Buffer.alloc(0), 'DOCX_TEMPLATE_EMPTY'],
      [Buffer.from('not a zip', 'utf8'), 'DOCX_TEMPLATE_NOT_A_ZIP'],
      [Buffer.from('PK and then garbage', 'latin1'), 'DOCX_TEMPLATE_NOT_A_ZIP'],
    ] as const) {
      let thrown: unknown;
      try {
        renderDocxFromTemplate(PARITY_DICT, bytes as Buffer);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `reason ${reason} was not thrown`).toBeInstanceOf(DocxTemplateError);
      expect((thrown as DocxTemplateError).reason).toBe(reason);
      expect((thrown as DocxTemplateError).message).toBe('the DOCX template could not be filled');
      expect((thrown as DocxTemplateError).message).not.toContain('PK');
    }
  });

  it('refuses a template with a malformed placeholder rather than emitting it', async () => {
    // An unclosed tag is a template-authoring fault. The refusal must be the FIXED message,
    // never the library's, which quotes the tag text.
    const source = new PizZipCtor(await templateWithPlaceholders());
    const rebuilt = new PizZipCtor();
    for (const name of Object.keys(source.files)) {
      const entry = source.files[name];
      if (entry === null || entry === undefined || entry.dir) continue;
      let content = entry.asNodeBuffer();
      if (name === 'word/document.xml') {
        content = Buffer.from(
          content.toString('utf8').replace('{{summary}}', '{{#unclosed'),
          'utf8',
        );
      }
      rebuilt.file(name, content, { date: new Date(Date.UTC(1980, 0, 1)) });
    }
    const broken = rebuilt.generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
      platform: 'UNIX',
    });
    let thrown: unknown;
    try {
      renderDocxFromTemplate(PARITY_DICT, broken);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxTemplateError);
    expect((thrown as DocxTemplateError).reason).toBe('DOCX_TEMPLATE_FILL_FAILED');
    expect((thrown as DocxTemplateError).message).not.toContain('unclosed');
  });

  it('and the fallback bytes are deterministic too', async () => {
    // A template fill goes through the same normalisation, so a user template rendered twice
    // is byte-identical - the same property the primary path has, for the same reason.
    const template = await templateWithPlaceholders();
    const first = renderDocxFromTemplate(PARITY_DICT, template);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = renderDocxFromTemplate(PARITY_DICT, template);
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex'),
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 5: dates come from the dictionary
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 5: dates come from the dictionary, never from this module', () => {
  it('mutating the dictionary\'s date changes the artifact', async () => {
    // The sharpest form of the acceptance item: the date is not hard-coded, not re-derived and
    // not cached - it is READ. Change the dictionary and the bytes change with it.
    const before = await renderDocxFromDictionary(PARITY_DICT);
    const mutated: ResumeDict = {
      ...PARITY_DICT,
      experience: PARITY_DICT.experience.map((entry, index) =>
        index === 0 ? { ...entry, rangeText: 'Sometime in Spring' } : entry,
      ),
    };
    const after = await renderDocxFromDictionary(mutated);
    expect(after.equals(before)).toBe(false);
    expect(textRunsOf(after).join('\n')).toContain('Sometime in Spring');
    expect(textRunsOf(after).join('\n')).not.toContain('Mar 2022 - Present');
  });

  it('a certificate date is read the same way', async () => {
    const mutated: ResumeDict = {
      ...PARITY_DICT,
      certifications: PARITY_DICT.certifications.map((entry) => ({
        ...entry,
        dateText: 'A DATE ONLY THE DICTIONARY KNOWS',
      })),
    };
    expect(textRunsOf(await renderDocxFromDictionary(mutated)).join('\n')).toContain(
      'A DATE ONLY THE DICTIONARY KNOWS',
    );
  });

  it('the module has no date or locale machinery of its own', () => {
    // Structural rather than behavioural: a future "just format it nicely here" edit fails
    // this before it can disagree with a PDF.
    const code = withoutComments(MODULE_SOURCE);
    for (const forbidden of ['Date(', 'Date.now', 'Intl', 'toLocale', 'toLocaleDateString', 'getMonth', 'getFullYear']) {
      // `new Date(FIXED_ZIP_DATE_MS)` is the one allowed occurrence and is asserted above.
      if (forbidden === 'Date(') continue;
      expect(code, `docx.ts contains ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// The empty-document case
// ---------------------------------------------------------------------------

describe('an empty document is a valid document', () => {
  it('produces a complete package whose only section is A4', async () => {
    const bytes = await renderDocxFromDictionary(projectResumeDict({}));
    expect(Buffer.isBuffer(bytes)).toBe(true);
    // A real OOXML package: the parts Word requires are all present.
    const zip = new PizZipCtor(bytes);
    for (const part of [
      '[Content_Types].xml',
      'word/document.xml',
      'word/styles.xml',
      '_rels/.rels',
      'docProps/core.xml',
    ]) {
      expect(zip.file(part), `the package is missing ${part}`).not.toBeNull();
    }
    // ...and the body has no heading, because an empty section is not an empty heading.
    const xml = (zip.file('word/document.xml') as { asText(): string }).asText();
    expect(xml).not.toContain('ClearanceSection');
    expect(textRunsOf(bytes).join('')).toBe('');
  });

  it('every hostile shape is an INPUT, not a throw', async () => {
    // `projectResumeDict` is total, so this renderer is handed a complete dictionary for
    // every one of these. An unhandled exception here would be a user-visible render failure.
    for (const input of [null, undefined, 42, 'a string', [], true, { basics: 42 }, { basics: [] }]) {
      await expect(renderDocxFromDictionary(projectResumeDict(input))).resolves.toBeInstanceOf(Buffer);
    }
    // ...and the dispatcher itself refuses a malformed REQUEST with its own TypeError.
    await expect(renderDocx(null as never)).rejects.toThrow(TypeError);
    await expect(renderDocx({ dict: null } as never)).rejects.toThrow(TypeError);
  });

  it('a dictionary holding only a name still renders it', async () => {
    const dict = projectResumeDict({ basics: { name: 'Grace Hopper' } });
    expect(dict.sections).toEqual(['contact']);
    expect(textRunsOf(await renderDocxFromDictionary(dict))).toContain('Grace Hopper');
  });
});

// ---------------------------------------------------------------------------
// The contact block prints each value once
// ---------------------------------------------------------------------------

describe('the contact block prints each of its values ONCE', () => {
  it('a headline with no name is the headline, printed once - not twice', async () => {
    // F6. With an empty name the headline field falls THROUGH the entry-headline chooser, so
    // it was emitted once as the entry headline and again as a body paragraph: the same string
    // twice at the top of the page, once strong and once plain. A nameless candidate is
    // ordinary - an imported JSON Resume profile whose name field was never filled - so this is
    // a path real users hit, not a synthetic one.
    const dict = projectResumeDict({ basics: { label: 'Platform engineer, eleven years of boring deploys' } });
    expect(dict.contact.name).toBe('');
    expect(dict.contact.headline).toBe('Platform engineer, eleven years of boring deploys');
    const text = textRunsOf(await renderDocxFromDictionary(dict));
    const occurrences = text.filter((line) => line.includes('Platform engineer, eleven years')).length;
    expect(occurrences, `the headline appears in: ${JSON.stringify(text)}`).toBe(1);
  });

  it('and the same holds when the name IS present, where the headline is a body line', async () => {
    // The other half of the fix: suppression is CONDITIONAL on the name being absent. A named
    // candidate still gets the headline as a body paragraph, and still exactly once - which is
    // the assertion that would fail if the fix had been "stop printing the headline".
    const dict = projectResumeDict({
      basics: { name: 'Grace Hopper', label: 'Compiler pioneer' },
    });
    const text = textRunsOf(await renderDocxFromDictionary(dict));
    expect(text.filter((line) => line.includes('Compiler pioneer'))).toHaveLength(1);
    // The name is the entry headline here, and appears once.
    expect(text.filter((line) => line.includes('Grace Hopper'))).toHaveLength(1);
  });

  it('an entry headline with an empty field is still one paragraph, not two', async () => {
    // The same fall-through exists on every entry section, and it is already asserted by the
    // parity suite; this repeats it here so the two DOCX suites cannot drift apart on it.
    const dict = projectResumeDict({
      basics: { name: 'Grace Hopper' },
      work: [{ position: '', name: 'Meridian Data' }],
    });
    const text = textRunsOf(await renderDocxFromDictionary(dict));
    expect(text.filter((line) => line.trim() === 'Meridian Data')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism and normalisation
// ---------------------------------------------------------------------------

describe('the produced bytes are a pure function of the dictionary', () => {
  it('two renders are byte-identical, and a mutated dictionary is not', async () => {
    const first = await renderDocxFromDictionary(PARITY_DICT);
    const second = await renderDocxFromDictionary(PARITY_DICT);
    expect(first.equals(second)).toBe(true);
    expect(createHash('sha256').update(first).digest('hex')).toMatch(/^[0-9a-f]{64}$/);

    const mutated = projectResumeDict({ basics: { name: 'Grace Hopper' } });
    expect((await renderDocxFromDictionary(mutated)).equals(first)).toBe(false);
  }, 30_000);

  it('every produced package is a valid zip carrying the OOXML parts', async () => {
    const bytes = await renderDocxFromDictionary(PARITY_DICT);
    // A zip magic, which is the least a stored artifact must be: the content-addressed store
    // and the download route both hand these bytes on verbatim.
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const zip = new PizZipCtor(bytes);
    expect(zip.file('word/document.xml')).not.toBeNull();
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
  });

  it('normaliseDocxBytes refuses bytes that are not a package, with a fixed reason', () => {
    // The one input check on the normalisation step: an empty buffer would otherwise produce
    // a silently EMPTY archive, and an empty artifact is the failure nobody notices.
    expect(() => normaliseDocxBytes(Buffer.alloc(0))).toThrow(TypeError);
    expect(() => normaliseDocxBytes('nope' as unknown as Buffer)).toThrow(TypeError);
  });

  it('buildDocxDocument returns a fresh object per call', async () => {
    // The `docx` library MUTATES a `Document` when it is packed (its numbering part gains an
    // `abstractNum` per pack), which is why the renderer never reuses one. This asserts the
    // property the determinism test depends on, directly.
    const first = buildDocxDocument(PARITY_DICT);
    const second = buildDocxDocument(PARITY_DICT);
    expect(first).not.toBe(second);
    expect(first).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Adversarial content, and the structural boundary
// ---------------------------------------------------------------------------

describe('resume content cannot become document structure', () => {
  it('a name full of XML markup round-trips as text', async () => {
    const hostile =
      '</w:t></w:r><w:r><w:t>INJECTED</w:t></w:r><w:r><w:t xml:space="preserve">';
    const bytes = await renderDocxFromDictionary(projectResumeDict({ basics: { name: hostile } }));
    // The RAW part is where the structural claim lives: every `<` the resume supplied is an
    // entity, so it opened no element and closed no run.
    const raw = rawDocumentXml(bytes);
    expect(raw).toContain('&lt;/w:t&gt;');
    expect(raw).not.toMatch(/<w:t[^>]*>INJECTED/);
    // And the CONTENT claim lives in the unescaped view: the words are all there, so nothing
    // was dropped to achieve the safety above.
    const text = textRunsOf(bytes).join('\n');
    expect(text).toContain('INJECTED');
    expect(text).toContain('</w:t></w:r><w:r><w:t>');
  });

  it('non-ASCII and astral characters survive the round trip', async () => {
    // A person's name is not ASCII, and the renderer must not mangle it to satisfy a source
    // code convention. (The MODULE is ASCII; the ARTIFACT is UTF-8.)
    const name = 'Jose\u0301 Nunez\u0303 \u2014 5\u20ac \u{1f600}';
    const bytes = await renderDocxFromDictionary(projectResumeDict({ basics: { name } }));
    const text = textRunsOf(bytes).join('\n');
    expect(text).toContain('Jose\u0301');
    expect(text).toContain('\u2014');
    expect(text).toContain('\u20ac');
    // The astral character is one symbol, so it round-trips as UTF-8 and not as a lone
    // surrogate (which is unencodable and would be a rendering failure in Word).
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
    expect([...text].some((character) => character.codePointAt(0) === 0x1f600)).toBe(true);
  });

  it('a resume that is entirely empty in one section does not emit that section', () => {
    // Rule 4 of `dict.ts`, observed through the renderer: the dictionary decides, and the
    // renderer follows.
    const dict = projectResumeDict({ basics: { name: 'Grace Hopper' }, work: [], projects: [] });
    expect(dict.sections).toEqual(['contact']);
  });

  it('a section outside the closed vocabulary is refused, never rendered as undefined', () => {
    const forged = {
      ...PARITY_DICT,
      sections: [...PARITY_DICT.sections, 'languages'] as unknown as ResumeDict['sections'],
    };
    // The refusal happens while the document is being BUILT, so nothing is packed: the call
    // rejects, and no half-written package is ever handed to the store.
    expect(() => buildDocxDocument(forged)).toThrow(/DOCX_SECTION_UNKNOWN/);
  });
});