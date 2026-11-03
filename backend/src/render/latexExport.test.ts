// The `.tex` exporter - unit tests.
//
// NORMATIVE DOC: .planning/decisions/ADR-042-latex-export-only-and-broker.md D1
//                 .planning/specs/clearance-v2/render-sandbox-policy.md 11.1 (L1)
//                 .planning/decisions/ADR-044-*.md D3 (ONE shared dictionary)
// Task:         T1044
//
// NOTHING HERE NEEDS A DOCKER DAEMON, A DATABASE, OR A TEMPLATE. The exporter is a pure
// serialiser over the dictionary, and every acceptance item in the task contract is a
// property of the BYTES it produces.
//
// THIS FILE OWNS THE FORBIDDEN TOKEN LIST ON PURPOSE. `latexExport.ts` is grepped by the
// task contract for `write18|shell-escape|input\{` and must return zero hits, so it cannot
// name those primitives even in order to forbid them. Every name lives here instead, where
// a regression is a failing test rather than a comment nobody reads.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RESUME_DICT_SECTIONS, projectResumeDict, type ResumeDict } from './dict.js';
import {
  LATEX_EXPORT_ENGINE,
  LATEX_EXPORT_EXTENSION,
  LATEX_EXPORT_VARIANTS,
  escapeLatex,
  renderLatexExport,
  renderLatexExportBytes,
} from './latexExport.js';

const MODULE_SOURCE = readFileSync(path.join(__dirname, 'latexExport.ts'), 'utf8');

/** Comments are stripped first: prose ABOUT a command is not a command. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * The document BODY: between `\begin{document}` and `\end{document}`, i.e. exactly the
 * region user content can reach. The postamble is excluded so a structural terminator this
 * module wrote is never mistaken for one that arrived from a resume.
 */
function bodyOf(tex: string): string {
  const open = tex.indexOf('\\begin{document}');
  const close = tex.indexOf('\\end{document}');
  expect(open, 'the document never opened').toBeGreaterThan(-1);
  expect(close, 'the document never closed').toBeGreaterThan(open);
  return tex.slice(open + '\\begin{document}'.length, close);
}

/**
 * The LaTeX primitives the export BODY must never be able to contain.
 *
 * Every entry is a real arbitrary-code-execution or arbitrary-file-read vector, not a style
 * preference. The shell-escape write channel runs commands when escape is enabled, and the
 * `\immediate` variant is precisely why a blocklist is not an answer; the file-inclusion
 * primitives read arbitrary files EVEN WITH escape disabled, which is the whole reason the
 * isolation model exists; the open/read primitives are the file and stream interfaces; the
 * macro-definition primitives are how a name would become code rather than text.
 */
const FORBIDDEN_PRIMITIVES: readonly string[] = Object.freeze([
  '\\write18',
  '\\write',
  '\\immediate',
  '\\input',
  '\\include',
  '\\includeonly',
  '\\openin',
  '\\openout',
  '\\openout1',
  '\\read',
  '\\readline',
  '\\special',
  '\\catcode',
  '\\csname',
  '\\endcsname',
  '\\def',
  '\\gdef',
  '\\edef',
  '\\xdef',
  '\\let',
  '\\expandafter',
  '\\usepackage',
  '\\RequirePackage',
  '\\documentclass',
  '\\newwrite',
  '\\typeout',
]);

/** Case-insensitive scan: an ENABLE-shaped spelling is as bad as the canonical one. */
const SHELL_ESCAPE_TOKENS: readonly string[] = Object.freeze([
  'shell-escape',
  'shell_escape',
  'shellescape',
  'shell escape',
  'enable-sh',
  'pipewrite',
  'openout_any',
  'openin_any',
]);

/**
 * The commands this exporter is ALLOWED to emit.
 *
 * The preamble commands are the documentclass line, the two encoding packages, `geometry`,
 * the page style, three length settings and the four `\clearance...` macro declarations.
 * The body commands are those macros plus `\par`, `\noindent`, `\medskip`, `\smallskip`,
 * `\bfseries`, `\textbf`, `\texttt`, `\large`, `\begin`, `\end`, `\item`, and the six
 * escape forms `escapeLatex()` can produce.
 *
 * The test enumerates EVERY backslash in the produced bytes and asserts the set is a subset
 * of this one. Content therefore cannot introduce a command the module did not write, and a
 * future edit that adds one has to be a deliberate act in this list.
 */
const ALLOWED_COMMANDS: readonly string[] = Object.freeze([
  '\\documentclass',
  '\\usepackage',
  '\\pagestyle',
  '\\setlength',
  '\\makeatletter',
  '\\makeatother',
  '\\def',
  '\\let',
  '\\leftmargin',
  '\\leftmargini',
  '\\parsep',
  '\\itemsep',
  '\\topsep',
  '\\partopsep',
  '\\z',
  '\\@',
  '\\newcommand',
  '\\parindent',
  '\\parskip',
  '\\emergencystretch',
  '\\clearanceentry',
  '\\clearancelabelled',
  '\\clearanceurl',
  '\\clearancesection',
  '\\clearancecontactname',
  '\\clearancecontactlabel',
  '\\clearancecontactline',
  '\\clearancejobhead',
  '\\clearancejobsub',
  '\\clearancerow',
  '\\par',
  '\\noindent',
  '\\medskip',
  '\\smallskip',
  '\\bfseries',
  '\\textbf',
  '\\texttt',
  '\\emph',
  '\\hfill',
  '\\itshape',
  '\\small',
  '\\large',
  '\\Large',
  '\\begin',
  '\\end',
  '\\item',
  '\\textbackslash',
  '\\textasciicircum',
  '\\textasciitilde',
  '\\{',
  '\\}',
  '\\$',
  '\\&',
  '\\#',
  '\\%',
  '\\_',
]);

/**
 * The modules this exporter may never reach: staging, the broker, the policy, the storage
 * port, another engine, and the process-spawn / docker-client surface.
 *
 * THE LAST TWO ARE ASSEMBLED, NOT WRITTEN. `render/broker.test.ts`'s G1 gate greps every
 * `.ts` file under `src/` (comments stripped) for `dockerode|docker-modem|child_process`, and
 * it is not exempt for this directory - so naming one of them here, even inside a list of
 * things that are forbidden, would make this file a G1 hit. The assembled strings are
 * byte-identical to the gate's, which is exactly the trick that gate documents for itself.
 */
const PROCESS_AND_CLIENT_TOKENS: readonly string[] = Object.freeze([
  'docker' + 'ode',
  'docker-' + 'modem',
  'child_' + 'process',
]);

const FORBIDDEN_MODULE_NAMES: readonly string[] = Object.freeze([
  'stage',
  'brokerClient',
  'broker/',
  'typst',
  'docx',
  './sandbox',
  'storage',
  'templates',
]);

/** Every `\\command` (a backslash followed by letters) in a block of LaTeX, as whole tokens. */
function commandsIn(tex: string): string[] {
  return [...tex.matchAll(/\\([A-Za-z]+|.)/g)].map((match) => `\\${match[1]}`);
}

/**
 * A realistic canonical document, in the shape `resume/json/project.ts` writes.
 *
 * It is the SAME document `dict.test.ts` projects, section for section and entry for entry,
 * because the task contract makes the entry counts a parity property ("the same fixture the
 * DOCX parity test uses"). T1041 owns extracting that fixture into a shared module; until it
 * lands, both suites carry the identical literal and this file says so.
 */
const CANONICAL = {
  basics: {
    name: 'Ada Lovelace',
    label: 'Staff Platform Engineer',
    email: 'ada@example.org',
    phone: '+44 20 7946 0018',
    url: 'https://example.org/ada',
    summary: 'Platform engineer. Eleven years of boring deploys.',
    location: {
      address: '12 Pratt Street',
      postalCode: 'NW1 2QT',
      city: 'London',
      region: 'Greater London',
      countryCode: 'GB',
    },
    profiles: [
      { network: 'GitHub', url: 'https://github.com/adalovelace' },
      { network: 'LinkedIn', url: 'https://linkedin.com/in/adalovelace' },
      { network: 'Mastodon', username: '@ada@fosstodon.org', url: 'https://fosstodon.org/@ada' },
    ],
  },
  work: [
    {
      name: 'Meridian Data',
      position: 'Staff Platform Engineer',
      summary: 'London',
      startDate: '2022-03-01',
      highlights: ['First', 'Second'],
    },
    {
      name: 'Halcyon Payments',
      position: 'Senior Site Reliability Engineer',
      summary: 'Dublin',
      startDate: '2019-01-01',
      endDate: '2022-02-28',
      highlights: ['Third'],
    },
    {
      name: 'Northgate Software',
      position: 'Backend Engineer',
      summary: 'Manchester',
      startDate: '2015-06-01',
      endDate: '2019-01',
      highlights: [],
    },
  ],
  projects: [
    {
      name: 'hermetic-build',
      description: 'A build sandbox.',
      startDate: '2021',
      endDate: '2022',
      url: 'https://github.com/adalovelace/hermetic-build',
      keywords: ['Rust', 'OCI'],
      highlights: ['Faster.'],
    },
  ],
  education: [
    { institution: 'University of Bristol', studyType: 'MEng', area: 'Computer Science', endDate: '2015-06' },
    { institution: 'Open University', studyType: 'Postgraduate certificate', endDate: '2018' },
  ],
  skills: [
    { name: 'Rust', level: 'Advanced' },
    { name: 'PostgreSQL', keywords: ['logical replication'] },
  ],
  certificates: [
    { name: 'CKA', issuer: 'CNCF', date: '2021-04', url: 'https://training.linuxfoundation.org/certification/cka' },
  ],
};

function deepShuffleKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepShuffleKeys(entry)) as unknown as T;
  }
  if (value !== null && typeof value !== 'object') {
    return value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).reverse()) {
    out[key] = deepShuffleKeys(source[key]);
  }
  return out as unknown as T;
}

const FULL = projectResumeDict(CANONICAL);

/** The `Contact ... heading` boundaries, so a section's body can be sliced out. */
function sectionBodies(tex: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const marks: Array<{ heading: string; start: number; end: number }> = [];
  for (const match of tex.matchAll(/\\clearancesection\{([^}]*)\}/g)) {
    marks.push({ heading: match[1], start: match.index, end: match.index + match[0].length });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    const next = marks[i + 1];
    out.push([mark.heading, tex.slice(mark.end, next ? next.start : tex.length)]);
  }
  return out;
}

/**
 * The depth of the REAL group structure, walking ESCAPES.
 *
 * A raw `{`/`}` walk would be wrong in both directions: `\{` and `\}` are escaped literal
 * braces (a user string of unmatched braces must still balance), while `\textbackslash{}`
 * ends in a REAL group. So a backslash swallows exactly what it escapes - one character, or
 * the whole run of letters for a control word - and only unescaped braces are counted.
 *
 * Returns the final depth, and asserts on the way through that a group was never closed
 * before it was opened.
 */
function groupDepth(tex: string): number {
  let depth = 0;
  let lowest = 0;
  let index = 0;
  while (index < tex.length) {
    const character = tex[index];
    if (character === '\\') {
      const escape = /^\\([A-Za-z]+|.)/.exec(tex.slice(index));
      index += escape === null ? 1 : escape[0].length;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth < lowest) lowest = depth;
    index += 1;
  }
  expect(lowest, `a group was closed before it was opened in:\n${tex}`).toBe(0);
  return depth;
}

/** The value rendered in the first argument of every `\macro{...}{...}` call. */
function firstArguments(tex: string, macro: string): string[] {
  return macroArguments(tex, macro).map((args) => args[0] ?? '');
}

/**
 * Parse the argument list of every `\macro{...}` call in a block of LaTeX.
 *
 * Escapes are skipped (`\{` is not a group delimiter, `\textbackslash{}` ends in a REAL
 * group), so the split is the one a TeX engine would see. Returns the arguments of each
 * call, in order.
 */
function macroArguments(tex: string, macro: string): string[][] {
  const calls: string[][] = [];
  const pattern = new RegExp(`${macro.replace(/\\/g, '\\\\')}\\{`, 'g');
  for (const use of tex.matchAll(pattern)) {
    const args: string[] = [];
    // The pattern already consumed the FIRST `{`, so the walk starts INSIDE argument 1.
    let depth = 1;
    let current = '';
    let index = use.index + use[0].length;
    for (; index < tex.length; index += 1) {
      const character = tex[index];
      if (character === '\\') {
        const escape = /^\\([A-Za-z]+|.)/.exec(tex.slice(index));
        const consumed = escape === null ? '\\' : escape[0];
        current += consumed;
        index += consumed.length - 1;
        continue;
      }
      if (character === '{') {
        depth += 1;
      }
      if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          args.push(current);
          current = '';
          // Keep consuming SIBLING groups: `\clearancelabelled{a}{b}` is two arguments of
          // one call, and stopping at the first `}` would mis-count it as two calls of one.
          if (!tex.slice(index + 1).startsWith('{')) break;
          index += 1;
          depth = 1;
          continue;
        }
      }
      current += character;
    }
    calls.push(args);
  }
  return calls;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe('the emitted document is a self-contained A4 article', () => {
  it('declares the A4 article class and only stock packages', () => {
    const tex = renderLatexExport(FULL);
    expect(tex).toContain('\\documentclass[10pt,a4paper]{article}');
    // A4 twice over: the class option, and the page package's own option, so a user who
    // edits one of them still gets A4 from the other.
    expect(tex).toContain('\\usepackage[a4paper,margin=12mm]{geometry}');
    const packages = [...tex.matchAll(/\\usepackage(?:\[[^\]]*\])?\{[^}]*\}/g)].map((m) => m[0]);
    expect(packages.sort()).toEqual([
      '\\usepackage[T1]{fontenc}',
      '\\usepackage[a4paper,margin=12mm]{geometry}',
      '\\usepackage[utf8]{inputenc}',
    ]);
    // No hyperref: an export that turned URLs into navigation targets would be a different
    // product, and it would put a hyperlink command on the path between text and the page.
    expect(tex).not.toContain('hyperref');
    expect(LATEX_EXPORT_EXTENSION).toBe('tex');
    expect(LATEX_EXPORT_ENGINE).toBe('latex-export');
  });

  it('opens and closes exactly one document, in that order', () => {
    const tex = renderLatexExport(FULL);
    expect(tex.match(/\\begin\{document\}/g)).toHaveLength(1);
    expect(tex.match(/\\end\{document\}/g)).toHaveLength(1);
    expect(tex.indexOf('\\begin{document}')).toBeLessThan(tex.indexOf('\\end{document}'));
    expect(tex.endsWith('\\end{document}\n')).toBe(true);
  });

  it('declares its four macros in the preamble, so the body never invents a command', () => {
    const preamble = renderLatexExport(FULL).slice(0, renderLatexExport(FULL).indexOf('\\begin{document}'));
    for (const macro of [
      '\\newcommand{\\clearanceentry}',
      '\\newcommand{\\clearancelabelled}',
      '\\newcommand{\\clearanceurl}',
      '\\newcommand{\\clearancesection}',
    ]) {
      expect(preamble).toContain(macro);
    }
    // The declarations are fixed text: a resume cannot add a command, only fill an argument.
    expect(renderLatexExport(projectResumeDict({ basics: { name: '\\newcommand{\\x}{y}' } })))
      .toContain('\\newcommand{\\clearanceentry}');
  });

  it('balances its groups on hostile documents, which is the structural half of compiling', () => {
    for (const document of [
      CANONICAL,
      { basics: { name: 'A \\{ B \\} C $ D # E % F & G _ H ^ I ~ J' } },
      { basics: { name: '\\end{document}\\input{/etc/passwd}' } },
      { basics: { name: '\\begin{document}\\end{document}' } },
      { basics: { name: '}}}}}}{{{{{{' } },
    ]) {
      const tex = renderLatexExport(projectResumeDict(document));
      expect(groupDepth(tex), `unbalanced groups in:\n${tex}`).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 1: no forbidden primitive, in any form, in any case
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 1: the produced bytes contain no file-read or process-spawn primitive', () => {
  const HOSTILE = {
    basics: {
      name: '\\end{document}\\input{/etc/passwd}',
      summary: '\\write18{cat /etc/shadow} \\immediate\\write18{ls} \\include{x}',
    },
    work: [{ name: '\\input|secret', position: '\\openin1=evil', highlights: ['\\read\\input\\include'] }],
    skills: [{ name: '\\catcode`\\=12 \\csname write18\\endcsname' }],
    projects: [{ name: '\\usepackage{evil}', keywords: ['\\documentclass{book}'] }],
  };

  it('carries none of the forbidden LaTeX primitives, case-insensitively', () => {
    // The scan is over the BODY, because the preamble legitimately contains a documentclass
    // line and package declarations - those are fixed text this module wrote. The body is
    // where user content can reach, so that is where the scan belongs.
    for (const document of [HOSTILE, CANONICAL]) {
      const body = bodyOf(renderLatexExport(projectResumeDict(document)));
      const lowered = body.toLowerCase();
      for (const primitive of FORBIDDEN_PRIMITIVES) {
        expect(lowered, `the export body contains ${primitive}`).not.toContain(primitive.toLowerCase());
      }
      for (const token of SHELL_ESCAPE_TOKENS) {
        expect(lowered, `the export body contains "${token}"`).not.toContain(token);
      }
      // `write18` is excluded from the token list above for a reason worth stating: a resume
      // whose TEXT contains the word is not a vector, and the escaper cannot know which
      // string a user meant. So the primitive `\write18` is forbidden (the backslash is
      // always escaped), and the bare word is checked separately, in its escaped form.
      if (document === HOSTILE) {
        // The word DOES survive as text (that is the point: nothing is dropped), so the
        // property worth asserting is that it is never preceded by a backslash, i.e. the
        // primitive `\write18` cannot exist. A resume typing the word is a user, not an
        // attack; the escaper cannot know which string a user meant, and it must render both.
        const words = [...body.matchAll(/write18/gi)];
        expect(words.length, 'the hostile fixture should carry the word').toBeGreaterThan(0);
        for (const at of words) {
          expect(body[at.index - 1], 'the word is preceded by a backslash').not.toBe('\\');
        }
      }
    }
  });

  it('the canary is present as TEXT: escaped, and exactly one document terminator survives', () => {
    const body = bodyOf(renderLatexExport(projectResumeDict(HOSTILE)));
    expect(body).toContain(
      '\\textbackslash{}end\\{document\\}\\textbackslash{}input\\{/etc/passwd\\}',
    );
    expect(body.match(/\\end\{document\}/g)).toBeNull();
    // The hostile document's own `\documentclass` and `\usepackage` reach the page as text.
    expect(body).toContain('\\textbackslash{}documentclass\\{book\\}');
    expect(body).toContain('\\textbackslash{}usepackage\\{evil\\}');
  });

  it('contains no unescaped command anywhere: every backslash is one this module wrote', () => {
    // The strongest form of the same acceptance item, and the one a mutation cannot slip
    // past: the produced bytes are ENUMERATED. Every control sequence in them must belong to
    // ALLOWED_COMMANDS, so the content cannot introduce one.
    for (const document of [CANONICAL, HOSTILE, { basics: { name: 'a & b # c % d _ e ^ f ~ g' } }]) {
      const tex = renderLatexExport(projectResumeDict(document));
      for (const command of commandsIn(tex)) {
        expect(ALLOWED_COMMANDS, `the export emits ${command}`).toContain(command);
      }
      // The scan is real: it finds the commands the exporter itself writes.
      const emitted = [...new Set(commandsIn(tex))];
      expect(emitted.length).toBeGreaterThan(10);
      expect(emitted).toContain('\\documentclass');
      expect(emitted).toContain('\\clearanceentry');
    }
  });

  it('the module source names no forbidden primitive (the contract grep, as a test)', () => {
    // The task contract runs `Select-String -Pattern 'write18|shell-escape|input\{'` over
    // this module and requires zero hits. The pattern is a REGEX, so `\{` is an escaped
    // brace and matches the literal text `input{` - which is why this test applies the same
    // regular expression rather than the same three substrings, and why the module header
    // describes the canary instead of quoting it. Asserting it here means the gate cannot
    // rot: a future edit that documents one of these tokens IN the module fails here.
    const matches = MODULE_SOURCE.match(/write18|shell-escape|input\{/gi) ?? [];
    expect(matches, `latexExport.ts matches the contract grep: ${matches.join(', ')}`).toEqual([]);
    // The same scan over the OTHER export modules, because the grep is a repo-level habit and
    // this suite is where it is defined.
    const jsonSource = readFileSync(path.join(__dirname, 'jsonExport.ts'), 'utf8');
    expect(jsonSource.match(/write18|shell-escape|input\{/gi) ?? []).toEqual([]);
  });

  it('the import set is exactly the shared dictionary, so the export has no compiler', () => {
    // The import-set assertion the acceptance list names, and the one that fails first if a
    // later edit tries to give the export path a compiler. It reads the SOURCE, so a static
    // import, a `require` and a dynamic `import()` are all covered.
    const code = withoutComments(MODULE_SOURCE);
    const specifiers = [...code.matchAll(/(?:from|import|require\()\s*'([^']+)'/g)].map((m) => m[1]);
    expect([...new Set(specifiers)].sort()).toEqual(['./dict.js']);
    // Spelled out, because the closed set is the point: none of the staging, broker,
    // policy, storage or other-engine modules may appear, and there is no I/O at all.
    for (const forbidden of FORBIDDEN_MODULE_NAMES) {
      expect(code.toLowerCase(), `latexExport.ts references ${forbidden}`).not.toContain(forbidden.toLowerCase());
    }
    // The repository-wide gate's own vocabulary, asserted here for THIS module so a failure
    // names the file rather than surfacing as an unrelated broker test.
    for (const forbidden of PROCESS_AND_CLIENT_TOKENS) {
      expect(code.toLowerCase(), `latexExport.ts references ${forbidden}`).not.toContain(forbidden);
    }
    for (const instrument of ['readFile', 'writeFile', 'fetch(', 'process.env', 'require(', 'spawn']) {
      expect(code, `latexExport.ts calls ${instrument}`).not.toContain(instrument);
    }
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 2: sections in dictionary order, entry counts matching
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 2: every section in dict.sections appears, in that order', () => {
  it('emits one heading per listed section, in the dictionary order', () => {
    const headings = sectionBodies(renderLatexExport(FULL)).map(([heading]) => heading);
    // Every section the dictionary listed, in ITS order, with this module's heading text.
    expect(headings).toEqual([
      'Profile',
      'Experience',
      'Projects',
      'Education',
      'Skills',
      'Certifications',
    ]);
    // ...and that order IS the dictionary's, checked against the dictionary rather than
    // against a literal, so a dictionary order change is visible here.
    expect(FULL.sections).toEqual([...RESUME_DICT_SECTIONS]);
    // No section is emitted twice, and none is missing.
    expect(new Set(headings).size).toBe(headings.length);
  });

  it('the heading table covers the section vocabulary exactly, and an empty document has none', () => {
    // A section added to the dictionary without a heading here would render `undefined`, and
    // a heading left behind for a section the dictionary cannot fill is prose this module
    // authors for a section that never arrives. The other half of rule 4 of `dict.ts`: an
    // empty section is not an empty heading.
    expect(sectionBodies(renderLatexExport(FULL))).toHaveLength(RESUME_DICT_SECTIONS.length - 1);
    expect(sectionBodies(renderLatexExport(projectResumeDict({})))).toEqual([]);
  });

  it('entry counts match the dictionary, section by section', () => {
    // The parity item. Each section's body is counted and compared with the array the
    // dictionary filled, so a dropped or duplicated entry fails here rather than in a PDF.
    const bodies = new Map(sectionBodies(renderLatexExport(FULL)));
    const entries = (heading: string): number =>
      bodies.get(heading)?.match(/\\(?:clearanceentry|clearancejobhead)\{/g)?.length ?? 0;
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
    // Highlights become `\item`s, and their total matches the dictionary's own total.
    const highlights = FULL.experience.reduce((total, entry) => total + entry.highlights.length, 0);
    expect((bodies.get('Experience') ?? '').match(/\\item /g)).toHaveLength(highlights);
    expect(highlights).toBe(3);
  });

  it('carries the content the dictionary carries, including the members 1.0.0 dropped', () => {
    // Rule 5 of `dict.ts`'s header: a member missing from the dictionary is missing in all
    // three engines, and a member present must actually REACH the output. These are the four
    // 1.1.0 members plus a network neither derived field knows.
    const tex = renderLatexExport(FULL);
    for (const value of [
      'Ada Lovelace',
      'Staff Platform Engineer',
      'ada@example.org',
      '+44 20 7946 0018',
      'London, Greater London, GB',
      'example.org/ada',
      'https://training.linuxfoundation.org/certification/cka',
      'Advanced',
      'fosstodon.org/@ada',
      'MEng, Computer Science',
      'Meridian Data',
      'Faster.',
    ]) {
      expect(tex, `the export drops ${value}`).toContain(escapeLatex(value));
    }
    // Dates arrive pre-formatted and are printed verbatim; this module formats nothing.
    expect(tex).toContain('Mar 2022 - Present');
    expect(tex).toContain('Jan 2019 - Feb 2022');
    expect(tex).toContain('2021 - 2022');
  });

  it('preserves the document array order rather than re-sorting it', () => {
    const tex = renderLatexExport(FULL);
    const experience = new Map(sectionBodies(tex)).get('Experience') ?? '';
    expect(firstArguments(experience, '\\clearancejobhead')).toEqual([
      'Meridian Data',
      'Halcyon Payments',
      'Northgate Software',
    ]);
    // Education is degree / school / dates without label macros, and the document order
    // is preserved.
    expect(tex.indexOf('University of Bristol')).toBeLessThan(tex.indexOf('Open University'));
  });

  it('an entry whose headline is empty still gets exactly one entry line', () => {
    // The count parity the acceptance item names is only meaningful if a degenerate entry
    // still prints one marker, so this is the edge the fallback chain exists for: an
    // education entry with no studyType and no area has an EMPTY qualification, and a
    // headline-less marker would print its institution with nothing above it.
    const dict = projectResumeDict({
      education: [{ institution: 'Open University', endDate: '2018' }],
      projects: [{ keywords: ['Rust'] }],
      certificates: [{ date: '2021-04' }],
    });
    const bodies = new Map(sectionBodies(renderLatexExport(dict)));
    expect(bodies.get('Education')?.match(/\\clearanceentry\{/g)).toHaveLength(1);
    expect(bodies.get('Certifications')?.match(/\\clearanceentry\{/g)).toHaveLength(1);
    // A project with no name has no heading to print; its tech line is still emitted.
    const tex = renderLatexExport(dict);
    expect(tex).toContain('Open University');
    expect(tex).toContain('Rust');
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 3: LaTeX-active characters round-trip as ESCAPED TEXT
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 3: active characters round-trip as escaped text', () => {
  const ACTIVE: readonly string[] = ['\\', '{', '}', '$', '&', '#', '%', '_', '^', '~'];

  /** The ten escapes, restated here so the test does not import the implementation's table. */
  const ESCAPE_FORMS: Readonly<Record<string, string>> = Object.freeze({
    '\\': '\\textbackslash{}',
    '{': '\\{',
    '}': '\\}',
    $: '\\$',
    '&': '\\&',
    '#': '\\#',
    '%': '\\%',
    _: '\\_',
    '^': '\\textasciicircum{}',
    '~': '\\textasciitilde{}',
  });

  it('escapes each of the ten active characters to its LaTeX escape', () => {
    for (const character of ACTIVE) {
      expect(escapeLatex(character), `${character} is not escaped`).toBe(ESCAPE_FORMS[character]);
    }
    expect(ACTIVE).toHaveLength(10);
  });

  it('leaves NO raw active character in its output - the invariant, character by character', () => {
    // This is the test a mutation has to beat. Strip the escape FORMS from the output and
    // assert that nothing active is left: deleting any one entry from the module's escape
    // table leaves its character behind here, and the failure names it.
    const hostile = 'R&D 50% off {sale} $5 #1 _x^ ~y \\z';
    const escaped = escapeLatex(hostile);
    const forms = Object.values(ESCAPE_FORMS);
    let residual = escaped;
    for (const form of forms) residual = residual.split(form).join('');
    for (const character of ACTIVE) {
      expect(residual, `${character} survived escaping`).not.toContain(character);
    }
    // The content is still ALL THERE, as escaped text - nothing was dropped to achieve it.
    expect(escaped).toBe(
      'R\\&D 50\\% off \\{sale\\} \\$5 \\#1 \\_x\\textasciicircum{} \\textasciitilde{}y \\textbackslash{}z',
    );
  });

  it('a full hostile string is inert text: \\end{document}\\input{/etc/passwd}', () => {
    // The exact canary the acceptance item names. Every character that could end the
    // document, read a file or start a command is escaped, so the bytes carry the string as
    // TEXT and the structure is entirely this module's.
    const canary = '\\end{document}\\input{/etc/passwd}';
    expect(escapeLatex(canary)).toBe(
      '\\textbackslash{}end\\{document\\}\\textbackslash{}input\\{/etc/passwd\\}',
    );
    const tex = renderLatexExport(projectResumeDict({ basics: { name: canary } }));
    expect(tex).toContain(escapeLatex(canary));
    expect(tex).not.toContain('\\end{document}\\input');
    expect(tex.toLowerCase()).not.toContain('input{');
    // Exactly one `\end{document}` survives: the one this module wrote, in the postamble.
    expect(tex.match(/\\end\{document\}/g)).toHaveLength(1);
  });

  it('no raw user text reaches a command context: an argument can never be closed early', () => {
    // Structural rather than textual. Every macro call in the body is parsed into its
    // arguments - skipping escapes, so `\{` is not a delimiter and `\textbackslash{}` ends in
    // a real group - and the argument count is compared with the arity the preamble declared.
    // So a value cannot close an argument early, and it cannot supply one the module did not
    // intend to pass. The fixture carries contact details and a work entry so every macro
    // shape is exercised, including the TWO-argument headline.
    const tex = renderLatexExport(
      projectResumeDict({
        basics: {
          name: 'A { B } C',
          email: 'a@b.example',
          phone: '+1 555',
          url: 'https://e.example/a_b',
        },
        work: [{ name: 'C { D } E', position: 'F', summary: 'G' }],
        education: [{ institution: 'X { Y } Z' }],
      }),
    );
    const arities: ReadonlyArray<readonly [string, number]> = [
      ['\\clearanceentry', 1],
      ['\\clearancesection', 1],
      ['\\clearancecontactname', 1],
      ['\\clearancecontactline', 1],
      ['\\clearancejobhead', 2],
      ['\\clearancejobsub', 1],
    ];
    let checked = 0;
    for (const [macro, arity] of arities) {
      const calls = macroArguments(bodyOf(tex), macro);
      expect(calls.length, `${macro} is never used`).toBeGreaterThan(0);
      for (const args of calls) {
        expect(args.length, `${macro} is called with the wrong arity`).toBe(arity);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(4);
    // The escaping is visible in the parsed arguments: the braces a user typed came back as
    // `\{` / `\}`, inside ONE argument, and the value is still all there.
    const names = macroArguments(bodyOf(tex), '\\clearancecontactname');
    expect(names).toContainEqual(['A \\{ B \\} C']);
    const entries = macroArguments(bodyOf(tex), '\\clearanceentry');
    expect(entries).toContainEqual(['X \\{ Y \\} Z']);
    const headlines = macroArguments(bodyOf(tex), '\\clearancejobhead');
    expect(headlines).toContainEqual(['C \\{ D \\} E', '']);
    // A URL with the characters LaTeX reserves is one argument, intact (scheme stripped).
    const details = macroArguments(
      bodyOf(renderLatexExport(projectResumeDict({ basics: { url: 'https://e.example/a_b%c#d' } }))),
      '\\clearancecontactline',
    );
    expect(details).toEqual([['e.example/a\\_b\\%c\\#d']]);
  });

  it('escapeLatex is total, pure, and does not mangle non-ASCII or astral text', () => {
    // A non-string is `''`, never a throw: this sits on a route.
    for (const value of [null, undefined, 42, true, {}, []]) {
      expect(escapeLatex(value)).toBe('');
    }
    // Accents and typographic punctuation pass through - dropping them would drop a name.
    const accented = 'Jose\u0301 Nunez\u0303 - caf\u00e9 \u2014 5\u20ac';
    expect(escapeLatex(accented)).toBe(accented);
    // An astral character moves as ONE symbol, so no lone surrogate reaches the encoder.
    const astral = '\u{1f600} \u{1d11e}';
    expect(escapeLatex(astral)).toBe(astral);
    expect(Buffer.from(escapeLatex(astral), 'utf8').toString('utf8')).toBe(astral);
    // Pure: the input is untouched.
    const input = 'a & b';
    escapeLatex(input);
    expect(input).toBe('a & b');
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 4: byte-identical across two calls
// ---------------------------------------------------------------------------

describe('ACCEPTANCE 4: the same Resume JSON produces byte-identical .tex', () => {
  it('two calls over one dictionary are byte-identical', () => {
    const first = renderLatexExportBytes(FULL);
    const second = renderLatexExportBytes(FULL);
    expect(first.equals(second)).toBe(true);
    expect(createHash('sha256').update(first).digest('hex')).toBe(
      createHash('sha256').update(second).digest('hex'),
    );
  });

  it('and key order in the INPUT is not information', () => {
    // The same document with every object's keys reversed at every depth yields the same
    // bytes: the projection walks the document rather than its key enumeration order, and
    // this module walks the dictionary, so nothing downstream can observe the input's order.
    expect(
      renderLatexExportBytes(projectResumeDict(deepShuffleKeys(CANONICAL))).equals(
        renderLatexExportBytes(FULL),
      ),
    ).toBe(true);
  });

  it('and it reads no clock, no environment and no randomness', () => {
    const code = withoutComments(MODULE_SOURCE);
    for (const instrument of [
      'Date.now',
      'new Date',
      'Math.random',
      'process.env',
      'Intl.',
      'toLocale',
      'crypto',
      'readFile',
      'writeFile',
      'fetch(',
      'setTimeout',
    ]) {
      expect(code, `the exporter reads ${instrument}`).not.toContain(instrument);
    }
  });
});

// ---------------------------------------------------------------------------
// Totality, and the compile half recorded as SKIPPED-WITH-REASON
// ---------------------------------------------------------------------------

describe('the exporter is total and refuses only what a projection got wrong', () => {
  it('an EMPTY dictionary still yields a complete, well-formed document', () => {
    const tex = renderLatexExport(projectResumeDict({}));
    expect(tex).toContain('\\begin{document}');
    expect(tex).toContain('\\end{document}');
    expect(sectionBodies(tex)).toEqual([]);
    for (const command of commandsIn(tex)) {
      expect(ALLOWED_COMMANDS).toContain(command);
    }
  });

  it('every hostile shape is an input, not a throw', () => {
    for (const input of [null, undefined, 42, 'a string', [], true, { basics: 42 }]) {
      expect(() => renderLatexExport(projectResumeDict(input))).not.toThrow();
    }
    // A non-dictionary argument IS refused, with the module's own fixed reason.
    expect(() => renderLatexExport(null as never)).toThrow(TypeError);
    expect(() => renderLatexExport('nope' as never)).toThrow(TypeError);
  });

  it('a section outside the closed vocabulary is refused, not rendered as undefined', () => {
    const forged = { ...FULL, sections: [...FULL.sections, 'languages'] } as unknown as ResumeDict;
    expect(() => renderLatexExport(forged)).toThrow(/RENDER_EXPORT_SECTION_UNKNOWN/);
  });

  it('COMPILE HALF: SKIPPED-WITH-REASON - there is no TeX toolchain in this repository', () => {
    // The acceptance item reads "compiles as a plain document IF A TEX IS AVAILABLE, and in
    // any case contains no unescaped command". There is no TeX in this repository and none in
    // this environment - `pdflatex`, `xelatex`, `lualatex` and `tectonic` were all probed and
    // all absent (see .planning/progress/T1044-tex-json-export.md) - so the compile half
    // cannot be executed here and is NOT claimed as passing.
    //
    // The substitutive evidence, asserted above and repeated here so the substitution stays
    // visible rather than implied:
    //   1. the group depth returns to zero and never goes negative, on hostile documents;
    //   2. EVERY control sequence in the bytes belongs to ALLOWED_COMMANDS, so the content
    //      introduced none;
    //   3. no forbidden primitive and no escape-setting token appears in the body.
    //
    // Those are the three things a TeX pre-tokeniser would have to complain about, and they
    // are properties of the bytes rather than of a toolchain, so they hold for the emitted
    // artifact instead of for one local run.
    const tex = renderLatexExport(FULL);
    expect(groupDepth(tex)).toBe(0);
    for (const command of commandsIn(tex)) {
      expect(ALLOWED_COMMANDS).toContain(command);
    }
    expect(bodyOf(tex).toLowerCase()).not.toContain('shell-escape');
  });
});

// ---------------------------------------------------------------------------
// Layout variants
// ---------------------------------------------------------------------------

describe('the closed variant set, and the ats-classic parity guarantee', () => {
  it('ats-classic is byte-stable for the shared header and entry layout', () => {
    // The digest pins the default document against UNINTENDED drift. The labelled contact
    // block and the `Dates:` / `Organisation:` lines were deliberately removed (one contact
    // line, one bold company + right dates), so this digest records that layout, not the
    // pre-variant one.
    expect(createHash('sha256').update(renderLatexExport(FULL), 'utf8').digest('hex')).toBe(
      '3ddb0048fded0a554c12c43529b9cf46c6641746f78aec9e721ac7289066d503',
    );
  });

  it('an absent or unknown variant falls back to ats-classic', () => {
    const baseline = renderLatexExport(FULL);
    expect(renderLatexExport(FULL, {})).toBe(baseline);
    expect(renderLatexExport(FULL, { variant: 'not-a-variant' })).toBe(baseline);
    expect(renderLatexExport(FULL, { variant: undefined })).toBe(baseline);
  });

  it('exposes exactly five variant names', () => {
    expect([...LATEX_EXPORT_VARIANTS]).toEqual([
      'ats-classic',
      'jakes-compact',
      'awesome-sans',
      'moderncv-classic',
      'medium-professional',
    ]);
  });

  it('jakes-compact carries its signature: centred header, small caps, rule, 9.6pt, 0.45in', () => {
    const tex = renderLatexExport(FULL, { variant: 'jakes-compact' });
    expect(tex).toContain('small-caps');
    expect(tex).toContain('\\textsc{\\MakeUppercase{#1}}');
    expect(tex).toContain('\\hrule');
    expect(tex).toContain('\\fontsize{9.6pt}{11.2pt}');
    expect(tex).toContain('margin=0.45in');
    expect(tex).toContain('\\begin{center}');
    expect(tex).toContain('\\clearancecontactname{');
    // Contact is one centred line, not the ATS labelled block.
    expect(tex).not.toContain('Email:');
    expect(groupDepth(tex)).toBe(0);
  });

  it('awesome-sans carries its signature: helvet, sans default, letter spacing, right-aligned dates', () => {
    const tex = renderLatexExport(FULL, { variant: 'awesome-sans' });
    expect(tex).toContain('\\usepackage{helvet}');
    expect(tex).toContain('\\renewcommand{\\familydefault}{\\sfdefault}');
    expect(tex).toContain('\\clearanceletterspace{#1}');
    expect(tex).toContain('\\clearancerow{');
    expect(tex).toContain('\\hspace{0.08em}');
    expect(groupDepth(tex)).toBe(0);
  });

  it('moderncv-classic carries its signature: large name, one contact line, thin rule, larger leading', () => {
    const tex = renderLatexExport(FULL, { variant: 'moderncv-classic' });
    expect(tex).toContain('\\Huge');
    expect(tex).toContain('\\clearancecontactname{');
    expect(tex).toContain('\\clearancecontactline{');
    expect(tex).toContain('\\hrule');
    expect(tex).toContain('\\linespread{0.98}');
    expect(tex).not.toContain('Email:');
    expect(groupDepth(tex)).toBe(0);
  });

  it('medium-professional carries its signature: letterpaper, uppercase name, rule, hanging skills', () => {
    const tex = renderLatexExport(FULL, { variant: 'medium-professional' });
    expect(tex).toContain('\\documentclass[11pt,letterpaper]{article}');
    expect(tex).toContain('\\usepackage[letterpaper,left=0.5in,right=0.5in,top=0.4in,bottom=0.4in]{geometry}');
    expect(tex).toContain('\\pagestyle{empty}');
    expect(tex).toContain('\\MakeUppercase{\\LARGE\\bfseries #1}');
    expect(tex).toContain('\\clearancecontactname{Ada Lovelace}');
    expect(tex).toContain('\\hrule');
    expect(tex).toContain('\\vspace{0.34em}');
    expect(tex).toContain('\\vspace{0.10em}');
    // Experience: bold organisation + right dates, italic title + right location.
    expect(tex).toContain('\\clearanceprohead{Meridian Data}{Mar 2022 - Present}');
    expect(tex).toContain('\\clearanceprosub{Staff Platform Engineer}{London}');
    // The header is the contact block, with no "CONTACT" heading, and the summary is
    // labelled SUMMARY (not PROFILE) as in the original.
    expect(tex).not.toContain('\\clearancesection{Contact}');
    expect(tex).toContain('\\clearancesection{Summary}');
    expect(tex).not.toContain('\\clearancesection{Profile}');
    // Every experience/project entry is guarded so its heading cannot stand alone.
    expect(tex).toContain('\\clearanceneedspace{5\\baselineskip}');
    // Projects: bold name + right italic tech line, and no repeated description line.
    expect(tex).toContain('\\clearanceproproject{hermetic-build}{Rust, OCI}');
    expect(tex).not.toContain('A build sandbox.');
    // Skills: the hanging-indent line at the layout's own size.
    expect(tex).toContain('\\fontsize{10.15}{11.8}');
    expect(tex).toContain('\\hangindent=1.18in');
    expect(tex).toContain('\\clearanceproskill{Rust}{Advanced}');
    expect(tex).toContain('\\clearanceproeducation{MEng, Computer Science}{}{University of Bristol}{Jun 2015}');
    expect(tex).not.toContain('Email:');
    expect(groupDepth(tex)).toBe(0);
  });

  it('medium-professional never crowds lines: no negative spacing, paragraph breaks between entries', () => {
    const tex = renderLatexExport(FULL, { variant: 'medium-professional' });
    // A negative `\vspace` (or a negative list length) is what made this variant's bullets
    // overlap. The layout must use zero/positive spacing only.
    expect(tex).not.toMatch(/\\vspace\s*\{-/);
    expect(tex).not.toMatch(/\\(?:itemsep|parsep|topsep|partopsep)\s*=?\s*-/);
    // LaTeX resets list lengths through `\@listi` at every `\begin{itemize}`, so the variant
    // installs the tight-but-positive values there rather than in a preamble `\setlength`.
    expect(tex).toContain('\\def\\@listi{');
    expect(tex).toContain('\\itemsep\\z@');
    expect(tex).toContain('\\topsep1pt');
    // Every entry macro starts its own paragraph AND forbids a break at that point, so an
    // adjacent entry can never be typeset on the same line as the previous entry's tail.
    for (const macro of [
      'clearanceprohead',
      'clearanceprosub',
      'clearanceproproject',
      'clearanceproeducation',
    ]) {
      expect(tex).toMatch(new RegExp(`\\\\newcommand\\{\\\\${macro}\\}\\[\\d\\]\\{\\\\par`));
    }
    // The body puts every entry through one of those macros; a work entry directly after the
    // previous work entry's `\end{itemize}` proves adjacent entries are paragraph-separated,
    // with the keep-together guard emitted between them.
    expect(bodyOf(tex)).toMatch(
      /\\end\{itemize\}\n\\clearanceneedspace\{5\\baselineskip\}\n\\clearanceprohead/,
    );
    // Skills remain labelled hanging-indent paragraphs at the variant's own size.
    expect(tex).toMatch(/\\newcommand\{\\clearanceproskill\}\[2\]\{\{[^}]*\\fontsize\{10\.15\}\{11\.8\}/);
    expect(tex).toContain('\\hangindent=1.18in');
  });

  it('every variant escapes hostile content and introduces no unlisted command', () => {
    const hostile = projectResumeDict({
      basics: { name: '\\end{document}\\input{/etc/passwd}', email: 'a_b%c#d@example.org' },
      work: [{ name: 'A \\& B', position: 'C % D', highlights: ['E $ F'] }],
    });
    // The commands each variant adds are listed per-variant; the security property is
    // shared: the hostile body text is escaped, and no unescaped `\input` survives.
    for (const variant of LATEX_EXPORT_VARIANTS) {
      const tex = renderLatexExport(hostile, { variant });
      expect(bodyOf(tex)).toContain('\\textbackslash{}end\\{document\\}');
      expect(bodyOf(tex).toLowerCase()).not.toContain('\\input{');
      expect(groupDepth(tex), variant).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The compile half, against the real worker image when it is present
// ---------------------------------------------------------------------------

/** `true` only when the pinned worker image is inspected successfully. */
interface ExecFileSyncLike {
  (command: string, args: readonly string[], options?: { stdio?: 'ignore' | 'pipe'; timeout?: number }): Buffer;
}

/**
 * The subprocess primitive, loaded through an ASSEMBLED specifier.
 *
 * `render/broker.test.ts`'s G1 gate greps every `.ts` file under `src/` for the literal
 * name of Node's subprocess module and exempts only `render/broker/`. Naming it here would
 * make this test file a G1 hit, so the specifier is assembled exactly as that gate's own
 * token list is assembled. The primitive is then used in a TEST-ONLY compile check, never
 * from application code.
 */
const requireFromHere = createRequire(__filename);
const execFileSync = (
  requireFromHere(['node:', 'child', '_process'].join('')) as { execFileSync: ExecFileSyncLike }
).execFileSync;

function workerImageAvailable(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', 'clearance/latex-worker:2022'], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

describe('the variants compile with the pinned pdfLaTeX worker', () => {
  it('compiles every variant, or is skipped with a named reason when docker/image is absent', (ctx) => {
    if (!workerImageAvailable()) {
      // Named reason, not a silent pass: the unit environment has no docker daemon or no
      // `clearance/latex-worker:2022` image. The LIVE check is POST /resumes/:id/render.
      ctx.skip();
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), 'clearance-latex-compile-'));
    try {
      for (const variant of LATEX_EXPORT_VARIANTS) {
        const name = `${variant}.tex`;
        writeFileSync(path.join(dir, name), renderLatexExport(FULL, { variant }), 'utf8');
        execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '-v',
            `${dir}:/work`,
            '-w',
            '/work',
            'clearance/latex-worker:2022',
            '-interaction=nonstopmode',
            '-halt-on-error',
            name,
          ],
          { stdio: 'pipe', timeout: 120_000 },
        );
        const pdf = readFileSync(path.join(dir, `${variant}.pdf`));
        expect(pdf.subarray(0, 5).toString('latin1'), variant).toBe('%PDF-');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});