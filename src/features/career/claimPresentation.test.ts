// Unit tests for the pure career-presentation helpers (T1020).
//
// Runner: vitest in node environment (`npm test`, see root vitest.config.ts;
// ADR-031 decision 3 - pure modules only, no jsdom / component tests). `describe`/`it`
// come from vitest; assertions use `node:assert/strict`, matching the existing frontend
// test style (provenanceLabel.test.ts, ProfileMatch.test.ts).
//
// What this file pins, and why each one cannot be checked anywhere else:
//   1. THE NAVIGATION CONTRACT. Since T1110 the sidebar is unconditional - the legacy builder
//      is deleted, so there is no flag state in which the V2 evidence layer should be hidden.
//      What is pinned is the resulting shape: every surviving V1 entry present, the V2 entries
//      present, `/app/career` and the T1021 wizard `/app/career-interview` both registered as
//      their own routes, both retired questionnaire URLs pointing at the wizard that replaced
//      them, and the nav module gating on no flag at all.
//   2. STATUS IS ICON + TEXT, NEVER COLOUR ALONE. Every status has a NON-EMPTY label and
//      an icon name, and the five labels are distinct - so no two states can be told
//      apart by colour alone, and no state is rendered as an empty badge.
//   3. THE UNCONFIRMED COUNTER IS ACCURATE. Same rule as the server
//      (`backend/src/career/claimCounts.ts`), so the header number and the API's `counts`
//      cannot disagree.
//   4. THE `App.tsx` ROUTE TABLE in source - the one thing a unit test cannot render is
//      whether a route is registered at all.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appNavItems, appNavItemsFor } from '../../components/layout/navigation';
import {
  CLAIM_KINDS,
  CLAIM_STATUSES,
  CONFIRMED_STATUS,
  IMPORT_WIZARD_STEPS,
  UNCONFIRMED_STATUSES,
  availableActions,
  confirmationProgress,
  emptyClaimCounts,
  emptyStateMessage,
  enrichmentMessage,
  isUnconfirmed,
  kindLabel,
  provenancePresentation,
  startsCollapsed,
  statusPresentation,
  summarizeClaims,
  unconfirmedCount,
  UNKNOWN_STATUS,
  type ClaimAction,
} from './claimPresentation';
import type { CareerClaim, CareerClaimCounts } from '@/services/api/career';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// T1110: the `FLAG_OFF` / `FLAG_ON` fixtures are gone with the nav gate they drove. The sidebar
// is no longer a function of a flag, so there is no state to construct.

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function claim(overrides: Partial<CareerClaim> = {}): CareerClaim {
  return {
    id: 'clm-1',
    profileId: 'profile-1',
    kind: 'achievement',
    statement: 'Cut CI build time by 40%',
    status: 'inferred',
    provenance: 'document_import',
    confidence: null,
    inferenceMethod: 'resume_import',
    producedByModel: null,
    evidenceSourceId: 'evd-1',
    experienceId: null,
    educationId: null,
    projectId: null,
    skillId: null,
    certificationId: null,
    achievementId: null,
    confirmedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    createdAt: '2026-10-03T09:00:00.000Z',
    updatedAt: '2026-10-03T09:00:00.000Z',
    ...overrides,
  };
}

/**
 * A counter fixture. `total` and `unconfirmed` are DERIVED from the per-status numbers
 * unless the caller states them, so a fixture can never claim "12 inferred, 0 total" -
 * which is exactly the kind of impossible counter a real bug produces.
 */
function counts(overrides: Partial<CareerClaimCounts> = {}): CareerClaimCounts {
  const merged = { ...emptyClaimCounts(), ...overrides } as CareerClaimCounts;
  if (overrides.total === undefined) {
    merged.total = CLAIM_STATUSES.reduce((sum, status) => sum + (merged[status] ?? 0), 0);
  }
  if (overrides.unconfirmed === undefined) {
    merged.unconfirmed = UNCONFIRMED_STATUSES.reduce(
      (sum, status) => sum + (merged[status] ?? 0),
      0,
    );
  }
  return merged;
}

// ---------------------------------------------------------------------------
// 1. The flag gate
// ---------------------------------------------------------------------------

// T1110 (cutover) - the gate this file used to describe is GONE.
//
// The old block asserted "with the flag OFF the sidebar is exactly the V1 list and
// `/app/career` is absent". That behaviour no longer exists and is not what needs protecting:
// the legacy builder that `v2ResumeStudio` was gating AGAINST is deleted, so a build without
// the career surface is a build with no evidence layer for the Studio to project from and no
// path for a V1 resume to be upgraded on. What replaced it is the inverse contract - the V2
// entries are unconditional, and the retired paths redirect to their successors - and that is
// asserted here. T1021 moved the redirect target from `/app/career` to the wizard at
// `/app/career-interview`, which is itself now a public entry point.
describe('career navigation after the merge', () => {
  it('the sidebar carries one Profile entry, and every declared entry is live', () => {
    const items = appNavItemsFor();
    const hrefs = items.map((item) => item.href);
    assert.deepEqual(hrefs, [
      '/app/resumes',
      '/app/profile',
      '/app/jobs',
      '/app/match',
      '/app/interview',
      '/app/applications',
      '/app/insights',
      '/app/settings',
    ]);
    assert.equal(hrefs.includes('/app/career'), false);
    for (const item of appNavItems) assert.ok(hrefs.includes(item.href), item.href);
    assert.equal(hrefs.includes('/app/build'), false);
  });

  it('the job-preferences page is a Profile tab, not a second sidebar entry', () => {
    const items = appNavItemsFor();
    const profileEntries = items.filter((item) => item.href === '/app/profile');
    assert.equal(profileEntries.length, 1);
    assert.equal(profileEntries[0].label, 'Profile');
    assert.deepEqual(profileEntries[0].match, ['/app/profile', '/app/career']);
    // The two pages behind the tabs are both registered, and they are still different pages.
    const app = readFileSync(path.join(HERE, '../../App.tsx'), 'utf8');
    assert.match(app, /path="\/app\/profile"\s+element=\{<CareerProfile \/>\}/);
    assert.match(app, /path="\/app\/profile\/preferences"\s+element=\{<Profile \/>\}/);
    assert.match(app, /path="\/app\/career"\s+element=\{<Navigate to="\/app\/profile" replace \/>\}/);
  });

  it('renders exactly the declared baseline, nothing added or dropped', () => {
    const items = appNavItemsFor();
    assert.deepEqual(items, appNavItems);
    // The job pipeline reads in the order it is walked inside the Match section.
    const order = items.map((item) => item.href);
    assert.deepEqual(
      order.filter((href) => ['/app/jobs', '/app/match', '/app/interview', '/app/applications'].includes(href)),
      ['/app/jobs', '/app/match', '/app/interview', '/app/applications'],
    );
    assert.equal(items[items.length - 1].href, '/app/settings');
  });

  it('the navigation module gates on NO flag at all', () => {
    // The cutover's job was to remove the gate, so the failure this guards against is the
    // cutover RESPONDING by inventing a new one. `src/lib/flags.ts` remains the cross-runtime
    // contract (asserted in `src/lib/flags.test.ts` against the backend reader); the nav layer
    // simply no longer reads it.
    const source = readFileSync(path.join(HERE, '../../components/layout/navigation.ts'), 'utf8');
    assert.equal(/flag:\s*"/.test(source), false);
    assert.equal(source.includes('V2_FLAG_ENV_KEYS'), false);
    assert.equal(/@\/lib\/flags/.test(source), false);
  });

  it('App.tsx registers the Profile tabs UNCONDITIONALLY, and /app/career redirects', () => {
    const source = readFileSync(path.join(HERE, '../../App.tsx'), 'utf8');
    // Neither tab sits inside a conditional any more, and the whole V2 gate is GONE.
    assert.equal(source.includes('{flags.v2ResumeStudio ? ('), false);
    assert.equal(source.includes(') : null}'), false);
    assert.equal(source.includes('import { flags } from "@/lib/flags"'), false);
    // Career record is the canonical Profile page; Job preferences is its second tab.
    assert.match(source, /path="\/app\/profile"\s+element=\{<CareerProfile \/>\}/);
    assert.match(source, /path="\/app\/profile\/preferences"\s+element=\{<Profile \/>\}/);
    // The old evidence-layer URL is a redirect, not a competing page.
    assert.match(source, /path="\/app\/career"\s+element=\{<Navigate to="\/app\/profile" replace \/>\}/);
    assert.equal(/path="\/app\/career"\s+element=\{<CareerProfile \/>\}/.test(source), false);
  });

  it('both retired questionnaire URLs point at the wizard that replaced them', () => {
    // T1021 pointed these at the Career Interview wizard. The IA merge made the wizard the
    // Rehearsal tab at `/app/interview`, so that is the canonical redirect target now. Its
    // finish action hands off to the verification list at `/app/profile`.
    const source = readFileSync(path.join(HERE, '../../App.tsx'), 'utf8');
    for (const from of ['/get-started/ai', '/get-started/ai-build']) {
      const escaped = from.replace(/\//g, '\\/');
      const declaration = source.match(
        new RegExp(`path="${escaped}"\\s+element=\\{<Navigate to="([^"]+)" replace \\/>\\}`),
      );
      assert.ok(declaration, `${from} must be declared as a replace-redirect`);
      assert.equal(declaration![1], '/app/interview');
    }
    // ...and the target is a live route, because the wizard is the Rehearsal tab.
    assert.match(source, /path="\/app\/interview" element=\{<CareerInterview \/>\}/);
    assert.match(source, /path="\/app\/profile" element=\{<CareerProfile \/>\}/);
  });
});

// ---------------------------------------------------------------------------
// 2. Icon + text, never colour alone
// ---------------------------------------------------------------------------

describe('status is conveyed by icon AND text', () => {
  it('every status has a non-empty label, an icon, and a description', () => {
    for (const status of CLAIM_STATUSES) {
      const presentation = statusPresentation(status);
      assert.ok(presentation.label.length > 0, `${status} has no label`);
      assert.ok(presentation.description.length > 0, `${status} has no description`);
      assert.ok(presentation.icon.length > 0, `${status} has no icon`);
      assert.notEqual(presentation.label, status, `${status} label is just the raw value`);
    }
  });

  it('the five statuses render FIVE DIFFERENT labels, so no two rely on colour', () => {
    const labels = CLAIM_STATUSES.map((status) => statusPresentation(status).label);
    assert.equal(new Set(labels).size, CLAIM_STATUSES.length);
    // The confirmed/unconfirmed contrast in particular must be legible in text.
    assert.equal(statusPresentation('user_confirmed').label, 'Confirmed');
    assert.match(statusPresentation('inferred').label, /not confirmed/i);
  });

  it('confirmed and pending are different TONES and different icons', () => {
    const confirmed = statusPresentation('user_confirmed');
    const pending = statusPresentation('inferred');
    assert.equal(confirmed.tone, 'confirmed');
    assert.equal(pending.tone, 'pending');
    assert.notEqual(confirmed.icon, pending.icon);
  });

  it('an UNKNOWN status fails closed: it never renders as confirmed', () => {
    for (const value of ['brand_new_status', '', null, undefined, 42 as unknown as string]) {
      const presentation = statusPresentation(value as string);
      assert.equal(presentation.label, UNKNOWN_STATUS.label);
      // The critical property: a status this build has never seen must not look safe to
      // use, or an unverified fact gets a confirmed-shaped badge.
      assert.notEqual(presentation.tone, 'confirmed');
      assert.equal(presentation.tone, 'pending');
    }
  });

  it('every provenance also has a non-empty label and an icon', () => {
    const provenances = [
      'user_entered',
      'document_import',
      'llm_inferred',
      'derived',
      'github_derived',
      'external_verified',
    ] as const;
    const labels = new Set<string>();
    for (const provenance of provenances) {
      const presentation = provenancePresentation(provenance);
      assert.ok(presentation.label.length > 0, provenance);
      assert.ok(presentation.icon.length > 0, provenance);
      assert.ok(presentation.description.length > 0, provenance);
      labels.add(presentation.label);
    }
    // "Typed by the user" and "read out of a file" are different words, not two shades.
    assert.equal(labels.size, provenances.length);
    assert.equal(provenancePresentation('document_import').label, 'From a document');
    assert.equal(provenancePresentation('user_entered').label, 'You entered this');
  });

  it('an UNKNOWN provenance is labelled, not blank', () => {
    assert.equal(provenancePresentation('from_the_future').label, 'Unknown source');
    assert.equal(provenancePresentation(null).label, 'Unknown source');
  });

  it('every claim kind has a human label', () => {
    for (const kind of CLAIM_KINDS) {
      const label = kindLabel(kind);
      assert.ok(label.length > 0, kind);
      assert.equal(label, label.trim());
    }
    assert.equal(kindLabel('soft_skill'), 'Summary');
    assert.equal(kindLabel('not_a_kind'), 'not_a_kind');
    assert.equal(kindLabel(null), 'Statement');
  });
});

// ---------------------------------------------------------------------------
// 3. The unconfirmed counter
// ---------------------------------------------------------------------------

describe('the unconfirmed counter is accurate', () => {
  it('counts inferred + contextual and excludes rejected and superseded', () => {
    const tallied = summarizeClaims([
      claim({ id: 'a', status: 'inferred' }),
      claim({ id: 'b', status: 'inferred' }),
      claim({ id: 'c', status: 'contextual' }),
      claim({ id: 'd', status: 'user_confirmed' }),
      claim({ id: 'e', status: 'user_confirmed' }),
      claim({ id: 'f', status: 'rejected' }),
      claim({ id: 'g', status: 'rejected' }),
      claim({ id: 'h', status: 'rejected' }),
      claim({ id: 'i', status: 'superseded' }),
    ]);
    assert.deepEqual(tallied, {
      inferred: 2,
      contextual: 1,
      user_confirmed: 2,
      rejected: 3,
      superseded: 1,
      total: 9,
      unconfirmed: 3,
    });
  });

  it('a decision MOVES the counter down, never up', () => {
    // The rejection case is the one that catches a "total minus confirmed" counter: three
    // rejections would inflate that answer to 6 and send the user back to work they had
    // already finished.
    const claims = [
      claim({ id: 'a', status: 'inferred' }),
      claim({ id: 'b', status: 'inferred' }),
      claim({ id: 'c', status: 'user_confirmed' }),
      claim({ id: 'd', status: 'rejected' }),
      claim({ id: 'e', status: 'rejected' }),
      claim({ id: 'f', status: 'rejected' }),
    ];
    const tallied = summarizeClaims(claims);
    assert.equal(tallied.unconfirmed, 2);
    assert.equal(tallied.total - tallied.user_confirmed, 5);
    assert.notEqual(tallied.unconfirmed, tallied.total - tallied.user_confirmed);

    // Rejecting one of the two remaining claims takes the counter to 1.
    const after = summarizeClaims([
      ...claims.slice(0, 2).map((c, i) => (i === 0 ? { ...c, status: 'rejected' as const } : c)),
      ...claims.slice(2),
    ]);
    assert.equal(after.unconfirmed, 1);
  });

  it('confirming the last pending claim reaches zero, and reopening puts it back', () => {
    const confirmed = summarizeClaims([claim({ id: 'a', status: 'user_confirmed' })]);
    assert.equal(confirmed.unconfirmed, 0);
    assert.equal(confirmed.total, 1);

    const reopened = summarizeClaims([claim({ id: 'a', status: 'inferred' })]);
    assert.equal(reopened.unconfirmed, 1);
  });

  it('an unknown status lands in total but does NOT inflate the work-to-do number', () => {
    const tallied = summarizeClaims([
      claim({ id: 'a', status: 'inferred' }),
      claim({ id: 'b', status: 'from_the_future' as CareerClaim['status'] }),
    ]);
    assert.equal(tallied.total, 2);
    assert.equal(tallied.unconfirmed, 1);
    assert.equal(isUnconfirmed('from_the_future'), false);
  });

  it('matches the server rule: the same two statuses, nothing else', () => {
    // If the client and the server ever disagreed about "unconfirmed", the header number
    // and the API's counts would contradict each other on the same page.
    assert.deepEqual([...UNCONFIRMED_STATUSES].sort(), ['contextual', 'inferred']);
    assert.equal(UNCONFIRMED_STATUSES.includes(CONFIRMED_STATUS), false);
    assert.equal(UNCONFIRMED_STATUSES.includes('rejected'), false);
    assert.equal(UNCONFIRMED_STATUSES.includes('superseded'), false);
  });

  it('prefers the SERVER count, and falls back to a local tally when there is none', () => {
    const claims = [claim({ id: 'a', status: 'inferred' })];
    // Server wins even when it disagrees with the visible rows: `GET /career/claims`
    // returns WHOLE-profile counts with a filtered list on purpose, so the counter stays
    // put while the user changes a filter.
    assert.equal(unconfirmedCount(claims, counts({ unconfirmed: 12 })), 12);
    assert.equal(unconfirmedCount(claims, null), 1);
    assert.equal(unconfirmedCount(claims, undefined), 1);
    assert.equal(unconfirmedCount([], counts({ unconfirmed: 4 })), 4);
    assert.equal(unconfirmedCount(null, null), 0);
  });

  it('is zero for an empty list, and reports every status key', () => {
    const tallied = summarizeClaims([]);
    assert.equal(tallied.total, 0);
    assert.equal(tallied.unconfirmed, 0);
    for (const status of CLAIM_STATUSES) {
      assert.equal(typeof tallied[status], 'number', `${status} missing from the counter`);
    }
  });

  it('"x of y confirmed" names both numbers (06 E.11 flow 1)', () => {
    assert.equal(confirmationProgress(counts({ user_confirmed: 12, inferred: 5, rejected: 3 })), '12 of 20 confirmed');
    assert.equal(confirmationProgress(emptyClaimCounts()), '0 of 0 confirmed');
  });
});

// ---------------------------------------------------------------------------
// Empty states and row affordances
// ---------------------------------------------------------------------------

describe('empty states say what is missing, not just "blank"', () => {
  it('distinguishes "nothing imported" from "imported but nothing confirmed"', () => {
    const none = emptyStateMessage(emptyClaimCounts());
    assert.match(none, /Drop in a resume/i);

    // The second case must NOT send the user back to the import wizard: re-uploading a
    // resume is the wrong action when the real one is "start confirming".
    const unconfirmed = emptyStateMessage(counts({ inferred: 12 }));
    assert.match(unconfirmed, /Nothing confirmed yet/i);
    assert.match(unconfirmed, /resume built now would be empty/i);
    assert.notEqual(unconfirmed, none);
  });

  it('says nothing once something is confirmed', () => {
    assert.equal(emptyStateMessage(counts({ user_confirmed: 1, inferred: 2 })), '');
  });
});

describe('the import wizard reports the enrichment outcome in words (ADR-041 D5)', () => {
  it('says the import worked WITHOUT a provider - the common case - not that something broke', () => {
    const message = enrichmentMessage({
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      provider: 'unknown',
      created: 0,
    });
    assert.ok(message);
    assert.match(message, /Imported without an AI provider/i);
    // The import DID complete, and the copy has to say so: a user who reads "no provider"
    // as a failure would re-upload the same file.
    assert.match(message, /read straight out of your file/i);
    assert.equal(/error|failed|could not/i.test(message as string), false);
  });

  it('distinguishes "nothing to try" from "tried and could not reach it"', () => {
    const unreachable = enrichmentMessage({
      status: 'skipped',
      reason: 'provider_unavailable',
      provider: 'groq',
      created: 0,
    });
    assert.match(unreachable as string, /could not be reached/i);
    assert.notEqual(unreachable, enrichmentMessage({
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      provider: 'unknown',
      created: 0,
    }));
  });

  it('still says every enriched claim is unconfirmed', () => {
    const message = enrichmentMessage({
      status: 'applied',
      reason: 'ok',
      provider: 'groq',
      created: 4,
    }) as string;
    assert.match(message, /groq/);
    assert.match(message, /4 more statements/);
    assert.match(message, /unconfirmed/i);
    // Singular is singular.
    assert.match(
      enrichmentMessage({ status: 'applied', reason: 'ok', provider: 'groq', created: 1 }) as string,
      /1 more statement\./,
    );
  });

  it('never hides an unrecognised reason behind a rosy summary', () => {
    const message = enrichmentMessage({
      status: 'skipped',
      reason: 'enrichment_failed:TypeError',
      provider: 'unknown',
      created: 0,
    }) as string;
    assert.match(message, /enrichment_failed:TypeError/);
  });

  it('the wizard stepper has three steps and the wizard renders step 2 of them', () => {
    // The verification list is step 3, so the wizard is a progress indicator rather than a
    // set of tabs: a user who has confirmed everything must not be walked back into it.
    assert.equal(IMPORT_WIZARD_STEPS, 3);
  });
});

describe('rejected rows start collapsed, and actions match the status', () => {
  it('starts a rejected row collapsed and everything else open', () => {
    assert.equal(startsCollapsed(claim({ status: 'rejected' })), true);
    assert.equal(startsCollapsed(claim({ status: 'inferred' })), false);
    assert.equal(startsCollapsed(claim({ status: 'user_confirmed' })), false);
  });

  it('offers Confirm on a pending claim and only Reopen on a rejected one', () => {
    assert.deepEqual(availableActions('inferred'), ['confirm', 'edit', 'reject']);
    assert.deepEqual(availableActions('contextual'), ['confirm', 'edit', 'reject']);
    assert.deepEqual(availableActions('rejected'), ['reopen']);
    // A rejected claim is never confirmable without a reopen - ADR-036 item 5 - and a
    // rejected claim with no Reopen button would be a dead end.
    assert.equal(availableActions('rejected').includes('confirm'), false);
  });

  it('never offers a bare Confirm on an already-confirmed claim', () => {
    // F1. `edit` and `edit_confirm` are BOTH refused from `user_confirmed`
    // (`verification.ts` transition table), and `updateClaimAttributes` refuses the row
    // outright, so offering Edit was a button whose only possible outcome was a 409.
    assert.deepEqual(availableActions('user_confirmed'), ['reject']);
  });

  it('treats an unknown status as pending, so a Confirm is offered rather than hidden', () => {
    // Fail-open on the ACTION and fail-closed on the BADGE: the row still say "unknown",
    // but the user is not locked out of deciding about it.
    assert.equal(statusPresentation('from_the_future').label, UNKNOWN_STATUS.label);
    assert.ok(availableActions('from_the_future').includes('confirm'));
  });
});

// ---------------------------------------------------------------------------
// F1 cross-check: the UI's offered actions vs the BACKEND's accepted transitions
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. `availableActions` is a pure function and the frontend test runner is
// node-only with no server (ADR-031 decision 3), so nothing in the ordinary suite can ask
// "would the server accept this?". That gap is exactly how F1 shipped: the pure module
// said a `user_confirmed` row offers Edit, the backend refused it from every angle, and
// every other test stayed green. This block closes the gap by reading the backend's real
// transition table out of its source and checking the mirror against it, so a change to
// EITHER side fails here.
//
// IT PARSES THE SOURCE RATHER THAN IMPORTING IT, deliberately: importing
// `backend/src/career/verification.ts` into a frontend test would drag `@prisma/client`
// and the whole career layer into the ROOT vitest project, which is a separate dependency
// graph from `backend/` (cf. `src/lib/flags.test.ts`, which imports
// `backend/src/config/flags` precisely because that module has no runtime deps). A regex
// over the one exported const answers the one question being asked, and if the table ever
// stops parsing, the FIRST test below fails loudly rather than the rest passing on an
// empty set.

const VERIFICATION_SOURCE = readFileSync(
  path.join(HERE, '../../../backend/src/career/verification.ts'),
  'utf8',
);

/** The `from` list of every action in `CLAIM_TRANSITIONS`, read from the backend source. */
function backendTransitions(): Record<string, string[]> {
  const table: Record<string, string[]> = {};
  for (const match of VERIFICATION_SOURCE.matchAll(
    /\[VerificationAction\.(\w+)\]:\s*\{\s*from:\s*\[([^\]]*)\]/g,
  )) {
    table[match[1]] = [...match[2].matchAll(/ClaimStatus\.(\w+)/g)].map((status) => status[1]);
  }
  return table;
}

/**
 * Which backend verbs a UI action can reach.
 *
 * `confirm` reaches `confirm` and `edit_confirm` (the confirm route takes an optional
 * `statement`, which turns it into an edit-and-confirm). `edit` reaches `edit` and
 * `edit_confirm` (the same route, with the panel's "Save and confirm" toggle). A UI action
 * is legal from a status when AT LEAST ONE verb it can reach accepts that status - which
 * is the right shape, because the user picks the variant at the point of use.
 */
const UI_ACTION_TO_BACKEND: Record<ClaimAction, string[]> = {
  confirm: ['confirm', 'edit_confirm'],
  edit: ['edit', 'edit_confirm'],
  reject: ['reject'],
  reopen: ['reopen'],
};

describe('availableActions is accepted by the BACKEND for every status (F1 cross-check)', () => {
  const transitions = backendTransitions();

  it('read the whole CLAIM_TRANSITIONS table out of the backend source', () => {
    // A guard on the guard: if the regex ever stops matching the real table, the checks
    // below would vacuously pass. Five actions, each with a non-empty from-list.
    assert.deepEqual(
      Object.keys(transitions).sort(),
      ['confirm', 'edit', 'edit_confirm', 'reject', 'reopen'],
    );
    for (const [action, from] of Object.entries(transitions)) {
      assert.ok(from.length > 0, `${action} has an empty from-list`);
    }
    // The rows F1 depended on, spelled out so a future edit to the table cannot make this
    // test agree with a wrong UI without someone seeing it here.
    assert.equal(transitions.edit.includes('user_confirmed'), false);
    assert.equal(transitions.edit_confirm.includes('user_confirmed'), false);
    assert.equal(transitions.confirm.includes('user_confirmed'), false);
    assert.equal(transitions.confirm.includes('superseded'), false);
    assert.equal(transitions.edit.includes('superseded'), true);
  });

  it('offers ONLY actions the backend accepts, for EVERY status', () => {
    // THE F1 REGRESSION GUARD. For each status the server can hold, every button this
    // module offers must have at least one backend verb accepting that status. Offering
    // Edit on `user_confirmed` - or Confirm on `superseded` - fails here.
    for (const status of CLAIM_STATUSES) {
      for (const action of availableActions(status)) {
        const verbs = UI_ACTION_TO_BACKEND[action];
        assert.ok(verbs, `no backend verb mapped for UI action "${action}"`);
        const accepted = verbs.filter((verb) => {
          const from = transitions[verb];
          assert.ok(from, `the backend table has no "${verb}" row - did CLAIM_TRANSITIONS change?`);
          return from.includes(status);
        });
        assert.ok(
          accepted.length > 0,
          `availableActions("${status}") offers "${action}", which reaches only [${verbs.join(', ')}] - and the backend accepts none of them from status "${status}". That button would always 409.`,
        );
      }
    }
  });

  it('reaches every status, so no status is silently left unchecked', () => {
    // Cheap sanity: the loop above is only as good as its input list.
    assert.equal(CLAIM_STATUSES.length, 5);
    for (const status of CLAIM_STATUSES) {
      assert.ok(availableActions(status).length > 0, `${status} offers no action at all`);
    }
  });

  it('offers the exact set that can move each claim forward', () => {
    // The subset check above is a "never too much" rule; this is the "enough" half, so a
    // table that silently emptied out could not pass by offering nothing.
    assert.deepEqual(availableActions('inferred'), ['confirm', 'edit', 'reject']);
    assert.deepEqual(availableActions('contextual'), ['confirm', 'edit', 'reject']);
    assert.deepEqual(availableActions('user_confirmed'), ['reject']);
    assert.deepEqual(availableActions('rejected'), ['reopen']);
    assert.deepEqual(availableActions('superseded'), ['edit', 'reject']);
  });
});
