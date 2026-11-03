// Per-page verification read/write seam for CompanyCareerPage (T904).
//
// This module exists so the verification write column list is defined in ONE
// place. The registry crawler's prismaStore delegates here, and the Full-scan
// route's per-page write-back delegates here too. No logic lives in this
// file - it is a pure prisma surface - so a column added or removed for the
// verification surface is a one-line change exercised by a key-set test
// (verifyStore.test.ts).
//
// COEXISTENCE RULES (documented here, enforced by callers + buildVerificationUpdate):
// - recompute-never-increment failureCount (already inside buildVerificationUpdate).
// - one row per update: no batch transaction; a write that throws on one page
//   never rolls back another page's write.
// - last-writer-wins per page across two concurrent writers (the admin crawl
//   and the Full sweep both write through this module and share the
//   recompute-not-increment rule).
// - nextCheckAt comes from staleness.nextCheckAt under the injected clock;
//   this module does not compute it.
// - failures (a thrown update / a thrown read) never fail the caller; the
//   Full route counts them on its response.
// - no credential or page content ever reaches lastError (the existing 500-char
//   bound is reused inside buildVerificationUpdate; this module passes the
//   prepared update through as-is).

import prisma from '../lib/prisma.js';
import type { StoredCareerPage, VerificationUpdate } from './crawler.js';

/**
 * Read a CompanyCareerPage row in its full verification shape. Returns null
 * when the row is missing (deleted between plan and write).
 */
export async function readPageForUpdate(pageId: string): Promise<StoredCareerPage | null> {
  const row = await prisma.companyCareerPage.findUnique({ where: { id: pageId } });
  return row === null ? null : { ...row };
}

/**
 * Apply a prepared verification update to one CompanyCareerPage row.
 * The column list below is BYTE-IDENTICAL to the pre-refactor inlined call in
 * crawler.ts; verifyStore.test.ts asserts the `data` key set so a drift here
 * is caught immediately.
 *
 * No batch transaction; one page's failure cannot roll back another.
 */
export async function writePageVerification(
  pageId: string,
  update: VerificationUpdate,
): Promise<void> {
  await prisma.companyCareerPage.update({
    where: { id: pageId },
    data: {
      verifyStatus: update.verifyStatus,
      verifyMethod: update.verifyMethod,
      verifiedAt: update.verifiedAt,
      lastCheckedAt: update.lastCheckedAt,
      httpStatus: update.httpStatus,
      resultCount: update.resultCount,
      failureCount: update.failureCount,
      nextCheckAt: update.nextCheckAt,
      lastError: update.lastError,
      provider: update.provider,
      boardToken: update.boardToken,
    },
  });
}