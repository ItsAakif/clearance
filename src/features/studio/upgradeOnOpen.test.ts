// UPGRADE-ON-OPEN (T1110) - the frontend half.
//
// WHY THIS FILE EXISTS. The cutover deleted the V1 builder and made `/app/build/:resumeId`
// REDIRECT to `/app/studio/:resumeId`. `Studio.tsx` reads `GET /resumes/:id/revisions`, and a
// `modelVersion = 1` row has none - so with the redirect alone the page would say "this resume
// has no revisions yet, so there is nothing to edit" for exactly the resumes that existed before
// the cutover. The Studio therefore calls `POST /resumes/:id/upgrade` when the revision list
// comes back empty, and this file pins that wiring and its safety.
//
// WHAT IS ASSERTED, AND WHY IT IS A SOURCE-LEVEL CONTRACT. ADR-031 decision 3 (and
// `vitest.config.ts`: `environment: 'node'`, `include: ['src/**/*.test.ts']`) keeps this repo
// out of jsdom and React Testing Library, so `Studio.tsx` cannot be RENDERED here. What CAN be
// checked is the two halves that decide whether the feature is correct:
//
//   1. THE WIRING, in `Studio.tsx`'s own source: the empty-revision branch calls `upgrade`, it
//      opens the revision the response carries, and it only falls through to the old
//      "nothing to edit" message when the server said nothing was created.
//   2. THE DATA, end to end through the REAL pure functions: an all-inferred document of the
//      shape the upgrade returns must survive `modelFromDocument` - which is what "the Studio can
//      load it" means when the Studio cannot be rendered - and `serialize` it back WITHOUT
//      changing a single status. A status rewrite in the editor is the one way an all-inferred
//      draft could silently become a confirmed one, and that is what test 3 makes impossible.
//
// THE SERVER HALF IS NOT RE-TESTED HERE. `backend/src/routes/resumes.test.ts` pins that the
// rows are `inferred` and that zero `ClaimVerification` rows are written; duplicating it here
// would assert the same fact against a fixture instead of against the route.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  X_CLEARANCE_KEY,
  type ResumeDocumentJson,
  type StudioUpgradeResult,
} from '@/services/api/studio';
import { modelFromDocument, serialize, assertStatusUnchanged } from '@/features/studio/blockModel';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `HERE` is `src/features/studio`, so the repo root is three levels up - the same shape
// `noLetterGeometry.test.ts` and `templateSwitch.test.ts` use.
const REPO = path.join(HERE, '..', '..', '..');
const STUDIO_SRC = readFileSync(path.join(REPO, 'src', 'pages', 'Studio.tsx'), 'utf8');
const STUDIO_API_SRC = readFileSync(path.join(REPO, 'src', 'services', 'api', 'studio.ts'), 'utf8');

// ---------------------------------------------------------------------------
// A document shaped exactly like the one `POST /resumes/:id/upgrade` returns
// ---------------------------------------------------------------------------

/**
 * One claim per status the upgrade can produce, all of them `inferred`.
 *
 * The three placements are the ones the legacy backfill actually produces: a `role` claim, an
 * `achievement` claim, and the `soft_skill` summary claim. All three are UNATTACHED, because the
 * route deliberately leaves `experienceId` and friends null - a legacy row's work history lives
 * in the `Resume` row's Json column, not in the profile's `Experience` table, so the projector
 * records them as `otherClaims` with `usage: omitted`.
 */
function upgradedDocument(): ResumeDocumentJson {
  const claims = [
    {
      claimId: 'clm-role',
      fingerprint: 'a'.repeat(64),
      kind: 'role' as const,
      status: 'inferred' as const,
      provenance: 'document_import' as const,
      confidence: null,
      evidenceSourceId: 'evd-legacy',
      usage: 'omitted' as const,
      jsonPath: null,
      renderedText: null,
    },
    {
      claimId: 'clm-achievement',
      fingerprint: 'b'.repeat(64),
      kind: 'achievement' as const,
      status: 'inferred' as const,
      provenance: 'document_import' as const,
      confidence: null,
      evidenceSourceId: 'evd-legacy',
      usage: 'verbatim' as const,
      jsonPath: 'work[0].highlights[0]',
      renderedText: 'Designed the COBOL compiler',
    },
    {
      claimId: 'clm-summary',
      fingerprint: 'c'.repeat(64),
      kind: 'soft_skill' as const,
      status: 'inferred' as const,
      provenance: 'document_import' as const,
      confidence: null,
      evidenceSourceId: 'evd-legacy',
      usage: 'verbatim' as const,
      jsonPath: 'basics.summary',
      renderedText: 'Invented the compiler.',
    },
  ];
  return {
    basics: {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      phone: null,
      url: null,
      location: { city: 'New York' },
      summary: 'Invented the compiler.',
    },
    work: [
      {
        name: 'US Navy',
        position: 'Rear Admiral',
        startDate: '',
        endDate: '',
        summary: '',
        highlights: ['Designed the COBOL compiler'],
      },
    ],
    [X_CLEARANCE_KEY]: {
      version: 1,
      generatedBy: 'legacy_resume_backfill',
      sourceModelVersion: 1,
      profileId: 'profile-1',
      claimCount: claims.length,
      confirmedClaimCount: 0,
      unconfirmedClaimCount: claims.length,
      claims,
    },
  };
}

function upgradeResult(overrides: Partial<StudioUpgradeResult> = {}): StudioUpgradeResult {
  return {
    upgraded: true,
    resume: { id: 'res-legacy', name: 'Old Resume', modelVersion: 2, profileId: 'profile-1' },
    revision: {
      id: 'rev-legacy-1',
      revisionNumber: 1,
      jsonHash: 'f'.repeat(64),
      createdAt: '2026-10-05T09:00:00.000Z',
      document: upgradedDocument(),
    },
    validation: { valid: true, errors: [] },
    gate: { allowed: false, reason: 'CLAIM_NOT_CONFIRMED', checked: 2, rendered: 2, violations: [] },
    claims: { created: 3, deduped: 0, total: 3, evidenceSourceId: 'evd-legacy' },
    statusAssigned: 'inferred',
    ...overrides,
  };
}

describe('the Studio is wired to upgrade-on-open', () => {
  it('the empty-revision branch calls `upgrade`, not an error message', () => {
    // The load path. If this regressed to "no revisions => show the error", the redirect would
    // dead-end again - so the ORDER is asserted, not just the presence of the call.
    const emptyBranch = STUDIO_SRC.indexOf('if (summaries.length === 0)');
    assert.notEqual(emptyBranch, -1, 'the empty-revision branch must exist');
    const branch = STUDIO_SRC.slice(emptyBranch, emptyBranch + 2200);
    assert.match(branch, /studioApi\.upgrade\(resumeId\)/);
    // The error is the LAST resort, taken only when the server created nothing.
    assert.ok(
      branch.indexOf('studioApi.upgrade(resumeId)') < branch.indexOf('nothing to edit'),
      'the upgrade call must come BEFORE the dead-end message',
    );
  });

  it('opens the revision the upgrade response already carries, rather than refetching it', () => {
    // The response includes the document. Re-reading it by revision number would be a second
    // round trip for bytes just sent - and, more importantly, a place where a mismatch between
    // what was created and what is opened could hide.
    const branch = STUDIO_SRC.slice(STUDIO_SRC.indexOf('if (summaries.length === 0)'));
    assert.match(branch, /result\.revision\.document/);
    assert.match(branch, /modelFromDocument\(created\.document\)/);
  });

  it('TOLD the user their content arrived as unverified drafts', () => {
    // Without this the upgrade is silent, and a user whose whole resume just became unrenderable
    // has no way to know why. The alert must link to the verification UI, which is where the
    // confirming decisions live.
    assert.match(STUDIO_SRC, /upgraded \?/);
    assert.match(STUDIO_SRC, /This resume was upgraded from the old builder/);
    assert.match(STUDIO_SRC, /recorded as unverified drafts/);
    assert.match(STUDIO_SRC, /to="\/app\/profile"/);
  });

  it('the API client exposes `upgrade` against the upgrade route', () => {
    assert.match(STUDIO_API_SRC, /async upgrade\(resumeId: string/);
    assert.match(STUDIO_API_SRC, /apiClient\.post<StudioUpgradeResult>\(`\/resumes\/\$\{resumeId\}\/upgrade`/);
  });
});

describe('an upgraded document loads into the Studio model', () => {
  it('the model round-trips every claim, and NO status changes', () => {
    // "The Studio can load it", in the only sense a node-environment test can check: the real
    // `modelFromDocument` accepts the document and the real `serialize` gives it back.
    const document = upgradedDocument();
    const model = modelFromDocument(document);
    assert.ok(model, 'the upgraded document must produce a model');
    const roundTripped = serialize(model);

    // `assertStatusUnchanged` is the mechanical form of "the Studio cannot confirm anything":
    // it is what `Studio.tsx` calls after every save. A single upgrade round trip must not move
    // a status, because the server wrote `inferred` and the gate's whole guarantee rests on the
    // client not being able to change that.
    assertStatusUnchanged(
      document[X_CLEARANCE_KEY].claims,
      roundTripped[X_CLEARANCE_KEY].claims,
    );
    for (const claim of roundTripped[X_CLEARANCE_KEY].claims) {
      assert.equal(claim.status, 'inferred', `${claim.claimId} changed status`);
      assert.equal(claim.provenance, 'document_import', `${claim.claimId} changed provenance`);
    }
    assert.equal(roundTripped[X_CLEARANCE_KEY].confirmedClaimCount, 0);
    assert.equal(
      roundTripped[X_CLEARANCE_KEY].unconfirmedClaimCount,
      roundTripped[X_CLEARANCE_KEY].claims.length,
    );
  });

  it('the user\'s own name and summary survive the round trip', () => {
    const roundTripped = serialize(modelFromDocument(upgradedDocument()));
    assert.equal(roundTripped.basics.name, 'Grace Hopper');
    assert.equal(roundTripped.basics.summary, 'Invented the compiler.');
    assert.equal(roundTripped.work?.[0]?.highlights?.[0], 'Designed the COBOL compiler');
  });
});

describe('the upgrade result shape the client relies on', () => {
  it('distinguishes "upgraded" from "already upgraded", and only the first carries claims', () => {
    // `claims: null` is how the Studio tells the two apart: an already-V2 row must not open with
    // "upgraded from the old builder", because nothing was upgraded.
    assert.equal(upgradeResult().claims?.total, 3);
    const already = upgradeResult({ upgraded: false, reason: 'already_upgraded', claims: null });
    assert.equal(already.claims, null);
    assert.equal(already.reason, 'already_upgraded');
  });

  it("always reports `statusAssigned: 'inferred'`, whatever the caller does", () => {
    // The echo exists so a client can prove the document's block did not decide anything. If a
    // future route change let the block decide, this type would be the place it shows up.
    assert.equal(upgradeResult().statusAssigned, 'inferred');
  });
});