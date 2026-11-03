// Importer unit tests (T642). All fixtures are synthetic: every host lives
// under example.test and every token/name is invented. No hand-written
// company rows exist anywhere outside these clearly-synthetic fixtures.
import { describe, it, expect } from 'vitest';
import {
  DATASET_ATS_CAREER_PAGE_URLS,
  SEED_BOARD_URL,
  deriveCompanyName,
  emptyStats,
  importPrepared,
  mergeStats,
  parseCsvRecord,
  prepareRow,
  summarize,
  type DatasetManifest,
  type PreparedRow,
  type RegistryStore,
  type SourceRow,
} from './importer.js';
import { extractAts } from './atsUrl.js';

const MANIFEST: DatasetManifest = {
  ...DATASET_ATS_CAREER_PAGE_URLS,
  retrievedAt: '2026-09-20',
};

function src(partial: Partial<SourceRow> & { url: string }): SourceRow {
  return { sourceRef: 'row:1', ...partial };
}

// In-memory fake implementing the RegistryStore contract with the SAME
// field discipline as the Prisma adapter: company refresh touches ONLY
// name/websiteUrl/industries; page re-match is a strict no-op.
interface FakeCompany {
  id: string;
  slug: string;
  name: string;
  websiteUrl: string | null;
  industries: string[] | null;
  registrySource: string;
  registryLicense: string;
  registrySourceRef: string;
}

interface FakePage {
  url: string;
  companyId: string;
  host: string;
  provider: string | null;
  boardToken: string | null;
  tier: number;
  isActive: boolean;
  verifyStatus: string;
  failureCount: number;
}

class FakeStore implements RegistryStore {
  companies = new Map<string, FakeCompany>();
  pages = new Map<string, FakePage>();
  private seq = 0;

  async upsertCompany(args: {
    slug: string;
    create: Omit<FakeCompany, 'id' | 'slug'>;
    refresh: { name: string; websiteUrl: string | null; industries: string[] | null };
  }): Promise<{ id: string; created: boolean }> {
    const existing = this.companies.get(args.slug);
    if (existing) {
      existing.name = args.refresh.name;
      existing.websiteUrl = args.refresh.websiteUrl;
      existing.industries = args.refresh.industries;
      return { id: existing.id, created: false };
    }
    this.seq += 1;
    const company: FakeCompany = { id: `c${this.seq}`, slug: args.slug, ...args.create };
    this.companies.set(args.slug, company);
    return { id: company.id, created: true };
  }

  async upsertCareerPage(args: {
    url: string;
    companyId: string;
    create: { host: string; provider: string | null; boardToken: string | null; tier: number };
  }): Promise<{ created: boolean }> {
    const existing = this.pages.get(args.url);
    if (existing) return { created: false };
    this.pages.set(args.url, {
      url: args.url,
      companyId: args.companyId,
      ...args.create,
      isActive: true,
      verifyStatus: 'unverified',
      failureCount: 0,
    });
    return { created: true };
  }
}

function mustPrepare(row: SourceRow): PreparedRow {
  const result = prepareRow(row, MANIFEST);
  if (!result.ok) throw new Error(`fixture failed to prepare: ${result.reason}`);
  return result.row;
}

describe('prepareRow', () => {
  it('maps a known ATS host to provider/token and tier 1 with provenance', () => {
    const row = mustPrepare(src({ url: 'https://boards.greenhouse.io/acme-test', sourceRef: 'row:7' }));
    expect(row.provider).toBe('greenhouse');
    expect(row.boardToken).toBe('acme-test');
    expect(row.tier).toBe(1);
    expect(row.host).toBe('boards.greenhouse.io');
    expect(row.registrySource).toBe('ats-career-page-urls');
    expect(row.registryLicense).toBe('CC-BY-4.0');
    expect(row.registrySourceRef).toBe('row:7');
    expect(row.slug.length).toBeGreaterThan(0);
  });

  it('maps an unknown host to null provider and tier 3', () => {
    const row = mustPrepare(src({ url: 'https://careers.acme-test.example.test/jobs' }));
    expect(row.provider).toBeNull();
    expect(row.boardToken).toBeNull();
    expect(row.tier).toBe(3);
  });

  it('rejects over-long URLs instead of aborting', () => {
    const long = `https://careers.acme-test.example.test/${'j'.repeat(2000)}`;
    expect(prepareRow(src({ url: long }), MANIFEST)).toEqual({ ok: false, reason: 'url-too-long' });
  });

  it('rejects malformed URLs and non-http schemes', () => {
    expect(prepareRow(src({ url: 'not a url' }), MANIFEST)).toEqual({ ok: false, reason: 'bad-url' });
    expect(prepareRow(src({ url: '' }), MANIFEST)).toEqual({ ok: false, reason: 'empty-url' });
    expect(prepareRow(src({ url: 'ftp://acme-test.example.test/jobs' }), MANIFEST)).toEqual({
      ok: false,
      reason: 'unsupported-scheme',
    });
  });

  it('never writes a row missing a licence', () => {
    const unlicensed: DatasetManifest = { ...MANIFEST, license: '' };
    expect(prepareRow(src({ url: 'https://boards.greenhouse.io/acme-test' }), unlicensed)).toEqual({
      ok: false,
      reason: 'missing-license',
    });
  });

  it('derives a company name from the board token when the dataset has none', () => {
    const row = mustPrepare(src({ url: 'https://jobs.lever.co/acme-test-labs' }));
    expect(row.companyName).toBe('acme test labs');
  });

  it('prefers an explicit dataset name and caps its length', () => {
    const row = mustPrepare(src({ url: 'https://boards.greenhouse.io/acme-test', name: '  Acme Test Inc  ' }));
    expect(row.companyName).toBe('Acme Test Inc');
  });
});

describe('importPrepared idempotence (double run)', () => {
  const fixtures: SourceRow[] = [
    src({ url: 'https://boards.greenhouse.io/acme-test', sourceRef: 'row:1' }),
    src({ url: 'https://jobs.lever.co/acme-test', sourceRef: 'row:2' }),
    src({ url: 'https://careers.acme-test.example.test/jobs', sourceRef: 'row:3' }),
    src({ url: 'https://acme-test.recruitee.com/', sourceRef: 'row:4' }),
  ];

  it('second run creates nothing and preserves verification fields', async () => {
    const store = new FakeStore();
    const rows = fixtures.map(mustPrepare);

    const first = await importPrepared(store, rows, { batchSize: 2 });
    expect(first.pagesCreated).toBe(4);
    expect(first.companiesCreated).toBe(4);

    // Simulate operator + verifier activity between runs.
    const page = store.pages.get('https://boards.greenhouse.io/acme-test');
    if (!page) throw new Error('fixture page missing');
    page.verifyStatus = 'ok';
    page.failureCount = 3;

    const second = await importPrepared(store, rows, { batchSize: 2 });
    expect(second.pagesCreated).toBe(0);
    expect(second.companiesCreated).toBe(0);
    expect(second.pagesMatched).toBe(4);
    expect(store.companies.size).toBe(4);
    expect(store.pages.size).toBe(4);

    const after = store.pages.get('https://boards.greenhouse.io/acme-test');
    expect(after?.verifyStatus).toBe('ok');
    expect(after?.failureCount).toBe(3);
  });

  it('does not resurrect a deactivated page on re-import', async () => {
    const store = new FakeStore();
    const rows = fixtures.map(mustPrepare);
    await importPrepared(store, rows);

    const page = store.pages.get('https://jobs.lever.co/acme-test');
    if (!page) throw new Error('fixture page missing');
    page.isActive = false;

    const rerun = await importPrepared(store, rows);
    expect(rerun.pagesCreated).toBe(0);
    expect(store.pages.get('https://jobs.lever.co/acme-test')?.isActive).toBe(false);
  });

  it('does not merge on name alone: same name, different hosts -> two companies', async () => {
    const store = new FakeStore();
    const rows = [
      mustPrepare(src({ url: 'https://boards.greenhouse.io/acme-shared', name: 'Acme Shared', sourceRef: 'a:1' })),
      mustPrepare(src({ url: 'https://jobs.lever.co/acme-shared', name: 'Acme Shared', sourceRef: 'b:1' })),
    ];
    expect(rows[0].slug).not.toBe(rows[1].slug);
    const stats = await importPrepared(store, rows);
    expect(stats.companiesCreated).toBe(2);
    expect(stats.pagesCreated).toBe(2);
  });

  it('refreshes only name/websiteUrl/industries on re-import', async () => {
    const store = new FakeStore();
    const original = [
      mustPrepare(src({ url: 'https://jobs.lever.co/acme-test', sourceRef: 'row:2' })),
    ];
    await importPrepared(store, original);
    const before = store.companies.get(original[0].slug);
    if (!before) throw new Error('fixture company missing');

    const refreshed = [
      mustPrepare(
        src({
          url: 'https://jobs.lever.co/acme-test',
          name: 'acme test',
          websiteUrl: 'https://acme-test.example.test',
          industries: ['software'],
          sourceRef: 'row:2-rev2',
        }),
      ),
    ];
    expect(refreshed[0].slug).toBe(original[0].slug);
    const stats = await importPrepared(store, refreshed);
    expect(stats.companiesCreated).toBe(0);
    expect(stats.pagesCreated).toBe(0);
    const after = store.companies.get(original[0].slug);
    expect(after?.id).toBe(before.id);
    expect(after?.websiteUrl).toBe('https://acme-test.example.test');
    expect(after?.industries).toEqual(['software']);
    // Provenance is create-only: the original locator survives the refresh.
    expect(after?.registrySource).toBe('ats-career-page-urls');
    expect(after?.registryLicense).toBe('CC-BY-4.0');
    expect(after?.registrySourceRef).toBe('row:2');
  });
});

describe('dry-run summarize', () => {
  it('reports per-provider and per-tier counts and writes nothing', () => {
    const rows = [
      mustPrepare(src({ url: 'https://boards.greenhouse.io/acme-a', sourceRef: 'row:1' })),
      mustPrepare(src({ url: 'https://boards.greenhouse.io/acme-b', sourceRef: 'row:2' })),
      mustPrepare(src({ url: 'https://careers.acme-c.example.test/jobs', sourceRef: 'row:3' })),
    ];
    const summary = summarize(rows);
    expect(summary.total).toBe(3);
    expect(summary.byProvider).toEqual({ greenhouse: 2, '(unknown)': 1 });
    expect(summary.byTier).toEqual({ 'tier-1': 2, 'tier-3': 1 });
  });
});

describe('parseCsvRecord', () => {
  it('splits simple rows and strips CR', () => {
    expect(parseCsvRecord('https://acme-test.example.test/jobs,Workday\r')).toEqual([
      'https://acme-test.example.test/jobs',
      'Workday',
    ]);
  });

  it('handles quoted fields with embedded commas and doubled quotes', () => {
    expect(parseCsvRecord('"https://acme-test.example.test/a?x=1,2",Workday')).toEqual([
      'https://acme-test.example.test/a?x=1,2',
      'Workday',
    ]);
    expect(parseCsvRecord('"say ""hi""",Workday')).toEqual(['say "hi"', 'Workday']);
  });
});

describe('seed board URLs', () => {
  it('every seed URL shape round-trips through extractAts with its token', () => {
    for (const [platform, build] of Object.entries(SEED_BOARD_URL)) {
      const url = build('acme-test');
      const identity = extractAts(url);
      expect(identity.provider).not.toBeNull();
      expect(identity.boardToken).toBe('acme-test');
      expect(platform.length).toBeGreaterThan(0);
    }
  });

  it('derives company names from tokens with host fallback', () => {
    expect(deriveCompanyName('pareto-ai', 'jobs.ashbyhq.com')).toBe('pareto ai');
    expect(deriveCompanyName(null, 'careers.acme-test.example.test')).toBe('careers.acme-test.example.test');
  });
});

describe('stats helpers', () => {
  it('merges batch stats additively', () => {
    const total = mergeStats(
      { ...emptyStats(), rowsSeen: 2, pagesCreated: 2 },
      { ...emptyStats(), rowsSeen: 3, pagesMatched: 3, skipped: [{ ref: 'row:9', reason: 'url-too-long' }] },
    );
    expect(total.rowsSeen).toBe(5);
    expect(total.pagesCreated).toBe(2);
    expect(total.pagesMatched).toBe(3);
    expect(total.skipped).toHaveLength(1);
  });
});
