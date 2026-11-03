// Unit tests for the autosave state machine (T1050).
//
// Runner: vitest, node environment (ADR-031 decision 3 - pure modules only). `describe`/`it`
// come from vitest; assertions use `node:assert/strict`.
//
// WHAT IS PINNED, AND WHY IT IS THE WHOLE POINT OF THIS FILE:
//
//   1. AN EDIT CREATES A NEW REVISION. The only transition that produces a persisted state
//      takes a revision NUMBER AND ITS HASH, so "autosave mutated revision 3" is not a state
//      this module can represent. The named test for mutation (a) is
//      "there is no transition that rewrites the revision already on the server".
//   2. A FAILED SAVE KEEPS THE DIRTY STATE, and keeps the reason. A refusal that turned the
//      indicator green would tell a user their edit is safe when the server never took it.
//   3. AN EDIT MADE DURING AN IN-FLIGHT SAVE IS NOT LOST. The success of the earlier save
//      cannot clear a dirty flag the later edit raised.
//   4. THE INDICATOR IS ICON + TEXT, and every state NAMES the revision on the server, because
//      "saved" without a number is a claim the user cannot check (06 E.11).

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INITIAL_SAVE_STATE,
  beginSave,
  isDirtyState,
  markDirty,
  revisionIdentity,
  saveFailed,
  saveIndicator,
  saveSucceeded,
  shouldOfferSave,
  type StudioSaveState,
} from './autosave';
import { studioApi } from '@/services/api/studio';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function savedAt(revisionNumber: number, jsonHash = HASH_A): StudioSaveState {
  return { ...INITIAL_SAVE_STATE, savedRevisionNumber: revisionNumber, savedJsonHash: jsonHash };
}

// ---------------------------------------------------------------------------
// 1. The lifecycle
// ---------------------------------------------------------------------------

describe('an edit is dirty until the server says otherwise', () => {
  it('starts clean, with nothing on the server', () => {
    assert.equal(INITIAL_SAVE_STATE.status, 'saved');
    assert.equal(INITIAL_SAVE_STATE.dirty, false);
    assert.equal(INITIAL_SAVE_STATE.savedRevisionNumber, null);
    assert.equal(INITIAL_SAVE_STATE.pendingEdits, 0);
  });

  it('marks an edit dirty and counts it', () => {
    const once = markDirty(INITIAL_SAVE_STATE);
    assert.equal(once.status, 'dirty');
    assert.equal(once.dirty, true);
    assert.equal(once.pendingEdits, 1);
    assert.equal(markDirty(once).pendingEdits, 2);
  });

  it('STAYS dirty while the save is in flight - nothing is saved until the server answers', () => {
    const saving = beginSave(markDirty(INITIAL_SAVE_STATE));
    assert.equal(saving.status, 'saving');
    assert.equal(saving.dirty, true);
    // The critical middle state: a spinner must not read as "saved".
    assert.equal(isDirtyState(saving), true);
    assert.equal(shouldOfferSave(saving), false);
  });

  it('a success records the NEW revision number and its hash', () => {
    const done = saveSucceeded(beginSave(markDirty(savedAt(3))), {
      revisionNumber: 4,
      jsonHash: HASH_B,
    });
    assert.equal(done.status, 'saved');
    assert.equal(done.dirty, false);
    assert.equal(done.savedRevisionNumber, 4);
    assert.equal(done.savedJsonHash, HASH_B);
    assert.equal(done.pendingEdits, 0);
    assert.equal(done.error, null);
  });
});

// ---------------------------------------------------------------------------
// 2. A failed save keeps the dirty state
// ---------------------------------------------------------------------------

describe('a refused save keeps the edits unsaved and the reason verbatim', () => {
  const refused = saveFailed(beginSave(markDirty(savedAt(3))), 'the document is not accounted for');

  it('is still dirty', () => {
    assert.equal(refused.status, 'error');
    assert.equal(refused.dirty, true);
    assert.equal(isDirtyState(refused), true);
  });

  it('still points at the revision that IS on the server', () => {
    // The page must not imply that anything reached the server.
    assert.equal(refused.savedRevisionNumber, 3);
    assert.equal(refused.savedJsonHash, HASH_A);
  });

  it('keeps the machine reason exactly as given', () => {
    assert.equal(refused.error, 'the document is not accounted for');
    assert.match(saveIndicator(refused).description, /the document is not accounted for/);
  });

  it('offers a retry', () => {
    assert.equal(shouldOfferSave(refused), true);
  });

  it('a later edit clears the stale error but stays dirty', () => {
    const edited = markDirty(refused);
    assert.equal(edited.error, null);
    assert.equal(edited.dirty, true);
  });

  it('there is NO transition that clears `dirty` while keeping the failure', () => {
    // Exhaustive over the module's surface: after a failure, every transition leaves it dirty.
    assert.equal(isDirtyState(saveFailed(savedAt(1), 'boom')), true);
    assert.equal(isDirtyState(beginSave(saveFailed(savedAt(1), 'boom'))), true);
    assert.equal(isDirtyState(markDirty(saveFailed(savedAt(1), 'boom'))), true);
  });
});

// ---------------------------------------------------------------------------
// 3. An edit during an in-flight save
// ---------------------------------------------------------------------------

describe('an edit made while a save is in flight is not lost', () => {
  it('a success with a pending edit leaves the state DIRTY again', () => {
    const inFlight = beginSave(markDirty(savedAt(3)));      // one edit, now the payload
    assert.equal(inFlight.pendingEdits, 0);
    const editedInFlight = markDirty(inFlight);            // a second edit arrives
    assert.equal(editedInFlight.pendingEdits, 1);

    const done = saveSucceeded(editedInFlight, { revisionNumber: 4, jsonHash: HASH_B });
    // The first edit is now on the server as revision 4; the SECOND one is not.
    assert.equal(done.status, 'dirty');
    assert.equal(done.dirty, true);
    assert.equal(done.savedRevisionNumber, 4);
    assert.equal(shouldOfferSave(done), true);
  });

  it('a success with nothing pending is clean', () => {
    const done = saveSucceeded(beginSave(markDirty(savedAt(3))), {
      revisionNumber: 4,
      jsonHash: HASH_B,
    });
    assert.equal(done.status, 'saved');
    assert.equal(done.dirty, false);
  });
});

// ---------------------------------------------------------------------------
// 4. MUTATION (a): there is no way to rewrite the revision on the server
// ---------------------------------------------------------------------------

describe('there is no transition that rewrites the revision already on the server', () => {
  it('the ONLY persisted transition takes a revision number and a hash - never an id to update', () => {
    const source = readFileSync(path.join(HERE, 'autosave.ts'), 'utf8');
    // Every occurrence of the field, in source order: the TYPE declaration, the initial state,
    // and the one assignment inside `saveSucceeded`. Nothing else may assign it - which is
    // what makes "rewrite the revision already on the server" unrepresentable here.
    const occurrences = [...source.matchAll(/savedRevisionNumber:\s*([^,\n};]+)/g)].map((match) =>
      match[1].trim(),
    );
    assert.deepEqual(occurrences, ['number | null', 'null', 'result.revisionNumber']);
    // And there is no "update"/"patch"/"put" verb anywhere in the module.
    assert.equal(/\b(update|patch|put|delete|overwrite|mutate)\w*\s*[:(]/.test(source), false);
  });

  it('the API client exposes NO method that could mutate a revision', () => {
    const methods = Object.keys(studioApi);
    for (const method of methods) {
      assert.equal(
        /^(update|patch|put|delete|set|save|replace|overwrite|mutate)/i.test(method),
        false,
        `studioApi.${method} looks like a mutation`,
      );
    }
    // ...and the one write is unambiguously a CREATE.
    assert.ok(methods.includes('createRevision'));
    assert.ok(methods.includes('createFromProfile'));
  });

  it('the page calls only createRevision, and never a revision-updating verb', () => {
    const source = readFileSync(path.join(HERE, '../../pages/Studio.tsx'), 'utf8');
    const calls = [...source.matchAll(/studioApi\.(\w+)/g)].map((match) => match[1]);
    assert.ok(calls.length > 0);
    for (const call of new Set(calls)) {
      assert.equal(
        /^(update|patch|put|delete|set|save|replace|overwrite|mutate)/i.test(call),
        false,
        `Studio.tsx calls studioApi.${call}`,
      );
    }
    assert.ok(calls.includes('createRevision'));
  });
});

// ---------------------------------------------------------------------------
// 5. The indicator
// ---------------------------------------------------------------------------

describe('the unsaved-changes indicator is icon + text and names the revision', () => {
  const cases: Array<[string, StudioSaveState]> = [
    ['never saved', INITIAL_SAVE_STATE],
    ['saved', savedAt(1)],
    ['dirty', markDirty(savedAt(1))],
    ['saving', beginSave(markDirty(savedAt(1)))],
    ['error', saveFailed(beginSave(markDirty(savedAt(1))), 'refused')],
  ];

  it('every state has a NON-EMPTY label, a description and an icon', () => {
    for (const [name, state] of cases) {
      const indicator = saveIndicator(state);
      assert.ok(indicator.label.length > 0, name);
      assert.ok(indicator.description.length > 0, name);
      assert.ok(indicator.icon.length > 0, name);
    }
  });

  it('the five states are FIVE DIFFERENT labels, so none relies on colour', () => {
    const labels = new Set(cases.map(([, state]) => saveIndicator(state).label));
    assert.equal(labels.size, cases.length);
    const icons = new Set(cases.map(([, state]) => saveIndicator(state).icon));
    assert.equal(icons.size, 4); // `saving` and the rest differ; `saved`/`dirty`/`error` all differ
  });

  it('says a save writes a NEW revision and never changes an old one', () => {
    const dirty = saveIndicator(markDirty(savedAt(3)));
    assert.match(dirty.description, /NEW revision/);
    assert.match(dirty.description, /will not change/);
  });

  it('the error state says what is still on the server and why the new one is not', () => {
    const indicator = saveIndicator(saveFailed(beginSave(markDirty(savedAt(3))), 'CLAIM_NOT_CONFIRMED'));
    assert.match(indicator.label, /Not saved/);
    assert.match(indicator.description, /Revision 3/);
    assert.match(indicator.description, /CLAIM_NOT_CONFIRMED/);
  });

  it('names the revision, so "saved" is checkable', () => {
    assert.equal(revisionIdentity(savedAt(7, HASH_B)), `revision 7, jsonHash ${HASH_B}`);
    assert.equal(revisionIdentity(INITIAL_SAVE_STATE), 'no revision yet');
  });
});