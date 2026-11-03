// Freshness guard + explicit posted-within window + relevance-then-recency
// ordering for on-demand discovery results (ADR-012, R7; ADR-028, wave 3).
//
// Two distinct policies share this module:
// - Absolute guard (always on): a row with a known postedAt older than
//   MAX_POSTED_AGE_DAYS is dropped. Undated rows are kept, so boards that do
//   not publish a date are not silently erased.
// - Explicit window: when the request carries postedWithin (day/week/month),
//   rows outside the window are dropped, INCLUDING undated rows, matching the
//   existing client rule in src/features/jobs/jobSearchUtils.ts.
//
// Ordering comparator (score desc, postedAt desc with undated last,
// provenance rank desc, input order):
// 1. Higher `score` first (missing/NaN counts as 0).
// 2. Newer `postedAt` first; a row with no readable date sorts after every
//    dated row, REGARDLESS of provenance (undated-last is unchanged).
// 3. Provenance tie-break (wave 3, ADR-028): only between rows of equal
//    score AND equal `postedAt` (including both-undefined), the stronger
//    `provenanceRank` (see ../discovery/provenance.ts) sorts first, so an
//    `index-date` row never outranks an equal-score `source-posted` row.
// 4. Input order (stable): fully-equal rows keep their input order.
//
// `isFresh` semantics are unchanged: undated rows are kept by the absolute
// guard and dropped under an explicit window. No route, UI or test may set
// `postedAt` for an index-date row to make it survive `postedWithin`.

import { provenanceRank, type DatedRow } from '../discovery/provenance.js';

export const MAX_POSTED_AGE_DAYS = 180;

export const POSTED_WITHIN_DAYS = { day: 1, week: 7, month: 30 } as const;

export type PostedWithin = keyof typeof POSTED_WITHIN_DAYS;

export interface FreshnessOptions {
  postedWithin?: PostedWithin;
  now?: Date;
  maxAgeDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function validTime(postedAt: unknown): number | undefined {
  if (postedAt instanceof Date) {
    const t = postedAt.getTime();
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export function isFresh(
  job: { postedAt?: Date },
  opts?: FreshnessOptions,
): boolean {
  const nowMs = opts?.now instanceof Date && !Number.isNaN(opts.now.getTime())
    ? opts.now.getTime()
    : Date.now();
  const maxAgeDays = opts?.maxAgeDays ?? MAX_POSTED_AGE_DAYS;
  const postedMs = validTime(job?.postedAt);

  // Undated rows are kept by the guard...
  if (postedMs === undefined) {
    // ...but dropped under an explicit window (client isPostedWithin rule).
    if (opts?.postedWithin !== undefined && opts.postedWithin in POSTED_WITHIN_DAYS) {
      return false;
    }
    return true;
  }

  const ageMs = nowMs - postedMs;
  // Absolute guard: known dates older than maxAgeDays are stale.
  if (ageMs > maxAgeDays * DAY_MS) return false;

  const windowKey = opts?.postedWithin;
  if (windowKey !== undefined && windowKey in POSTED_WITHIN_DAYS) {
    if (ageMs > POSTED_WITHIN_DAYS[windowKey as PostedWithin] * DAY_MS) return false;
  }
  return true;
}

// Stable sort by (score desc, then postedAt desc with undated rows last,
// then provenance rank desc, then input order). Rows with equal score,
// equal date and equal provenance keep their input order. Never mutates.
export function sortByRelevanceThenRecency<
  T extends { postedAt?: Date },
>(jobs: Array<T & { score?: number }>): T[] {
  const decorated = jobs.map((job, index) => {
    const score = typeof job.score === 'number' && !Number.isNaN(job.score) ? job.score : 0;
    const t = validTime(job.postedAt);
    const rank = provenanceRank(job as unknown as DatedRow);
    return { job, index, score, time: t, rank };
  });
  decorated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.time === undefined && b.time === undefined) {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.index - b.index;
    }
    if (a.time === undefined) return 1;
    if (b.time === undefined) return -1;
    if (b.time !== a.time) return b.time - a.time;
    if (b.rank !== a.rank) return b.rank - a.rank;
    return a.index - b.index;
  });
  return decorated.map((d) => d.job);
}
