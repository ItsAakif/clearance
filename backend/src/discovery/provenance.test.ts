import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NULL_DATE_SOURCES,
  PROVENANCE_RANKS,
  classify,
  dateLabel,
  isIndexDate,
  isPostedAtSource,
  provenanceRank,
  type DatedRow,
  type PostedAtSource,
} from './provenance.js';

const DATE = new Date('2026-09-10T12:00:00.000Z');
const RAW = '2026-09-10T12:00:00.000Z';

describe('null invariant (N4, acceptance criterion 1)', () => {
  it('exposes exactly the three null-date classes', () => {
    expect([...NULL_DATE_SOURCES].sort()).toEqual(
      ['discovery-at', 'index-date', 'unknown'].sort(),
    );
  });

  it.each([...NULL_DATE_SOURCES])(
    'classify(%s) returns a null postedAt even when given a usable Date',
    (source: PostedAtSource) => {
      const row = classify({ postedAt: DATE, postedAtSource: source, postedAtRaw: RAW });
      expect(row.postedAt).toBeUndefined();
      expect(row.postedAtSource).toBe(source);
      expect(row.postedAtRaw).toBe(RAW);
    },
  );

  it.each([...NULL_DATE_SOURCES])(
    'classify(%s) returns a null postedAt even when given a parseable string date',
    (source: PostedAtSource) => {
      const row = classify({ postedAt: RAW, postedAtSource: source });
      expect(row.postedAt).toBeUndefined();
      expect(row.postedAtSource).toBe(source);
    },
  );

  it.each([...NULL_DATE_SOURCES])(
    'classify(%s) returns a null postedAt even when given a numeric timestamp',
    (source: PostedAtSource) => {
      const row = classify({ postedAt: DATE.getTime(), postedAtSource: source });
      expect(row.postedAt).toBeUndefined();
      expect(row.postedAtSource).toBe(source);
    },
  );

  it('a date without a recognised date-bearing source is dropped, never relabelled', () => {
    for (const missing of [undefined, null, 'bogus-source'] as const) {
      const row = classify({ postedAt: DATE, postedAtSource: missing });
      expect(row.postedAt).toBeUndefined();
      expect(row.postedAtSource).toBe('unknown');
    }
  });
});

describe('date-bearing classes keep a valid date', () => {
  it.each(['source-posted', 'source-updated', 'page-derived'] as const)(
    'classify(%s) keeps a valid Date by value',
    (source: PostedAtSource) => {
      const row = classify({ postedAt: DATE, postedAtSource: source, postedAtRaw: RAW });
      expect(row.postedAt).toBeInstanceOf(Date);
      expect(row.postedAt?.getTime()).toBe(DATE.getTime());
      expect(row.postedAt).not.toBe(DATE);
      expect(row.postedAtSource).toBe(source);
      expect(row.postedAtRaw).toBe(RAW);
    },
  );

  it('an invalid Date never survives, even for a date-bearing class', () => {
    const row = classify({
      postedAt: new Date('not-a-date'),
      postedAtSource: 'source-posted',
    });
    expect(row.postedAt).toBeUndefined();
    expect(row.postedAtSource).toBe('source-posted');
  });
});

describe('postedAtRaw is verbatim audit text, never parsed into postedAt', () => {
  it('an unparseable raw value classifies as unknown with a null date and the raw preserved', () => {
    const raw = 'sometime last spring-ish?!';
    const row = classify({ postedAtRaw: raw });
    expect(row.postedAtSource).toBe('unknown');
    expect(row.postedAt).toBeUndefined();
    expect(row.postedAtRaw).toBe(raw);
  });

  it('keeps an unparseable raw byte-for-byte (whitespace included)', () => {
    const raw = '  Posted: ASAP!! \t';
    const row = classify({ postedAtRaw: raw });
    expect(row.postedAtRaw).toBe(raw);
    expect(row.postedAt).toBeUndefined();
  });

  it('a parseable raw string is still never adopted as postedAt', () => {
    const row = classify({ postedAtSource: 'index-date', postedAtRaw: RAW });
    expect(row.postedAt).toBeUndefined();
    expect(row.postedAtSource).toBe('index-date');
    expect(row.postedAtRaw).toBe(RAW);
  });

  it('a valid explicit date survives alongside an unparseable raw audit string', () => {
    const row = classify({
      postedAt: DATE,
      postedAtSource: 'source-posted',
      postedAtRaw: 'garbage from upstream',
    });
    expect(row.postedAt?.getTime()).toBe(DATE.getTime());
    expect(row.postedAtSource).toBe('source-posted');
    expect(row.postedAtRaw).toBe('garbage from upstream');
  });
});

describe('isIndexDate', () => {
  it('is true only for index-date', () => {
    const sources: Array<PostedAtSource | undefined> = [
      'source-posted',
      'source-updated',
      'page-derived',
      'discovery-at',
      'index-date',
      'unknown',
      undefined,
    ];
    for (const source of sources) {
      expect(isIndexDate({ postedAtSource: source })).toBe(source === 'index-date');
    }
  });
});

describe('dateLabel covers all six classes; Found is never Posted', () => {
  const expected: Record<PostedAtSource, 'Posted' | 'Updated' | 'Found'> = {
    'source-posted': 'Posted',
    'source-updated': 'Updated',
    'page-derived': 'Posted',
    'discovery-at': 'Found',
    'index-date': 'Found',
    unknown: 'Found',
  };

  it.each(Object.keys(expected) as PostedAtSource[])('dateLabel(%s)', (source) => {
    expect(dateLabel({ postedAtSource: source })).toBe(expected[source]);
  });

  it('a Found row is never labelled Posted (asserted for every class)', () => {
    const all: DatedRow[] = (
      [...Object.keys(expected)] as PostedAtSource[]
    ).map((postedAtSource) => ({ postedAtSource }));
    for (const row of all) {
      const label = dateLabel(row);
      expect(['Posted', 'Updated', 'Found']).toContain(label);
      if (label === 'Found') expect(label).not.toBe('Posted');
    }
    expect(dateLabel({ postedAtSource: 'discovery-at' })).toBe('Found');
    expect(dateLabel({ postedAtSource: 'index-date' })).toBe('Found');
    expect(dateLabel({ postedAtSource: 'unknown' })).toBe('Found');
  });

  it('a missing source is Found, never Posted', () => {
    expect(dateLabel({})).toBe('Found');
  });
});

describe('provenanceRank ordering (documented contract for the ordering tie-break)', () => {
  it('pins the exact documented numbers', () => {
    expect(PROVENANCE_RANKS).toEqual({
      'source-posted': 50,
      'source-updated': 40,
      'page-derived': 30,
      'discovery-at': 20,
      'index-date': 10,
      unknown: 0,
    });
  });

  it('orders source-posted > source-updated > page-derived > null-date classes', () => {
    const rank = (s: PostedAtSource) => provenanceRank({ postedAtSource: s });
    expect(rank('source-posted')).toBeGreaterThan(rank('source-updated'));
    expect(rank('source-updated')).toBeGreaterThan(rank('page-derived'));
    for (const nullSource of NULL_DATE_SOURCES) {
      expect(rank('page-derived')).toBeGreaterThan(rank(nullSource));
    }
  });

  it('an index-date row never outranks a source-posted row', () => {
    expect(provenanceRank({ postedAtSource: 'source-posted' })).toBeGreaterThan(
      provenanceRank({ postedAtSource: 'index-date' }),
    );
  });

  it('a missing or unrecognised source ranks as unknown', () => {
    expect(provenanceRank({})).toBe(0);
    expect(provenanceRank({ postedAtSource: undefined })).toBe(0);
  });

  it('isPostedAtSource accepts exactly the six classes', () => {
    for (const s of [
      'source-posted',
      'source-updated',
      'page-derived',
      'discovery-at',
      'index-date',
      'unknown',
    ] as const) {
      expect(isPostedAtSource(s)).toBe(true);
    }
    expect(isPostedAtSource(null)).toBe(false);
    expect(isPostedAtSource('Source-Posted')).toBe(false);
    expect(isPostedAtSource('')).toBe(false);
  });
});

describe('module hygiene (no DB, no clock, no network)', () => {
  it('provenance.ts imports no Prisma and reads no clock', () => {
    const raw = readFileSync(join(process.cwd(), 'src', 'discovery', 'provenance.ts'), 'utf8');
    const code = raw
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/@prisma\/client/);
    expect(code).not.toMatch(/PrismaClient/);
    expect(code).not.toMatch(/from\s+['"][^'"]*prisma/i);
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/fetch\s*\(/);
  });
});
