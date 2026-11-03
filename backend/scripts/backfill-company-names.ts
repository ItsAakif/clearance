// Backfill real company names onto active catalogue rows.
//
// The Deep sweep used to persist the adapter's `company`, which for every ATS
// board is the board token (e.g. `hss`, `skit`, `0g`). The registry already
// knows the display name: `CompanyCareerPage.boardToken` + `companyId` ->
// `Company.name`. This script walks active `JobListing` rows, parses the board
// token back out of `sourceUrl` per provider, looks the token up in the
// registry, and updates BOTH `JobListing.company` and the derived
// `searchDocument.company` (the catalogue reads the document, not the column).
//
// Idempotent: a second run finds every row already carrying the registry name
// and updates zero rows.
//
// Run: cd backend && npx tsx scripts/backfill-company-names.ts
// (DATABASE_URL must point at the target database.)

import { Prisma } from '@prisma/client';
import prisma from '../src/lib/prisma.js';
import { buildSearchDocument } from '../src/search/document.js';

const BATCH_SIZE = 200;

/** `JobListing.source` -> registry provider id. */
const SOURCE_PROVIDER: Readonly<Record<string, string>> = {
  greenhouse: 'greenhouse',
  lever: 'lever',
  ashby: 'ashby',
  workable: 'workable',
  jobvite: 'jobvite',
  smartrecruiters: 'smartrecruiters',
  rippling: 'rippling',
  recruitee: 'recruitee',
  teamtailor: 'teamtailor',
  breezyhr: 'breezy',
  pinpoint: 'pinpointhq',
  bamboohr: 'bamboohr',
  freshteam: 'freshteam',
};

/** Providers whose token is the first path segment on these hosts. */
const PATH_HOSTS: Readonly<Record<string, readonly string[]>> = {
  greenhouse: ['boards.greenhouse.io'],
  lever: ['jobs.lever.co'],
  ashby: ['jobs.ashbyhq.com'],
  workable: ['apply.workable.com', 'jobs.workable.com'],
  jobvite: ['jobs.jobvite.com'],
  rippling: ['ats.rippling.com'],
};

/** Providers whose token is the first host label before this domain. */
const SUBDOMAIN_DOMAINS: Readonly<Record<string, string>> = {
  recruitee: 'recruitee.com',
  teamtailor: 'teamtailor.com',
  breezy: 'breezy.hr',
  pinpointhq: 'pinpointhq.com',
  bamboohr: 'bamboohr.com',
  freshteam: 'freshteam.com',
};

export interface BoardRef {
  provider: string;
  token: string;
}

function cleanToken(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  let token = value.trim();
  if (token.length === 0) return null;
  try {
    token = decodeURIComponent(token);
  } catch {
    // Keep the raw segment when it is not valid percent-encoding.
  }
  return token.length > 0 ? token : null;
}

function firstPathSegment(url: URL): string | null {
  const segment = url.pathname.split('/').find((part) => part.length > 0);
  return cleanToken(segment);
}

/**
 * Parse the board token from a stored `sourceUrl`, using the provider implied
 * by `source`. Returns null when the source is unsupported or the URL does not
 * carry that provider's token shape.
 */
export function parseBoardToken(source: string, sourceUrl: string): BoardRef | null {
  const provider = SOURCE_PROVIDER[source];
  if (!provider) return null;

  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');

  if (provider === 'smartrecruiters') {
    const segments = url.pathname.split('/').filter(Boolean);
    if (host === 'jobs.smartrecruiters.com') {
      const token = cleanToken(segments[0]);
      return token ? { provider, token } : null;
    }
    if (host === 'api.smartrecruiters.com') {
      if (segments[0] !== 'v1' || segments[1] !== 'companies') return null;
      const token = cleanToken(segments[2]);
      return token ? { provider, token } : null;
    }
    return null;
  }

  const domain = SUBDOMAIN_DOMAINS[provider];
  if (domain) {
    const suffix = `.${domain}`;
    if (!host.endsWith(suffix)) return null;
    const label = host.slice(0, -suffix.length);
    const token = cleanToken(label);
    return token && !token.includes('.') ? { provider, token } : null;
  }

  const hosts = PATH_HOSTS[provider];
  if (!hosts || !hosts.includes(host)) return null;
  const token = firstPathSegment(url);
  return token ? { provider, token } : null;
}

function pairKey(provider: string, token: string): string {
  return `${provider}\u0000${token}`;
}

async function lookupCompanyNames(
  refs: Map<string, BoardRef>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (refs.size === 0) return names;

  const pages = await prisma.companyCareerPage.findMany({
    where: {
      boardToken: { not: null },
      OR: [...refs.values()].map(({ provider, token }) => ({ provider, boardToken: token })),
    },
    select: {
      provider: true,
      boardToken: true,
      company: { select: { name: true } },
    },
  });

  for (const page of pages) {
    if (typeof page.provider !== 'string' || typeof page.boardToken !== 'string') continue;
    const name = typeof page.company?.name === 'string' ? page.company.name.trim() : '';
    if (name.length === 0) continue;
    names.set(pairKey(page.provider, page.boardToken), name);
  }
  return names;
}

interface ScannedRow {
  id: string;
  title: string;
  company: string;
  location: string | null;
  source: string;
  sourceUrl: string;
  applyUrl: string | null;
  postedAt: Date | null;
  firstSeenAt: Date | null;
  isActive: boolean;
  description: string;
}

async function fetchBatch(cursor: string, take: number): Promise<ScannedRow[]> {
  return prisma.jobListing.findMany({
    where: cursor
      ? { isActive: true, id: { gt: cursor } }
      : { isActive: true },
    orderBy: { id: 'asc' },
    take,
    select: {
      id: true,
      title: true,
      company: true,
      location: true,
      source: true,
      sourceUrl: true,
      applyUrl: true,
      postedAt: true,
      firstSeenAt: true,
      isActive: true,
      description: true,
    },
  });
}

/** Active rows whose `company` still equals a registry board token. */
async function countTokenLikeCompanies(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count
    FROM "JobListing" j
    WHERE j."isActive" = true
      AND EXISTS (
        SELECT 1
        FROM "CompanyCareerPage" p
        WHERE p."boardToken" IS NOT NULL
          AND lower(p."boardToken") = lower(j."company")
      )
  `;
  return rows[0]?.count ?? 0;
}

/** Every board token the registry knows, lower-cased (used to reject token names). */
async function loadKnownTokens(): Promise<Set<string>> {
  const rows = await prisma.companyCareerPage.findMany({
    where: { boardToken: { not: null } },
    select: { boardToken: true },
    distinct: ['boardToken'],
  });
  const tokens = new Set<string>();
  for (const row of rows) {
    if (typeof row.boardToken === 'string' && row.boardToken.length > 0) {
      tokens.add(row.boardToken.toLowerCase());
    }
  }
  return tokens;
}

interface Example {
  before: string;
  after: string;
  title: string;
  source: string;
}

async function main(): Promise<void> {
  const beforeTokenLike = await countTokenLikeCompanies();
  const knownTokens = await loadKnownTokens();
  const now = new Date();
  let cursor = '';
  let scanned = 0;
  let matched = 0;
  let updated = 0;
  let batches = 0;
  const examples: Example[] = [];

  for (;;) {
    const rows = await fetchBatch(cursor, BATCH_SIZE);
    if (rows.length === 0) break;
    batches += 1;

    const refs = new Map<string, BoardRef>();
    for (const row of rows) {
      const ref = parseBoardToken(row.source, row.sourceUrl);
      if (ref) refs.set(pairKey(ref.provider, ref.token), ref);
    }
    const names = await lookupCompanyNames(refs);

    for (const row of rows) {
      scanned += 1;
      const ref = parseBoardToken(row.source, row.sourceUrl);
      if (!ref) continue;
      const name = names.get(pairKey(ref.provider, ref.token));
      if (!name) continue;
      matched += 1;
      // Only replace a board token (the sweep's value), never overwrite a real
      // name that another ingest path already stored. The registry name is only
      // an improvement when it differs from the token.
      const current = row.company.trim();
      const stillToken = current.length === 0 || current === ref.token;
      if (!stillToken || current === name) continue;
      // A registry "name" that is itself a board token is no better than the
      // row's current token (the live registry derives names from tokens), so
      // never trade one token for another.
      if (knownTokens.has(name.toLowerCase())) continue;

      const before = row.company;
      const document = buildSearchDocument({ ...row, company: name });
      await prisma.jobListing.update({
        where: { id: row.id },
        data: {
          company: name,
          searchDocument: document as unknown as Prisma.InputJsonValue,
          searchUpdatedAt: now,
        },
      });
      updated += 1;
      if (examples.length < 5) {
        examples.push({ before, after: name, title: row.title, source: row.source });
      }
    }

    cursor = rows[rows.length - 1].id;
    console.log(
      `[company-backfill] batch=${batches} scanned=${scanned} matched=${matched} updated=${updated} cursor=${cursor}`,
    );
  }

  const afterTokenLike = await countTokenLikeCompanies();
  console.log(
    `[company-backfill] scanned=${scanned} matched=${matched} updated=${updated} remainingTokenLike=${afterTokenLike} (before=${beforeTokenLike})`,
  );
  if (examples.length === 0) {
    console.log('[company-backfill] examples: none (nothing needed updating)');
  } else {
    console.log(`[company-backfill] examples (${examples.length}):`);
    for (const example of examples) {
      console.log(
        `  ${example.before} -> ${example.after} | ${example.source} | ${example.title}`,
      );
    }
  }
}

main()
  .catch((error) => {
    console.error('[company-backfill] failed', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
