// The `.json` exporter - the canonical bytes of the revision, and nothing else.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 5
//                   ("T1041 and T1044 consume `dict.ts` for content and order"; sec. 12
//                   maps the retired `json.ts` module to this task)
//                 .planning/decisions/ADR-044-*.md D3 (ONE shared dictionary, three
//                   serialisers)
//                 .planning/specs/clearance-v2/05-canonical-model.md sec. 1 (JSON Resume +
//                   `x-clearance` is THE document; ADR-035)
// Task:         T1044
//
// WHY THIS MODULE DOES NOT READ `render/dict.ts`, AND WHY THAT IS THE POINT.
//
// The task contract says this exporter emits "the canonical Resume JSON bytes of the
// revision". That is a different artifact from the dictionary, and it is deliberately NOT
// derived from it:
//
//   - the dictionary is the RENDER PROJECTION (rule 5 of `dict.ts`'s header): it carries
//     what a page can show, and it deliberately OMITS the `x-clearance` ledger - claim ids,
//     statuses, provenance, usage - because printing a claim status next to a name is not
//     a decision a projection may take. Re-deriving the export from the dictionary would
//     therefore silently DELETE the provenance block from the user's own document.
//   - the canonical serialiser is already `canonicalJsonString` in `resume/json/
//     jsonresume.ts`, the SAME function the revision snapshot and `ResumeRevision.jsonHash`
//     use. This module calls it and encodes the result. It does not re-implement
//     serialisation, does not sort keys a second way, and cannot drift from the hash.
//
// SO THE INPUT TYPE IS THE DOCUMENT, not the dictionary. The signature is
// `unknown -> Buffer` with the input read defensively, for the same reason
// `projectResumeDict` is total: this function sits on a route, and a throw there is a
// user-visible render failure. A malformed document must produce an export or a
// machine-readable refusal, never an unhandled exception.
//
// DETERMINISM IS THE ACCEPTANCE ITEM. `canonicalJsonString` sorts object keys in ascending
// code-unit order AT EVERY DEPTH and preserves array order, drops `undefined` members
// exactly as `JSON.stringify` does, and REJECTS a non-JSON value with a `TypeError` rather
// than coercing it. Two exports of one revision are therefore byte-identical, and the
// bytes are the same bytes `jsonHash` was computed over - which is what makes a `.json`
// export a checkable artifact rather than a rendering of one.
//
// SCHEMA VALIDATION IS THE ROUTE'S, NOT THIS MODULE'S. `validateResumeJson` in
// `resume/json/validate.ts` runs before the render port is reached (the pre-render gate),
// and the export test asserts the produced bytes validate against `RESUME_JSON_SCHEMA`.
// Re-validating here would mean a second schema call on every download for a property that
// is already checked upstream - and, worse, it would make this module the place where a
// schema question is answered, which belongs to the validator.

import { canonicalJsonString, type ResumeJson } from '../resume/json/jsonresume.js';

/** The extension the artifact is named with, without the dot. */
export const JSON_EXPORT_EXTENSION = 'json';

/**
 * The canonical `.json` STRING for a revision document.
 *
 * Exported separately from the bytes because the string is what a hash is taken over
 * (`canonicalJsonHash` hashes exactly this) and because a caller that wants to compare two
 * revisions does not need to decode UTF-8 to do it.
 *
 * Throws the `TypeError` `canonicalJsonString` throws for a value that is not JSON (a
 * function, a symbol, `NaN`, `Infinity`, a `Date`, a `Map`, a class instance, a cycle).
 * That is deliberate and inherited, not an oversight: a projection that quietly serialised
 * a `Date` to a string would make the export depend on an implementation detail, and the
 * route turns the throw into a refusal rather than into a wrong document.
 */
export function renderJsonExportString(revision: unknown): string {
  return canonicalJsonString(revision);
}

/**
 * The canonical `.json` BYTES for a revision document, UTF-8 encoded.
 *
 * The artifact the route stores and the user downloads: the revision's own document, with
 * the `x-clearance` ledger intact, in the exact byte form the revision hash was taken over.
 */
export function renderJsonExportBytes(revision: ResumeJson | unknown): Buffer {
  return Buffer.from(renderJsonExportString(revision), 'utf8');
}

/**
 * A defensive narrow to `ResumeJson`, for a caller that has bytes and wants the type.
 *
 * This asserts nothing: it reads the shape the same way `readClearanceBlock` does, because
 * a document arriving from a download is UNTRUSTED input (policy 1.1) and a type cast is
 * not validation. Structural validity is `validateResumeJson`'s job.
 */
export function asResumeJson(value: unknown): ResumeJson {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('asResumeJson: a Resume JSON document is required');
  }
  return value as ResumeJson;
}