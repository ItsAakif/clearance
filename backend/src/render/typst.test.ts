// render/typst.test.ts - the artifact-metadata readers in `typst.ts`.
//
// WHAT IS PROVEN HERE, and why it is a file of its own:
//
//   1. THE PAGE COUNT IS READ FROM THE WHOLE ARTIFACT (defect round, finding F2).
//      `countPdfPages` used to scan `MAGIC_WINDOW * 64` = 32,768 bytes and answer `null`
//      for anything longer. The three LIVE resume renders measured 27,863 / 32,920 /
//      34,789 bytes, so `pageCount` was `null` for two of the three shipped templates and
//      `PagePreview.tsx` rendered its "N pages" caption as an empty string. The fixtures
//      below are built at exactly those three sizes, with the page object placed PAST the
//      old window, so the 32,768-byte version of this function returns `null` for two of
//      the three and the mutation is observable rather than theoretical.
//   2. A MULTI-PAGE DOCUMENT COUNTS CORRECTLY. Nothing in the live evidence did: every
//      artifact measured was one page, so "1" and "a count" were indistinguishable.
//   3. THE POLICY IS STILL "DECLINE, DO NOT GUESS": no page objects -> `null`, and an
//      empty/non-buffer -> `null`. A producer that hides its objects in an object stream
//      must not produce a zero in a column the documents list quotes.
//   4. THE MAGIC / PAGE-GEOMETRY PATH IS UNTOUCHED. `assertArtifactBytes` reads the same
//      buffer, and the A4 MediaBox is read off the produced bytes by the live proof rather
//      than here - so the test asserts what the code actually does: the same A4 fixture is
//      ACCEPTED by the artifact checks and a non-PDF is still refused, before anything is
//      stored.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { RENDER_LIMITS } from './sandbox.js';
import { RenderPortError } from './types.js';
import { assertArtifactBytes, countPdfPages } from './typst.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A synthetic PDF of EXACTLY `totalBytes`, with its page objects placed after the filler.
 *
 * The filler comes first on purpose: putting the page objects at the end is what makes
 * these fixtures a real mutation target, because the old 32,768-byte window never reached
 * them. The document carries a `/Type /Pages` ROOT as well, so the `/Type /Page` matcher's
 * negative lookahead is exercised on every call: `/Pages` must never be counted as a page.
 */
function pdfOfSize(totalBytes: number, pages: number): Buffer {
  const header = Buffer.from('%PDF-1.7\n', 'latin1');
  const pageObjects = Buffer.concat(
    Array.from({ length: pages }, (_, i) =>
      Buffer.from(
        `${i + 10} 0 obj\n<< /Type /Page /Parent 9 0 R /MediaBox [0 0 595.2756 841.8898] >>\nendobj\n`,
        'latin1',
      ),
    ),
  );
  const root = Buffer.from('9 0 obj\n<< /Type /Pages /Count 3 /Kids [10 0 R 11 0 R] >>\nendobj\n', 'latin1');
  const tail = Buffer.from('trailer\n<< /Root 9 0 R /Size 13 >>\n%%EOF\n', 'latin1');
  const fillerLength = totalBytes - header.length - pageObjects.length - root.length - tail.length;
  if (fillerLength < 0) throw new Error(`fixture of ${totalBytes} bytes is too small`);
  return Buffer.concat([header, Buffer.alloc(fillerLength, 0x20), pageObjects, root, tail]);
}

/** The three sizes the live T1050 / T1054 runs actually produced. */
const LIVE_SIZES = [
  { template: 'typst-compact-two-col', bytes: 27_863, oldWindowAnswer: 1 },
  { template: 'typst-ats-classic', bytes: 32_920, oldWindowAnswer: null },
  { template: 'typst-modern-cards', bytes: 34_789, oldWindowAnswer: null },
] as const;

/** The byte length of the window `countPdfPages` used to scan: `MAGIC_WINDOW * 64`. */
const OLD_WINDOW_BYTES = 512 * 64;

// ---------------------------------------------------------------------------
// F2: the page count
// ---------------------------------------------------------------------------

describe('countPdfPages reads the WHOLE artifact, not a leading window (F2)', () => {
  it.each(LIVE_SIZES)('$template ($bytes bytes) yields a page count', ({ bytes }) => {
    expect(countPdfPages(pdfOfSize(bytes, 1)), `${bytes} bytes`).toBe(1);
  });

  it('the two live sizes that used to answer null now answer 1, and the small one is unchanged', () => {
    // The regression the defect round closed, stated as one assertion so a re-introduced
    // window is impossible to miss: two of the three shipped templates produced `null`,
    // which `PagePreview.tsx` renders as an EMPTY caption rather than "unknown".
    const answers = LIVE_SIZES.map(({ bytes }) => countPdfPages(pdfOfSize(bytes, 1)));
    expect(answers).toEqual([1, 1, 1]);
    expect(answers[0]).toBe(LIVE_SIZES[0].oldWindowAnswer); // 27,863 B: inside the window already
  });

  it('the two oversized fixtures are LONGER than the old window - which is exactly why they were null', () => {
    // The mutation target, stated so it cannot silently stop being one. The old code returned
    // `null` for ANY buffer longer than 32,768 bytes, so "the fixture is longer than the old
    // window" IS the defect - there is no separate position requirement to satisfy. The
    // 27,863-byte fixture is the honest control: it fitted, it was never the defect, and it
    // must keep the answer it always had.
    expect(pdfOfSize(LIVE_SIZES[0].bytes, 1).length).toBeLessThan(OLD_WINDOW_BYTES);
    for (const { template, bytes } of LIVE_SIZES.slice(1)) {
      const pdf = pdfOfSize(bytes, 1);
      expect(pdf.length, template).toBe(bytes);
      expect(pdf.length, template).toBeGreaterThan(OLD_WINDOW_BYTES);
      // A window of the old size would have DECLINED it outright.
      expect(pdf.subarray(0, OLD_WINDOW_BYTES).length, template).toBeLessThan(pdf.length);
      expect(countPdfPages(pdf), template).toBe(1);
    }
  });

  it('a page object 150 KB into a 200 KB document is still counted - this is not a BIGGER window', () => {
    // The distinction that matters: a "fix" that widened `MAGIC_WINDOW * 64` to, say, 256 KiB
    // would pass the three live sizes and still be wrong for any longer document. The page
    // object here sits far beyond any plausible window.
    const pdf = pdfOfSize(200_000, 1);
    expect(pdf.length).toBe(200_000);
    expect(pdf.indexOf('/Type /Page ', 0, 'latin1')).toBeGreaterThan(OLD_WINDOW_BYTES * 4);
    expect(countPdfPages(pdf)).toBe(1);
    // ...and the /Pages root at the end is still not counted as a page.
    expect(pdf.toString('latin1')).toContain('/Type /Pages');
    expect(countPdfPages(pdf)).toBe(1);
  });

  it('counts a MULTI-page document, with both page objects past the old window', () => {
    // Nothing in the live evidence was ever two pages, so "1" and "a count" had never been
    // told apart by a real artifact.
    expect(countPdfPages(pdfOfSize(34_789, 2))).toBe(2);
    expect(countPdfPages(pdfOfSize(120_000, 3))).toBe(3);
    // The `/Type /Pages` ROOT is not a page, at either size.
    const pdf = pdfOfSize(34_789, 2);
    expect(pdf.toString('latin1')).toContain('/Type /Pages');
    expect(countPdfPages(pdf)).toBe(2);
  });

  it('still DECLINES rather than guessing', () => {
    // The policy that makes this column trustworthy: `null` means "not read", never 0.
    expect(countPdfPages(Buffer.from('', 'latin1'))).toBeNull();
    expect(countPdfPages(Buffer.from('%PDF-1.7\ntrailer\n%%EOF\n', 'latin1'))).toBeNull();
    // A 100 KiB document with its objects inside an object stream: no `/Type /Page` token
    // survives, so the answer is "unknown" rather than a lower bound.
    const compressed = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.alloc(100_000, 0x20),
      Buffer.from('trailer\n%%EOF\n', 'latin1'),
    ]);
    expect(countPdfPages(compressed)).toBeNull();
    expect(countPdfPages('not a buffer' as never)).toBeNull();
    expect(countPdfPages(null as never)).toBeNull();
  });

  it('reads a slash-less and a spaced `/Type/Page` the same way', () => {
    // Typst writes `/Type /Page`; another producer writes `/Type/Page`. Both are one page,
    // and a matcher that only handled the spaced form would answer `null` for a real PDF.
    const tight = Buffer.from('%PDF-1.7\n1 0 obj\n<</Type/Page/MediaBox[0 0 595.2756 841.8898]>>\nendobj\n%%EOF\n', 'latin1');
    expect(countPdfPages(tight)).toBe(1);
    const padded = Buffer.from('%PDF-1.7\n1 0 obj\n<<  /Type   /Page  >>\nendobj\n%%EOF\n', 'latin1');
    expect(countPdfPages(padded)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The other reader on the same buffer
// ---------------------------------------------------------------------------

describe('assertArtifactBytes on the SAME buffer the page count reads', () => {
  const a4 = pdfOfSize(34_789, 1);

  it('accepts the 34 KiB A4 fixture - the magic check was never windowed', () => {
    const sha256 = createHash('sha256').update(a4).digest('hex');
    expect(() =>
      assertArtifactBytes(a4, a4.length, sha256, 'application/pdf'),
    ).not.toThrow();
    expect(countPdfPages(a4)).toBe(1);
  });

  it('refuses a non-PDF, a lying digest and a lying size, all before any storage write', () => {
    const notPdf = Buffer.from('<html>a4 is a size, not a content type</html>', 'latin1');
    const cases: Array<[Buffer, number, string, string]> = [
      [notPdf, notPdf.length, createHash('sha256').update(notPdf).digest('hex'), 'ARTIFACT_BAD_MAGIC'],
      [a4, a4.length, '0'.repeat(64), 'ARTIFACT_DIGEST_MISMATCH'],
      [a4, a4.length + 1, createHash('sha256').update(a4).digest('hex'), 'ARTIFACT_SIZE_CHANGED'],
    ];
    for (const [bytes, size, digest, reason] of cases) {
      expect(() => assertArtifactBytes(bytes, size, digest, 'application/pdf'), reason).toThrowError(
        RenderPortError,
      );
      try {
        assertArtifactBytes(bytes, size, digest, 'application/pdf');
        throw new Error(`expected ${reason} to be refused`);
      } catch (error) {
        expect((error as RenderPortError).code, reason).toBe('RENDER_ARTIFACT_INVALID');
        expect((error as RenderPortError).reason, reason).toBe(reason);
      }
    }
  });

  it('the scan is bounded by the artifact cap, which is what made the whole buffer safe', () => {
    // The argument `countPdfPages` now rests on. If the cap were lifted this comment would
    // be the thing to re-derive, so it is asserted rather than assumed.
    expect(RENDER_LIMITS.outputBytes).toBe(20 * 1024 * 1024);
    expect(a4.length).toBeLessThan(RENDER_LIMITS.outputBytes);
  });
});