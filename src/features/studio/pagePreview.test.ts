// The preview's SOURCE is the render endpoint, not a local layout (T1050).
//
// The acceptance item is "the preview is the typesetter output, not a parallel CSS layout
// (assert: the preview source is the render endpoint/template engine)". A snapshot of rendered
// markup could not establish that - a CSS mirror would look identical in a snapshot. So this
// file asserts the ENDPOINT and the plumbing instead:
//
//   1. `studioApi` really calls `POST /resumes/:id/render` and
//      `GET /resumes/:id/documents/:docId`. Proven by stubbing `globalThis.fetch` and reading
//      the URLs - the real request path, not a comment.
//   2. `PagePreview.tsx` obtains its bytes ONLY through those two calls and embeds them; it
//      contains no layout of the resume document at all.
//   3. No file in the new tree imports the frozen legacy builder, which is the CSS layout the
//      Studio must not grow a second copy of.
//   4. When the render is refused, the refusal code is surfaced - the empty state is the
//      machine's reason, never a drawn page.
//
// Mutation (c) for this file: replace the preview's fetch with a local layout and
// "the preview fetches the RENDER ENDPOINT and nothing else" fails, because the stub would
// never be called.

import { describe, it, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPortRefusal, studioApi } from '@/services/api/studio';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.join(HERE, '..', '..', 'features', 'studio');
const PAGE = path.join(TREE, 'PagePreview.tsx');
const PDF_PAGES = path.join(TREE, 'PdfPages.tsx');

function studioFiles(): string[] {
  return readdirSync(TREE).filter((name) => /\.(ts|tsx)$/.test(name));
}

// ---------------------------------------------------------------------------
// The real request path
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('the preview fetches the RENDER ENDPOINT and nothing else', () => {
  it('renders through POST /resumes/:id/render, naming the revision it wants', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase(), body: undefined });
      return new Response(JSON.stringify({ documentId: 'doc-1', format: 'pdf', hash: 'f'.repeat(64) }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const result = await studioApi.renderRevision('res-1', { revisionId: 'rev-9' });

    assert.equal(result.documentId, 'doc-1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.match(calls[0].url, /\/resumes\/res-1\/render\?revisionId=rev-9$/);
  });

  it('renders the CURRENT revision when no revisionId is named', async () => {
    await studioApi.renderRevision('res-1').catch(() => undefined);
    assert.match(calls[0].url, /\/resumes\/res-1\/render$/);
    assert.deepEqual(calls[0].body, { format: 'pdf' });
  });

  it('streams the artifact bytes from GET /resumes/:id/documents/:docId', async () => {
    const bytes = await studioApi.downloadDocument('res-1', 'doc-1');
    assert.ok(bytes instanceof Blob);
    assert.match(calls[0].url, /\/resumes\/res-1\/documents\/doc-1$/);
    assert.equal(calls[0].method, 'GET');
  });

  it('reads the page count and the rendered template from the document row', async () => {
    await studioApi.listDocuments('res-1');
    assert.match(calls[0].url, /\/resumes\/res-1\/documents$/);
  });

  it('sends NO templateId: the template is not a document-level request member', async () => {
    await studioApi.renderRevision('res-1', { revisionId: 'rev-1' });
    const body = calls[0].body as Record<string, unknown>;
    // The default call names no template, so the server renders with its own default and the
    // body is byte-identical to the one this client sent before the seam was widened.
    assert.equal('templateId' in body, false);
    assert.deepEqual(Object.keys(body), ['format']);
  });

  it('sends the templateId ONLY when the caller names one (T1050 escalation 1)', async () => {
    // The other half of the assertion above, and the one that makes the switch real: the
    // selected template travels in the RENDER REQUEST. It is still not a member of the
    // document - `templateSwitch.test.ts` holds that half - so switching produces a different
    // ARTIFACT of the same revision rather than a new revision with a different hash.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: (init?.method ?? 'GET').toUpperCase(), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ documentId: 'doc-2', format: 'pdf', hash: 'a'.repeat(64) }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const result = await studioApi.renderRevision('res-1', {
      revisionId: 'rev-1',
      templateId: 'typst-modern-cards',
    });

    assert.equal(result.documentId, 'doc-2');
    assert.match(calls[0].url, /\/resumes\/res-1\/render\?revisionId=rev-1$/);
    assert.deepEqual(calls[0].body, { format: 'pdf', templateId: 'typst-modern-cards' });
    // ...and the module offers NO other way to send a layout: comments stripped first (this
    // test's own prose above is about `templateId`), `templateId` appears on the render call
    // and on no other method.
    const source = readFileSync(path.join(HERE, '..', '..', 'services', 'api', 'studio.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    const methods = code
      .split(/\n {2}async /)
      .slice(1)
      .filter((chunk) => /templateId/.test(chunk))
      .map((chunk) => chunk.split('(')[0].trim());
    assert.deepEqual(methods, ['renderRevision']);
  });
});

// ---------------------------------------------------------------------------
// PagePreview's own source
// ---------------------------------------------------------------------------

describe('PagePreview obtains its bytes from the typesetter and draws nothing', () => {
  const source = readFileSync(PAGE, 'utf8');

  it('calls the render endpoint and then the document endpoint', () => {
    assert.match(source, /studioApi\.renderRevision\(/);
    assert.match(source, /studioApi\.downloadDocument\(/);
    // The render happens BEFORE the download: without a documentId there are no bytes.
    const render = source.indexOf('studioApi.renderRevision(');
    const download = source.indexOf('studioApi.downloadDocument(');
    assert.ok(render > 0 && download > render);
  });

  it('passes the SELECTED TEMPLATE to the render request, and re-renders when it changes', () => {
    // The switch reaches the renderer through the render call, and nowhere else. The
    // `templateId` in the effect's dependency list is what makes switching the template spend
    // a render: the server's cache makes a second template a second artifact, so the preview
    // has to ask for it to show it.
    assert.match(source, /templateId,/);
    // The callbacks are held in refs and are NOT dependencies of `render`: a parent that hands
    // back a new inline callback on every render must not re-spend a render.
    assert.match(source, /const onRefusalRef = useRef\(onRefusal\)/);
    assert.match(source, /const onArtifactRef = useRef\(onArtifact\)/);
    assert.match(source, /onRefusalRef\.current\?\.\(/);
    assert.match(source, /\[release, resumeId, revisionId, templateId\],?\s*\);/);
    // The auto-render effect keys ONLY on the triple, never on `render`, and the same triple
    // is auto-rendered at most once.
    assert.match(source, /\}, \[resumeId, revisionId, templateId\]\);/);
    assert.match(source, /lastAutoKeyRef\.current === key/);
    // ...and it is still not a member of the document: the component reads only the two counts.
    assert.equal(/meta\.\s*templateId|document[^\n]*templateId/.test(source), false);
  });

  it('renders the artifact bytes into our own canvases with pdf.js', () => {
    // PIN 1 (CHANGED from `<object data=...>`): the bytes are still the typesetter's, but
    // pdf.js parses them and each page is painted onto a canvas this tree owns. The pdf.js
    // plumbing lives in the shared `PdfPages.tsx`; `PagePreview` fetches the bytes and hands
    // them over, so both the Studio and the application workspace use one rasteriser.
    const source = readFileSync(PAGE, 'utf8');
    const rasteriser = readFileSync(PDF_PAGES, 'utf8');
    assert.match(source, /URL\.createObjectURL\(bytes\)/);
    assert.match(source, /URL\.revokeObjectURL\(/);
    assert.match(source, /from '\.\/PdfPages'|from "\.\/PdfPages"/);
    assert.match(rasteriser, /pdfjsLib\.getDocument\(\{ data \}\)/);
    assert.match(rasteriser, /window\.document\.createElement\('canvas'\)/);
    assert.match(rasteriser, /pdf\.numPages/);

    // PIN 2 (CHANGED from `type="application/pdf"`): no browser PDF chrome may appear in the
    // pane, so there is no <object>, <embed> or PDF <iframe> left to hand the file to a viewer.
    assert.equal(/<object|<embed|application\/pdf/.test(source), false);
    assert.equal(/<object|<embed|application\/pdf/.test(rasteriser), false);
    assert.equal(/data=\{state\.objectUrl\}/.test(source), false);

    // PIN 3 (ADDED): the worker is Vite's `?url` form, pages honour devicePixelRatio, and the
    // pdf.js document is destroyed on re-render/unmount rather than leaking a worker.
    assert.match(rasteriser, /pdf\.worker\.min\.mjs\?url/);
    assert.match(rasteriser, /devicePixelRatio/);
    assert.match(rasteriser, /pdfRef\.current[\s\S]{0,120}\.destroy\(\)/);
  });

  it('contains NO layout of the resume document', () => {
    // A CSS mirror would have to READ the document: map over `work`, print `basics.name`,
    // lay out a section list. None of that is here - `document` is only ever counted from.
    // The optional-chaining spelling (`document?.work`) is matched too: the first version of
    // this assertion used `document\.` and the mutation below evaded it with a `?`.
    const member = /document\s*\??\s*\.\s*(work|basics|education|projects|skills|certificates)\b/;
    assert.equal(member.test(source), false, 'the document must never be read to draw anything');
    assert.equal(
      /\{document\s*[.[]/.test(source),
      false,
      'no document member may be read inside the markup - it is only ever counted',
    );
    assert.equal(/ResumePreview|TemplateRenderer|resume-builder/.test(source), false);
    // The component derives nothing from the document: the caption and the claim
    // guarantee line that read it were removed, so the preview draws only the
    // typesetter's artifact.
    assert.equal(
      /\bplacedClaimCount\(|unconfirmedPlacedCount\(/.test(source),
      false,
      'the preview must not compute claim counts',
    );
  });

  it('surfaces the machine refusal verbatim, and never draws a page in its place', () => {
    assert.match(source, /renderPortRefusal\(caught\)/);
    assert.match(source, /state\.code/);
    assert.match(source, /PRE_RENDER_GATE_BLOCKED/);
    // `RENDER_BUSY` is a transient broker refusal: it retries quietly instead of showing the
    // red gate, and only falls through to the machine's own reason when the backoff is spent.
    assert.match(source, /RENDER_BUSY/);
    assert.match(source, /Renderer busy - retrying\.\.\./);
    // The wording has to say what it is NOT drawing, or an empty box reads as a bug.
    assert.match(source, /never draws a layout of its own|Nothing is drawn here on purpose/);
  });
});

describe('no file in the Studio tree imports the frozen legacy builder', () => {
  it('the CSS layout the Studio must not duplicate is nowhere in reach', () => {
    for (const name of studioFiles()) {
      const source = readFileSync(path.join(TREE, name), 'utf8');
      assert.equal(
        /features\/resume-builder|from\s+"@\/features\/resume-builder/.test(source),
        false,
        `${name} imports the legacy builder`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The refusal, and the guarantee line
// ---------------------------------------------------------------------------

describe('a refusal is reported with its code, not paraphrased away', () => {
  it('keeps the code and the message the server sent', () => {
    const refusal = renderPortRefusal({ statusCode: 409, code: 'PRE_RENDER_GATE_BLOCKED', message: 'not renderable' });
    assert.equal(refusal.code, 'PRE_RENDER_GATE_BLOCKED');
    assert.equal(refusal.message, 'not renderable');
  });

  it('falls back to a stable code and message for an error with neither', () => {
    const refusal = renderPortRefusal(new Error('boom'));
    assert.equal(refusal.code, 'render_failed');
    assert.equal(refusal.message, 'boom');
    assert.equal(renderPortRefusal(undefined).message, 'the render could not be produced');
  });
});

describe('the preview panel carries no explanatory copy', () => {
  it('drops the revision caption and the claim guarantee line', () => {
    const source = readFileSync(PAGE, 'utf8');
    assert.equal(/Rendered by the typesetter/.test(source), false);
    assert.equal(/claim-backed statement/.test(source), false);
    assert.equal(/all of them confirmed/.test(source), false);
    // The compact toolbar is still there.
    assert.match(source, /Page \{currentPage\} \/ \{totalPages\}/);
    assert.match(source, /Fit width/);
  });
});