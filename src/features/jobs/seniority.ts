// Seniority labels + deterministic level inference (Workstream C, T220).
//
// Single source of wording for seniority. The stored enum
// (junior | mid | senior | staff | lead | principal) is fixed by the database
// and untouched here: eight label rows map onto six stored values
// (SENIORITY_LABELS.length === 8, distinct values === 6). Any UI that assumes
// a 1:1 mapping is the bug this module exists to prevent.
//
// D1 (labels only): the `years` strings are display copy that nothing parses
// back into a number. No backend years extraction is delivered and none is
// planned in this workstream.

export type SeniorityValue = 'junior' | 'mid' | 'senior' | 'staff' | 'lead' | 'principal';
export type InferredLevel = SeniorityValue | 'unknown';

export interface SeniorityLabel {
  /** Stable React key; unique across rows (rows may share a stored value). */
  key: string;
  /** Human label shown in dropdowns, filters, and badges. */
  label: string;
  /** Copy only - never parsed, validated or persisted. */
  years: string;
  /** Stored enum value written to CareerProfile.seniority / matched by filters. */
  value: SeniorityValue;
}

export const SENIORITY_LABELS: readonly SeniorityLabel[] = [
  { key: 'entry', label: 'Fresher / Entry', years: '0-1y', value: 'junior' },
  { key: 'associate', label: 'Junior / Associate', years: '0-2y', value: 'junior' },
  { key: 'mid', label: 'Mid', years: '2-5y', value: 'mid' },
  { key: 'senior', label: 'Senior', years: '5-8y', value: 'senior' },
  { key: 'staff', label: 'Staff / Principal', years: '8y+', value: 'staff' },
  { key: 'principal', label: 'Staff / Principal', years: '8y+', value: 'principal' },
  { key: 'lead', label: 'Lead / Manager', years: '', value: 'lead' },
  { key: 'executive', label: 'Executive / Director', years: '', value: 'lead' },
];

/** Row key of the default selection (a label key, not a stored value). */
export const DEFAULT_SENIORITY_LABEL_KEY = 'mid';

// Filter grid order, with `lead` last because it is the people-management axis
// rather than a step on the years ladder.
export const SENIORITY_ORDER: readonly SeniorityValue[] = ['junior', 'mid', 'senior', 'staff', 'principal', 'lead'];

/** First label whose value matches; returns the raw string for unknown input (never throws). */
export function labelForValue(value: SeniorityValue): string {
  const v = String(value ?? '');
  const row = SENIORITY_LABELS.find((l) => l.value === v);
  return row ? row.label : v;
}

export function isSeniorityValue(v: string): v is SeniorityValue {
  return typeof v === 'string' && (SENIORITY_ORDER as readonly string[]).includes(v);
}

/**
 * Dedupe toggle for the experience multi-select (T222 STEP 3).
 *
 * The eight label rows map onto six stored values, so toggling a row toggles
 * its stored value: checking adds it (no duplicates), unchecking removes it
 * (unchecking either of a shared-value pair unchecks both rows, because only
 * one value exists behind them). Values outside the six stored values are
 * dropped, never emitted. Pure: no React, no fetching.
 */
export function toggleSeniorityValue(
  current: SeniorityValue[],
  value: SeniorityValue,
  next: boolean,
): SeniorityValue[] {
  if (!isSeniorityValue(value)) return [...current];
  const asSet = new Set<SeniorityValue>();
  for (const v of current) {
    if (isSeniorityValue(v)) asSet.add(v);
  }
  if (next) asSet.add(value);
  else asSet.delete(value);
  return [...asSet];
}

// Pre-compiled keyword matchers as module-level constants (lowercase arrays
// plus, for short tokens, boundary-anchored RegExps built once). This module
// runs inside a `useMemo` over whole result lists, so it must not build
// regexes per call: every RegExp construction in this file is at module
// scope, never inside inferJobLevel.
const RULE1_EARLY_JUNIOR = ['intern', 'internship', 'trainee', 'graduate', 'apprentice'];
const RULE2_EXEC_LEAD = ['executive', 'director', 'vice president', 'head of', 'chief'];
const RULE3_MANAGER_LEAD = ['manager', 'management', 'team lead', 'tech lead', 'engineering lead'];
const RULE6_JUNIOR = ['junior', 'associate', 'entry level', 'entry-level'];
const RULE7_MID = ['mid-level', 'mid level', 'intermediate'];

// Boundary-anchored matchers for short tokens (`sr`, `jr`, `vp`, `iii`, bare
// `lead`), built once. A trailing-space token such as `vp ` or `sr ` is
// covered by the word boundary, which also matches `vp,` / end-of-title.
const VP_RE = new RegExp('\\bvp\\b');
const SR_DOT_RE = new RegExp('\\bsr\\.');
const SR_WORD_RE = new RegExp('\\bsr\\b');
const JR_DOT_RE = new RegExp('\\bjr\\.');
const JR_WORD_RE = new RegExp('\\bjr\\b');
const III_RE = new RegExp('\\biii\\b');
// Bare "Lead ..." titles ("Lead Senior Engineer") resolve to the management
// axis per the spec edge cases; longer phrases are covered by RULE3_MANAGER_LEAD.
const LEAD_WORD_RE = new RegExp('\\blead\\b');

// First `N+ years` / `N-M years` (or bare `N years`) band in a description;
// only the first match is used and only its leading number N matters.
const YEARS_BAND_RE = new RegExp('(\\d+)\\s*(?:\\+\\s*|[-\\u2013\\u2014]\\s*\\d+\\s*)?years?');

/**
 * Deterministic keyword inference. Title is authoritative; the description
 * band is only consulted when no title rule matched. First match wins.
 */
export function inferJobLevel(title: string, description?: string): InferredLevel {
  // `title` is typed as string but may arrive as undefined/null from untyped
  // API payloads at runtime; coerce before matching.
  const t = String(title ?? '').toLowerCase();

  // Rule 1: entry pipeline.
  for (const k of RULE1_EARLY_JUNIOR) {
    if (t.includes(k)) return 'junior';
  }

  // Rule 2: executive axis.
  for (const k of RULE2_EXEC_LEAD) {
    if (t.includes(k)) return 'lead';
  }
  if (VP_RE.test(t)) return 'lead';

  // Rule 3: people management. Checked before rule 6, so
  // "Associate Product Manager" is `lead` (the role owns people) while
  // "Client Associate" stays `junior`.
  for (const k of RULE3_MANAGER_LEAD) {
    if (t.includes(k)) return 'lead';
  }
  if (LEAD_WORD_RE.test(t)) return 'lead';

  // Rule 4: checked before rule 5, so "Staff Software Engineer" is `staff`
  // and not `senior` (and "Senior Staff Engineer" likewise resolves here).
  if (t.includes('principal')) return 'principal';
  if (t.includes('staff')) return 'staff';

  // Rule 5.
  if (t.includes('senior')) return 'senior';
  if (SR_DOT_RE.test(t) || SR_WORD_RE.test(t) || III_RE.test(t)) return 'senior';

  // Rule 6.
  for (const k of RULE6_JUNIOR) {
    if (t.includes(k)) return 'junior';
  }
  if (JR_DOT_RE.test(t) || JR_WORD_RE.test(t)) return 'junior';

  // Rule 7.
  for (const k of RULE7_MID) {
    if (t.includes(k)) return 'mid';
  }

  // Rule 8: description band, only when no title rule matched and a
  // description was supplied. Never call `.toLowerCase()` on `description`
  // without the same coercion guard used for `title`.
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

  // Rule 9.
  return 'unknown';
}
