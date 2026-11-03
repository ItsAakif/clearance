// =====================================================================================
// resume/json/claimSurface.ts - WHERE CLAIM TEXT LIVES, defined once (T1030; ADR-043).
//
// WHAT THIS MODULE IS FOR. The pre-render belt ("no string may appear on the claim rail
// unless a text-rendering entry of this document's own `x-clearance` block names it, at
// that exact path, with that exact text") needs a definition of the claim rail. The
// projector needs the SAME definition, to write the `jsonPath` it records for a claim it
// placed. Those two used to be two hand-maintained lists, and they disagreed - which is
// the whole of review finding N1/N3: a second list drifted from the projector, walked
// only element 0 of every array, and included six paths the projector never writes.
//
// SO THERE IS ONE LIST AND IT IS CONSUMED TWICE:
//   - `project.ts` builds every text-writing `jsonPath` with `pathFromTemplate`, so a new
//     verbatim site cannot exist without appearing in the belt's domain;
//   - `revisions.ts` walks the stored document with `claimBackedTextAt`, so the belt
//     sees every claim-backed string the document actually contains.
//
// THE DOMAIN IS THE CLAIM RAIL AND NOTHING ELSE. `projects[].keywords`,
// `project.description`, `work[].summary` and `skills[].name` are entity/profile columns
// the projector copies verbatim. There is NO claim to compare them against, so a belt that
// included them would refuse every legitimate projection that carries one - a false
// positive in a control about UNACCOUNTED CLAIMS, and a permanent one. They are outside
// this domain by construction, and their fail-open status is a NAMED RESIDUAL with an
// owner (ADR-043 "Deliberate residual": R-ENTITY), not something a private array is
// allowed to imply.
//
// `basics.summary` LEFT THIS LIST ON PURPOSE, IN T1080 (ADR-043 R-SUMMARY). It was the
// other half of the same sentence, and it could not be closed sooner because closing it
// required the ROW, not the belt: a summary with no claim behind it is free prose, and the
// first thing T1080's `reword_summary` would do is rewrite free prose. The closing
// precondition is T1020's - `career/resumeImport.ts#resumeToCandidateClaims` emits a
// `soft_skill` claim for the parsed professional summary - so the row now exists, the
// projector places it at `basics.summary` as a RENDERED usage (`resume/json/project.ts`,
// `ProjectionInput.summaryClaims`), and the belt can see the surface. A profile whose
// summary text has NO claim is now UNAUDITED and refused by rule 5, which is the honest
// answer and the price ADR-043 named when it accepted R-SUMMARY.
//
// WHY A TEMPLATE, NOT A PATH LIST. `*` is a wildcard over an ARRAY, and the only correct
// reading of a wildcard is EVERY element. The attempt-2 bug was `Array.prototype.find` on
// the `*` step, which returns the first match: `work[1].highlights` was invisible to the
// belt, so moving the text one element along the array was a bypass. `claimBackedTextAt`
// therefore enumerates indices, and a test in `revisions.test.ts` puts the text at
// `work[1]` with `work[0]` empty.
// =====================================================================================

/**
 * The templates for the claim-backed text surface: the two JSON Resume highlight members
 * the projector writes CLAIM text into, plus `basics.summary` (ADR-043 R-SUMMARY, closed
 * by T1080).
 *
 * This is the belt's DOMAIN, and it is derived from the projector rather than restated
 * next to it. Adding a member here without an emission site in `project.ts` fails
 * `claimSurface.test.ts` (the drift test compares both directions), and adding an
 * emission site in `project.ts` without a member here fails the same test - so the two
 * lists cannot drift apart again.
 *
 * `*` is a wildcard over an array, and it is exhaustive: every index, not the first.
 *
 * ORDER IS THE PROJECTOR'S INDEX CONTRACT. `project.ts` reaches the first two by index
 * (`CLAIM_BACKED_TEXT_PATHS[0]` is `work[].highlights`), so `basics.summary` is APPENDED
 * rather than prepended: inserting a template in the middle would silently re-point the
 * projector's index-based aliases at the wrong member, and the drift test would then
 * compare two different documents and still pass.
 */
export const CLAIM_BACKED_TEXT_PATHS: ReadonlyArray<readonly string[]> = Object.freeze([
  Object.freeze(['work', '*', 'highlights', '*']),
  Object.freeze(['projects', '*', 'highlights', '*']),
  // ADR-043 R-SUMMARY, closed here. `basics.summary` has NO wildcard: it is a single
  // string, which is also why `claimBackedTextAt` walks it in one step.
  Object.freeze(['basics', 'summary']),
]);

/**
 * The concrete `jsonPath` a claim's text occupies, built from a template and the indices
 * that were taken at each `*`.
 *
 * This is the function the PROJECTOR uses, so a `jsonPath` written into `x-clearance` and
 * a path the BELT later reads are the same string by construction rather than by two
 * agreeing template literals. A mismatch here is the failure that made rule 5 of
 * `assertRevisionRenderableInScope` refuse legitimate projections.
 *
 * `indices` must supply one index per `*`, in order:
 *   `pathFromTemplate(CLAIM_BACKED_TEXT_PATHS[0], [1, 2])` -> `work[1].highlights[2]`
 *
 * Non-numeric tokens are copied through unchanged, so the function also works for a
 * template that is already concrete.
 */
export function pathFromTemplate(
  template: readonly string[],
  indices: readonly number[] = [],
): string {
  let taken = 0;
  let path = '';
  for (const token of template) {
    if (token !== '*') {
      path = path === '' ? token : `${path}.${token}`;
      continue;
    }
    const index = indices[taken];
    taken += 1;
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError(
        `pathFromTemplate: ${JSON.stringify(template)} needs a non-negative integer for its wildcard #${taken - 1}`,
      );
    }
    path = `${path}[${index}]`;
  }
  return path;
}

/** One non-empty string the document places on the claim rail. */
export interface ClaimBackedText {
  /** The concrete `jsonPath`, e.g. `work[0].highlights[2]`. */
  readonly path: string;
  /** The TRIMMED text, which is the form `x-clearance.renderedText` stores. */
  readonly text: string;
}

/**
 * Every non-empty string the document places on the claim rail, at its concrete path.
 *
 * TOTALLY EXHAUSTIVE over wildcard steps, and tolerant about shape: a member that is
 * missing, `null`, not an object, or not an array where the template says `*` simply
 * yields nothing. A malformed document has nothing to account for, and refusing it here
 * would be a second schema validator with a different opinion.
 *
 * Only NON-EMPTY trimmed strings are returned, and the value returned is TRIMMED, because
 * the projector trims what it places (`renderedTextFor`) and the belt compares against
 * `x-clearance.renderedText` as written. An empty string is not text a renderer can
 * attribute to a claim; the projector no longer emits one (see `placementOf` in
 * `project.ts`).
 *
 * The order is the order of `CLAIM_BACKED_TEXT_PATHS` then ascending indices, so the
 * result is a function of the document alone.
 */
export function claimBackedTextAt(document: unknown): ClaimBackedText[] {
  const found: ClaimBackedText[] = [];
  for (const template of CLAIM_BACKED_TEXT_PATHS) {
    walk(document, template, 0, [], found);
  }
  return found;
}

function walk(
  value: unknown,
  template: readonly string[],
  step: number,
  indices: readonly number[],
  out: ClaimBackedText[],
): void {
  if (step === template.length) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.length > 0) out.push({ path: pathFromTemplate(template, indices), text });
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const token = template[step];
  if (token === '*') {
    if (!Array.isArray(value)) return;
    // EVERY element, never `find`. This is the difference between a belt and a
    // suggestion: `Array.prototype.find` would make `work[1]` invisible to a document
    // whose text sits at `work[1]`.
    for (let index = 0; index < value.length; index += 1) {
      walk(value[index], template, step + 1, [...indices, index], out);
    }
    return;
  }
  walk((value as Record<string, unknown>)[token], template, step + 1, indices, out);
}
