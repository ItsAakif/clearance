// The shared render vocabulary - the formats the route accepts, the content types the
// artifacts carry, and the ONE error type every render rejection becomes.
//
// NORMATIVE DOC: .planning/specs/clearance-v2/T1040-implementation-plan.md sec. 7
//                 (the render route's format contract, the error mapping, the persistence
//                 shape) and sec. 13 rulings 1 and 4 (`typ` refused; `tex`/`json` use the
//                 reserved `templateId: 'none'`)
//                 .planning/specs/clearance-v2/render-sandbox-policy.md 9.2 (the closed
//                 outcome set), 9.3/9.4 (the error surface), 6.4 (metadata only)
//                 .planning/decisions/ADR-044-*.md D2 (Postgres holds metadata, never bytes)
// Task:         T1043
//
// WHY THE ERROR TYPE LIVES HERE AND NOT IN THE PORT. Three different modules reject a
// render for three different reasons - `stage.ts` (input caps and the tree audit),
// `brokerClient.ts` (the broker's own closed outcome codes, verbatim) and the template
// registry (a template that did not clear its review gate) - and each of them already
// owns a closed code vocabulary with fixed messages. What they do NOT own is the HTTP
// status, because none of them is the API. This module is that one place: it takes a
// machine code from any of them and answers the single question the route asks, "what
// status, and what fixed text?". Adding a status to `shared/errors.ts` per code would put
// render policy in a module about login and uploads, and duplicating the mapping inside
// `renderPort.ts` would make the route and the port able to disagree about a refusal.
//
// THE MESSAGES ARE A LOOKUP TABLE, NOT TEMPLATES (policy 9.3). No `code`, `reason`,
// revision id, template id, storage key, digest or staged content is ever interpolated
// into one. That is structural, not a convention: there is no interpolation site to misuse,
// and the same rule the sibling modules (`stage.ts`, `storage.ts`, `templates.ts`) already
// follow with their own `REASON_TEXT` tables.
//
// WHY `EXPORT_MIME_TYPES` IS RE-EXPORTED RATHER THAN DECLARED. It is defined once, in
// `render/exportMime.ts` (T1044), against the closed `ExportFormat` union. A second table
// here would be a second answer to "what content type is a `.tex`", and the two could
// disagree for a stored artifact's `mimeType` column. This module re-exports the same
// binding so a caller of the render port needs one import, and adds the COMPILED formats'
// content types from `stage.ts` (T1013, policy 6.4) - which is a different question again
// and deliberately not merged with the export table (T1044's header says why).

import { ARTIFACT_MIME_TYPES } from './stage.js';
import { EXPORT_FORMATS, EXPORT_MIME_TYPES, type ExportFormat } from './exportMime.js';
import { RENDER_FORMATS, type RenderFormat } from './sandbox.js';

export { EXPORT_FORMATS, EXPORT_MIME_TYPES, type ExportFormat };

// ---------------------------------------------------------------------------
// The format vocabulary the route accepts
// ---------------------------------------------------------------------------

/**
 * The formats `POST /resumes/:id/render` accepts (T1030's route already refuses anything
 * outside this list, and this module does not widen it).
 *
 * A closed table, not a `string`. Every branch below - the content type, the file
 * extension, whether a template is resolved, whether a broker job exists - is a decision
 * about a MEMBER of this set, so a format that is not a member has to be unreachable
 * rather than merely unhandled.
 *
 * It is also a SUPERSET of what the port can produce, deliberately: `typ` is accepted by
 * the route and refused BY THE PORT, because a `.typ` export is a bundle this phase does not
 * ship (ruling 1). Refusing it in the route would change T1030's shipped contract, so the
 * refusal lives where the bundle question is answered. `docx` was in that position until
 * T1041 and is now produced in-process, so it is the shape a future format should follow:
 * accepted, and either produced or refused with a machine reason.
 */
export const RENDER_REQUEST_FORMATS = Object.freeze([
  'pdf',
  'docx',
  'tex',
  'typ',
  'json',
] as const);

export type RenderRequestFormat = (typeof RENDER_REQUEST_FORMATS)[number];

/**
 * `true` for a member of the route's accepted set. Deliberately separate from
 * `isRenderFormat()` in `sandbox.ts`, which answers a different question: what the
 * COMPILE path accepts (`pdf`/`png`/`svg`).
 */
export function isRenderRequestFormat(value: unknown): value is RenderRequestFormat {
  return typeof value === 'string' && (RENDER_REQUEST_FORMATS as readonly string[]).includes(value);
}

/**
 * The content type of a DOCX artifact: the WordprocessingML OOXML media type.
 *
 * It lives HERE rather than in `docx.ts` because this module is the one that answers "what
 * `Content-Type` does a stored artifact of this format carry", and the row's `mimeType`
 * column is what `GET .../documents/:docId` sends. A second copy in `docx.ts` would be a
 * second answer to that question, and the two could disagree - which is exactly why
 * `EXPORT_MIME_TYPES` is re-exported here rather than redeclared (this header's own note on
 * T1044).
 *
 * It is NOT `application/octet-stream`. That would download correctly and parse never,
 * because Word identifies a package by its content type first.
 */
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * The content type a stored artifact of this request format carries.
 *
 * Two tables, one function, and the split is the point (T1044's header): a compile output
 * is typed by `ARTIFACT_MIME_TYPES` (policy 6.4) and an export by `EXPORT_MIME_TYPES`,
 * and a merged table would let a later edit type an export as a compile output.
 *
 * `docx` has its OWN constant above rather than an `EXPORT_MIME_TYPES` member, because it
 * is not an export in this repository's vocabulary - it is a rendered, editable document
 * that happens to be produced in-process (ADR-039), the way `pdf` is a rendered document
 * that happens to be produced by a broker. Same distinction the tables already draw.
 *
 * `typ` has no entry and is REFUSED rather than defaulted: a `.typ` export is a bundle this
 * phase does not ship (ruling 1). Defaulting it to `application/octet-stream` would put a
 * wrong `mimeType` in a `ResumeDocument` row, and the row's `mimeType` is what
 * `GET .../documents/:docId` sends as `Content-Type`.
 */
export function requestMimeType(format: string): string {
  if (format === 'pdf') return ARTIFACT_MIME_TYPES.pdf;
  if (format === 'docx') return DOCX_MIME_TYPE;
  if (format === 'tex' || format === 'json') {
    const exportFormat = format as ExportFormat;
    return EXPORT_MIME_TYPES[exportFormat];
  }
  throw new RenderPortError(
    'render_format_unsupported',
    format === 'typ' ? 'TYP_EXPORT_IS_A_BUNDLE' : 'FORMAT_HAS_NO_ARTIFACT_TYPE',
  );
}

/**
 * The file extension the download is named with, without the dot.
 *
 * The attachment name is assembled from this plus a SANITISED stem, and both halves are
 * allowlists, so a header built from them cannot contain a separator, a quote or a
 * control byte. `typ` is absent for the same reason `requestMimeType` refuses it: there is
 * no artifact to name. `docx` needs no special case at all - the extension IS the format,
 * which is why it was here before the DOCX renderer existed and needs nothing now.
 */
export function requestExtension(format: string): string {
  if (format === 'pdf' || format === 'tex' || format === 'json' || format === 'docx') {
    return format;
  }
  throw new RenderPortError(
    'render_format_unsupported',
    format === 'typ' ? 'TYP_EXPORT_IS_A_BUNDLE' : 'FORMAT_HAS_NO_ARTIFACT_TYPE',
  );
}

// ---------------------------------------------------------------------------
// The request and result shapes
// ---------------------------------------------------------------------------

/** What `routes/resumes.ts` hands the port. Structurally T1030's `RenderResult` call. */
export interface RenderPortRequest {
  readonly revisionId: string;
  readonly format: string;
  readonly userId: string;
}

/** What the port returns. Byte-for-byte T1030's `RenderResult`, so the route is unchanged. */
export interface RenderPortResult {
  readonly documentId: string;
  readonly format: string;
  /** The sha256 of the exact artifact bytes - the same value the row's `hash` records. */
  readonly hash: string;
}

/** The formats the compile path itself knows, re-exported for the port's own signature. */
export type { RenderFormat };

/** The compile-path format table, re-exported so the port needs one import. */
export { RENDER_FORMATS };

// ---------------------------------------------------------------------------
// The one render error
// ---------------------------------------------------------------------------

/**
 * The closed set of CODES a render refusal may carry, in the vocabulary of policy 9.2 plus
 * the two this layer owns.
 *
 * - the policy's own outcomes, carried verbatim from `stage.ts` / `brokerClient.ts` so a
 *   broker's code and a stager's code are the same string at the API boundary;
 * - `render_format_unsupported` and `render_template_unsupported` for the two refusals
 *   that are about the REQUEST rather than about a compile, and which therefore have no
 *   policy 9.2 outcome;
 * - `render_broker_unavailable` for "the broker could not be reached at all", which is a
 *   deployment fault and is deliberately NOT given the broker's own code, so an operator
 *   can tell "the render was refused" from "there was no renderer to ask";
 * - `render_storage_unavailable` for the storage port refusing or failing, which is the
 *   mirror image: the compile may well have succeeded and the bytes have nowhere to go.
 *
 * Nothing else may be thrown at the API boundary. `handleApiError` is the fallback for an
 * error this list does not contain, and it answers 500 with a generic message - correct,
 * but it throws away the machine code, which is the whole point of the design.
 */
export const RENDER_PORT_ERROR_CODES = Object.freeze([
  // policy 9.2, verbatim
  'RENDER_INPUT_TOO_LARGE',
  'RENDER_COMPILE_ERROR',
  'RENDER_TIMEOUT',
  'RENDER_RESOURCE_LIMIT',
  'RENDER_ARTIFACT_INVALID',
  'RENDER_TOOLCHAIN_MISMATCH',
  'RENDER_BUSY',
  'RENDER_INPUT_INVALID',
  // this layer
  'render_format_unsupported',
  'render_template_unsupported',
  'render_broker_unavailable',
  'render_storage_unavailable',
  'render_revision_unavailable',
] as const);

export type RenderPortErrorCode = (typeof RENDER_PORT_ERROR_CODES)[number];

/**
 * Fixed user-facing text per code, taken from policy 9.2's table verbatim where the policy
 * states it. A lookup table rather than a template so a code can never carry caller data
 * (policy 9.3), and frozen so no route can extend it at runtime.
 */
const CODE_TEXT: Readonly<Record<RenderPortErrorCode, string>> = Object.freeze({
  RENDER_INPUT_TOO_LARGE: 'This document is too large to render.',
  RENDER_COMPILE_ERROR: 'This template could not be rendered. Check your content and try again.',
  RENDER_TIMEOUT: 'Rendering took too long and was stopped.',
  RENDER_RESOURCE_LIMIT: 'This document is too large or complex to render.',
  RENDER_ARTIFACT_INVALID: 'The rendered document could not be produced.',
  RENDER_TOOLCHAIN_MISMATCH: 'This template needs a different rendering engine version.',
  RENDER_BUSY: 'The renderer is busy. Try again in a moment.',
  RENDER_INPUT_INVALID: 'This document could not be rendered.',
  render_format_unsupported: 'That format is not available for this document.',
  render_template_unsupported: 'That template is not available for this document.',
  render_broker_unavailable: 'The renderer is temporarily unavailable',
  render_storage_unavailable: 'The rendered document could not be stored.',
  render_revision_unavailable: 'The rendered document could not be produced.',
});

/**
 * The HTTP status per code, and the whole of the contract's error mapping
 * (plan sec. 7, T1040 sec. 13):
 *
 *   429  RENDER_BUSY
 *   422  RENDER_INPUT_TOO_LARGE, RENDER_COMPILE_ERROR, and the two request-shaped
 *        refusals (`render_format_unsupported`, `render_template_unsupported`) - the
 *        request is well-formed and the thing asked for cannot be produced;
 *   503  RENDER_TIMEOUT, RENDER_RESOURCE_LIMIT, RENDER_ARTIFACT_INVALID, and the two
 *        deployment faults (broker unreachable, storage unavailable) - nothing about the
 *        request is wrong and retrying later may work;
 *   409  RENDER_INPUT_INVALID and RENDER_TOOLCHAIN_MISMATCH, which are the two the
 *        existing V2 route already reports at 409: the revision's own bytes are not a
 *        valid render input, and the template's pin is not the pinned toolchain. Both are
 *        a property of the stored state, and 503/422 would each point triage somewhere
 *        else.
 *
 * `RENDER_INPUT_INVALID` and `RENDER_TOOLCHAIN_MISMATCH` are listed in `RENDER_LIMITS`
 * vocabulary but are NOT in policy 9.2's table, so the status here is this layer's
 * judgement and it is the one that matches `sendServiceError`'s existing mapping.
 */
const CODE_STATUS: Readonly<Record<RenderPortErrorCode, number>> = Object.freeze({
  RENDER_INPUT_TOO_LARGE: 422,
  RENDER_COMPILE_ERROR: 422,
  RENDER_TIMEOUT: 503,
  RENDER_RESOURCE_LIMIT: 503,
  RENDER_ARTIFACT_INVALID: 503,
  RENDER_TOOLCHAIN_MISMATCH: 409,
  RENDER_BUSY: 429,
  RENDER_INPUT_INVALID: 409,
  render_format_unsupported: 422,
  render_template_unsupported: 422,
  render_broker_unavailable: 503,
  render_storage_unavailable: 503,
  render_revision_unavailable: 503,
});

/**
 * One render refusal. Carries a machine code, a machine reason and NOTHING else: the
 * message is looked up from the code, so a caller cannot put a path, a stderr line or a
 * staged string into a response body by throwing one of these (policy 9.3/9.4).
 *
 * `reason` is log-safe and machine-readable. It is deliberately NOT echoed to the client
 * by the route for every code, because a reason vocabulary is an internal taxonomy; the
 * one exception is the two request-shaped refusals, whose reason IS the actionable part
 * (`TYP_EXPORT_IS_A_BUNDLE` says why `.typ` is refused, and no other string can), and the
 * route's `format:'typ'` acceptance item asks for exactly that.
 */
export class RenderPortError extends Error {
  readonly code: RenderPortErrorCode;
  readonly reason: string;

  constructor(code: RenderPortErrorCode, reason: string) {
    super(CODE_TEXT[code]);
    this.name = 'RenderPortError';
    this.code = code;
    this.reason = reason;
  }

  /** The status this code maps to. See `CODE_STATUS`. */
  get status(): number {
    return CODE_STATUS[this.code];
  }

  /** Fixed text for a code, for a caller that needs the message without the throw. */
  static messageFor(code: RenderPortErrorCode): string {
    return CODE_TEXT[code];
  }

  /** The status for a code, for a caller that classifies without catching. */
  static statusFor(code: RenderPortErrorCode): number {
    return CODE_STATUS[code];
  }
}

/**
 * The reasons the route is allowed to surface to a client, verbatim.
 *
 * It holds ONE reason now. `DOCX_RENDERER_NOT_SHIPPED` was removed with the T1041 hole it
 * named: the DOCX renderer shipped, the reason is unreachable, and a set that still
 * advertised a refusal nobody can provoke is a second answer to "what can this format do".
 * The set stays CLOSED for the same reason it was closed - a client-visible reason is an API
 * contract, and adding one is a deliberate act.
 */
export const CLIENT_VISIBLE_RENDER_REASONS: ReadonlySet<string> = new Set([
  'TYP_EXPORT_IS_A_BUNDLE',
]);
