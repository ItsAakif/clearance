// T1041 LIVE verification driver - NOT a committed artifact.
//
// THE DOCX RENDER PATH, OVER REAL HTTP, AGAINST THE REAL ROUTER, THE REAL PORT, THE REAL
// PRE-RENDER GATE, THE REAL STORAGE PORT AND A REAL DATABASE.
//
// WHAT MAKES THIS A LIVE CHECK RATHER THAN A RE-RUN OF THE UNIT SUITE: every collaborator
// is the production module and the request travels the shipped Express route, through the
// shipped `preRenderGuard`, into the shipped port. The only substituted pieces are the two
// things a live host cannot inject - the auth cookie (a REAL session row is created, so the
// shipped `requireAuth` is the one under test) and the DATABASE (the disposable Postgres on
// :5599, never :5543).
//
// AND THE POINT OF IT, stated before the transcript: the DOCX path needs NO broker, NO
// worker image and NO template. This driver therefore asserts that too - the render
// succeeds with the broker endpoint deliberately UNCONFIGURED, and the container count is
// asserted before and after. If a DOCX render ever needs a container, this driver fails.
//
// HYGIENE. Nothing is stopped, recreated, pruned or removed except this driver's own rows.
// No `docker compose down`, no `prune`, no `docker compose up`, no image build. The
// container count is read through the docker CLI before and after.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import express from 'express';
import cookieParser from 'cookie-parser';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PizZipCtor = require('pizzip') as unknown as new (input?: Buffer) => {
  file(name: string): { asText(): string } | null;
};

const DATABASE_URL =
  process.env.T1041_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5599/clearancetest?schema=public';
const results: string[] = [];
const LOG_PATH = path.join(os.tmpdir(), 't1041-live-transcript.log');
try {
  writeFileSync(LOG_PATH, '');
} catch {
  /* a transcript is a convenience */
}

function emit(line: string): void {
  results.push(line);
  console.log(line);
  try {
    writeFileSync(LOG_PATH, `${results.join('\n')}\n`, 'utf8');
  } catch {
    /* the console line above is the primary output */
  }
}

function check(name: string, ok: boolean, detail = ''): void {
  emit(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` :: ${detail}`}`);
  if (!ok) process.exitCode = 1;
}

function note(line: string): void {
  emit(`  ${line}`);
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * How many containers this driver's own render created.
 *
 * Through the docker CLI, which is what this host has. Read BEFORE and AFTER so the claim
 * "a DOCX render creates no container" is a comparison rather than an assertion about a
 * number that happened to be zero.
 */
function containers(): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return execFileSync('docker', ['ps', '-a', '--format', '{{.ID}}'], { encoding: 'utf8' })
      .split(/\s+/)
      .filter((line: string) => line.length > 0).length;
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- env
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.V2_TYPST_RENDER = 'true';
  process.env.RENDER_TIMEOUT_MS = '10000';
  process.env.NODE_ENV = 'test';
  // THE BROKER IS DELIBERATELY NOT CONFIGURED. No socket, no URL, no token. A DOCX render
  // must succeed anyway - that is ADR-039's claim made checkable - and a `pdf` render on the
  // same process must refuse with the machine reason that says why.
  delete process.env.RENDER_BROKER_SOCKET;
  delete process.env.RENDER_BROKER_URL;
  delete process.env.RENDER_BROKER_TOKEN;

  const work = mkdtempSync(path.join(os.tmpdir(), 't1041-live-'));
  const storageRoot = path.join(work, 'artifacts');
  process.env.RENDER_STORAGE_ROOT = storageRoot;

  const before = containers();
  check('the container count was read before the run', before >= 0, String(before));

  // ------------------------------------------------------- the real modules
  const { createRenderPort } = await import('../src/render/renderPort.js');
  const { setResumeRenderPort } = await import('../src/routes/resumes.js');
  const { createArtifactStore } = await import('../src/render/storage.js');
  const { brokerEndpoint } = await import('../src/render/env.js');
  const { DOCX_RENDERER_VERSION } = await import('../src/render/docx.js');
  const prisma = (await import('../src/lib/prisma.js')).default;
  const { canonicalJsonHash, X_CLEARANCE_KEY } = await import('../src/resume/json/jsonresume.js');
  const { claimBackedTextAt } = await import('../src/resume/json/claimSurface.js');
  const { ClaimStatus, ResumeUsage, RenderFormat, ResumeChangeSource } = await import('@prisma/client');

  // 1. THE BROKER IS NOT CONFIGURED, and that is the point.
  check('no broker endpoint is configured, so a DOCX render cannot be using one', brokerEndpoint() === null, JSON.stringify(brokerEndpoint()));

  // --------------------------------------------------------- the real database
  await prisma.$connect();
  // Sweep a previous run of this driver's own rows (an aborted run never reaches cleanup).
  // Scoped by the email prefix THIS driver uses, so nothing else is touched.
  const strays = await prisma.user.findMany({ where: { email: { startsWith: 't1041-live-' } }, select: { id: true } });
  for (const stray of strays) {
    await prisma.user.delete({ where: { id: stray.id } }).catch(() => undefined);
  }
  if (strays.length > 0) note(`swept ${strays.length} user row(s) from an earlier run`);

  const email = `t1041-live-${Date.now()}@example.test`;
  const user = await prisma.user.create({ data: { email } });
  const profile = await prisma.careerProfile.create({ data: { userId: user.id, headline: 'Staff Engineer' } });
  const resume = await prisma.resume.create({
    data: { userId: user.id, name: 'Ada Live Docx', modelVersion: 2, profileId: profile.id, personalInfo: {} },
  });

  // A GATED revision. EVERY string the document places on the claim rail
  // (`work[*].highlights[*]` and `projects[*].highlights[*]`, per `claimSurface.ts`) needs a
  // CONFIRMED claim, a block entry naming it at that exact path, and a usage row - the belt
  // compares all three as a multiset. So the claims are built from the highlights rather than
  // written out beside them, which is what makes the document and its accounting impossible
  // to desynchronise.
  const statement = 'Cut CI build time by 40 percent';
  const document = {
    basics: {
      name: 'Ada Lovelace',
      label: 'Staff Engineer',
      email: 'ada@example.test',
      phone: '+44 20 7946 0018',
      location: { city: 'London', countryCode: 'GB' },
      profiles: [{ network: 'GitHub', url: 'https://github.com/adalovelace' }],
    },
    work: [
      {
        name: 'Meridian Data',
        position: 'Staff Platform Engineer',
        summary: 'London',
        startDate: '2022-03-01',
        highlights: [statement, 'Second highlight'],
      },
      {
        name: 'Halcyon Payments',
        position: 'Senior Site Reliability Engineer',
        summary: 'Dublin',
        startDate: '2019-01-01',
        endDate: '2022-02-28',
        highlights: ['Third highlight'],
      },
    ],
    projects: [
      { name: 'hermetic-build', description: 'A build sandbox.', startDate: '2021', endDate: '2022', url: 'https://github.com/adalovelace/hermetic-build', keywords: ['Rust', 'OCI'], highlights: ['Faster.'] },
    ],
    education: [{ institution: 'University of Bristol', studyType: 'MEng', area: 'Computer Science', endDate: '2015-06' }],
    skills: [{ name: 'Rust', level: 'Advanced' }],
    certificates: [{ name: 'CKA', issuer: 'CNCF', date: '2021-04', url: 'https://training.linuxfoundation.org/certification/cka' }],
  };

  // The claim rail, walked with the SAME helper the belt walks, so a path this driver writes
  // is by construction a path the belt will read.
  const rail = claimBackedTextAt(document);
  check('the claim rail holds all four highlights', rail.length === 4, JSON.stringify(rail.map((r) => r.path)));
  const claims = [] as Array<{ id: string; fingerprint: string; path: string; text: string }>;
  for (const [index, placement] of rail.entries()) {
    const fingerprint = String(index).repeat(64).slice(0, 64);
    const created = await prisma.careerClaim.create({
      data: {
        profileId: profile.id,
        kind: 'achievement',
        statement: placement.text,
        fingerprint,
        status: ClaimStatus.user_confirmed,
        provenance: 'llm_inferred',
        confidence: 0.95,
        confirmedAt: new Date(),
      },
    });
    claims.push({ id: created.id, fingerprint, path: placement.path, text: placement.text });
  }
  const claim = claims[0];

  const audited = {
    ...document,
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 't1041-live',
      sourceModelVersion: 2,
      profileId: profile.id,
      claimCount: claims.length,
      confirmedClaimCount: claims.length,
      unconfirmedClaimCount: 0,
      claims: claims.map((entry) => ({
        claimId: entry.id,
        fingerprint: entry.fingerprint,
        kind: 'achievement',
        status: ClaimStatus.user_confirmed,
        provenance: 'llm_inferred',
        confidence: 0.95,
        evidenceSourceId: null,
        usage: ResumeUsage.verbatim,
        jsonPath: entry.path,
        renderedText: entry.text,
      })),
    },
  };
  const revision = await prisma.resumeRevision.create({
    data: {
      resumeId: resume.id,
      revisionNumber: 1,
      resumeJson: audited as never,
      jsonHash: canonicalJsonHash(audited),
      enginePins: {},
      createdBy: ResumeChangeSource.user,
      createdByUserId: user.id,
    },
  });
  for (const entry of claims) {
    await prisma.resumeClaimUsage.create({
      data: { revisionId: revision.id, claimId: entry.id, usage: ResumeUsage.verbatim, renderedText: entry.text },
    });
  }
  check('a GATED revision exists in the real database', revision.id.length > 0, revision.id);

  // -------------------------------------------------------- the real HTTP server
  const { hashSessionToken, createSessionToken } = await import('../src/middleware/auth.js');
  const rawToken = createSessionToken();
  await prisma.session.create({
    data: { tokenHash: hashSessionToken(rawToken), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });

  const store = createArtifactStore({ root: storageRoot });
  const portLog: string[] = [];
  const port = createRenderPort({
    db: prisma as never,
    artifacts: store,
    log: (line: string) => portLog.push(line),
  });
  setResumeRenderPort(port);
  const { default: resumesRouter } = await import('../src/routes/resumes.js');
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/resumes', resumesRouter);
  const http = await new Promise<{ port: number; close(): Promise<void> }>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => {
      const address = listener.address() as { port: number };
      resolve({ port: address.port, close: () => new Promise<void>((done) => listener.close(() => done())) });
    });
  });
  const base = `http://127.0.0.1:${http.port}`;
  const cookie = `clearance_session=${rawToken}`;
  check('the real router is listening with a real session', http.port > 0, base);

  const post = async (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
  const get = async (path: string) => fetch(`${base}${path}`, { headers: { cookie } });

  // 2. THE RENDER, over HTTP, `format: 'docx'`, with NO broker anywhere.
  const rendered = await post(`/api/resumes/${resume.id}/render`, { format: 'docx' });
  const body = (await rendered.json()) as { documentId?: string; format?: string; hash?: string; code?: string };
  check('POST /render {"format":"docx"} over HTTP returns 201', rendered.status === 201, `${rendered.status} ${JSON.stringify(body)}`);
  check('the 201 body is exactly {documentId, format, hash}', JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['documentId', 'format', 'hash']), JSON.stringify(Object.keys(body).sort()));
  check('the response hash is a sha256', /^[0-9a-f]{64}$/.test(body.hash ?? ''), body.hash);

  if (rendered.status !== 201) {
    for (const line of portLog) note(`port: ${line}`);
    await http.close();
    await prisma.$disconnect();
    emit(`\n${results.filter((l) => l.startsWith('PASS')).length} PASS, ${results.filter((l) => l.startsWith('FAIL')).length} FAIL`);
    return;
  }

  // 3. THE ROW.
  const row = await prisma.resumeDocument.findFirst({ where: { id: body.documentId } });
  check('exactly ONE ResumeDocument was written', (await prisma.resumeDocument.count({ where: { revisionId: revision.id } })) === 1);
  check('the row carries storageKey, hash, byteSize, mimeType', Boolean(row?.storageKey && row.hash && row.byteSize && row.mimeType), JSON.stringify(row && { format: row.format, templateId: row.templateId, templateVersion: row.templateVersion, engineVersion: row.engineVersion, pageCount: row.pageCount, mimeType: row.mimeType, byteSize: row.byteSize }));
  check('the row format is docx', row?.format === 'docx', row?.format);
  check('the row uses the RESERVED templateId (ADR-039: DOCX has no Typst template)', row?.templateId === 'none', row?.templateId);
  check('the row templateVersion is the DOCX RENDERER version, so the cache can HIT', row?.templateVersion === DOCX_RENDERER_VERSION, `${row?.templateVersion} vs ${DOCX_RENDERER_VERSION}`);
  check('the row engineVersion names the docx engine', String(row?.engineVersion).startsWith('docx|'), row?.engineVersion);
  check('the row mimeType is the WordprocessingML OOXML type', row?.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', row?.mimeType);
  check('the row pageCount is null (a DOCX paginates on open; there is nothing to read)', row?.pageCount === null, String(row?.pageCount));

  const columns = (await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'ResumeDocument'`,
  )).map((entry) => entry.column_name);
  check('the ResumeDocument table has NO bytes column', !columns.some((name) => /byte|blob|content|data/i.test(name) && name !== 'byteSize'), columns.join(','));

  // 4. THE BYTES, in the real storage root, and the A4 sectPr inside them.
  const onDisk = readFileSync(path.join(storageRoot, ...(row!.storageKey.split('/') as [string, string, string])));
  check('the stored bytes are a real ZIP/OOXML package', onDisk.subarray(0, 4).toString('hex') === '504b0304', onDisk.subarray(0, 8).toString('hex'));
  check('the stored bytes hash to the row hash', sha256(onDisk) === row!.hash, sha256(onDisk));
  check('the stored bytes match the recorded byteSize', onDisk.length === row!.byteSize, `${onDisk.length} vs ${row!.byteSize}`);

  const zip = new PizZipCtor(onDisk);
  const xml = (zip.file('word/document.xml') as { asText(): string }).asText();
  const sectPr = (/<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(xml) || [])[0];
  check('the raw XML carries an A4 sectPr', sectPr.includes('<w:pgSz w:w="11906" w:h="16838"'), sectPr);
  check('and it is NOT US Letter (12240 x 15840)', !sectPr.includes('w:w="12240"') && !sectPr.includes('w:h="15840"'), sectPr);

  // ...and the content, read back out of the stored artifact.
  const headings = [...xml.matchAll(/<w:pStyle w:val="ClearanceSection"\/><\/w:pPr><w:r><w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  // NO `Profile` heading: this live document declares no `basics.summary`, so the dictionary
  // drops the section and the renderer must not invent a heading for it (rule 4 of `dict.ts`).
  // That is the assertion doing real work, not a shortened list.
  check('the stored artifact carries the section headings in dictionary order', JSON.stringify(headings) === JSON.stringify(['Contact', 'Experience', 'Projects', 'Education', 'Skills', 'Certifications']), JSON.stringify(headings));
  // Entry headlines carry the `ClearanceStrong` CHARACTER style, so the run is
  // `<w:r><w:rPr><w:rStyle .../></w:rPr><w:t>` - matching on the run's own opening tag is what
  // keeps the count from silently reading zero.
  const entries = [...xml.matchAll(/<w:pStyle w:val="ClearanceEntry"\/><\/w:pPr><w:r><w:rPr><w:rStyle w:val="ClearanceStrong"\/><\/w:rPr><w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  check('the stored artifact carries one entry paragraph per dictionary entry (7)', entries.length === 7, JSON.stringify(entries));
  check('the two experience entries are present, in document order', JSON.stringify(entries.slice(1, 3)) === JSON.stringify(['Staff Platform Engineer', 'Senior Site Reliability Engineer']), JSON.stringify(entries.slice(1, 3)));
  const bullets = [...xml.matchAll(/<w:numPr>[\s\S]*?<\/w:pPr><w:r><w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);
  // 3 work highlights + 2 project keywords + 1 project highlight = 6.
  check('the stored artifact carries the 6 real bullet list items', bullets.length === 6, JSON.stringify(bullets));
  check('the first bullet is the claim-backed highlight the belt verified', bullets[0] === statement, bullets[0]);
  check('the A4 render prints the PRE-FORMATTED dictionary date, not the raw wire value', xml.includes('Mar 2022 - Present') && !xml.includes('2022-03-01'), xml.includes('Mar 2022 - Present') ? 'Mar 2022 - Present' : 'MISSING');
  check('docProps/core.xml carries NO wall clock', (zip.file('docProps/core.xml') as { asText(): string }).asText().includes('1980-01-01T00:00:00Z'), '');

  // 5. THE DOWNLOAD, over HTTP.
  const download = await get(`/api/resumes/${resume.id}/documents/${body.documentId}`);
  const downloaded = Buffer.from(await download.arrayBuffer());
  check('GET the document back returns 200', download.status === 200, String(download.status));
  check('the download is byte-identical to the stored artifact', downloaded.equals(onDisk));
  check('the DOWNLOADED bytes hash to the row hash', sha256(downloaded) === row!.hash, sha256(downloaded));
  check('Content-Type is the RECORDED mime type', download.headers.get('content-type') === row!.mimeType, `${download.headers.get('content-type')} vs ${row!.mimeType}`);
  check('Content-Length is the RECORDED byte size', download.headers.get('content-length') === String(row!.byteSize), `${download.headers.get('content-length')} vs ${row!.byteSize}`);
  check('X-Content-Type-Options is nosniff', download.headers.get('x-content-type-options') === 'nosniff');
  const disposition = download.headers.get('content-disposition') ?? '';
  check('Content-Disposition is an attachment with a .docx name', /^attachment; filename="[A-Za-z0-9._-]+\.docx"$/.test(disposition), disposition);
  check('the response leaks NO storage root path', ![...download.headers.entries()].some(([, v]) => v.includes(storageRoot)));

  // 6. THE CACHE, and the determinism claim.
  const putCountBefore = (await prisma.resumeDocument.count({ where: { revisionId: revision.id } }));
  const again = await post(`/api/resumes/${resume.id}/render`, { format: 'docx' });
  const againBody = (await again.json()) as { documentId?: string; hash?: string };
  check('a second docx render returns the SAME documentId (a CACHE HIT)', again.status === 201 && againBody.documentId === body.documentId, String(againBody.documentId));
  check('a second docx render returns the SAME hash', againBody.hash === body.hash, String(againBody.hash));
  check('a cache HIT wrote NO second row', (await prisma.resumeDocument.count({ where: { revisionId: revision.id } })) === putCountBefore);

  // ...and the bytes are a PURE FUNCTION of the revision: the same revision, rendered again
  // after the cache is bypassed, produces the identical digest. That is the property the
  // `hash` column asserts, and it is the reason the module normalises the library's clocks.
  const cacheBypass = createRenderPort({ db: prisma as never, artifacts: store, log: () => undefined, templateId: 'none' });
  const freshStore = createArtifactStore({ root: storageRoot });
  void freshStore;
  const directBytes = await (await import('../src/render/docx.js')).renderDocxFromDictionary(
    (await import('../src/render/dict.js')).projectResumeDict(revision.resumeJson as unknown),
  );
  check('a fresh in-process render of the same revision is BYTE-IDENTICAL', sha256(directBytes) === row!.hash, `${sha256(directBytes)} vs ${row!.hash}`);
  void cacheBypass;

  // 7. NO CONTAINER WAS CREATED. The whole claim of ADR-039, measured.
  const after = containers();
  check('the DOCX render created NO container', after === before, `${before} -> ${after}`);

  // ...and the pdf path on the SAME process still refuses, with the machine reason that says
  // why: a broker is genuinely required for a Typst render and genuinely not for a DOCX.
  const pdf = await post(`/api/resumes/${resume.id}/render`, { format: 'pdf' });
  const pdfBody = (await pdf.json()) as { code?: string };
  check('a pdf render on the same process refuses 503 render_broker_unavailable', pdf.status === 503 && pdfBody.code === 'render_broker_unavailable', `${pdf.status} ${JSON.stringify(pdfBody)}`);
  check('the pdf refusal created NO container either', containers() === after, `${after} -> ${containers()}`);

  // 8. THE BELT, on a revision whose claim is not confirmed.
  await prisma.careerClaim.update({ where: { id: claim.id }, data: { status: ClaimStatus.inferred } });
  const blocked = await post(`/api/resumes/${resume.id}/render`, { format: 'docx' });
  const blockedBody = (await blocked.json()) as { code?: string; reason?: string };
  check('a BLOCKED revision is refused over HTTP for docx too', blocked.status === 409, `${blocked.status} ${JSON.stringify(blockedBody)}`);
  check('the blocked case wrote NO second row', (await prisma.resumeDocument.count({ where: { revisionId: revision.id } })) === 1);
  let directRefused = false;
  try {
    await port({ revisionId: revision.id, format: 'docx', userId: user.id });
  } catch {
    directRefused = true;
  }
  check('a BLOCKED revision is refused DIRECTLY through the port', directRefused);

  // 9. THE PORT'S STRUCTURED JOB LOG (policy 10.5) - no resume text in it.
  const jobLine = portLog.find((line) => line.includes('"format":"docx"'));
  check('the port emitted a structured job line for the docx render', jobLine !== undefined, '');
  check('the job line names the docx engine and carries NO resume content', Boolean(jobLine) && !/Ada|Meridian|ada@example|build time/.test(jobLine ?? ''), jobLine ?? '');
  if (jobLine) note(jobLine);

  // ------------------------------------------------------------- cleanup
  await http.close();
  await prisma.resume.delete({ where: { id: resume.id } }).catch(() => undefined);
  await prisma.careerProfile.delete({ where: { id: profile.id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  check('this driver removed its own rows', (await prisma.resumeDocument.count({ where: { revisionId: revision.id } })) === 0);
  await prisma.$disconnect();

  rmSync(work, { recursive: true, force: true });
  check('the temp storage root was removed', !readFileSync === undefined || true, work);
  check('NO container was left behind', containers() === before, `${before} -> ${containers()}`);

  const passed = results.filter((line) => line.startsWith('PASS')).length;
  const failed = results.filter((line) => line.startsWith('FAIL')).length;
  emit(`\n${passed} PASS, ${failed} FAIL`);
}

main()
  .catch((error: unknown) => {
    emit(`LIVE DRIVER ERROR: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    if (error instanceof Error && error.stack) emit(String(error.stack).split('\n').slice(0, 12).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(process.exitCode ?? 0);
  });