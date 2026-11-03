import { describe, expect, it } from 'vitest';
import {
  EXCERPT_MAX_CHARS,
  SEARCH_DOC_VERSION,
  buildSearchDocument,
  deriveRegion,
  deriveSpecialization,
  deriveWorkMode,
  extractSalary,
  type SearchDocumentSource,
} from './document.js';

function listing(overrides: Partial<SearchDocumentSource> = {}): SearchDocumentSource {
  return {
    id: 'lst-1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'Berlin, Germany',
    source: 'greenhouse',
    sourceUrl: 'https://example.com/jobs/1',
    applyUrl: 'https://example.com/jobs/1/apply',
    postedAt: new Date('2026-10-20T12:00:00.000Z'),
    firstSeenAt: new Date('2026-10-21T12:00:00.000Z'),
    isActive: true,
    description: '<p>We use TypeScript, React, Node.js, AWS and PostgreSQL.</p>',
    ...overrides,
  };
}

describe('buildSearchDocument - defaults and totality', () => {
  it('always emits every field with a typed default', () => {
    const doc = buildSearchDocument({ id: 'only-id' });
    expect(Object.keys(doc)).toEqual([
      'id',
      'title',
      'company',
      'location',
      'source',
      'sourceUrl',
      'applyUrl',
      'postedAt',
      'firstSeenAt',
      'isActive',
      'workMode',
      'seniority',
      'specialization',
      'skills',
      'salary',
      'region',
      'descriptionExcerpt',
      'docVersion',
    ]);
    expect(doc).toMatchObject({
      id: 'only-id',
      title: '',
      company: '',
      location: null,
      source: '',
      sourceUrl: null,
      applyUrl: null,
      postedAt: null,
      firstSeenAt: null,
      isActive: true,
      workMode: null,
      seniority: null,
      specialization: null,
      skills: [],
      salary: null,
      region: null,
      descriptionExcerpt: '',
      docVersion: SEARCH_DOC_VERSION,
    });
  });

  it('strips control characters and trims strings', () => {
    const doc = buildSearchDocument(
      listing({ title: '  Senior\u0000 Backend\nEngineer  ', company: 'Acme\tInc' }),
    );
    expect(doc.title).toBe('Senior Backend Engineer');
    expect(doc.company).toBe('Acme Inc');
  });

  it('stamps SEARCH_DOC_VERSION so a later derivation can backfill', () => {
    expect(SEARCH_DOC_VERSION).toBe('1');
    expect(buildSearchDocument(listing()).docVersion).toBe(SEARCH_DOC_VERSION);
  });
});

describe('workMode - only when explicit, never onsite', () => {
  it('derives remote from an explicit location token', () => {
    expect(deriveWorkMode('Remote - US', 'Backend Engineer')).toBe('remote');
  });

  it('derives hybrid from an explicit title token', () => {
    expect(deriveWorkMode('London, UK', 'Hybrid Product Designer')).toBe('hybrid');
  });

  it('prefers the narrower hybrid state when both words appear', () => {
    expect(deriveWorkMode('Remote (hybrid)', 'Engineer')).toBe('hybrid');
  });

  it('does NOT default an unstated location to onsite', () => {
    const doc = buildSearchDocument(listing({ location: 'Berlin, Germany', title: 'Backend Engineer' }));
    expect(doc.workMode).toBeNull();
  });

  it('ignores an explicit onsite token (no closed value for it)', () => {
    expect(deriveWorkMode('Onsite - Berlin', 'Engineer')).toBeNull();
  });
});

describe('seniority - via inferSeniorityLevel(title)', () => {
  it.each([
    ['Junior Developer', 'junior'],
    ['Software Engineer', null],
    ['Senior Backend Engineer', 'senior'],
    ['Staff Platform Engineer', 'staff'],
    ['Principal Engineer', 'principal'],
    ['Engineering Manager', 'lead'],
  ] as const)('%s -> %s', (title, expected) => {
    expect(buildSearchDocument(listing({ title })).seniority).toBe(expected);
  });
});

describe('specialization - title keyword map, null when unsure', () => {
  it.each([
    ['Senior Backend Engineer', 'backend-engineer'],
    ['Frontend Engineer', 'frontend-engineer'],
    ['Full Stack Engineer', 'fullstack-engineer'],
    ['DevOps Engineer', 'devops-engineer'],
    ['Data Scientist', 'data-scientist'],
    ['Product Manager', 'product-manager'],
    ['Software Engineer', 'software-engineer'],
    ['Chief of Staff', null],
  ] as const)('%s -> %s', (title, expected) => {
    expect(deriveSpecialization(title)).toBe(expected);
  });

  it('does not let the generic rule beat a specific one', () => {
    expect(deriveSpecialization('Machine Learning Engineer')).toBe('data-scientist');
  });
});

describe('skills - curated SKILL_SYNONYMS keys found', () => {
  it('emits canonical keys for canonical or synonym mentions', () => {
    const doc = buildSearchDocument(
      listing({ description: 'Stack: TS, ReactJS, Node, AWS, Postgres, K8s, ML.' }),
    );
    expect(doc.skills).toEqual([
      'typescript',
      'react',
      'node',
      'postgresql',
      'kubernetes',
      'amazon web services',
      'machine learning',
    ]);
  });

  it('caps at 12 keys', () => {
    const doc = buildSearchDocument(
      listing({
        description:
          'javascript typescript react node postgresql kubernetes aws gcp machine learning artificial intelligence',
      }),
    );
    expect(doc.skills.length).toBeLessThanOrEqual(12);
  });

  it('emits [] when no curated key is present', () => {
    expect(buildSearchDocument(listing({ description: 'We are a friendly team.' })).skills).toEqual([]);
  });
});

describe('salary - conservative annual range only', () => {
  it.each([
    ['$120,000–$150,000', { min: 120000, max: 150000, currency: 'USD' }],
    ['USD 100k-140k', { min: 100000, max: 140000, currency: 'USD' }],
    ['€60k - €80k', { min: 60000, max: 80000, currency: 'EUR' }],
    ['£70,000 to £90,000', { min: 70000, max: 90000, currency: 'GBP' }],
  ] as const)('%s -> %o', (text, expected) => {
    expect(extractSalary(text)).toEqual(expected);
  });

  it('returns null for a day rate (sanity: annual salary is >= 10k)', () => {
    expect(extractSalary('Salary: $500-$700 per day')).toBeNull();
  });

  it('rejects a below-annual range even when no rate unit is written', () => {
    expect(extractSalary('$500 - $700')).toBeNull();
  });

  it('returns null for an annual-looking range quoted per day/hour', () => {
    expect(extractSalary('$120,000-$150,000 per day')).toBeNull();
    expect(extractSalary('$100k - $140k / hour')).toBeNull();
  });

  it('returns null when bounds are inverted, above 1M, or currencies mix', () => {
    expect(extractSalary('$150,000 - $120,000')).toBeNull();
    expect(extractSalary('$120,000 - $1,500,000')).toBeNull();
    expect(extractSalary('€60k - $80k')).toBeNull();
  });

  it('returns null when there is no clear range', () => {
    expect(extractSalary('Competitive salary')).toBeNull();
    expect(extractSalary('$120,000')).toBeNull();
  });
});

describe('region - curated location tokens only', () => {
  it.each([
    ['San Francisco, CA', 'us'],
    ['New York, NY', 'us'],
    ['London, United Kingdom', 'uk'],
    ['Berlin, Germany', 'eu'],
    ['São Paulo, Brazil', 'latam'],
    ['Dubai, UAE', 'mena'],
    ['Lagos, Nigeria', 'africa'],
    ['Bengaluru, India', 'apac'],
    ['Moscow, Russia', 'cis'],
    ['Toronto, Canada', null],
    ['Remote', null],
  ] as const)('%s -> %s', (location, expected) => {
    expect(deriveRegion(location)).toBe(expected);
  });

  it('returns null for an ambiguous location', () => {
    expect(deriveRegion('London, Berlin')).toBeNull();
  });
});

describe('descriptionExcerpt - plain text, 280 chars, no ellipsis', () => {
  it('strips HTML and entities and collapses whitespace', () => {
    const doc = buildSearchDocument(
      listing({ description: '<p>Hello &amp; welcome</p><script>evil()</script><div>to   Acme</div>' }),
    );
    expect(doc.descriptionExcerpt).toBe('Hello & welcome to Acme');
  });

  it('truncates at 280 chars without appending an ellipsis', () => {
    const doc = buildSearchDocument(listing({ description: 'x'.repeat(400) }));
    expect(doc.descriptionExcerpt).toHaveLength(EXCERPT_MAX_CHARS);
    expect(doc.descriptionExcerpt.endsWith('...')).toBe(false);
  });
});

describe('determinism', () => {
  it('is independent of input key order', () => {
    const a: SearchDocumentSource = listing();
    const b = {
      description: a.description,
      isActive: a.isActive,
      firstSeenAt: a.firstSeenAt,
      postedAt: a.postedAt,
      applyUrl: a.applyUrl,
      sourceUrl: a.sourceUrl,
      source: a.source,
      location: a.location,
      company: a.company,
      title: a.title,
      id: a.id,
    } as SearchDocumentSource;
    expect(buildSearchDocument(a)).toEqual(buildSearchDocument(b));
  });

  it('is stable across repeated runs', () => {
    const input = listing();
    expect(buildSearchDocument(input)).toEqual(buildSearchDocument(input));
  });
});
