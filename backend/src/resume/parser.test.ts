import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect } from 'vitest';
import { parseUploadedResume, validateUploadedFile, normalizeDate, resumeToMarkdown, type ParsedResume } from './parser.js';

describe('validateUploadedFile', () => {
  it('accepts a small PDF', () => {
    expect(() => validateUploadedFile(Buffer.from('x'), 'application/pdf', 'r.pdf')).not.toThrow();
  });
  it('rejects oversized files', () => {
    expect(() => validateUploadedFile(Buffer.alloc(11 * 1024 * 1024), 'application/pdf', 'r.pdf')).toThrow();
  });
  it('rejects disallowed mime types', () => {
    expect(() => validateUploadedFile(Buffer.from('x'), 'image/png', 'r.png')).toThrow();
  });
  it('rejects dangerous extensions', () => {
    expect(() => validateUploadedFile(Buffer.from('x'), 'text/plain', 'evil.exe')).toThrow();
  });
});

describe('normalizeDate', () => {
  it('maps "Present" -> Present', () => expect(normalizeDate('Present')).toBe('Present'));
  it('normalizes "Jan 2020" -> 2020-01', () => expect(normalizeDate('Jan 2020')).toBe('2020-01'));
  it('keeps a bare year', () => expect(normalizeDate('2019')).toBe('2019'));
  it('returns empty for blank', () => expect(normalizeDate('')).toBe(''));
});

describe('resumeToMarkdown', () => {
  it('renders name, skills, and sections', () => {
    const p: ParsedResume = {
      personalInfo: { fullName: 'Jane Doe', email: 'j@x.com', phone: '', location: '', linkedin: '', website: '' },
      summary: 'Engineer',
      experience: [],
      education: [],
      projects: [],
      skills: ['TypeScript'],
      languages: [],
      rawText: ''
    };
    const md = resumeToMarkdown(p);
    expect(md).toContain('# Jane Doe');
    expect(md).toContain('## Skills');
    expect(md).toContain('TypeScript');
  });
});

// ==================== T1053: THE TECHNOLOGY-LINE LABEL ====================

/**
 * The shipped label, restated here so the table below is a test of a KNOWN pattern rather
 * than of whatever the module happens to contain. The doc/code drift guard in the first test
 * is what ties this copy to `parser.ts`.
 */
const TECH_LINE_LABEL = /^(?:technologies|tech|stack)\s*:/i;

/** Drive the real, public parse path so the assertions are about the parser's OUTPUT. */
async function parseText(...lines: string[]): Promise<ParsedResume> {
  const text = ['Ada Lovelace', 'ada@example.com', '', ...lines].join('\n');
  return parseUploadedResume(Buffer.from(text, 'utf8'), 'text/plain');
}

describe('T1053: the technology-line label is anchored, not a bare substring match', () => {
  it('DRIFT GUARD: parser.ts holds the anchored alternation, in ONE shared constant', () => {
    // This is the assertion the mutation kills. The defect was a MISSING GROUP in
    // `/^technologies|tech|stack\s*:/i`, which made the alternation unanchored, so the guard
    // has to see both halves of the fix: the anchored literal, and the absence of the old one.
    const source = readFileSync(path.join(__dirname, 'parser.ts'), 'utf8');
    // Comments are stripped first: this test QUOTES the old pattern in order to explain it
    // (that is the module's own comment above the constant), and prose about a pattern is
    // not the pattern. Same rule as `broker.test.ts`'s G1/G2 gates.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    expect(
      code,
      'parser.ts must not keep the ungrouped alternation, which reads as (^technologies)|(tech)|(stack\\s*:)',
    ).not.toContain('^technologies|tech|stack');
    expect(code).toContain('const TECH_LINE_LABEL = /^(?:technologies|tech|stack)\\s*:/i;');
    // ...and BOTH sites that ask the question use it. Two sites with two copies of the
    // pattern is how they drifted apart in the first place, so the count is pinned.
    expect(code.match(/TECH_LINE_LABEL\.test\(/g)).toHaveLength(2);
  });

  it('TABLE: a leading technologies/tech/stack label plus a colon matches, and nothing else does', () => {
    const cases: ReadonlyArray<{ line: string; isLabel: boolean }> = [
      // The three positive forms the contract names. `Tech:` and `Stack:` reached the old
      // pattern only through its bare `tech` substring alternative, and `Technologies:` only
      // because `^technologies` happened to be the first branch.
      { line: 'Tech: React, Node', isLabel: true },
      { line: 'Technologies: Go', isLabel: true },
      { line: 'Stack: Rust', isLabel: true },
      // A label with no colon is not a label: the `\s*:` guard used to apply to the WRONG
      // branch of the alternation, so nothing actually required a colon.
      { line: 'Stack Rust', isLabel: false },
      { line: 'tech React, Node', isLabel: false },
      // The defect the fix is named for: the substring alone used to be enough.
      { line: 'We shipped fintech products', isLabel: false },
      { line: 'mytech stack', isLabel: false },
      { line: 'Fintech', isLabel: false },
    ];
    for (const { line, isLabel } of cases) {
      expect(TECH_LINE_LABEL.test(line), `"${line}" should ${isLabel ? '' : 'not '}be a label`).toBe(
        isLabel,
      );
    }
    // The historical defect, stated as a fact about the OLD pattern so the table above has a
    // visible reason to exist. Note what it did and did not do, because the difference
    // matters: the bare `tech` branch required NO colon, so a line merely CONTAINING `tech`
    // was a label; the `stack` branch DID carry `\s*:`, so `Stack Rust` was correctly
    // rejected even by the old pattern. The defect was the missing GROUP, not a missing
    // colon - the colon guard was simply attached to the wrong branch.
    const ungrouped = /^technologies|tech|stack\s*:/i;
    expect(ungrouped.test('We shipped fintech products')).toBe(true);
    expect(ungrouped.test('tech React, Node')).toBe(true);
    expect(ungrouped.test('Stack Rust')).toBe(false);
    expect(ungrouped.test('Tech: React')).toBe(true);
  });

  it('a "Fintech" project line is a project, never a technology claim', async () => {
    // End-to-end through the public entry point. The tech line is consumed as the current
    // project's technology list, and the Fintech line - which CONTAINS the substring `tech` -
    // becomes its own project entry contributing NO technology. The acceptance item is the
    // second assertion: nothing in the parse output treats that line as a technology.
    const parsed = await parseText(
      'PROJECTS',
      'Risk Engine',
      'Tech: React, Node',
      'We shipped fintech products for three banks',
    );
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[0].title).toBe('Risk Engine');
    expect(parsed.projects[0].tech).toEqual(['React', 'Node']);
    expect(parsed.projects[1].title).toBe('We shipped fintech products for three banks');
    expect(parsed.projects[1].tech).toEqual([]);
    // No technology anywhere in the parse carries a fragment of the Fintech line.
    for (const project of parsed.projects) {
      for (const tech of project.tech) expect(tech.toLowerCase()).not.toContain('fintech');
    }
    expect(JSON.stringify(parsed.skills).toLowerCase()).not.toContain('fintech');
    expect(JSON.stringify(parsed.languages).toLowerCase()).not.toContain('fintech');
  });

  it('"Stack:" attaches to the current project; a colon-less label does not', async () => {
    const parsed = await parseText('PROJECTS', 'Ledger Service', 'Stack: Rust, Go', 'Stack Rust');
    expect(parsed.projects[0].title).toBe('Ledger Service');
    expect(parsed.projects[0].tech).toEqual(['Rust', 'Go']);
    // The colon-less line is a project of its own, with an empty technology list.
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.projects[1].title).toBe('Stack Rust');
    expect(parsed.projects[1].tech).toEqual([]);
  });

  it('DOCUMENTED PRE-EXISTING QUIRK, unchanged here: "Technologies:" is claimed as a SKILLS header', async () => {
    // NOT a change and NOT in scope for T1053; pinned so that a future edit to either the
    // section patterns or this label is deliberate. `detectSections` runs BEFORE
    // `parseProjects`, and `SECTION_PATTERNS.skills` matches `^technologies`, so a
    // "Technologies:" line inside a projects section never reaches the project parser at
    // all: it switches the section and its own text is dropped as a header. T1053 narrows
    // the project label only; this behaviour is identical before and after the fix.
    const parsed = await parseText('PROJECTS', 'Risk Engine', 'Technologies: Go');
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].tech).toEqual([]);
    expect(JSON.stringify(parsed.projects)).not.toContain('Go');
  });

  it('the capture contract is unchanged: the value still splits on "," and "-" after the colon', async () => {
    // T1053 narrows the PATTERN. The split is deliberately untouched, including its quirks:
    // a hyphen inside a technology name still splits ("scikit-learn" -> two entries). Pinned
    // here so a future "while we are in here" change to the delimiter set is a deliberate act
    // rather than a silent one.
    const parsed = await parseText('PROJECTS', 'Risk Engine', 'Tech: scikit-learn, Node');
    expect(parsed.projects[0].tech).toEqual(['scikit', 'learn', 'Node']);
  });
});
