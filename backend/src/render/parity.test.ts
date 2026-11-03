// The DOCX <-> DICTIONARY parity test - the Phase 4 (a) text-level property, asserted.
//
// NORMATIVE DOC: .planning/tasks/T1041-docx-renderer.md ("section order matches dict.sections
//                   and entry counts match the dictionary"; "text-level parity ... asserted
//                   against the shared parity fixture")
//                 .planning/decisions/ADR-039-docx-renders-independently.md ("a Phase 4
//                   acceptance test asserting text-level parity (section order, entry
//                   counts, bullet strings) across Typst, LaTeX and DOCX from ONE Resume
//                   JSON, and A4 asserted on both PDF and DOCX")
//                 .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 5, sec. 13
//                   ruling 15 (the ONE fixture)
// Task:         T1041
//
// =====================================================================================
// WHY THIS FILE EXISTED ALREADY, AND WHY IT READS THE XML
// =====================================================================================
//
// The property is "the DOCX says the same thing as the dictionary". Asserting that against the
// `docx` object graph would assert it against this module's own intermediate: it would pass
// even if the PACKER dropped a paragraph, dropped a bullet, or emitted the wrong page size. So
// every assertion here goes through the artifact: the `.docx` is unzipped and
// `word/document.xml` is parsed with the same small set of regular expressions a Word
// consumer would use to read it back.
//
// That is the whole point of writing an OOXML renderer rather than a text one. The bytes are
// the deliverable, and the bytes are what is checked.
//
// NOTHING HERE NEEDS A DOCKER DAEMON, A DATABASE OR A BROKER. The DOCX path is in-process by
// construction (ADR-039), which is what makes a parity suite cheap enough to run on every
// commit. The Typst PDF half of the cross-engine parity is T1045's live evidence; what this
// file proves is the half that is a property of THIS module's output.

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PARITY_DICT,
  PARITY_RESUME_JSON,
  PARITY_SECTION_HEADINGS,
} from './__fixtures__/parityResume.js';
import {
  RESUME_DICT_SECTIONS,
  projectResumeDict,
  type ResumeDict,
  type ResumeDictSection,
} from './dict.js';
import {
  DOCX_PAGE_HEIGHT_TWIPS,
  DOCX_PAGE_WIDTH_TWIPS,
  DOCX_STYLE_BODY,
  DOCX_STYLE_ENTRY,
  DOCX_STYLE_SECTION,
  renderDocxFromDictionary,
} from './docx.js';
import { escapeLatex, renderLatexExport } from './latexExport.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZipCtor = require('pizzip') as unknown as new (input?: Buffer) => {
  file(name: string): { asText(): string } | null;
};

// ---------------------------------------------------------------------------
// Reading a produced .docx back
// ---------------------------------------------------------------------------

/** The `word/document.xml` of a produced package. */
function documentXml(bytes: Buffer): string {
  const zip = new PizZipCtor(bytes);
  const part = zip.file('word/document.xml');
  expect(part, 'the package has no word/document.xml').not.toBeNull();
  return (part as { asText(): string }).asText();
}

/** The `word/styles.xml` of a produced package. */
function stylesXml(bytes: Buffer): string {
  const zip = new PizZipCtor(bytes);
  const part = zip.file('word/styles.xml');
  expect(part, 'the package has no word/styles.xml').not.toBeNull();
  return (part as { asText(): string }).asText();
}

/**
 * The document body, one entry per paragraph, as `{style, text}`.
 *
 * The split is on `<w:p>` boundaries and each paragraph's text is its `<w:t>` runs joined.
 * A `<w:t>` may be XML-escaped, and the dictionary's strings are NOT escaped when compared -
 * so `text` is unescaped here, which is what makes the comparison a comparison of CONTENT
 * rather than of encoding. Unescaping is deliberately minimal and total: the five XML
 * entities and the numeric forms, and nothing else.
 */
interface DocxParagraphView {
  readonly style: string;
  readonly text: string;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphsOf(xml: string): DocxParagraphView[] {
  const out: DocxParagraphView[] = [];
  const body = xml.slice(xml.indexOf('<w:body>'));
  for (const match of body.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const inner = match[1];
    const styleMatch = /<w:pStyle w:val="([^"]*)"\/>/.exec(inner);
    const runs = [...inner.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((run) => run[1]);
    out.push({ style: styleMatch === null ? '' : styleMatch[1], text: unescapeXml(runs.join('')) });
  }
  return out;
}

/**
 * The paragraphs that carry a real bullet (`w:numPr`), in document order.
 *
 * Counting the LIST MARKER rather than the text is what makes the bullet-string assertion
 * meaningful: a renderer that printed `First` as an ordinary paragraph would produce the same
 * visible words with no list at all, and this is the check that notices.
 */
function bulletTextsOf(xml: string): string[] {
  const out: string[] = [];
  const body = xml.slice(xml.indexOf('<w:body>'));
  for (const match of body.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    if (!match[1].includes('<w:numPr>')) continue;
    const runs = [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((run) => run[1]);
    out.push(unescapeXml(runs.join('')));
  }
  return out;
}

/** The `sectPr` of the produced document, or `''` when there is none. */
function sectionPropertiesOf(xml: string): string {
  const match = /<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>/.exec(xml);
  return match === null ? '' : match[0];
}

/**
 * The document split into per-section bodies, keyed by heading text.
 *
 * The heading paragraph is the boundary and belongs to no section, so a count taken over a
 * slice cannot be inflated by the heading that starts it.
 */
async function sectionBodiesOf(bytes: Buffer): Promise<Map<string, DocxParagraphView[]>> {
  const bodies = new Map<string, DocxParagraphView[]>();
  let current = '';
  for (const paragraph of paragraphsOf(documentXml(bytes))) {
    if (paragraph.style === DOCX_STYLE_SECTION) {
      current = paragraph.text;
      bodies.set(current, []);
      continue;
    }
    if (current !== '') bodies.get(current)?.push(paragraph);
  }
  return bodies;
}

const FULL = PARITY_DICT;
let cachedBytes: Buffer | null = null;

/** The artifact, packed once. Packing is the expensive part; every test reads the same bytes. */
async function fullDocx(): Promise<Buffer> {
  if (cachedBytes === null) cachedBytes = await renderDocxFromDictionary(FULL);
  return cachedBytes;
}

// ---------------------------------------------------------------------------
// The fixture itself
// ---------------------------------------------------------------------------

describe('the shared fixture is the document the other two suites project', () => {
  it('populates EVERY section, so a parity claim covers the whole vocabulary', () => {
    expect(FULL.sections).toEqual([...RESUME_DICT_SECTIONS]);
    expect(FULL.sections).toHaveLength(RESUME_DICT_SECTIONS.length);
  });

  it('is the SAME literal `dict.test.ts` and `latexExport.test.ts` carry, not a third copy', () => {
    // The point of ruling 15: three consumers must describe ONE document, or a parity test
    // passes by comparing two different resumes. This asserts the equivalence against the
    // other two suites' SOURCES, so a future edit that forked either of them fails here
    // instead of quietly making the parity claim about a different document.
    //
    // Compared as an ORDERED, PATH-QUALIFIED projection each document declares, not as text,
    // so comments, whitespace and trailing commas cannot fail the check while a real
    // divergence does. The path is what makes ORDER visible (F2): `work[0].name` and
    // `work[1].name` are different tokens, so a `work[]` reordered in one copy changes the
    // sequence and fails here. `projectionIsOrderSensitive` below is the positive control.
    // The only difference the shipped copies carry is a comment, which this projection drops -
    // so if this ever fails, the difference is in the DATA.
    //
    // No `eval` and no `new Function` over repository source text: both are a code-execution
    // hole, and this suite's whole subject is a renderer that must never execute input.
    const fixtureLeaves = leavesOf(PARITY_RESUME_JSON);
    for (const file of ['dict.test.ts', 'latexExport.test.ts'] as const) {
      const source = readFileSync(path.join(__dirname, file), 'utf8');
      const literal = extractCanonicalLiteral(source, 'CANONICAL');
      expect(literal, `${file} no longer declares the parity document`).not.toBeNull();
      expect(leavesOfLiteral(literal as string), `${file} diverges from the shared fixture`).toEqual(
        fixtureLeaves,
      );
    }
  });

  it('the pinning projection is ORDER SENSITIVE, which is what F2 required', () => {
    // Without this, the test above is unfalsifiable in the direction that matters: a
    // projection that returned a SORTED leaf set would pass it for a `work[]` reordered in
    // one copy, and this suite's own claim ("preserves the document array order") is about
    // order. Both projections are exercised here, from both directions of the comparison.
    const ordered = "{ work: [{ name: 'A' }, { name: 'B' }] }";
    const reordered = "{ work: [{ name: 'B' }, { name: 'A' }] }";
    // The literal scanner.
    expect(leavesOfLiteral(ordered)).not.toEqual(leavesOfLiteral(reordered));
    // ...and the object walker, against the very same reordering.
    expect(leavesOf({ work: [{ name: 'A' }, { name: 'B' }] })).not.toEqual(
      leavesOf({ work: [{ name: 'B' }, { name: 'A' }] }),
    );
    // ...and the two agree on the UNREORDERED document, so the sensitivity above is the
    // reordering being seen and not the scanner and the walker simply disagreeing.
    expect(leavesOfLiteral(ordered)).toEqual(leavesOf({ work: [{ name: 'A' }, { name: 'B' }] }));
    // A rename and a changed value are still caught, so order sensitivity is added to the
    // check rather than traded against it.
    expect(leavesOfLiteral(ordered)).not.toEqual(leavesOfLiteral("{ work: [{ name: 'A' }, { name: 'C' }] }"));
  });

  it('carries enough of every member that a renderer cannot pass by ignoring one', () => {
    // Counts, not values: a parity test over a resume with one entry in a section cannot
    // distinguish "rendered it" from "dropped the last one".
    expect(FULL.experience).toHaveLength(3);
    expect(FULL.projects).toHaveLength(1);
    expect(FULL.education).toHaveLength(2);
    expect(FULL.skills).toHaveLength(2);
    expect(FULL.certifications).toHaveLength(1);
    expect(FULL.experience[2]?.highlights).toHaveLength(0);
    expect(FULL.experience[0]?.highlights).toHaveLength(2);
    expect(FULL.projects[0]?.keywords).toHaveLength(2);
    expect(FULL.projects[0]?.highlights).toHaveLength(1);
    expect(FULL.certifications[0]?.url).not.toBe('');
    expect(FULL.skills[0]?.level).toBe('Advanced');
    expect(FULL.contact.locationParts.address).toBe('12 Pratt Street');
    expect(FULL.contact.profiles).toHaveLength(3);
  });
});

/**
 * Every KEY and SCALAR LEAF a JSON value declares, in DOCUMENT ORDER, with array indices in
 * the path.
 *
 * F2. The previous version returned a SORTED leaf set, which is a MULTISET: it caught a
 * renamed member and a changed value, but a `work[]` reordered in one copy left both multisets
 * identical and the gate GREEN - while the three suites would then describe the same resume
 * in different orders, which is the divergence ruling 15's ONE-fixture rule exists to
 * prevent and which this suite's own order claims are about.
 *
 * The path is what restores the sensitivity. `work[0].name` and `work[1].name` are different
 * strings, so swapping two entries changes the emitted sequence; a renamed member changes it;
 * a changed value changes it. Keys of an OBJECT are still emitted in the object's own order,
 * which is the one tolerance kept deliberately - reformatting a literal is not a divergence -
 * and the trade-off is documented on `leavesOfLiteral`.
 */
function leavesOf(value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      out.push(`${path}=${node}`);
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      out.push(`${path}=${typeof node}:${String(node)}`);
      return;
    }
    if (Array.isArray(node)) {
      out.push(`#${path}`);
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      out.push(`#${path}`);
      for (const key of Object.keys(node)) walk((node as Record<string, unknown>)[key], join(path, key));
    }
  };
  walk(value, '');
  return out;
}

/** A path segment join that keeps `[n]` attached to the member it indexes. */
function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/**
 * The same projection, over a TypeScript object LITERAL read as source text.
 *
 * ONE string-aware scan, because two separate regex passes get this wrong in both directions
 * and both failures were observed here rather than anticipated: a line-comment regex deletes
 * the rest of every line at the doubled slash inside a URL, and a key regex reports `https`
 * as an object key out of `'https://example.org'`. The scanner tracks whether it is inside a
 * string, so a comment marker in a string is text, a quote in a comment is not a string, and
 * a colon in a string is not a key.
 *
 * `undefined` members (which a fixture never has) are simply absent from both sides, and
 * string literals are unescaped so `'a\'b'` and `"a'b"` compare equal, which is the one place
 * a formatter could otherwise fake a divergence.
 *
 * ORDER SENSITIVITY IS THE POINT, and it is the F2 fix. The token list is NOT sorted: it is
 * emitted in document order, and an array element contributes its INDEX as a path segment.
 * A sorted leaf set is a MULTISET, and a multiset cannot see `work[]` reordered - which is
 * precisely the divergence this test exists to catch, because the parity suite's own claims
 * are about order ("preserves the document array order"). The cost is stated rather than
 * hidden: a copy whose OBJECT members were reordered would now also fail, which is stricter
 * than the document requires but cannot mask a real divergence.
 */
interface LiteralFrame {
  readonly kind: 'object' | 'array';
  /** The path of the container's own VALUE, e.g. `work` or `work[0]`. */
  readonly base: string;
  /** Array frames only: how many elements have been STARTED. JavaScript source has no
   * `[0]` token to read an index from, so the scanner counts them - and a reordered array
   * produces a different sequence, which is the whole point of the F2 fix. */
  next: number;
}

function leavesOfLiteral(literal: string): string[] {
  const out: string[] = [];
  let index = 0;
  const frames: LiteralFrame[] = [];
  // A key names whatever follows it; it is consumed by the `{`, `[`, or scalar branch that
  // reads that value, so the two projections cannot disagree about where a path starts.
  let pendingKey: string | null = null;

  /** The path of whatever the scanner is inside right now. */
  const currentPath = (): string => frames[frames.length - 1]?.base ?? '';

  /**
   * A value is starting. If we are inside an ARRAY this value is the next element, so claim
   * its index; otherwise it is an object member's value or a container opening, and the caller
   * names it. Returns the claimed index, or -1 when there is no enclosing array.
   */
  const beginElement = (): number => {
    const top = frames[frames.length - 1];
    if (top === undefined || top.kind !== 'array') return -1;
    const claimed = top.next;
    top.next += 1;
    return claimed;
  };

  /** The path of the value that is starting: an array element, or a pending key's value. */
  const valuePath = (element: number): string => {
    const base = currentPath();
    if (element >= 0) return base === '' ? `[${element}]` : `${base}[${element}]`;
    return pendingKey === null ? base : join(base, pendingKey);
  };

  const quoteAt = (at: number): string | null => {
    const character = literal[at];
    return character === '"' || character === "'" || character === '`' ? character : null;
  };

  while (index < literal.length) {
    const quote = quoteAt(index);
    if (quote !== null) {
      // Consume the whole literal, honouring backslash escapes, and record its VALUE.
      let cursor = index + 1;
      let raw = '';
      while (cursor < literal.length) {
        const character = literal[cursor];
        if (character === '\\') {
          raw += character + (literal[cursor + 1] ?? '');
          cursor += 2;
          continue;
        }
        if (character === quote) break;
        raw += character;
        cursor += 1;
      }
      const path = valuePath(beginElement());
      pendingKey = null;
      out.push(`${path}=${unescapeJs(quote + raw + quote)}`);
      index = cursor + 1;
      continue;
    }
    // Line comment.
    if (literal[index] === '/' && literal[index + 1] === '/') {
      while (index < literal.length && literal[index] !== '\n') index += 1;
      continue;
    }
    // Block comment.
    if (literal[index] === '/' && literal[index + 1] === '*') {
      const close = literal.indexOf('*/', index + 2);
      index = close < 0 ? literal.length : close + 2;
      continue;
    }
    // An identifier: a KEY (`name:`) or a bare literal (`true`, `false`, `null`).
    if (/[A-Za-z_$]/.test(literal[index])) {
      let cursor = index;
      while (cursor < literal.length && /[\w$]/.test(literal[cursor])) cursor += 1;
      const word = literal.slice(index, cursor);
      if (literal[cursor] === ':') {
        pendingKey = word;
      } else if (word === 'true' || word === 'false' || word === 'null') {
        const path = valuePath(beginElement());
        pendingKey = null;
        out.push(`${path}=${word}`);
      }
      index = cursor;
      continue;
    }
    // A numeric literal is a scalar value.
    if (/[-0-9]/.test(literal[index])) {
      let cursor = index;
      while (cursor < literal.length && /[-+0-9.eE]/.test(literal[cursor])) cursor += 1;
      const raw = literal.slice(index, cursor);
      if (/^[-+]?[0-9]/.test(raw)) {
        const path = valuePath(beginElement());
        pendingKey = null;
        out.push(`${path}=number:${raw}`);
      }
      index = cursor;
      continue;
    }
    // `{` opens an object, `[` opens an array. Either may be an ARRAY ELEMENT, or the value
    // of the key just read. The container token is emitted before its children, which is the
    // order `leavesOf` produces for a real object.
    if (literal[index] === '{' || literal[index] === '[') {
      const kind = literal[index] === '{' ? 'object' : 'array';
      const path = valuePath(beginElement());
      pendingKey = null;
      out.push(`#${path}`);
      frames.push({ kind, base: path, next: 0 });
      index += 1;
      continue;
    }
    // A closer pops whatever was opened. Separators are punctuation: elements are counted by
    // `beginElement` at each value, not at each comma.
    if (literal[index] === '}' || literal[index] === ']') {
      pendingKey = null;
      frames.pop();
      index += 1;
      continue;
    }
    index += 1;
  }
  return out;
}

/** Unquote and unescape one JavaScript string literal, tolerating the backslash forms used. */
function unescapeJs(literal: string): string {
  const inner = literal.slice(1, -1);
  return inner
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\(['"\\`/])/g, '$1')
    .replace(/\\\\/g, '\\');
}

/**
 * The source text of a `const <name> = {...}` declaration, braces matched.
 *
 * Brace counting is correct here rather than a regex because the literals contain braces
 * inside string values; a regex would stop at the first `}` in a hostile-looking fixture.
 */
function extractCanonicalLiteral(source: string, name: string): string | null {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  let inString: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (inString !== null) {
      if (character === '\\') {
        index += 1;
      } else if (character === inString) {
        inString = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      inString = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ACCEPTANCE 1: section order matches dict.sections
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1: the DOCX sections appear in dict.sections order', () => {
  it('emits exactly one heading per listed section, in the dictionary order', async () => {
    const paragraphs = paragraphsOf(documentXml(await fullDocx()));
    const headings = paragraphs
      .filter((paragraph) => paragraph.style === DOCX_STYLE_SECTION)
      .map((paragraph) => paragraph.text);
    expect(headings).toEqual(FULL.sections.map((section) => PARITY_SECTION_HEADINGS[section]));
    // ...and that order IS the dictionary's, checked against the dictionary rather than a
    // literal, so a dictionary order change is visible here.
    expect(FULL.sections).toEqual([...RESUME_DICT_SECTIONS]);
    expect(new Set(headings).size).toBe(headings.length);
  });

  it('the heading text agrees with the .tex exporter\'s, so two engines name a section alike', async () => {
    // The cross-engine half of Phase 4 (a) that CAN be unit-tested: two of the three
    // serialisers are pure, so their section vocabularies are compared here directly. The
    // Typst template's own headings are a `.typ` file and belong to T1045's live run.
    const texHeadings = [...renderLatexExport(FULL).matchAll(/\\clearancesection\{([^}]*)\}/g)].map(
      (match) => match[1],
    );
    const docxHeadings = paragraphsOf(documentXml(await fullDocx()))
      .filter((paragraph) => paragraph.style === DOCX_STYLE_SECTION)
      .map((paragraph) => paragraph.text)
      // The contact block is the header in the .tex output and has no section heading.
      .filter((heading) => heading !== PARITY_SECTION_HEADINGS.contact);
    expect(texHeadings).toEqual(docxHeadings);
    expect(texHeadings).toHaveLength(FULL.sections.length - 1);
  });

  it('a section the dictionary does not list is not emitted at all', async () => {
    // The other half of rule 4 of `dict.ts`: an EMPTY section is not an empty heading. An
    // empty document yields a package with no headings, not seven blank ones.
    const empty = await renderDocxFromDictionary(projectResumeDict({}));
    const headings = paragraphsOf(documentXml(empty)).filter(
      (paragraph) => paragraph.style === DOCX_STYLE_SECTION,
    );
    expect(headings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 2: entry counts match the dictionary
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2: entry counts match the dictionary, section by section', () => {
  it('every section emits exactly as many entry paragraphs as the dictionary holds', async () => {
    // Slice the document at its headings so each section is counted on its OWN body - a
    // total would not catch one section over-emitting and another under-emitting.
    const bodies = await sectionBodiesOf(await fullDocx());
    const entries = (heading: string): number =>
      (bodies.get(heading) ?? []).filter((p) => p.style === DOCX_STYLE_ENTRY).length;
    const reported = [
      `Experience:${entries('Experience')}/${FULL.experience.length}`,
      `Projects:${entries('Projects')}/${FULL.projects.length}`,
      `Education:${entries('Education')}/${FULL.education.length}`,
      `Skills:${entries('Skills')}/${FULL.skills.length}`,
      `Certifications:${entries('Certifications')}/${FULL.certifications.length}`,
    ];
    expect(reported).toEqual([
      'Experience:3/3',
      'Projects:1/1',
      'Education:2/2',
      'Skills:2/2',
      'Certifications:1/1',
    ]);
    // And the CONTACT section emits its single entry, so the count property is stated for
    // every section that has one rather than only the five array-backed ones.
    expect(entries('Contact')).toBe(1);
  });

  it('an entry whose headline field is empty still gets exactly one entry paragraph', async () => {
    // The degenerate edge the count parity depends on: an education entry with no
    // `studyType` and no `area` has an EMPTY qualification, and emitting nothing for it would
    // make "entry counts match" true only by luck.
    const dict = projectResumeDict({
      education: [{ institution: 'Open University', endDate: '2018' }],
      projects: [{ keywords: ['Rust'] }],
      certificates: [{ date: '2021-04' }],
    });
    const paragraphs = paragraphsOf(documentXml(await renderDocxFromDictionary(dict)));
    const entries = paragraphs.filter((p) => p.style === DOCX_STYLE_ENTRY).map((p) => p.text);
    expect(entries).toHaveLength(3);
    // The fallback is the entry's OWN field, printed as such.
    expect(entries).toContain('Open University');
  });

  it('preserves the document array order rather than re-sorting it', async () => {
    // Sliced per section rather than over the whole document, so the Contact entry (which
    // precedes Experience) cannot be mistaken for an experience entry.
    const bodies = await sectionBodiesOf(await fullDocx());
    const entriesOf = (heading: string): string[] =>
      (bodies.get(heading) ?? [])
        .filter((paragraph) => paragraph.style === DOCX_STYLE_ENTRY)
        .map((paragraph) => paragraph.text);
    expect(entriesOf('Experience')).toEqual([
      'Staff Platform Engineer',
      'Senior Site Reliability Engineer',
      'Backend Engineer',
    ]);
    expect(entriesOf('Education')).toEqual(['MEng, Computer Science', 'Postgraduate certificate']);
    expect(entriesOf('Skills')).toEqual(['Rust', 'PostgreSQL']);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 3: bullet strings match the dictionary
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 3: the bullet strings are the dictionary\'s, as real list items', () => {
  it('every highlight and keyword is a bullet, in document order', async () => {
    const xml = documentXml(await fullDocx());
    const bullets = bulletTextsOf(xml);
    // The expected list, composed from the dictionary rather than written out: experience
    // highlights in order, then the project's keywords then its highlights, then the skill
    // keywords. This is the ordering claim, and it is the ordering ADR-044 D3 promises.
    const expected = [
      ...FULL.experience.flatMap((entry) => entry.highlights),
      ...FULL.projects.flatMap((entry) => [...entry.keywords, ...entry.highlights]),
      ...FULL.skills.flatMap((entry) => entry.keywords),
    ];
    expect(bullets).toEqual(expected);
    expect(bullets).toHaveLength(7);
  });

  it('a bullet is a LIST paragraph, not a literal glyph in a body paragraph', async () => {
    // The check that makes the previous one mean something: a renderer that printed the
    // words as ordinary text would pass a text comparison and fail this. And the marker is
    // not a `-` character in the text, because ATS parsers key on the list structure.
    const paragraphs = paragraphsOf(documentXml(await fullDocx()));
    const bodyTexts = paragraphs
      .filter((p) => p.style === DOCX_STYLE_BODY && p.text.length > 0)
      .map((p) => p.text);
    for (const bullet of bulletTextsOf(documentXml(await fullDocx()))) {
      const prefixed = bodyTexts.some(
        (text) => text === `\u2022 ${bullet}` || text === `- ${bullet}` || text === `\u25cf ${bullet}`,
      );
      expect(prefixed, `"${bullet}" is rendered as literal text, not as a list item`).toBe(false);
    }
  });

  it('the bullet list the package declares uses a BULLET numFmt, not a decimal counter', async () => {
    // A resume bullet that renders as "1. 2. 3." would be a visible defect that a text
    // comparison cannot see, so the numbering part is read directly.
    const zip = new PizZipCtor(await fullDocx());
    const numbering = zip.file('word/numbering.xml');
    expect(numbering, 'the package has no word/numbering.xml').not.toBeNull();
    const xml = (numbering as { asText(): string }).asText();
    expect(xml).toContain('<w:numFmt w:val="bullet"/>');
    // The glyph is the bullet character the module declares, not a hyphen.
    expect(xml).toContain('\u2022');
  });

  it('the .tex exporter emits the same bullet strings from the same dictionary', async () => {
    // The second pure engine's half of the cross-engine bullet claim. `escapeLatex` is
    // IMPORTED rather than reimplemented here: a hand-written escape table in this file would
    // be a third answer to "what is a bullet's text", and the two could disagree.
    const texItems = [...renderLatexExport(FULL).matchAll(/\\item ([^\n\\]*)/g)].map((match) =>
      match[1].trimEnd(),
    );
    const expected = [
      ...FULL.experience.flatMap((entry) => entry.highlights),
      // Project keywords and skill keywords are ONE line each in the .tex output, not
      // bullets, so only the highlight runs are list items.
      ...FULL.projects.flatMap((entry) => entry.highlights),
    ];
    expect(texItems).toHaveLength(expected.length);
    expect(texItems).toEqual(expected.map((item) => escapeLatex(item)));
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 4: A4 section properties, read from the bytes
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4: the section properties are A4', () => {
  it('the sectPr carries A4 page size, and never US Letter', async () => {
    const sectPr = sectionPropertiesOf(documentXml(await fullDocx()));
    expect(sectPr).not.toBe('');
    expect(sectPr).toContain(`<w:pgSz w:w="${DOCX_PAGE_WIDTH_TWIPS}" w:h="${DOCX_PAGE_HEIGHT_TWIPS}"`);
    expect(sectPr).toContain('w:orient="portrait"');
    // A4 in twips is 11906 x 16838 (210mm x 297mm). Letter is 12240 x 15840 and is this
    // library's own default, so the negative assertion is the one that has teeth.
    expect(DOCX_PAGE_WIDTH_TWIPS).toBe(11906);
    expect(DOCX_PAGE_HEIGHT_TWIPS).toBe(16838);
    expect(sectPr).not.toContain('w:w="12240"');
    expect(sectPr).not.toContain('w:h="15840"');
    // The margins are stated too, so a future edit cannot silently drop the whole `pgMar`.
    expect(sectPr).toContain('<w:pgMar');
  });

  it('the .tex export declares A4 as well, so the two agree on the page', () => {
    // The other pure engine. A parity claim about content would be hollow if one engine
    // printed A4 and the other Letter.
    expect(renderLatexExport(FULL)).toContain('\\documentclass[10pt,a4paper]{article}');
  });

  it('an EMPTY document still produces an A4 section', async () => {
    const sectPr = sectionPropertiesOf(documentXml(await renderDocxFromDictionary(projectResumeDict({}))));
    expect(sectPr).toContain(`<w:pgSz w:w="${DOCX_PAGE_WIDTH_TWIPS}" w:h="${DOCX_PAGE_HEIGHT_TWIPS}"`);
  });
});

// ---------------------------------------------------------------------------
// The styles are real structure, not formatting
// ---------------------------------------------------------------------------

describe('the section semantics are real document structure', () => {
  it('every style this module names is DECLARED in word/styles.xml', async () => {
    // A paragraph referencing a style that does not exist renders as the default style in
    // Word - silently. So the reference and the declaration are checked against each other.
    const styles = stylesXml(await fullDocx());
    const used = new Set(
      paragraphsOf(documentXml(await fullDocx()))
        .map((paragraph) => paragraph.style)
        .filter((style) => style.length > 0),
    );
    expect([...used].sort()).toEqual(['ClearanceBody', 'ClearanceEntry', 'ClearanceMeta', 'ClearanceSection']);
    for (const style of used) {
      expect(styles, `${style} is used but not declared`).toContain(`w:styleId="${style}"`);
    }
  });

  it('section headings carry an outline level, so they are navigable structure', async () => {
    // `w:outlineLvl` is what puts a heading in Word's navigation pane and what an ATS reads
    // as a section boundary. A bold paragraph is not a heading.
    const styles = stylesXml(await fullDocx());
    const sectionStyle = /<w:style [^>]*w:styleId="ClearanceSection"[\s\S]*?<\/w:style>/.exec(styles);
    expect(sectionStyle, 'ClearanceSection is not declared').not.toBeNull();
    expect(sectionStyle?.[0]).toContain('<w:outlineLvl w:val="0"/>');
  });

  it('the character styles are declared, so the emphasis is a style and not inline markup', async () => {
    const styles = stylesXml(await fullDocx());
    expect(styles).toContain('w:styleId="ClearanceStrong"');
    expect(styles).toContain('w:styleId="ClearanceMuted"');
    // ...and they are USED, which is the half a declaration-only test would miss.
    const xml = documentXml(await fullDocx());
    expect(xml).toContain('<w:rStyle w:val="ClearanceStrong"/>');
    expect(xml).toContain('<w:rStyle w:val="ClearanceMuted"/>');
  });

  it('no document metadata carries resume content', async () => {
    // `docProps/core.xml` is read by search indexes and document browsers that never render
    // the body, so a name in a document property is a disclosure the user did not make.
    const zip = new PizZipCtor(await fullDocx());
    const core = zip.file('docProps/core.xml');
    expect(core).not.toBeNull();
    const xml = (core as { asText(): string }).asText();
    for (const secret of ['Ada Lovelace', 'ada@example.org', 'Meridian Data', 'Faster.']) {
      expect(xml, `docProps/core.xml leaks "${secret}"`).not.toContain(secret);
    }
    expect(xml).toContain('Clearance');
  });
});

// ---------------------------------------------------------------------------
// Content survives the round trip, and cannot escape it
// ---------------------------------------------------------------------------

describe('the content survives the round trip, and cannot escape it', () => {
  it('carries every value the dictionary holds, including the members 1.0.0 dropped', async () => {
    // Rule 5 of `dict.ts`'s header: a member missing from the dictionary is missing in all
    // three engines, and a member present must actually REACH the output.
    const paragraphs = paragraphsOf(documentXml(await fullDocx()));
    const all = paragraphs.map((paragraph) => paragraph.text).join('\n');
    for (const value of [
      'Ada Lovelace',
      'Staff Platform Engineer',
      'ada@example.org',
      '+44 20 7946 0018',
      'London, Greater London, GB',
      'https://example.org/ada',
      'https://github.com/adalovelace/hermetic-build',
      'https://training.linuxfoundation.org/certification/cka',
      'Advanced',
      '@ada@fosstodon.org',
      'MEng, Computer Science',
      'Meridian Data',
      'Faster.',
      'Faster.',
    ]) {
      expect(all, `the DOCX drops ${value}`).toContain(value);
    }
  });

  it('dates arrive pre-formatted and are printed verbatim', async () => {
    // The DOCX path formats NOTHING: `dict.ts` did it once (ADR-044 D3, rule 3). If the
    // artifact printed `2022-03-01` the formatter had been bypassed.
    const all = paragraphsOf(documentXml(await fullDocx())).map((p) => p.text).join('\n');
    expect(all).toContain('Mar 2022 - Present');
    expect(all).toContain('Jan 2019 - Feb 2022');
    expect(all).toContain('2021 - 2022');
    expect(all).toContain('Jun 2015');
    expect(all).toContain('2021');
    // And it never prints the RAW wire value, which would prove a re-format path exists.
    expect(all).not.toContain('2022-03-01');
    expect(all).not.toContain('2022-02-28');
  });

  it('XML-active characters round-trip as TEXT, and introduce no structure', async () => {
    // The DOCX user-content boundary (policy 8.4): a value is text and leaves as a text run.
    // The `docx` builder escapes the five XML-active characters itself, which is what makes
    // a resume unable to inject a paragraph, a style reference or a field.
    const hostile = 'A & B < C > D " E \' F';
    const xml = documentXml(
      await renderDocxFromDictionary(projectResumeDict({ basics: { name: hostile } })),
    );
    const runs = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => match[1]);
    expect(runs).toContain('A &amp; B &lt; C &gt; D &quot; E &apos; F');
    // Nothing raw survives: the `<` that would open a tag is gone from the text runs.
    for (const run of runs) {
      expect(run, 'an unescaped active character survived').not.toMatch(/[<>&](?!amp;|lt;|gt;|quot;|apos;|#)/);
    }
  });

  it('a hostile value cannot reach the STYLES part, so it cannot become a style reference', async () => {
    // The structural half of the boundary. A `pStyle` is an attribute VALUE, and the builder
    // writes ours; a resume that typed `</w:t><w:pStyle w:val="..."/>` must still land as
    // text in the body and change nothing in `word/styles.xml`.
    const marker = 'ClearanceStrong';
    await renderDocxFromDictionary(
      projectResumeDict({ basics: { name: `</w:t><w:pPr><w:pStyle w:val="${marker}"/></w:pPr><w:t>` } }),
    );
    const styles = stylesXml(await fullDocx());
    // The declaration count is unchanged: nothing was added to the styles part.
    expect((styles.match(/<w:style /g) ?? []).length).toBe(
      (stylesXml(await fullDocx()).match(/<w:style /g) ?? []).length,
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism, and the key-order invariance that makes it meaningful
// ---------------------------------------------------------------------------

describe('the same dictionary produces the same bytes', () => {
  it('two calls are byte-identical, more than a second apart', async () => {
    const first = await renderDocxFromDictionary(FULL);
    // A second later, so a wall-clock timestamp inside the package WOULD differ. The library
    // writes one and offers no option to pin it; the module normalises both sources of drift.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await renderDocxFromDictionary(FULL);
    expect(first.equals(second)).toBe(true);
  }, 30_000);

  it('and key order in the INPUT is not information', async () => {
    // The same document with every object's keys reversed at every depth yields the same
    // bytes: the projection walks the document rather than its key enumeration order, and
    // this renderer walks the dictionary, so nothing downstream can observe the input's
    // order.
    const shuffled = deepShuffleKeys(PARITY_RESUME_JSON);
    expect((await renderDocxFromDictionary(projectResumeDict(shuffled))).equals(await fullDocx())).toBe(true);
  }, 30_000);

  it('and the produced package carries no wall clock at all', async () => {
    const zip = new PizZipCtor(await fullDocx());
    const core = (zip.file('docProps/core.xml') as { asText(): string }).asText();
    expect(core).toContain('<dcterms:created xsi:type="dcterms:W3CDTF">1980-01-01T00:00:00Z</dcterms:created>');
    expect(core).toContain('<dcterms:modified xsi:type="dcterms:W3CDTF">1980-01-01T00:00:00Z</dcterms:modified>');
  });
});

function deepShuffleKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => deepShuffleKeys(entry)) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) out[key] = deepShuffleKeys(source[key]);
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The forged-dictionary edge the section dispatch must refuse
// ---------------------------------------------------------------------------

describe('a dictionary this renderer cannot trust is refused, not rendered', () => {
  it('a section outside the closed vocabulary is refused', async () => {
    const forged = {
      ...FULL,
      sections: [...FULL.sections, 'languages'] as unknown as readonly ResumeDictSection[],
    };
    await expect(renderDocxFromDictionary(forged)).rejects.toThrow(/DOCX_SECTION_UNKNOWN/);
  });

  it('and a non-dictionary argument is a TypeError', async () => {
    await expect(renderDocxFromDictionary(null as unknown as ResumeDict)).rejects.toThrow(TypeError);
    await expect(renderDocxFromDictionary('nope' as unknown as ResumeDict)).rejects.toThrow(TypeError);
  });
});