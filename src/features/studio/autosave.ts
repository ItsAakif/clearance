// autosave.ts - the dirty / saving / saved state machine (T1050).
//
// PURE, no React, no network (ADR-031 decision 3), so every transition below is asserted in
// `autosave.test.ts` rather than observed in a browser.
//
// THE RULE THIS FILE EXISTS TO MAKE UNBREAKABLE: AN EDIT CREATES A NEW REVISION AND A
// REVISION IS NEVER MUTATED. There is deliberately no `updateRevision` / `patchRevision` /
// `saveInPlace` transition here, and the only transition that produces a persisted state is
// `saveSucceeded`, which takes a revision NUMBER AND ITS HASH. Nothing in this file can
// express "change revision 3": the state after a successful save is described by what a
// `POST /resumes/:id/revisions` answered with, so "autosave mutated the existing revision" is
// not a bug this module can express, it is a bug it cannot be written.
//
// THE OTHER RULE: A FAILED SAVE KEEPS THE DIRTY STATE. `saveFailed` does NOT clear the dirty
// flag and does NOT roll the model back. The user still has unsaved work, the server refused
// it, and the honest thing to say is "unsaved, and here is why" - a save button that went
// green over an edit the server never took is the failure mode this state machine exists to
// prevent. The reason is kept verbatim so the Studio can show the machine error.

export type SaveStatus = "saved" | "dirty" | "saving" | "error";

export interface StudioSaveState {
  status: SaveStatus;
  /** The last revision the server confirmed. `null` before the first successful save. */
  savedRevisionNumber: number | null;
  /** The `jsonHash` the server recorded for that revision. The document's identity. */
  savedJsonHash: string | null;
  /** True when the model holds edits the server has not accepted. */
  dirty: boolean;
  /** The verbatim failure reason, kept until the next successful save or the next edit. */
  error: string | null;
  /** How many edits are waiting for the in-flight save. Cleared by a success or a new edit. */
  pendingEdits: number;
}

export const INITIAL_SAVE_STATE: StudioSaveState = {
  status: 'saved',
  savedRevisionNumber: null,
  savedJsonHash: null,
  dirty: false,
  error: null,
  pendingEdits: 0,
};

/**
 * An edit happened. The document is now dirty and stays dirty.
 *
 * `pendingEdits` is a COUNT, not a boolean, because a second edit during an in-flight save
 * must not be lost by the first save's success: the state after that success has to be dirty
 * again. Clearing the count here and having `saveSucceeded` re-read it is what makes that
 * work (see the test "an edit made while a save is in flight stays dirty").
 */
export function markDirty(state: StudioSaveState): StudioSaveState {
  return {
    ...state,
    status: 'dirty',
    dirty: true,
    pendingEdits: state.pendingEdits + 1,
    error: null,
  };
}

/**
 * A save started. Still dirty: nothing is saved until the server says so.
 *
 * `pendingEdits` is ZEROED here, and that is what makes the count mean what it says: the edits
 * waiting when the save starts ARE the in-flight payload, so the counter is reset to ask the
 * only question that matters afterwards - "did anything change while this was in flight?".
 */
export function beginSave(state: StudioSaveState): StudioSaveState {
  return { ...state, status: 'saving', dirty: true, error: null, pendingEdits: 0 };
}

/**
 * The save succeeded. This is a NEW revision number - never the one that was already there.
 *
 * `dirty` is `pendingEdits > 0`, i.e. an edit that landed while this save was in flight
 * keeps the state dirty rather than being reported as saved, which is the difference between
 * "the last thing I did is on the server" and "the last thing the server has is what I see".
 */
export function saveSucceeded(
  state: StudioSaveState,
  result: { revisionNumber: number; jsonHash: string },
): StudioSaveState {
  return {
    status: state.pendingEdits > 0 ? 'dirty' : 'saved',
    savedRevisionNumber: result.revisionNumber,
    savedJsonHash: result.jsonHash,
    dirty: state.pendingEdits > 0,
    error: null,
    pendingEdits: 0,
  };
}

/**
 * The save failed. The edits are STILL unsaved and the reason is kept verbatim.
 *
 * `dirty` is unconditionally true: there is no branch in which a refusal clears it. The
 * `pendingEdits` count is kept so an in-flight edit tally is not silently discarded either.
 */
export function saveFailed(state: StudioSaveState, reason: string): StudioSaveState {
  return { ...state, status: 'error', dirty: true, error: reason };
}

/**
 * Whether the document holds edits the server has not accepted.
 *
 * ONE predicate, derived from `status` rather than from the `dirty` field, so a state whose
 * flag and status disagreed (which a hand-written state object could do) still answers the way
 * the four states actually behave: a save in flight and a refused save both mean "unsaved".
 */
export function isDirtyState(state: StudioSaveState): boolean {
  return state.status === 'dirty' || state.status === 'saving' || state.status === 'error';
}

/** Whether the Studio should offer a save / retry. One predicate, so the UI cannot drift. */
export function shouldOfferSave(state: StudioSaveState): boolean {
  return isDirtyState(state) && state.status !== 'saving';
}

/** The status line the Studio shows. Icon + text, never colour alone (06 E.11). */
export interface SaveIndicator {
  status: SaveStatus;
  /** A glyph name the component maps to a lucide icon. */
  icon: 'check' | 'pencil' | 'loader' | 'alert';
  label: string;
  description: string;
}

/**
 * The unsaved-changes indicator 06 E.11 flow 4 asks for, in words as well as a glyph.
 *
 * Every state says WHICH revision is on the server, because "saved" without a number is a
 * claim the user cannot check. `saveRevisionNth` is worded so the sentence reads correctly for
 * the first revision too.
 */
export function saveIndicator(state: StudioSaveState): SaveIndicator {
  const revision = state.savedRevisionNumber === null ? null : `Revision ${state.savedRevisionNumber}`;
  switch (state.status) {
    case 'saving':
      return {
        status: 'saving',
        icon: 'loader',
        label: 'Saving a new revision',
        description: `${state.pendingEdits} edit${state.pendingEdits === 1 ? '' : 's'} waiting to be written as a new revision.`,
      };
    case 'dirty':
      return {
        status: 'dirty',
        icon: 'pencil',
        label: 'Unsaved changes',
        description:
          state.savedRevisionNumber === null
            ? 'Nothing has been saved yet. Saving writes a new revision; the existing ones are never changed.'
            : `${revision} is on the server. Your edits will be written as a NEW revision; ${revision} will not change.`,
      };
    case 'error':
      return {
        status: 'error',
        icon: 'alert',
        label: 'Not saved',
        description: `${revision === null ? 'Nothing' : revision} is still the newest revision on the server. The server said: ${state.error ?? 'the save was refused'}`,
      };
    case 'saved':
    default:
      return {
        status: 'saved',
        icon: 'check',
        label: revision === null ? 'Saved' : `Saved as ${revision}`,
        description:
          revision === null
            ? 'Every edit has been written as a new revision.'
            : `${revision} is the newest revision. Earlier revisions are unchanged.`,
      };
  }
}

/**
 * A summary line the preview shows about the revision it is rendering.
 *
 * The `jsonHash` is the document's identity, so it is what proves "the template did not
 * change the document": the same hash on both sides of a template switch is the evidence, and
 * it is displayed rather than asserted in a comment.
 */
export function revisionIdentity(state: StudioSaveState): string {
  if (state.savedRevisionNumber === null) return 'no revision yet';
  return `revision ${state.savedRevisionNumber}, jsonHash ${state.savedJsonHash ?? 'unknown'}`;
}