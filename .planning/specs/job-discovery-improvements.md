# Job discovery infrastructure improvements

## OBJECTIVE

Make the backend job-source pipeline return complete and stable listings, fail
gracefully when an individual source is unhealthy, and make source failures
observable. The work is backend-only: it must not remove a scraper, alter
authentication, or modify any frontend code.

## VERIFIED

The following files were read in full during planning:

- `backend/src/jobSources/index.ts`
- `backend/src/jobSources/scrapingBackend.ts`
- `backend/src/jobSources/aggregators.ts`
- `backend/src/jobSources/search.ts`
- `backend/src/routes/jobs.ts`
- `backend/src/routes/boards.ts`
- `backend/package.json`
- `backend/prisma/schema.prisma`
- `backend/src/jobSources/defaultBoards.ts`
- `backend/src/ai/keyManager.ts`
- `backend/src/routes/api.smoke.test.ts`
- `backend/tsconfig.json`

Observed facts that this plan relies on:

1. `index.ts` has a JSON-only `fetcher`, Workday assumes `{ jobs: [] }`, Ashby
   uses an internal GraphQL request and synthesizes a description, and
   Recruitee constructs its URL with `https://#{company}...`. `runSource` is the
   single dispatch point.
2. Both `/api/jobs/search` and `/api/jobs/scan` run sources with
   `Promise.all(...catch(() => []))`, so source failures are currently silently
   discarded. Both routes upsert by `(source, externalId)`.
3. `JobListing` already has `@@unique([source, externalId])`, but source IDs
   are provider-specific, positional in search results, or derived from
   mutable/unsafe values. `JobBoard` has no health fields or health relation.
4. `fast-xml-parser` is already a backend dependency. There is no HTML parser
   dependency. Node is declared as `>=18` and the backend uses strict
   TypeScript/ESM (`NodeNext`).
5. `search.ts` already preserves keyed Tavily/Exa search first, but its
   keyless implementation is Arbeitnow-only. It does not currently make a
   DuckDuckGo request.
6. `scrapingBackend.ts` is an existing, separate unified scraper and is not a
   target for removal or redesign.

## ARCHITECTURE DECISIONS

### 1. Keep all existing source types and scraper backends

Modify the normalizers and orchestration around existing providers; do not
delete or disable any `runSource` case, `SUPPORTED_SCRAPER_PROVIDERS` entry,
or function in `scrapingBackend.ts`. The scraper backend remains BYOK and its
existing routing/error behavior remains unchanged.

### 2. Use Ashby's documented public posting API

Replace the brittle internal GraphQL request in `fetchAshby` with
`GET https://api.ashbyhq.com/posting-api/job-board/{board}`. This is a public,
unauthenticated endpoint and returns `descriptionPlain`/`descriptionHtml`,
published time, job URL, apply URL, department, team, employment type, and
secondary locations. It directly resolves the stub-description defect and
avoids guessing internal GraphQL field names. Do not add authentication or an
Ashby key.

### 3. Parse Workday as JSON or XML based on the response body

Add a text-response fetch helper and use `fast-xml-parser` for XML. Do not
assume a particular `Content-Type`: some public Workday feeds are mislabeled.
Detect JSON after trimming the body (leading `{` or `[`) and parse all other
successful bodies as XML. Normalize RSS 2.0 `channel.item`, Atom `feed.entry`,
and common Workday nested `jobs/job` arrays. Preserve the existing JSON
`data.jobs` behavior.

### 4. Hash stable listing identity, not result position

Add one shared identity helper in `index.ts` (or a new
`backend/src/jobSources/jobIdentity.ts`; the implementor should prefer the new
file to avoid making the source index larger). The canonical identity is:

```text
url:<normalized applyUrl/sourceUrl>
```

when a URL exists, otherwise:

```text
content:<normalized title>|<normalized company>|<normalized location>|<normalized description>
```

Normalize by trimming, collapsing whitespace, lowercasing, stripping URL
fragments, removing known tracking parameters (`utm_*`, `fbclid`, `gclid`),
and removing a trailing URL slash. Hash the canonical UTF-8 string with
Node's `crypto.createHash('sha256')`; use the full lowercase hex digest
prefixed with `sha256-` as `RawJob.externalId`.

This makes repeated fetches deterministic and lets in-memory deduplication
collapse the same URL/content returned by multiple configured boards. Keep
`source` as the provider that supplied the winning record, because the API and
source filter depend on it. Do not change the existing database unique
constraint or rewrite historical IDs; new/upserted records use the stable ID.

### 5. Track health per configured JobBoard, not globally per provider

Create a `JobSourceHealth` model related one-to-one to `JobBoard`. A user may
configure multiple feeds of the same type, so a provider-global record would
misrepresent health. Record success when the source HTTP/pipeline completes,
including a valid empty result; record failure when `runSource` rejects.
Health writes are best effort and must never turn a successful discovery into
a 500 response.

Expose health through the existing authenticated boards API: include the
health object in `GET /api/boards`, and add `GET /api/boards/:id/health` with
ownership enforcement. Do not create an unauthenticated health endpoint.

### 6. Preserve paid/keyed search and make the keyless order explicit

The order is:

1. configured Exa/Tavily key path (existing behavior),
2. keyless Arbeitnow API (primary),
3. keyless DuckDuckGo HTML search (secondary only when Arbeitnow errors or
   produces zero usable matches).

Do not use DuckDuckGo's Instant Answer API; it is not a web-results API. Use
the no-JS HTML endpoint and parse result links/snippets with `cheerio`. A DDG
failure after an Arbeitnow failure should surface the DDG error (with the
Arbeitnow error retained in the log), while an empty DDG result is a valid
empty response. Apply `site:` to both providers where possible and keep
result limits bounded.

## STEPS

### Step 1 - Add source identity and normalization primitives (sequential)

**Files:**

- Create `backend/src/jobSources/jobIdentity.ts`.
- Modify `backend/src/jobSources/index.ts` imports and every normalizer map.

In `jobIdentity.ts`, export these exact contracts:

```ts
import { createHash } from 'node:crypto';
import type { RawJob } from './index.js';

export function canonicalizeJobIdentity(job: Pick<RawJob, 'title' | 'company' | 'location' | 'description' | 'sourceUrl' | 'applyUrl'>): string;
export function jobExternalId(job: Pick<RawJob, 'title' | 'company' | 'location' | 'description' | 'sourceUrl' | 'applyUrl'>): string;
export function dedupeJobs(jobs: RawJob[]): RawJob[];
export function withDeterministicExternalId(job: RawJob): RawJob;
```

Implementation requirements:

- `normalizeText` trims, converts all whitespace runs to one space, and uses
  lowercase. Treat missing values as empty strings.
- `normalizeUrl` uses `new URL`; lowercases protocol/hostname, removes hash,
  removes query keys matching `/^(utm_|fbclid$|gclid$)/i`, and removes a final
  slash except for the root. If URL parsing fails, normalize the raw string
  as text rather than throwing.
- Prefer normalized `applyUrl`, then normalized `sourceUrl`, for the `url:`
  identity. If neither exists, use the four normalized content fields. Do not
  include `source` in the identity.
- Hash with `createHash('sha256').update(canonical, 'utf8').digest('hex')` and
  return `sha256-${digest}`.
- `withDeterministicExternalId` must preserve a non-empty legacy external ID
  only when explicitly needed for existing data? For this rollout, all jobs
  emitted by current fetchers must call it and therefore receive the hash.
  The helper itself always assigns the hash so callers cannot accidentally
  reintroduce positional IDs.
- `dedupeJobs` preserves first-seen order, computes the same canonical key,
  and returns one record per identity. It must also call
  `withDeterministicExternalId` on retained records.
- Avoid a runtime circular import: `jobIdentity.ts` may import the `RawJob`
  interface with `import type` only. `index.ts` imports the functions after its
  interface declaration.

In `index.ts`, import `dedupeJobs` and `withDeterministicExternalId` and apply
the latter in every source map result, including `fetchViaScraper`; then apply
`dedupeJobs` at the end of `runSource` (wrap the switch result in a local
`jobs` variable and return `dedupeJobs(jobs)`). Do not alter the switch's
supported types. In `jobs.ts`, also call `dedupeJobs` on the flattened results
before filtering and slicing in both search and scan, because dedupe must span
multiple configured boards.

### Step 2 - Fix Ashby complete descriptions (independent of Step 3)

**File:** `backend/src/jobSources/index.ts`, `fetchAshby` region around lines
45-73.

Replace the GraphQL POST with:

```ts
const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}`;
const res = await fetch(url, {
  headers: { Accept: 'application/json', 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' },
});
if (!res.ok) throw new Error(`Ashby fetch failed ${res.status} for ${company}`);
const data: any = await res.json();
const jobs: any[] = Array.isArray(data?.jobs) ? data.jobs : [];
```

Filter `isListed !== false`, require a title, and match query against title,
primary location, department, and team. Map exactly as follows:

- `externalId`: `String(j.id || j.jobUrl || j.applyUrl || title)` before the
  deterministic ID pass;
- `source`: `'ashby'`;
- `sourceUrl`: `j.jobUrl || j.applyUrl`;
- `title`: `j.title || 'Untitled Role'`;
- `company`: input `company`;
- `location`: join non-empty `j.location` plus
  `j.secondaryLocations.map(x => x.location)` with `', '`; if empty and
  `j.isRemote`/`j.workplaceType === 'Remote'`, use `'Remote'`;
- `description`: `j.descriptionPlain || stripHtml(j.descriptionHtml || '')`;
- `applyUrl`: `j.applyUrl || j.jobUrl`;
- `postedAt`: `j.publishedAt ? new Date(j.publishedAt) : undefined`.

Add a local `stripHtml` implementation using a temporary tag replacement only
if no existing shared HTML utility is appropriate; it must decode at least
`&amp;`, `&lt;`, `&gt;`, `&quot;`, and `&#39;`, collapse whitespace, and never
throw. Prefer `descriptionPlain`, so no HTML dependency is needed for Ashby.
Do not include the old title/department/type stub as a fallback description.

### Step 3 - Fix Workday XML/RSS parsing (independent of Step 2)

**File:** `backend/src/jobSources/index.ts`, `fetcher` and
`fetchWorkday` regions.

Keep `fetcher` unchanged for JSON-only sources, but add:

```ts
async function fetchText(url: string): Promise<{ body: string; contentType: string }> {
  const res = await fetch(url, { headers: { Accept: 'application/json, application/rss+xml, application/xml, text/xml, text/plain', 'User-Agent': 'ClearanceJobBot/1.0 (+https://clearance.app)' } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return { body: await res.text(), contentType: res.headers.get('content-type') || '' };
}
```

Import `XMLParser` from `fast-xml-parser`. In `fetchWorkday`, parse JSON when
the trimmed body begins with `{` or `[`, otherwise parse XML with:

```ts
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
```

Normalize XML candidates from `rss.channel.item`, `feed.entry`,
`jobs.job`, and `job`; use an `asArray` helper so one item and many items are
handled identically. For Atom links, choose `link['@_href']`, then `link`;
for RSS use `link`. Map field aliases `jobId|id|guid`, `title`,
`company|author`, `location|jobLocation`, `description|summary|content`,
and `pubDate|published|updated`. Support object-valued XML nodes by taking
their `#text` value. Strip HTML from descriptions only when the XML value is
HTML; preserve plain text. Require a non-empty title and URL (source URL may
fall back to apply URL), retain `company || 'Workday'`, and preserve the
existing query title filtering and `postedAt` conversion.

The JSON branch must continue accepting `{ jobs: [...] }` and use the same
normalizer. A malformed XML body must reject with an error identifying the
Workday URL; the route-level health wrapper handles the failure.

### Step 4 - Replace the Recruitee URL template hack (independent)

**File:** `backend/src/jobSources/index.ts`, `fetchRecruitee` around line 181.

Replace:

```ts
fetcher(`https://#{company}.recruitee.com/api/offers.json`.replace('#{company}', company))
```

with:

```ts
const hostCompany = encodeURIComponent(company.trim());
const data = await fetcher(`https://${hostCompany}.recruitee.com/api/offers.json`);
```

Keep the `offers` schema, query filtering, fields, and source name unchanged.
Reject blank company input at the caller/config validation boundary rather than
silently producing a malformed host; `runSource` already returns `[]` when no
board is supplied. Do not change auth or frontend validation.

### Step 5 - Improve keyless search fallback (sequential)

**Files:**

- `backend/src/jobSources/search.ts`
- `backend/package.json` (add `cheerio` runtime dependency; use the current
  compatible 1.x release and update the lockfile through the package manager)

Retain `hasSearchKey`, Exa, and Tavily behavior and their result contracts.
Replace the current `searchJobsKeyless` body with this exact flow:

```ts
async function searchJobsKeyless(config: SearchConfig): Promise<RawJob[]> {
  try {
    const jobs = await searchJobsArbeitnow(config);
    if (jobs.length > 0) return jobs;
  } catch (error) {
    console.warn('[jobSources/search] Arbeitnow fallback failed:', (error as Error).message);
  }
  return searchJobsDuckDuckGo(config);
}
```

`searchJobsArbeitnow` must GET
`https://www.arbeitnow.com/api/job-board-api`, add `?page=N` only if paging
is needed, set the existing bot User-Agent, and inspect up to enough pages to
return `maxResults` (cap page traversal at 3). Match the query case-
insensitively across title, company, tags, and description. Interpret a
simple quoted/`OR` query conservatively by matching any non-empty term; apply
`site` as an additional URL-host substring filter. Map the existing fields,
use stable `j.slug || j.url || j.id` as the pre-hash external value, and use
`created_at` as a Unix-seconds timestamp (`new Date(value * 1000)`) while also
accepting an ISO string. Return `source: 'search'` and pass each result through
the identity helper.

`searchJobsDuckDuckGo` must:

- build `q = site:${config.site} ${config.query}` when `site` is set;
- POST form data `{ q, kl: 'us-en' }` to
  `https://html.duckduckgo.com/html/` with a stable browser-like User-Agent,
  `Accept: text/html`, and a 20-second `AbortSignal.timeout(20_000)`;
- throw `DuckDuckGo search failed: <status>` for non-2xx responses;
- parse `div.result` (excluding `.result--no-result`), title from
  `a.result__a`, URL from its `href`, and snippet from `.result__snippet`;
- resolve DDG redirect URLs with `new URL(href, endpoint)` and return the
  `uddg` query parameter when present;
- map title, URL, snippet, `source: 'search'`, company via the existing URL/
  title helpers, description snippet, and `applyUrl` URL; cap to
  `config.maxResults || 10`, then apply deterministic IDs.

Import `load` from `cheerio` as an ESM import compatible with the installed
version. Do not use regex to parse arbitrary HTML. If DDG returns a CAPTCHA or
no result rows, return an empty list (unless the HTTP request itself fails).

### Step 6 - Add persistent source health (sequential after Step 1)

**Files:**

- `backend/prisma/schema.prisma`
- Create Prisma migration directory
  `backend/prisma/migrations/<timestamp>_add_job_source_health/migration.sql`
- Create `backend/src/jobSources/sourceHealth.ts`
- `backend/src/routes/jobs.ts`
- `backend/src/routes/boards.ts`

Add this exact Prisma model after `JobBoard`:

```prisma
model JobSourceHealth {
  id                 String   @id @default(uuid())
  jobBoardId         String   @unique
  jobBoard           JobBoard @relation(fields: [jobBoardId], references: [id], onDelete: Cascade)
  status             String   @default("unknown") // unknown | healthy | degraded | failed
  consecutiveFailures Int     @default(0)
  lastRunAt          DateTime?
  lastSuccessAt      DateTime?
  lastFailureAt      DateTime?
  lastError          String?  @db.Text
  lastResultCount    Int      @default(0)
  lastLatencyMs      Int?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt
}
```

Add `sourceHealth JobSourceHealth?` to `JobBoard`. The migration SQL must be
exactly equivalent to Prisma's PostgreSQL output and include a foreign key:

```sql
CREATE TABLE "JobSourceHealth" (
  "id" TEXT NOT NULL,
  "jobBoardId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'unknown',
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastRunAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lastResultCount" INTEGER NOT NULL DEFAULT 0,
  "lastLatencyMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobSourceHealth_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobSourceHealth_jobBoardId_key" ON "JobSourceHealth"("jobBoardId");
ALTER TABLE "JobSourceHealth" ADD CONSTRAINT "JobSourceHealth_jobBoardId_fkey"
  FOREIGN KEY ("jobBoardId") REFERENCES "JobBoard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

In `sourceHealth.ts`, export:

```ts
export async function recordSourceSuccess(jobBoardId: string, resultCount: number, latencyMs: number): Promise<void>;
export async function recordSourceFailure(jobBoardId: string, error: unknown, latencyMs: number): Promise<void>;
```

Use `prisma.jobSourceHealth.upsert` keyed by `jobBoardId`. Success sets
`status: 'healthy'`, resets failures to 0, updates `lastRunAt`,
`lastSuccessAt`, `lastResultCount`, `lastLatencyMs`, and clears `lastError`.
Failure sets `status: 'failed'` (use `'degraded'` only if a future partial
result contract is added), increments `consecutiveFailures`, updates
`lastRunAt`, `lastFailureAt`, `lastError`, and latency. Store only
`String(error instanceof Error ? error.message : error).slice(0, 2000)`; never
store response bodies, API keys, cookies, or request URLs containing secrets.
Catch/log persistence errors with
`console.warn('[jobSources/sourceHealth] unable to record source health:', ...)`
and do not rethrow.

In both jobs routes, retain the existing per-source `catch(() => [])` user
behavior but replace it with a board-aware wrapper:

```ts
const startedAt = Date.now();
try {
  const jobs = await runSource(config);
  await recordSourceSuccess(board.id, jobs.length, Date.now() - startedAt);
  return jobs;
} catch (error) {
  await recordSourceFailure(board.id, error, Date.now() - startedAt);
  console.warn('[jobs] source failed:', board.id, (error as Error).message);
  return [];
}
```

Do not log config secrets; the board ID and sanitized error message are the
maximum allowed. Apply this to both `/search` and `/scan`, preserving auth,
ownership, filters, pagination, and response shapes.

Modify `GET /api/boards` to `include: { sourceHealth: true }`. Add before the
`/:id` routes:

```ts
router.get('/:id/health', requireAuth, async (req: Request, res: Response) => {
  try {
    const board = await prisma.jobBoard.findUnique({ where: { id: req.params.id }, include: { sourceHealth: true } });
    if (!board) throw new NotFoundError('Job Board');
    if (board.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    res.json(board.sourceHealth || { status: 'unknown', consecutiveFailures: 0, lastResultCount: 0 });
  } catch (error) {
    handleApiError(error, res);
  }
});
```

Do not add health fields to the auth system, `User`, `AIProviderKey`, or
`JobListing`. Do not make health creation mandatory when a board is created;
the first run creates it lazily.

### Step 7 - Dependency and generated-client update (sequential)

**Files:** `backend/package.json` and the repository lockfile if present.

Add only `cheerio` as a new runtime dependency for DDG HTML parsing. Do not
add an XML package because `fast-xml-parser` is already present. Run
`npm install` from `backend` to update the lockfile, then run
`npm run db:generate` after the Prisma schema change. No frontend package may
be modified.

## CONSTRAINTS

- Do not remove or disable any existing scraper (`scrapingBackend.ts` and all
  scraper providers remain supported).
- Do not change `requireAuth`, auth middleware, JWT/cookie behavior, user
  ownership checks, or key encryption/rotation.
- Do not modify frontend files or frontend API types.
- Preserve all existing source types, route paths, route response fields,
  query filters, and liveness/evaluation behavior.
- Do not expose API keys or raw provider responses in health records or logs.
- Do not make all-source failure fatal to `/search` or `/scan`; one failed
  source must still allow other configured boards to return results.
- Do not replace the existing keyed Tavily/Exa path with DDG. DDG is only the
  no-key secondary after Arbeitnow.
- Do not rewrite existing `JobListing` rows or change its unique constraint.
- Avoid circular imports: `jobIdentity.ts` uses a type-only `RawJob` import;
  `sourceHealth.ts` imports Prisma directly and must not import routes or the
  source index.

## DATABASE / MIGRATION NOTES

There are currently no files under `backend/prisma/migrations/` in the
workspace, so the implementor must create the migration directory and SQL
listed above. Do not use `db:push` as a substitute for a committed migration.
The migration is additive, has no destructive operation, and cascades health
row deletion with its board. Existing boards intentionally have no health row
until their next run; API clients receive an explicit unknown fallback.

## TESTING STRATEGY

Create `backend/src/jobSources/jobSources.test.ts` using Vitest and mocked
`globalThis.fetch`. Tests must assert:

1. `fetchWorkday` accepts JSON and maps the old `{ jobs: [] }` shape.
2. `fetchWorkday` accepts RSS XML with one and multiple `<item>` nodes,
   including `guid`, `link`, `description`, and `pubDate`; it returns title,
   URL, description, and Date correctly.
3. `fetchWorkday` accepts Atom `<entry>` and `link href`.
4. malformed XML rejects and does not return a fabricated job.
5. `fetchAshby` uses the documented GET URL, preserves full
   `descriptionPlain`, falls back from HTML, maps secondary locations and
   published date, and excludes `isListed: false`.
6. Recruitee with `company: 'acme jobs'` requests exactly
   `https://acme%20jobs.recruitee.com/api/offers.json` and maps offers.
7. two equivalent jobs with different provider IDs receive the same
   `sha256-` ID and `dedupeJobs` keeps the first; a changed URL/content gets a
   different ID.
8. Arbeitnow is attempted first, returns filtered stable results, and DDG is
   not called when it succeeds with matches.
9. Arbeitnow HTTP failure and zero-match cases invoke DDG; DDG HTML parsing
   extracts title, decoded `uddg` URL, and snippet, and honors `maxResults`.
10. DDG non-2xx rejects with the specified error; an empty result page returns
    `[]`.

Add route coverage in `backend/src/routes/jobDiscovery.test.ts` (or extend an
existing route test file if the project test harness has a shared DB fixture)
for:

- a successful `/api/jobs/scan` run creating `JobSourceHealth.status ===
  'healthy'`, count, and latency fields;
- a failed source returning HTTP 200 with other source results and creating a
  failed health row with incremented failures and sanitized error;
- `GET /api/boards` including `sourceHealth` and
  `GET /api/boards/:id/health` enforcing 401, 403, 404, and owner success.

If route tests cannot use a real PostgreSQL test database, mock Prisma at the
same boundary used by existing tests; do not weaken production ownership
checks. Existing `backend/src/routes/api.smoke.test.ts` must continue to pass.

Run from `backend`:

```text
npm install
npm run db:generate
npm test
npm run build
```

For migration verification against a disposable PostgreSQL database, run
`npm run db:migrate` with its `DATABASE_URL`; confirm the generated Prisma
client exposes `jobSourceHealth` and that the unique foreign key exists.

## ACCEPTANCE CRITERIA

- Workday RSS/Atom XML produces real listings with links, descriptions, and
  publication dates; JSON Workday feeds remain supported.
- Ashby listings contain the provider's actual plain description or a safe
  HTML-to-text fallback, never the old title/department/type stub.
- Every newly fetched job has a deterministic SHA-256 external ID; duplicate
  URLs/content are collapsed before database upsert and result limiting.
- Every configured board run records success or failure, result count, latency,
  timestamps, consecutive failures, and a bounded error, without exposing
  secrets.
- Keyless search attempts Arbeitnow first and DuckDuckGo HTML second on error
  or zero matches; keyed Exa/Tavily behavior remains intact.
- Recruitee constructs its hostname directly with a safely encoded company
  token and no placeholder replacement.
- No existing scraper, auth path, or frontend file is removed or changed.
- `npm test`, `npm run build`, and the migration/client generation checks pass.

## RISKS

- Workday XML schemas vary. The alias list and RSS/Atom/container handling
  above intentionally tolerate common variants, but an undocumented custom
  namespace may require a fixture adjustment without changing the public
  `RawJob` contract.
- Ashby's documented endpoint may return a different URL or null description
  for unusual boards. The mapper has URL fallbacks and allows an empty
  description, but must not recreate the old synthetic stub.
- DuckDuckGo's HTML endpoint is unofficial and may rate-limit or change
  markup. `cheerio`, bounded requests, stable headers, and empty/failure
  fallback behavior limit blast radius; Arbeitnow remains primary.
- Hashing URL identity means a provider URL migration creates a new listing;
  this is preferable to merging unrelated jobs. Historical IDs remain intact.
- Parallel board runs can update separate health rows safely. Repeated runs of
  the same board can race on `consecutiveFailures`; use Prisma atomic
  `{ increment: 1 }` in the failure update and accept last-write-wins for
  timestamps.
- Adding a relation requires `prisma generate` before TypeScript build; a
  stale generated client is an implementation failure, not a reason to remove
  the health model.

## IMPLEMENTOR MUST VERIFY

- [ ] Only `.planning/**` was pre-existing plan output; implementation touches
      exactly the backend paths named in Steps 1-7 plus the lockfile/migration.
- [ ] `jobIdentity.ts` has no runtime circular import and all source mappers
      use deterministic IDs.
- [ ] `runSource`, `/search`, and `/scan` dedupe at the correct scopes.
- [ ] Workday JSON, RSS, and Atom fixtures pass.
- [ ] Ashby full-description and unlisted-job tests pass.
- [ ] Recruitee encoded-host test passes.
- [ ] Arbeitnow-primary/DDG-secondary tests pass, including site and limit.
- [ ] Health success/failure persistence is best effort and route health is
      authenticated and owner-scoped.
- [ ] The exact additive Prisma migration applies and generated client builds.
- [ ] No scraper source, auth code, frontend code, or evaluation/liveness code
      was modified.
- [ ] `npm test` and `npm run build` pass from `backend`.
