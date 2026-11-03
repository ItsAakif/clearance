// Wave 9 Pass 1 - deterministic hard filters (T780, ADR-027, N5/N18).
//
// PURE, deterministic, model-free: no I/O, no DB, no ORM, no model client,
// no clock read (`now` is INJECTED by the caller). The only imports are
// TYPES (erased at compile time), so there is no runtime dependency on any
// route, store, or AI module. `kept` follows the input order; pass 2 orders.
//
// DROP-REASON PRECEDENCE (first match wins, pinned so output is stable):
//   already_applied > already_evaluated > expired > excluded >
//   location_mismatch > seniority_mismatch > duplicate (batch-only, see below)
//
// SENIORITY RULE (STEP 3): follows the EXISTING system, not a new invention.
// Source file: `src/features/jobs/seniority.ts` (`inferJobLevel`, ADR-009).
// The keyword rules 1-9 below are ported verbatim in behaviour (title is
// authoritative; the description years-band is consulted only when no title
// rule matched; first match wins; `unknown` when nothing matches). Rank order
// follows that module's SENIORITY_ORDER:
//   junior(0) < mid(1) < senior(2) < staff(3) < principal(4) < lead(5)
// (`lead` is last because it is the people-management axis.) An over-senior
// role (job rank STRICTLY above the intent level) is dropped ONLY when
// `intent.seniority` is set - i.e. the caller explicitly asked for a level.
// A downgrade direction (job rank at or below the intent level) is NOT a
// hard failure and keeps the job. An `unknown` job level never drops.
//
// JOB IDENTITY (`jobFilterKey`): `externalId`, else `applyUrl`, else
// `sourceUrl`, else the normalised `title|company|location` triple. The
// `known` sets are tested against each of externalId/applyUrl/sourceUrl AND
// the derived key, so callers may store any of those id forms.
// `duplicate` is batch-only: `hardFilter` (single job, no set context) never
// returns it; `applyHardFilters` drops the 2nd+ occurrence of a key.

import type { RawJob } from '../jobSources/adapters/http.js';
import type { SearchIntent } from '../discovery/searchIntent.js';

// ---------------------------------------------------------------------------
// Drop reasons (stable, machine-readable; wave 10/13 render these)
// ---------------------------------------------------------------------------

export const HARD_FILTER_REASONS = {
  seniorityMismatch: 'seniority_mismatch',
  excluded: 'excluded',
  locationMismatch: 'location_mismatch',
  alreadyEvaluated: 'already_evaluated',
  alreadyApplied: 'already_applied',
  expired: 'expired',
  duplicate: 'duplicate',
} as const;

export type HardFilterReason =
  (typeof HARD_FILTER_REASONS)[keyof typeof HARD_FILTER_REASONS];

// ---------------------------------------------------------------------------
// Context + verdict (exact shape per T780)
// ---------------------------------------------------------------------------

export interface HardFilterContext {
  intent: SearchIntent;
  profile?: {
    seniority?: string;
    locationPref?: string[];
    remoteOnly?: boolean;
    topSkills?: string[];
  };
  known: {
    evaluatedJobIds: ReadonlySet<string>;
    appliedJobIds: ReadonlySet<string>;
  };
  now: Date;
}

export interface HardFilterVerdict {
  keep: boolean;
  reason?: string;
}

// A RawJob carries no expiry column; some producers attach an `expiresAt`
// hint (Date | ISO string | epoch ms). Read structurally - never required.
type MaybeExpiring = RawJob & { expiresAt?: unknown };

// ---------------------------------------------------------------------------
// Job identity
// ---------------------------------------------------------------------------

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Deterministic identity key for known-set lookups and batch duplicates. */
export function jobFilterKey(job: RawJob): string {
  const externalId = String(job.externalId ?? '').trim();
  if (externalId) return `id:${externalId}`;
  const applyUrl = String(job.applyUrl ?? '').trim();
  if (applyUrl) return `url:${applyUrl}`;
  const sourceUrl = String(job.sourceUrl ?? '').trim();
  if (sourceUrl) return `url:${sourceUrl}`;
  return `content:${normalizeText(job.title)}|${normalizeText(job.company)}|${normalizeText(job.location)}`;
}

function isKnown(job: RawJob, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  const candidates = [
    String(job.externalId ?? '').trim(),
    String(job.applyUrl ?? '').trim(),
    String(job.sourceUrl ?? '').trim(),
    jobFilterKey(job),
  ];
  for (const c of candidates) {
    if (c && ids.has(c)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Seniority inference (ported behaviour from
// `src/features/jobs/seniority.ts` -> `inferJobLevel`, ADR-009)
// ---------------------------------------------------------------------------

type SeniorityValue = 'junior' | 'mid' | 'senior' | 'staff' | 'lead' | 'principal';
type InferredLevel = SeniorityValue | 'unknown';

const SENIORITY_RANK: Readonly<Record<SeniorityValue, number>> = {
  junior: 0,
  mid: 1,
  senior: 2,
  staff: 3,
  principal: 4,
  lead: 5,
};

const RULE1_EARLY_JUNIOR = ['intern', 'internship', 'trainee', 'graduate', 'apprentice'];
const RULE2_EXEC_LEAD = ['executive', 'director', 'vice president', 'head of', 'chief'];
const RULE3_MANAGER_LEAD = ['manager', 'management', 'team lead', 'tech lead', 'engineering lead'];
const RULE6_JUNIOR = ['junior', 'associate', 'entry level', 'entry-level'];
const RULE7_MID = ['mid-level', 'mid level', 'intermediate'];

const VP_RE = /\bvp\b/;
const SR_DOT_RE = /\bsr\./;
const SR_WORD_RE = /\bsr\b/;
const JR_DOT_RE = /\bjr\./;
const JR_WORD_RE = /\bjr\b/;
const III_RE = /\biii\b/;
const LEAD_WORD_RE = /\blead\b/;
const YEARS_BAND_RE = /(\d+)\s*(?:\+\s*|[-\u2013\u2014]\s*\d+\s*)?years?/;

/**
 * Behavioural port of `inferJobLevel(title, description?)` from
 * `src/features/jobs/seniority.ts` (ADR-009). Title is authoritative; the
 * description years-band is only consulted when no title rule matched.
 */
export function inferSeniorityLevel(title: string, description?: string): InferredLevel {
  const t = String(title ?? '').toLowerCase();

  for (const k of RULE1_EARLY_JUNIOR) {
    if (t.includes(k)) return 'junior';
  }
  for (const k of RULE2_EXEC_LEAD) {
    if (t.includes(k)) return 'lead';
  }
  if (VP_RE.test(t)) return 'lead';
  for (const k of RULE3_MANAGER_LEAD) {
    if (t.includes(k)) return 'lead';
  }
  if (LEAD_WORD_RE.test(t)) return 'lead';
  if (t.includes('principal')) return 'principal';
  if (t.includes('staff')) return 'staff';
  if (t.includes('senior')) return 'senior';
  if (SR_DOT_RE.test(t) || SR_WORD_RE.test(t) || III_RE.test(t)) return 'senior';
  for (const k of RULE6_JUNIOR) {
    if (t.includes(k)) return 'junior';
  }
  if (JR_DOT_RE.test(t) || JR_WORD_RE.test(t)) return 'junior';
  for (const k of RULE7_MID) {
    if (t.includes(k)) return 'mid';
  }

  const d = String(description ?? '').toLowerCase();
  if (d.trim()) {
    const m = YEARS_BAND_RE.exec(d);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) {
        if (n >= 8) return 'staff';
        if (n >= 5) return 'senior';
        if (n >= 2) return 'mid';
        return 'junior';
      }
    }
  }
  return 'unknown';
}

function isSeniorityValue(value: unknown): value is SeniorityValue {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SENIORITY_RANK, value)
  );
}

// ---------------------------------------------------------------------------
// Remote / location
// ---------------------------------------------------------------------------

const REMOTE_RE = /\bremote\b|\bwfh\b|\bwork\s+from\s+home\b|\btelecommute\b|\btelework\b|\bvirtual\b|\bdistributed\b/i;

/** A job counts as remote when its location or title says so. */
export function isRemoteJob(job: Pick<RawJob, 'title' | 'location'>): boolean {
  return REMOTE_RE.test(String(job.location ?? '')) || REMOTE_RE.test(String(job.title ?? ''));
}

function locationMatches(jobLocation: string, wanted: string): boolean {
  const job = normalizeText(jobLocation);
  const want = normalizeText(wanted);
  if (!job || !want) return false;
  return job.includes(want) || want.includes(job);
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

function expiresAtMs(job: RawJob): number | null {
  const raw: unknown = (job as MaybeExpiring).expiresAt;
  if (raw == null) return null;
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * Single-job verdict. Pure: no I/O, no clock read, no network, no model call.
 * Never returns `duplicate` (batch-only; see `applyHardFilters`).
 */
export function hardFilter(job: RawJob, ctx: HardFilterContext): HardFilterVerdict {
  // Already applied: dropped from EVALUATION, never deleted from storage
  // (this function has no store access at all - it only labels).
  if (isKnown(job, ctx.known.appliedJobIds)) {
    return { keep: false, reason: HARD_FILTER_REASONS.alreadyApplied };
  }
  if (isKnown(job, ctx.known.evaluatedJobIds)) {
    return { keep: false, reason: HARD_FILTER_REASONS.alreadyEvaluated };
  }

  const expiry = expiresAtMs(job);
  if (expiry !== null && expiry < ctx.now.getTime()) {
    return { keep: false, reason: HARD_FILTER_REASONS.expired };
  }

  const exclusions = ctx.intent.exclusions ?? [];
  if (exclusions.length > 0) {
    const haystack =
      `${String(job.title ?? '')} ${String(job.company ?? '')} ${String(job.description ?? '')}`.toLowerCase();
    for (const raw of exclusions) {
      const token = String(raw ?? '').trim().toLowerCase();
      if (token && haystack.includes(token)) {
        return { keep: false, reason: HARD_FILTER_REASONS.excluded };
      }
    }
  }

  const remote = isRemoteJob(job);
  if (ctx.intent.remoteOnly === true && !remote) {
    return { keep: false, reason: HARD_FILTER_REASONS.locationMismatch };
  }
  const locations = ctx.intent.locations ?? [];
  if (locations.length > 0 && !remote) {
    const jobLocation = String(job.location ?? '');
    const matched = locations.some((wanted) => locationMatches(jobLocation, String(wanted ?? '')));
    if (!matched) {
      return { keep: false, reason: HARD_FILTER_REASONS.locationMismatch };
    }
  }

  // Seniority: an over-senior role is filtered ONLY when the intent states a
  // level; a downgrade (job at/below the intent level) always keeps.
  const intentLevel: unknown = ctx.intent.seniority;
  if (isSeniorityValue(intentLevel)) {
    const jobLevel = inferSeniorityLevel(job.title, job.description);
    if (jobLevel !== 'unknown' && SENIORITY_RANK[jobLevel] > SENIORITY_RANK[intentLevel]) {
      return { keep: false, reason: HARD_FILTER_REASONS.seniorityMismatch };
    }
  }

  return { keep: true };
}

/**
 * Batch pass over a candidate set. Deterministic: same input yields the same
 * output; `kept` follows the input order (no reordering - pass 2 orders).
 * The 2nd+ occurrence of a job key is dropped with reason `duplicate`
 * (first occurrence wins).
 */
export function applyHardFilters(
  jobs: RawJob[],
  ctx: HardFilterContext,
): { kept: RawJob[]; dropped: Array<{ job: RawJob; reason: string }> } {
  const kept: RawJob[] = [];
  const dropped: Array<{ job: RawJob; reason: string }> = [];
  const seen = new Set<string>();
  for (const job of jobs) {
    const verdict = hardFilter(job, ctx);
    if (!verdict.keep) {
      dropped.push({ job, reason: verdict.reason ?? 'unknown' });
      continue;
    }
    const key = jobFilterKey(job);
    if (seen.has(key)) {
      dropped.push({ job, reason: HARD_FILTER_REASONS.duplicate });
      continue;
    }
    seen.add(key);
    kept.push(job);
  }
  return { kept, dropped };
}
