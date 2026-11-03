// =====================================================================================
// resume/legacyExportGuard.ts - the V2 cutover guard for the FROZEN legacy export routes
// (T1030, review finding F10; ADR-035, ADR-036; 05 sec.6, sec.7; FREEZE.md A-42/A-43, K-01).
//
// THE DECISION THIS MODULE ENFORCES, quoted from the orchestrator's ruling:
//
//   "No resume with `modelVersion >= 2` may be exported or previewed through ANY legacy
//    path."
//
// WHY IT HAS TO BE A SEPARATE MODULE. At this commit the gate is complete and the legacy
// export surface is not gated AT ALL - the gate's own review said so, and it is true:
//
//   - `GET /resumes/:id/export/pdf`     renders the legacy `Resume` row's JSON columns;
//   - `GET /resumes/:id/export/docx`    ditto, via the template or programmatic builder;
//   - `POST /resumes/export/docx-preview` renders caller-supplied `sections`;
//   - `POST /resumes/export/pdf-preview`  ditto;
//   - `POST /export/html-to-pdf`        renders arbitrary caller-supplied HTML;
//   - `POST /export/html-to-docx`       ditto.
//
// Meanwhile the GATED V2 route, `POST /resumes/:id/render`, returns 404 because no
// renderer port is installed yet (T1042 owns that). So at this instant the product
// promise - "no unconfirmed claim ever reaches a rendered artifact" - was enforced on a
// route that cannot render and unenforced on every route that can. That is a sequencing
// artefact, not a design, and the only two honest resolutions are "flag them" or "refuse
// them". This module is the refusal.
//
// WHAT THIS IS AND IS NOT. It is a CORRECTNESS GATE, not a feature: it adds no format,
// no parameter and no capability, it removes one. A V1 resume exports exactly as it did
// before this guard - same bytes, same status, same content-type - and that is asserted
// in `legacyExportGuard.test.ts` rather than asserted here in a comment.
//
// WHY THE FROZEN FILES MAY CARRY IT. FREEZE.md sec. 5.2 is explicit that a security fix
// on a frozen path is allowed: "Is it a pure bug fix or a security fix? Allowed; say so
// in the PR." A V2 resume exported through the legacy renderer is exactly that: a
// document that is under clearance control being rendered by a path with no gate. The
// guard is one call at the top of each handler; the rest of each file is untouched.
//
// WHY THE PREVIEW ROUTES CHECK `modelVersion` WHEN THEY HAVE NO RESUME. The `*-preview`
// routes render `sections` straight from the request body - there is no `Resume` row in
// the path. So a preview is refused only when the CALLER NAMES the resume it previews
// (`resumeId` in the body) and that resume is V2. A preview of caller-supplied data with
// no resume named is not attributable to a V2 document, and refusing it would break the
// legacy builder for every user including the ones on V1 rows. This is the one place
// where the decision is applied by attribution rather than by identity, and it is
// stated here rather than left for a reader to discover.
//
// THE CALLER CONTRACT: CHECK OWNERSHIP BEFORE CALLING `legacyExportRefusal` (review
// finding N7). The refusal body carries `resume.modelVersion`, so a route that refuses a
// row it has not first proved the caller owns is a cross-tenant oracle for exactly the
// fact this guard exists to protect: name another user's id, read 409, learn the
// version. Every call site does this - `routes/resume.ts` `refuseIfClearanceControlled`
// is only ever reached after `ensureOwnership`, and so is `routes/export.ts`'s
// `refuseIfV2ResumeNamed`. The contract is stated HERE as well as at the call sites
// because this module is the policy and the policy is what a new call site will read.
// =====================================================================================

/**
 * `Resume.modelVersion` at and above which a row is under clearance control.
 *
 * Read from the schema comment rather than hard-coded twice: `prisma/schema.prisma`
 * says `1 = legacy builder shape; 2 = Resume JSON projection`. A V3 would also be gated,
 * which is the correct default for a control that has to be re-decided deliberately
 * rather than silently relaxed by an enum growing.
 */
export const CLEARANCE_CONTROLLED_MODEL_VERSION = 2;

/** The gated path a refused caller should use instead. Named in every refusal. */
export const GATED_V2_RENDER_PATH = 'POST /resumes/:id/render';

/** The stable, machine-readable code. A client branches on this, not on prose. */
export const LEGACY_EXPORT_REFUSED_CODE = 'legacy_export_v2_refused';

/** The minimal row shape this guard needs. Keeps the seam trivially fakeable. */
export interface LegacyExportResumeRef {
  id: string;
  userId: string;
  modelVersion: number;
}

/**
 * Is this row under clearance control?
 *
 * A `NaN` / non-numeric / missing `modelVersion` is treated as CONTROLLED. The schema
 * defaults it to 1, so "absent" is not a reachable state for a real row - but if a
 * projection or a partial select ever produced one, "I do not know what this is" must
 * not resolve to "it is fine to render ungated". Fail closed on an unknown shape.
 */
export function isClearanceControlled(resume: LegacyExportResumeRef | null | undefined): boolean {
  if (!resume) return true;
  const version = resume.modelVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) return true;
  return version >= CLEARANCE_CONTROLLED_MODEL_VERSION;
}

/** What a refusal carries. Serialised verbatim into the 409 body. */
export interface LegacyExportRefusal {
  code: typeof LEGACY_EXPORT_REFUSED_CODE;
  error: string;
  reason: 'V2_RESUME_NOT_EXPORTABLE_THROUGH_LEGACY_PATH';
  modelVersion: number;
  gatedPath: string;
}

export function legacyExportRefusal(resume: LegacyExportResumeRef): LegacyExportRefusal {
  return {
    code: LEGACY_EXPORT_REFUSED_CODE,
    error:
      'This resume is under clearance control and may not be exported or previewed through a legacy path. ' +
      `Use the gated renderer: ${GATED_V2_RENDER_PATH}.`,
    reason: 'V2_RESUME_NOT_EXPORTABLE_THROUGH_LEGACY_PATH',
    modelVersion: resume.modelVersion,
    gatedPath: GATED_V2_RENDER_PATH,
  };
}

/** 409, not 404: the caller is authenticated and the refusal is a rule, not a lookup. */
export const LEGACY_EXPORT_REFUSED_STATUS = 409;
