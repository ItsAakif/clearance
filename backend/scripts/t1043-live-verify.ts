// T1043 LIVE verification driver - NOT a committed artifact.
//
// THE WHOLE PORT, OVER HTTP, AGAINST THE REAL BROKER, THE REAL WORKER IMAGE, THE REAL
// TEMPLATE REGISTRY, THE REAL STORAGE PORT AND A REAL DATABASE.
//
// What makes this a LIVE check rather than a re-run of the unit suite: every collaborator
// is the production module. The only substituted pieces are the two things a live host
// cannot inject - the express AUTH middleware (a real session row is created instead, so
// `requireAuth` is the shipped one) and the DATABASE (the disposable Postgres on :5599,
// never :5543).
//
// What it asserts, in order:
//   1. the broker BOOTS against the real daemon (preflight + image present);
//   2. a GATED revision renders over real HTTP: 201 with `{documentId, format, hash}`;
//   3. the `ResumeDocument` row carries the storage key, hash, byte size and mime type, and
//      carries NO bytes column;
//   4. the artifact really is in the storage root, and its digest equals the row's;
//   5. `GET /resumes/:id/documents/:docId` streams byte-identical bytes with the RECORDED
//      content type and length, and their sha256 equals the row's `hash`;
//   6. a SECOND render of the same revision is a CACHE HIT - zero containers, same id;
//   7. a BLOCKED revision never reaches the broker, over HTTP and directly through the port;
//   8. no container, no spool and no temp dir is left behind.
//
// HYGIENE. Nothing is stopped, recreated, pruned or removed except this script's OWN
// container, its OWN broker process and its OWN temp directories. No `docker compose down`,
// no `prune`, no `docker compose up`. The worker image is read, never built.
// The broker is run IN-PROCESS (the same modules the compose service runs) rather than as
// a container, because the compose broker needs the Linux-path spelling of the host root
// and this host's CLI needs the Windows one; both spellings are exercised by T1031 and
// choosing between them here would test the spelling, not the port.

import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import express from 'express';
import cookieParser from 'cookie-parser';

const HOST_ROOT = process.env.RENDER_HOST_TYPST_ROOT ?? 'E:\\Projects\\Webd+AI\\Clearance';
const DATABASE_URL =
  process.env.T1043_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:5599/clearancetest?schema=public';
const TOKEN = 't1043-live-token-not-a-secret';
const results: string[] = [];

/** Bound at startup, so the probe's archive measurement uses the real stager's emitter. */
let openStageTreeStreamForLength: (tree: never) => Readable = () => {
  throw new Error('openStageTreeStream was not bound');
};

/**
 * The log file, written by THIS process.
 *
 * Not a shell redirect: two runs of the driver on this host overlapped more than once and a
 * shared pipe meant the second run's transcript replaced the first's - so the evidence for
 * "it hung here" was the wrong run's output. Writing the file from inside the process means
 * the transcript and the run are the same thing.
 */
const LOG_PATH = path.join(os.tmpdir(), 't1043-live-transcript.log');
try {
  writeFileSync(LOG_PATH, '');
} catch {
  // A transcript is a convenience; failing to create one must not fail the run.
}

function emit(line: string): void {
  results.push(line);
  console.log(line);
  try {
    appendFileSync(LOG_PATH, `${line}\n`, 'utf8');
  } catch {
    // Same: the console line above is the primary output.
  }
}

function check(name: string, ok: boolean, detail = ''): void {
  emit(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` :: ${detail}`}`);
  if (!ok) process.exitCode = 1;
}

/** The broker's own log lines, streamed rather than buffered for the same reason. */
function note(line: string): void {
  emit(`  ${line}`);
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function containers(): string[] {
  // Read through the docker CLI, which is what this host actually has. The point is the
  // COUNT before and after, so a list of ids is enough and a JSON dependency is not.
  return execCapture(['ps', '-a', '--filter', 'name=t1043-live', '--format', '{{.ID}}'])
    .split(/\s+/)
    .filter((line) => line.length > 0);
}

function execCapture(argv: string[]): string {
  // Deliberately `child_process`: this is a VERIFICATION DRIVER under `scripts/`, not
  // application code, and the repo's grep gate scopes `render/broker/` as the only place
  // the backend may reach Docker. The application process never does this.
  // eslint-disable-next-line
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  try {
    return execFileSync('docker', argv, { encoding: 'utf8' });
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------- env
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.RENDER_BROKER_TOKEN = TOKEN;
  // NOT the driver's own socket variable: the PORT builds its client from the ENVIRONMENT
  // (`brokerEndpointFromEnv`), so the endpoint the broker listens on has to be the one the
  // port will dial. Leaving this unset is exactly the `render_broker_unavailable` /
  // `BROKER_NOT_CONFIGURED` case, and a live run that skipped this would have been testing
  // a port that could never reach a broker.
  process.env.RENDER_BROKER_SOCKET = 'PENDING';
  delete process.env.RENDER_BROKER_URL;
  process.env.RENDER_HOST_TYPST_ROOT = HOST_ROOT;
  process.env.V2_TYPST_RENDER = 'true';
  process.env.RENDER_TIMEOUT_MS = '10000';
  process.env.NODE_ENV = 'test';

  const work = mkdtempSync(path.join(os.tmpdir(), 't1043-live-'));
  const storageRoot = path.join(work, 'artifacts');
  const spoolRoot = path.join(work, 'spool');
  process.env.RENDER_STORAGE_ROOT = storageRoot;

  const before = containers();
  check('no t1043 container existed before the run', before.length === 0, before.join(','));

  // ------------------------------------------------------- the real modules
  const { createRenderPort } = await import('../src/render/renderPort.js');
  const { createBrokerServer } = await import('../src/render/broker/index.js');
  const { setResumeRenderPort } = await import('../src/routes/resumes.js');
  const { createArtifactStore } = await import('../src/render/storage.js');
  const { loadTemplateRegistry, RENDER_DEFAULT_TEMPLATE_ID } = await import('../src/render/templates.js');
  const { TYPST_PIN } = await import('../src/render/sandbox.js');
  const prisma = (await import('../src/lib/prisma.js')).default;
  const { canonicalJsonHash, X_CLEARANCE_KEY } = await import('../src/resume/json/jsonresume.js');
  const { ClaimStatus, ResumeUsage, RenderFormat, ResumeChangeSource } = await import('@prisma/client');

  // 1. The BROKER, on a real local socket, with the real worker image.
  // The transport is a unix socket on POSIX and a NAMED PIPE on Windows, which Node exposes
  // as a `net` listener on a `\\.\pipe\...` path - the same substitution T1031's driver made
  // and for the same reason (a file-backed socket in a temp dir is `EACCES` here). The client
  // is unchanged: it hands the path to `http.request({socketPath})` either way, so the code
  // under test is the production transport, not a stand-in.
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\clearance-t1043-live-${process.pid}`
      : path.join(work, 'broker.sock');
  const brokerLog: string[] = [];
  const server = createBrokerServer({
    token: TOKEN,
    spoolRoot,
    hostRoot: HOST_ROOT,
    image: 'clearance/typst-worker:0.15.1',
    // Collected rather than streamed: the broker logs a line per job, and streaming them
    // interleaved with the checks makes the transcript harder to read than a block printed
    // only when something failed.
    log: (...args: unknown[]) => brokerLog.push(args.map(String).join(' ')),
  });
  // `createBrokerServer` returns the HTTP server rather than starting it, so the LISTEN is
  // this driver's step - the same shape `main()` uses, and the reason a unit test can build
  // the whole pipeline with no socket at all.
  await new Promise<void>((resolve, reject) => {
    server.server.once('error', reject);
    server.server.listen(socketPath, resolve);
  });
  // The port's client reads the endpoint at CONSTRUCTION, so the environment has to name the
  // socket the broker is actually bound to before any render happens.
  process.env.RENDER_BROKER_SOCKET = socketPath;
  check('the real broker is listening on a real local socket', typeof server.address() === 'string', String(server.address()));

  // A wrong token is refused BEFORE any container: an unauthenticated render broker is a
  // public RCE queue (ADR-044 D1), and this is the cheapest place to prove the port's
  // client carries the header at all.
  const { RenderBrokerClient, brokerEndpointFromEnv } = await import('../src/render/brokerClient.js');
  const { brokerEndpoint } = await import('../src/render/env.js');
  const { openStageTreeStream } = await import('../src/render/stage.js');
  openStageTreeStreamForLength = openStageTreeStream as unknown as (tree: never) => Readable;
  void brokerEndpointFromEnv;
  let unauthRefused = false;
  let unauthDetail = '';
  try {
    // A real tree, because the client builds the frame BEFORE the broker sees the token: the
    // declared `treeBytes` is the LENGTH OF THE USARCHIVE, not the sum of the file bytes
    // (the archive adds a 512-byte header per entry, padding to 512, two zero blocks and a
    // record pad). Getting that wrong is the client's own `RENDER_INPUT_INVALID`, which
    // would prove nothing about authentication.
    const probeTree = await stageProbeTree();
    const archiveLength = await archiveByteLength(probeTree);
    await new RenderBrokerClient({ endpoint: { socketPath, token: 'wrong' }, timeoutMs: 20_000 }).render(
      {
        jobId: 't1043-unauth-probe', engine: 'typst', format: 'pdf',
        templateId: record0Id(), templateVersion: '1',
        expectedEngineVersion: TYPST_PIN.version, creationTimestampUnix: 1_757_000_000,
        treeBytes: archiveLength, treeFileCount: probeTree.files.length,
        userId: 'probe', revisionId: 'probe',
      },
      probeTree,
    );
  } catch (error) {
    const typed = error as { name?: string; message?: string; status?: number; code?: string; reason?: string };
    unauthDetail = `${typed.name}: status=${typed.status ?? '-'} code=${typed.code ?? '-'} reason=${typed.reason ?? '-'} message=${typed.message ?? String(error)}`;
    unauthRefused = typed.status === 401 && typed.code === 'RENDER_UNAUTHORIZED';
  }
  // The broker's own refusal text is the FIXED string from its error table ("The render
  // request was not authorized."), so the status is read off the CLIENT's typed error rather
  // than out of a message - `BrokerClientError` carries `status`, `code` and `reason`, and
  // those are the machine fields a caller would branch on.
  check('a wrong broker token is refused (401, no container)', unauthRefused, unauthDetail);

  /** The default template's id, read from the registry loaded below; a probe only. */
  function record0Id(): string {
    return process.env.T1043_PROBE_TEMPLATE ?? 'typst-ats-classic';
  }
  async function stageProbeTree() {
    const { stageRenderJobInMemory } = await import('../src/render/stage.js');
    const record = (await loadTemplateRegistry()).get(record0Id());
    return stageRenderJobInMemory({
      engine: 'typst',
      template: { path: record.templatePath },
      dataBytes: Buffer.from('{"dictVersion":"probe"}', 'utf8'),
      sourceRoot: record.dir,
    });
  }
  /**
   * The real archive length, drained through the real `openStageTreeStream`.
   *
   * `StageTree.totalBytes` is the sum of the FILE bytes; the wire's `treeBytes` is the length
   * of the ustar ARCHIVE. They differ by a 512-byte header per entry, per-file padding, the
   * `.pkgcache` directory entry, two zero blocks and the record pad - so this is measured
   * rather than computed, which is also why the client builds the frame from the real stream.
   */
  async function archiveByteLength(tree: Parameters<typeof openStageTreeStreamForLength>[0]): Promise<number> {
    let total = 0;
    for await (const chunk of openStageTreeStreamForLength(tree)) total += (chunk as Buffer).length;
    return total;
  }

  // ------------------------------------------------- the real registry, the real store
  const registry = await loadTemplateRegistry();
  const record = registry.get(RENDER_DEFAULT_TEMPLATE_ID);
  check('the real template registry loaded and reviewed the default template', registry.templates.length > 0, registry.templates.map((t) => t.id).join(','));
  const store = createArtifactStore({ root: storageRoot });

  // --------------------------------------------------------- the real database
  await prisma.$connect();
  // Sweep the users a PREVIOUS run of this driver left behind (an aborted run never reaches
  // its own cleanup). Scoped by the email prefix this driver uses, so nothing else in the
  // disposable database is touched.
  const strays = await prisma.user.findMany({ where: { email: { startsWith: 't1043-live-' } }, select: { id: true } });
  for (const stray of strays) {
    await prisma.user.delete({ where: { id: stray.id } }).catch(() => undefined);
  }
  if (strays.length > 0) note(`swept ${strays.length} user row(s) from an earlier run`);

  const email = `t1043-live-${Date.now()}@example.test`;
  const user = await prisma.user.create({ data: { email } });
  // The `headline` is a real column (Prisma's error output listed it); the document's name is
  // carried in the Resume JSON and the dictionary, which is what the templates read.
  const profile = await prisma.careerProfile.create({ data: { userId: user.id, headline: 'Staff Engineer' } });
  const resume = await prisma.resume.create({
    data: { userId: user.id, name: 'Ada Live', modelVersion: 2, profileId: profile.id, personalInfo: {} },
  });

  // A claim the user CONFIRMED, so the belt allows a render. The document is built to
  // describe it exactly, because the read-time guard compares the stored bytes against the
  // usage log as a multiset and requires every claim-backed string to be named at its path.
  const statement = 'Cut CI build time by 40 percent';
  const fingerprint = 'a'.repeat(64);
  // No `usage` on the claim: Prisma's error output showed the column does not exist there -
  // usage lives on `ResumeClaimUsage`, which is the row the belt actually reads. The claim
  // carries the STATUS, which is the only thing the gate consults.
  const claim = await prisma.careerClaim.create({
    data: {
      profileId: profile.id,
      kind: 'achievement',
      statement,
      fingerprint,
      status: ClaimStatus.user_confirmed,
      provenance: 'llm_inferred',
      confidence: 0.95,
      confirmedAt: new Date(),
    },
  });
  const document = {
    basics: { name: 'Ada Lovelace', label: 'Staff Engineer', email: 'ada@example.test' },
    work: [{ name: 'Acme', position: 'Staff Engineer', startDate: '2020-01', highlights: [statement] }],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 't1043-live',
      sourceModelVersion: 2,
      profileId: profile.id,
      claimCount: 1,
      confirmedClaimCount: 1,
      unconfirmedClaimCount: 0,
      claims: [
        {
          claimId: claim.id,
          fingerprint,
          kind: 'achievement',
          status: ClaimStatus.user_confirmed,
          provenance: 'llm_inferred',
          confidence: 0.95,
          evidenceSourceId: null,
          usage: ResumeUsage.verbatim,
          jsonPath: 'work[0].highlights[0]',
          renderedText: statement,
        },
      ],
    },
  };
  const revision = await prisma.resumeRevision.create({
    data: {
      resumeId: resume.id,
      revisionNumber: 1,
      resumeJson: document as never,
      jsonHash: canonicalJsonHash(document),
      enginePins: {},
      createdBy: ResumeChangeSource.user,
      createdByUserId: user.id,
    },
  });
  await prisma.resumeClaimUsage.create({
    data: { revisionId: revision.id, claimId: claim.id, usage: ResumeUsage.verbatim, renderedText: statement },
  });
  check('a GATED revision exists in the real database', revision.id.length > 0, revision.id);

  // -------------------------------------------------------- the real HTTP server
  // The shipped `requireAuth` runs, against a REAL session row: the only substitution is
  // that the cookie is planted directly rather than through `POST /auth/login`, which is a
  // password exchange and has nothing to do with what is being verified.
  const { hashSessionToken, createSessionToken } = await import('../src/middleware/auth.js');
  const rawToken = createSessionToken();
  await prisma.session.create({
    data: { tokenHash: hashSessionToken(rawToken), userId: user.id, expiresAt: new Date(Date.now() + 3_600_000) },
  });

  // The BROKER CLIENT, built the way the PORT builds it - from the environment - and then
  // handed in explicitly. That is the real production path (a flag-off deployment has no
  // broker), but constructing it here also means a transport problem shows up as a NAME in
  // the transcript rather than as a 503 from the port with nothing behind it.
  const endpoint = brokerEndpoint();
  check('the port can resolve a broker endpoint from the environment', endpoint !== null, JSON.stringify(endpoint));
  const portLog: string[] = [];
  const port = createRenderPort({
    db: prisma as never,
    artifacts: store,
    registry,
    log: (line: string) => portLog.push(line),
  });
  setResumeRenderPort(port);
  note(`the port will dial ${endpoint === null ? '(nothing)' : (endpoint.socketPath ?? endpoint.url)}`);
  const { default: resumesRouter } = await import('../src/routes/resumes.js');
  const app = express();
  app.use(express.json());
  // The shipped `cookieParser()`, because the shipped `requireAuth` reads the session from
  // `req.cookies.clearance_session` and would answer 401 for a missing parser rather than
  // for a missing session. Mounting the real one is the point: the auth path under test is
  // the production one.
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

  // 2. THE RENDER, over HTTP, with the flag ON and the real broker.
  // A DIRECT call first, purely so a refusal is legible: the port's error carries a machine
  // `reason` that the HTTP body deliberately does not (only the two request-shaped reasons
  // are client-visible). A live failure has to be diagnosable without turning the API into a
  // diagnostic channel, and the direct call is the sanctioned way to see the reason.
  let directFailure: { code?: string; reason?: string; message?: string; stack?: string } | null = null;
  try {
    await port({ revisionId: revision.id, format: 'pdf', userId: user.id });
  } catch (error) {
    const typed = error as { code?: string; reason?: string; message?: string; stack?: string };
    directFailure = { code: typed.code, reason: typed.reason, message: typed.message, stack: typed.stack };
    // The stack goes in the DRIVER's output, never into a response: the port is right to
    // reduce the failure to a code and a fixed message, and a live check that cannot see the
    // stack is a live check that cannot diagnose anything.
    note(`a direct render failed: code=${typed.code ?? '-'} reason=${typed.reason ?? '-'} message=${typed.message ?? String(error)}`);
    if (typed.stack) note(String(typed.stack).split('\n').slice(0, 8).join('\n'));
  }
  check('a direct render either succeeds or reports a machine reason', directFailure === null || Boolean(directFailure.reason), JSON.stringify(directFailure));

  const rendered = await post(`/api/resumes/${resume.id}/render`, { format: 'pdf' });
  const body = (await rendered.json()) as { documentId?: string; format?: string; hash?: string; code?: string; reason?: string };
  check('POST /render over HTTP returns 201', rendered.status === 201, `${rendered.status} ${JSON.stringify(body)}`);
  if (rendered.status !== 201) {
    // The driver's own broker log and the port's structured lines are the evidence a live
    // failure needs; a bare FAIL line is not diagnosable from the outside.
    note('broker log:');
    for (const line of brokerLog) note(`broker: ${line}`);
    note('port log:');
    for (const line of portLog) note(`port: ${line}`);
    // The database and HTTP assertions that follow need a row, and a null dereference on
    // `row.storageKey` would mask the real failure with a crash.
    if (directFailure?.stack) note(`direct failure stack:\n${directFailure.stack.split('\n').slice(0, 12).join('\n')}`);
    emit(`\n${results.filter((l) => l.startsWith('PASS')).length} PASS, ${results.filter((l) => l.startsWith('FAIL')).length} FAIL`);
    await http.close();
    await server.close();
    await prisma.$disconnect();
    return;
  }
  check('the 201 body is exactly {documentId, format, hash}', JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['documentId', 'format', 'hash']), JSON.stringify(Object.keys(body).sort()));
  check('the response hash is a sha256', /^[0-9a-f]{64}$/.test(body.hash ?? ''), body.hash);

  // 3. THE ROW.
  const row = await prisma.resumeDocument.findFirst({ where: { id: body.documentId } });
  check('exactly one ResumeDocument was written', (await prisma.resumeDocument.count({ where: { revisionId: revision.id } })) === 1);
  check('the row carries storageKey, hash, byteSize, mimeType', Boolean(row?.storageKey && row.hash && row.byteSize && row.mimeType), JSON.stringify(row && { storageKey: row.storageKey, hash: row.hash, byteSize: row.byteSize, mimeType: row.mimeType, pageCount: row.pageCount, engineVersion: row.engineVersion, templateVersion: row.templateVersion, templateId: row.templateId }));
  const columns = (await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'ResumeDocument'`,
  )).map((entry) => entry.column_name);
  check('the ResumeDocument table has NO bytes column', !columns.some((name) => /byte|blob|content|data/i.test(name) && name !== 'byteSize'), columns.join(','));

  // 4. THE BYTES, in the real storage root.
  const onDisk = readFileSync(path.join(storageRoot, ...(row!.storageKey.split('/') as [string, string, string])));
  check('the stored bytes are a real PDF', onDisk.subarray(0, 5).toString('latin1') === '%PDF-', onDisk.subarray(0, 8).toString('latin1'));
  check('the stored bytes hash to the row hash', sha256(onDisk) === row!.hash, sha256(onDisk));
  check('the stored bytes match the recorded byteSize', onDisk.length === row!.byteSize, `${onDisk.length} vs ${row!.byteSize}`);

  // 5. THE DOWNLOAD, over HTTP, and its digest.
  const download = await get(`/api/resumes/${resume.id}/documents/${body.documentId}`);
  const downloaded = Buffer.from(await download.arrayBuffer());
  check('GET the document back returns 200', download.status === 200, String(download.status));
  check('the download is byte-identical to the stored artifact', downloaded.equals(onDisk));
  check('the DOWNLOADED bytes hash to the row hash', sha256(downloaded) === row!.hash, sha256(downloaded));
  check('Content-Type is the RECORDED mime type', download.headers.get('content-type') === row!.mimeType, `${download.headers.get('content-type')} vs ${row!.mimeType}`);
  check('Content-Length is the RECORDED byte size', download.headers.get('content-length') === String(row!.byteSize), `${download.headers.get('content-length')} vs ${row!.byteSize}`);
  check('X-Content-Type-Options is nosniff', download.headers.get('x-content-type-options') === 'nosniff');
  const disposition = download.headers.get('content-disposition') ?? '';
  check('Content-Disposition is an attachment with a sanitised filename', /^attachment; filename="[A-Za-z0-9._-]+"$/.test(disposition), disposition);
  check('the response leaks NO storage root path', ![...download.headers.entries()].some(([, v]) => v.includes(storageRoot)));

  // The list, metadata only.
  const list = await get(`/api/resumes/${resume.id}/documents`);
  const listed = (await list.json()) as Array<Record<string, unknown>>;
  check('GET the document LIST returns 200 and one entry', list.status === 200 && listed.length === 1, String(listed.length));
  check('the list carries NO storageKey and NO bytes', !('storageKey' in (listed[0] ?? {})), Object.keys(listed[0] ?? {}).join(','));

  // 6. THE CACHE. A second render must be a HIT: same documentId, and NO new container.
  const containersBeforeHit = containers().length;
  const again = await post(`/api/resumes/${resume.id}/render`, { format: 'pdf' });
  const againBody = (await again.json()) as { documentId?: string; hash?: string };
  check('a second render of the same revision returns the SAME documentId', again.status === 201 && againBody.documentId === body.documentId, `${againBody.documentId}`);
  check('a second render returns the SAME hash', againBody.hash === body.hash);
  check('a CACHE HIT created NO container', containers().length === containersBeforeHit, `${containersBeforeHit} -> ${containers().length}`);
  check('a CACHE HIT still writes exactly ONE row', (await prisma.resumeDocument.count({ where: { revisionId: revision.id } })) === 1);

  // 6b. A STORAGE FAULT IN THE CACHE LOOKUP (T1043 review F1). The cache deliberately lets
  // `store.head` throw - a storage fault is not a miss - so this is the one phase where a
  // `StorageError` can be raised inside the port. Before the fix it escaped untranslated and
  // answered 500; the contract, `types.ts` and the port's own header all say 503
  // `render_storage_unavailable`. Driven over the REAL router with the REAL row above, so the
  // lookup genuinely reaches `head` rather than short-circuiting on a version mismatch.
  //
  // The fault is injected at the I/O boundary only, by proxying the REAL fs store and
  // replacing `head` with one that raises T1032's real `StorageError`. Unmounting the volume
  // to provoke it for real would be destructive to a shared Docker host; everything else -
  // the port, the translator, the router, `sendServiceError`, the database row - is real.
  const { StorageError } = await import('../src/render/storage.js');
  const headFaultStore = {
    ...store,
    head: async (): Promise<never> => {
      throw new StorageError('STORAGE_IO', 'IO_ERROR');
    },
  } as unknown as typeof store;
  const headFaultPort = createRenderPort({
    db: prisma as never,
    artifacts: headFaultStore,
    registry,
    log: (line: string) => portLog.push(line),
  });
  setResumeRenderPort(headFaultPort);
  const containersBeforeHeadFault = containers().length;
  const headFault = await post(`/api/resumes/${resume.id}/render`, { format: 'pdf' });
  const headFaultBody = (await headFault.json()) as { code?: string; error?: string };
  check(
    'a THROWING store.head in the CACHE LOOKUP answers 503 render_storage_unavailable, never a 500',
    headFault.status === 503 && headFaultBody.code === 'render_storage_unavailable',
    `${headFault.status} ${JSON.stringify(headFaultBody)}`,
  );
  check(
    'the storage-fault refusal is the FIXED message and leaks no root path',
    headFaultBody.error === 'The rendered document could not be stored.' && !JSON.stringify(headFaultBody).includes(storageRoot),
    JSON.stringify(headFaultBody),
  );
  check(
    'the storage fault created NO container and wrote NO row',
    containers().length === containersBeforeHeadFault && (await prisma.resumeDocument.count({ where: { revisionId: revision.id } })) === 1,
    `${containersBeforeHeadFault} -> ${containers().length}`,
  );
  // The same refusal DIRECTLY through the port, which is the claim the contract's mapping is
  // about - the HTTP status is derived from the error, so the error itself must be the port's.
  let headFaultDirect = '';
  try {
    await headFaultPort({ revisionId: revision.id, format: 'pdf', userId: user.id });
    headFaultDirect = 'NO REFUSAL';
  } catch (error) {
    const typed = error as { name?: string; code?: string; status?: number; reason?: string };
    headFaultDirect = `${typed.name}: code=${typed.code ?? '-'} status=${typed.status ?? '-'} reason=${typed.reason ?? '-'}`;
  }
  check(
    'a THROWING store.head is refused DIRECTLY with the port s own error type',
    headFaultDirect.startsWith('RenderPortError: code=render_storage_unavailable status=503'),
    headFaultDirect,
  );
  setResumeRenderPort(port);

  // 7. THE BELT, on a revision whose claim is NOT confirmed - over HTTP and directly.
  await prisma.careerClaim.update({ where: { id: claim.id }, data: { status: ClaimStatus.inferred } });
  const beforeBlocked = containers().length;
  const blocked = await post(`/api/resumes/${resume.id}/render`, { format: 'pdf' });
  const blockedBody = (await blocked.json()) as { code?: string; reason?: string };
  check('a BLOCKED revision is refused over HTTP with 409', blocked.status === 409, `${blocked.status} ${JSON.stringify(blockedBody)}`);
  let directRefused = false;
  try {
    await port({ revisionId: revision.id, format: 'pdf', userId: user.id });
  } catch (error) {
    directRefused = error instanceof Error;
  }
  check('a BLOCKED revision is refused DIRECTLY through the port', directRefused);
  check('the blocked case created NO container', containers().length === beforeBlocked, `${beforeBlocked} -> ${containers().length}`);
  check('the blocked case wrote NO second row', (await prisma.resumeDocument.count({ where: { revisionId: revision.id } })) === 1);

  // And the `tex` export, which needs no broker at all: same path, no container.
  await prisma.careerClaim.update({ where: { id: claim.id }, data: { status: ClaimStatus.user_confirmed } });
  const beforeExport = containers().length;
  const tex = await post(`/api/resumes/${resume.id}/render`, { format: 'tex' });
  const texBody = (await tex.json()) as { documentId?: string; hash?: string };
  check('a tex export returns 201 with NO container', tex.status === 201 && containers().length === beforeExport, `${tex.status} ${containers().length}`);
  const texRow = await prisma.resumeDocument.findFirst({ where: { id: texBody.documentId } });
  check('the export row uses the RESERVED templateId', texRow?.templateId === 'none', texRow?.templateId);
  check('the export row carries the export mime type', texRow?.mimeType === 'application/x-tex', texRow?.mimeType);
  const texDownload = await get(`/api/resumes/${resume.id}/documents/${texBody.documentId}`);
  const texBytes = Buffer.from(await texDownload.arrayBuffer());
  check('the export downloads byte-identically', texDownload.status === 200 && sha256(texBytes) === texRow?.hash, `${texDownload.status}`);
  check('the exported .tex names the resume content', texBytes.toString('utf8').includes('Ada Lovelace'));

  // 8. THE DATABASE: the driver's own rows are removed, and the resume's cascade takes the
  //    revision, the usage row, the claim and both documents with it.
  await http.close();
  await server.close();
  const documentsBefore = await prisma.resumeDocument.count();
  await prisma.resume.delete({ where: { id: resume.id } }).catch(() => undefined);
  await prisma.careerProfile.delete({ where: { id: profile.id } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  const documentsAfter = await prisma.resumeDocument.count();
  check(
    'the cascade removed BOTH documents with the resume',
    documentsAfter === documentsBefore - 2,
    `${documentsBefore} -> ${documentsAfter}`,
  );
  await prisma.$disconnect();

  // 9. HYGIENE. Everything below is read BEFORE the driver's own cleanup, because a check
  // performed after the directory is removed cannot tell "the broker cleaned up" from "I
  // deleted it" - and the first is the property, the second is this driver's housekeeping.
  const leftover = containers();
  check('NO container was left behind', leftover.length === 0, leftover.join(','));
  // The broker's spool ROOT is created by `createSpool` and belongs to the operator's
  // configuration; what must not survive is a per-JOB spool directory. Asserting the root is
  // ABSENT would be asserting something the broker does not promise and never did - the
  // per-job `mkdtemp` is removed in the spool's own dispose, and the root is the operator's
  // to keep. So the assertion is on the root's CONTENTS: no `job-*` directory, which is
  // exactly the class of thing a job leaves behind.
  const spoolEntries = existsDir(spoolRoot) ? readdirSync(spoolRoot).map(String) : [];
  check(
    'the broker left NO per-job spool directory behind',
    !spoolEntries.some((name) => name.startsWith('job-')),
    spoolEntries.join(',') || '(root absent or empty)',
  );
  // And the storage root is where this run's own bytes are, before the driver deletes them.
  const storeEntries = existsDir(storageRoot) ? readdirSync(storageRoot, { recursive: true }).map(String) : [];
  note(`the storage root held ${storeEntries.length} entries before cleanup: ${storeEntries.join(', ')}`);
  check(
    'the storage root holds ONLY content-addressed artifacts',
    storeEntries.length > 0 && storeEntries.every((name) => /^(artifacts|\.tmp-)/.test(name)),
    storeEntries.join(','),
  );

  rmSync(work, { recursive: true, force: true });
  check('the temp work dir was removed', !existsDir(work));

  const passed = results.filter((line) => line.startsWith('PASS')).length;
  const failed = results.filter((line) => line.startsWith('FAIL')).length;
  console.log(`\n${passed} PASS, ${failed} FAIL`);
}

function existsDir(target: string): boolean {
  try {
    readdirSync(target);
    return true;
  } catch {
    return false;
  }
}

main()
  .catch((error: unknown) => {
    emit(`LIVE DRIVER ERROR: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    if (error instanceof Error && error.stack) emit(String(error.stack).split('\n').slice(0, 12).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    // The process is expected to EXIT: an open server handle or a live prisma pool would
    // hang the driver after every check had already printed, which reads as a failed run
    // rather than a finished one. `process.exitCode` is what carries the verdict.
    process.exit(process.exitCode ?? 0);
  });
