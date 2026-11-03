// The EXPORT formats' content types - the two outputs that need no typesetter and no
// container.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 7
//                 (the render route's format contract) and sec. 13 ruling 4
//                 (`tex`/`json` rows use the reserved `templateId: 'none'`)
//                 .planning/decisions/ADR-042-latex-export-only-and-broker.md D1
//                 (LaTeX is export-only; there is no server-side compile)
// Task:         T1044
//
// WHY A SEPARATE TABLE, AND WHY IT HAS EXACTLY TWO MEMBERS. `ARTIFACT_MIME_TYPES`
// (`render/stage.ts`, T1013) answers "what are the BYTES of a finished compile?" for the
// paged formats. This table answers a different question - "what do we hand the user when
// there was no compile at all?" - and the two must not be merged, because a `.tex` and a
// `.json` never pass through the broker, the staging tree, `/out` or `validateRenderArtifact`.
// One merged table would let a later edit type an export artifact as a compile output.
//
// THERE IS NO `typ` MEMBER, AND THAT IS A DECISION, NOT AN OMISSION. A `.typ` export is a
// BUNDLE: one template plus `data.json` plus `packages.lock` (T1040 sec. 11 open item 1).
// T1040 sec. 13 ruling 1 closed it as (c) KEEP REFUSING, and the refusal is the route's
// (`422 render_format_unsupported` / `TYP_EXPORT_IS_A_BUNDLE`). So the format is refused
// BEFORE it can reach a table that would give it a content type: declaring `typ` here would
// be the first step of shipping the bundle shape this program exists to delete. `pdf`/`png`/
// `svg` are absent for the same reason in the other direction - they are compile artifacts
// and live in `ARTIFACT_MIME_TYPES`.
//
// The table is FROZEN and the vocabulary is CLOSED, because a content type is a wire
// contract: a value a caller could edit at runtime is one a stored artifact's `mimeType`
// column could silently stop matching. `exportMimeType()` therefore takes the closed
// `ExportFormat` union, and the runtime guard refuses anything outside it with a FIXED
// reason string - no caller data is ever interpolated into the message (policy 9.3/9.4).

/**
 * The closed set of export formats, in the order the route's contract lists them.
 *
 * `pdf`/`png`/`svg` are NOT here: they are compile outputs (`ARTIFACT_MIME_TYPES`), not
 * exports. `typ` is NOT here, and must not be added without ADR-044 open item 1 being
 * decided the other way (T1040 sec. 13 ruling 1).
 */
export const EXPORT_FORMATS = Object.freeze(['tex', 'json'] as const);

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The content type recorded on a stored export artifact and sent as `Content-Type` by
 * `GET /resumes/:id/documents/:docId`.
 *
 * `application/x-tex` is the vendor tree the IANA has no registration for; `text/x-tex` is
 * what TeX Live itself emits and is equally unregistered. The contract pins the former, and
 * a stored `mimeType` that disagreed with the header would be a worse bug than an
 * unregistered type.
 */
export const EXPORT_MIME_TYPES: Readonly<Record<ExportFormat, string>> = Object.freeze({
  tex: 'application/x-tex',
  json: 'application/json',
});

/** `false` for `pdf`, `typ`, `''`, `null` and anything else outside the closed set. */
export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * The content type for an export format, or a FIXED-reason refusal.
 *
 * The reason string is a policy-style constant with no caller data in it, so an unknown
 * format can never smuggle content into a log line or an error body (policy 9.3/9.4).
 */
export function exportMimeType(format: ExportFormat): string {
  if (!isExportFormat(format)) {
    throw new Error(
      `RENDER_EXPORT_FORMAT_UNKNOWN: export format must be one of ${EXPORT_FORMATS.join(', ')}`,
    );
  }
  return EXPORT_MIME_TYPES[format];
}