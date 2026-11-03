// Studio API - the Resume Studio's typed wrappers over the V2 resume surfaces (T1050).
//
// HOUSE PATTERN (`services/api/*`, cf. `career.ts`): a thin typed wrapper over `apiClient`,
// transforming wire shapes into the frontend's own vocabulary and nothing else. No React, no
// flags, no components, so the module is testable in isolation - which matters here because
// ONE acceptance item is exactly "the preview's source is the render endpoint": with the
// URLs built in this module, a test can assert the endpoint the preview really calls
// (see `src/features/studio/pagePreview.test.ts`) instead of taking a snapshot of a layout.
//
// WHAT THE STUDIO MAY AND MAY NOT SEND. This module is deliberately NARROWER than the
// backend surface:
//
//   - there is NO method that updates an existing revision. `createRevision` is the only
//     write, so autosave cannot mutate revision N - it always creates N+1 (ADR-035, 05
//     sec.6). `saveRevision` below is named for what it does; there is no `saveInPlace`
//     for a mutation test to remove.
//   - `templateId` appears on the RENDER call and NOWHERE ELSE. The template is a
//     render-time choice: `renderRevision` sends it only when the caller names one, it is
//     never a member of the document, and there is no other method here that takes a layout
//     of any kind. T1050 escalation 1 widened the render seam; it did not give the template a
//     path into the resume JSON.
//
// THE `x-clearance` BLOCK IS CARRIED VERBATIM. The claim statuses in a document are copies
// of `CareerClaim.status` read by the projector, and `createRevision` REFUSES a document
// whose block disagrees with the rows (`CLEARANCE_DISAGREES_WITH_CLAIMS`). So the editor
// treats status as read-only server truth - see `features/studio/blockModel.ts`, which is
// the only place a document is rewritten and which never touches a status.
//
// GATE VERDICTS ARE SURFACED, NEVER INVENTED. `StudioGateVerdict` is the server's own shape
// (`allowed` + counts, or `reason` + `violations`), because "confirm these claims first" is
// the single most important thing the Studio has to say and it must say the server's reason
// rather than a paraphrase.

import { apiClient } from "./client";

// ---------------------------------------------------------------------------
// The document: JSON Resume + the one `x-clearance` extension block
// ---------------------------------------------------------------------------

/** Mirrors `backend/src/resume/json/jsonresume.ts` `ClaimStatus`. */
export type StudioClaimStatus =
  | "inferred"
  | "contextual"
  | "user_confirmed"
  | "rejected"
  | "superseded";

/** Mirrors `ClaimProvenance`. */
export type StudioClaimProvenance =
  | "user_entered"
  | "document_import"
  | "llm_inferred"
  | "derived"
  | "github_derived"
  | "external_verified";

/** Mirrors `ResumeUsage`: the gated usages are `verbatim` and `tailored`. */
export type StudioClaimUsage = "verbatim" | "tailored" | "omitted";

/** One claim, as the document accounts for it. */
export interface StudioClearanceClaim {
  claimId: string;
  fingerprint: string;
  kind: string;
  /** SERVER TRUTH. Never written by the editor. */
  status: StudioClaimStatus;
  provenance: StudioClaimProvenance;
  confidence: number | null;
  evidenceSourceId: string | null;
  usage: StudioClaimUsage;
  /** `work[0].highlights[2]` when the claim's text is placed; `null` when omitted. */
  jsonPath: string | null;
  renderedText: string | null;
}

/** The extension block. Its shape is strict in the server's schema (`additionalProperties: false`). */
export interface StudioClearanceBlock {
  version: number;
  generatedBy: string;
  sourceModelVersion: number;
  profileId: string;
  claimCount: number;
  confirmedClaimCount: number;
  unconfirmedClaimCount: number;
  claims: StudioClearanceClaim[];
}

/** The one extension key. Named here so the frontend and the schema cannot drift on the spelling. */
export const X_CLEARANCE_KEY = "x-clearance" as const;

export interface StudioBasics {
  name: string;
  label?: string;
  image?: string;
  email?: string;
  phone?: string;
  url?: string;
  summary?: string;
  location?: Record<string, string>;
  profiles?: Array<{ network?: string; username?: string; url: string }>;
}

export interface StudioWorkEntry {
  name: string;
  position: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  summary?: string;
  highlights?: string[];
}

export interface StudioEducationEntry {
  institution: string;
  url?: string;
  area?: string;
  studyType?: string;
  startDate?: string;
  endDate?: string;
  score?: string;
  courses?: string[];
}

export interface StudioProjectEntry {
  name: string;
  description?: string;
  highlights?: string[];
  keywords?: string[];
  startDate?: string;
  endDate?: string;
  roles?: string[];
  entity?: string;
  url?: string;
}

export interface StudioSkillEntry {
  name: string;
  level?: string;
  keywords?: string[];
}

export interface StudioCertificateEntry {
  name: string;
  date?: string;
  issuer?: string;
  url?: string;
}

/**
 * The canonical document (05 sec.1). Every root member is optional except `basics` in
 * practice: JSON Resume requires `basics.name` and nothing else.
 */
export interface ResumeDocumentJson {
  basics: StudioBasics;
  work?: StudioWorkEntry[];
  education?: StudioEducationEntry[];
  projects?: StudioProjectEntry[];
  skills?: StudioSkillEntry[];
  certificates?: StudioCertificateEntry[];
  [X_CLEARANCE_KEY]?: StudioClearanceBlock;
}

// ---------------------------------------------------------------------------
// The gate verdict (reported, never invented)
// ---------------------------------------------------------------------------

export interface StudioGateViolation {
  claimId: string;
  reason: string;
  claimStatus: StudioClaimStatus | null;
  usage: string;
}

export type StudioGateVerdict =
  | { allowed: true; checked: number; rendered: number }
  | {
      allowed: false;
      reason: string;
      violations: StudioGateViolation[];
      checked: number;
      rendered: number;
    };

/** The revision list entry. `resumeJson` is omitted by the server's list route. */
export interface StudioRevisionSummary {
  id: string;
  resumeId: string;
  revisionNumber: number;
  jsonHash: string;
  createdBy: string;
  createdByUserId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface StudioRevision extends StudioRevisionSummary {
  document: ResumeDocumentJson;
  gate: StudioGateVerdict;
}

/** The render response. `documentId` is then streamed from `downloadDocument`. */
export interface StudioRenderResult {
  documentId: string;
  format: string;
  hash: string;
}

/** One rendered artifact's metadata. Never bytes, never a storage key. */
export interface StudioDocumentSummary {
  id: string;
  format: string;
  templateId: string;
  templateVersion: string | null;
  pageCount: number | null;
  hash: string;
  byteSize: number;
  mimeType: string;
  createdAt: string;
}

/** What `POST /resumes/from-profile` answers with (the Studio's only way to make a V2 resume). */
export interface StudioFromProfileResult {
  resume: { id: string; name: string; modelVersion: number; profileId: string; createdAt: string };
  revision: {
    id: string;
    revisionNumber: number;
    jsonHash: string;
    createdAt: string;
    document: ResumeDocumentJson;
  };
  validation: { valid: boolean; errors: Array<{ path: string; keyword: string; message: string }> };
  gate: StudioGateVerdict;
}

/**
 * What `POST /resumes/:id/upgrade` answers with: a V1 `Resume` row's FIRST V2 revision,
 * projected from its own content through the legacy backfill.
 *
 * `upgraded: false` means the row was already V2 and nothing was written - the response carries
 * the CURRENT revision instead. `claims: null` in that case, because no claim was touched.
 * `statusAssigned` is echoed by the server so a caller can prove the document's block did not
 * decide any status: it is `inferred` for every claim, always, and the user confirms.
 */
export interface StudioUpgradeResult {
  upgraded: boolean;
  /** Present only when `upgraded` is false. The machine reason, so the UI can say which. */
  reason?: "already_upgraded";
  resume: { id: string; name?: string; modelVersion: number; profileId: string };
  revision: {
    id: string;
    revisionNumber: number;
    jsonHash: string;
    createdAt: string;
    document: ResumeDocumentJson;
  };
  validation?: { valid: boolean; errors: Array<{ path: string; keyword: string; message: string }> };
  gate: StudioGateVerdict;
  claims: { created: number; deduped: number; total: number; evidenceSourceId: string } | null;
  statusAssigned: StudioClaimStatus;
}

/**
 * The machine reason a render was refused, when the server classified it.
 *
 * `render_template_unsupported` is the one the Studio must surface honestly: it is what the
 * server answers for a template id it cannot resolve - a reserved id, one that is not in the
 * registry, or a value that is not a template id at all - and the Studio reports the code
 * verbatim rather than quietly previewing a different layout (see `TemplateSwitch.tsx`).
 */
export interface StudioRenderRefusal {
  code: string;
  reason?: string;
  message: string;
}

/** The formats the render route accepts. `typ` is accepted and refused by the port. */
export const STUDIO_RENDER_FORMATS = ["pdf", "docx", "tex", "json"] as const;
export type StudioRenderFormat = (typeof STUDIO_RENDER_FORMATS)[number];

function revisionNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`revisions: "${value}" is not a revision number`);
  }
  return parsed;
}

export const studioApi = {
  /**
   * The V2 DATA PATH: create a `modelVersion: 2` resume and its first revision, projected
   * from the career profile. Nothing else in the application can make one, so this is how
   * the Studio gets a document to edit.
   */
  async createFromProfile(input: { name?: string } = {}): Promise<StudioFromProfileResult> {
    return apiClient.post<StudioFromProfileResult>("/resumes/from-profile", input);
  },

  /** Every revision of a resume, oldest first (the server's order is a contract). */
  async listRevisions(resumeId: string): Promise<StudioRevisionSummary[]> {
    return apiClient.get<StudioRevisionSummary[]>(`/resumes/${resumeId}/revisions`);
  },

  /**
   * UPGRADE-ON-OPEN (T1110). Give a `modelVersion: 1` row its first V2 revision, or report the
   * current one if it already has one.
   *
   * Why the Studio calls this rather than the user being told to go and import things: the
   * cutover made `/app/build/:resumeId` redirect here, so this call is what stops the redirect
   * from being a dead end for exactly the resumes that existed before it.
   *
   * Idempotent on the server, and safe to call on a row that is already V2 - so the Studio can
   * call it on every load without tracking whether it has. It CONFIRMS NOTHING: the revision it
   * creates carries every claim as `inferred`, and the user confirms them in the verification
   * UI. `claims` is `null` when nothing was written, which is how the caller tells the two cases
   * apart.
   */
  async upgrade(resumeId: string, input: { profileId?: string } = {}): Promise<StudioUpgradeResult> {
    return apiClient.post<StudioUpgradeResult>(`/resumes/${resumeId}/upgrade`, input);
  },

  /** One revision plus its document and its gate verdict. */
  async getRevision(resumeId: string, number: number): Promise<StudioRevision> {
    return apiClient.get<StudioRevision>(`/resumes/${resumeId}/revisions/${number}`);
  },

  /**
   * CREATE revision N+1. The only write the Studio makes.
   *
   * `usages` is deliberately NOT a parameter: the server derives the usage set from the
   * document's own `x-clearance` block and refuses a restatement that disagrees
   * (`resume/revisions.ts#createRevision`). A client that could restate it would be a second
   * thing to keep in step with the block, and the block is the document's own account of
   * itself.
   */
  async createRevision(
    resumeId: string,
    document: ResumeDocumentJson,
    options: { reason?: string } = {},
  ): Promise<StudioRevision> {
    return apiClient.post<StudioRevision>(`/resumes/${resumeId}/revisions`, {
      document,
      reason: options.reason ?? "edited in the Resume Studio",
    });
  },

  /**
   * Ask the server what a projection of the profile WOULD contain. Writes nothing - it is
   * the "what would I get" surface, and the Studio uses it to tell a user whose profile has
   * no confirmed claims what a resume would be before they build one.
   */
  async project(resumeId: string): Promise<{
    modelVersion: number;
    document: ResumeDocumentJson;
    jsonHash?: string;
    gate: StudioGateVerdict & { unconfirmed?: number; note?: string };
    backfill?: { claimDrafts: number; persisted: boolean; note: string };
  }> {
    return apiClient.post(`/resumes/${resumeId}/project`);
  },

  /**
   * Render a revision. THIS IS THE PREVIEW'S ONLY SOURCE (ADR-037 item 3): the bytes come
   * from the typesetter, so there is exactly one layout authority and the browser cannot
   * drift from print.
   *
   * `templateId` IS A RENDER-TIME CHOICE AND IS SENT ONLY WHEN ASKED FOR. It is omitted from
   * the body entirely when the caller names none, so the default call is byte-identical to the
   * one this module made before the seam was widened - and it never reaches the DOCUMENT: the
   * revision the server stores is the same snapshot whichever template laid it out, and the
   * cache's own key (`revisionId + format + templateId`) is what makes a second template a
   * second artifact rather than a rewrite of the first.
   *
   * Omitting `revisionId` means "the current revision", which is what a preview of the last
   * autosave wants.
   */
  async renderRevision(
    resumeId: string,
    options: { format?: StudioRenderFormat; revisionId?: string; templateId?: string } = {},
  ): Promise<StudioRenderResult> {
    const query = options.revisionId ? `?revisionId=${encodeURIComponent(options.revisionId)}` : "";
    return apiClient.post<StudioRenderResult>(`/resumes/${resumeId}/render${query}`, {
      format: options.format ?? "pdf",
      // Conditional rather than `templateId: options.templateId`: an absent member and an
      // explicit `undefined` are the same JSON on the wire, but a member that is always
      // present would be a promise the default path does not keep.
      ...(options.templateId ? { templateId: options.templateId } : {}),
    });
  },

  /** Every rendered artifact of a resume, newest first. Metadata only. */
  async listDocuments(resumeId: string): Promise<StudioDocumentSummary[]> {
    return apiClient.get<StudioDocumentSummary[]>(`/resumes/${resumeId}/documents`);
  },

  /**
   * The typesetter's BYTES for one document.
   *
   * `download` rather than `get`, because the response is a PDF: `request()` would try to
   * parse it as JSON. The caller turns this into an object URL and embeds it; it never
   * redraws it.
   */
  async downloadDocument(resumeId: string, documentId: string): Promise<Blob> {
    return apiClient.download(`/resumes/${resumeId}/documents/${documentId}`);
  },
};

/**
 * Classify a thrown render failure into the machine reason the UI must show verbatim.
 *
 * An `ApiClientError` from the render route carries `{statusCode, code, message}` and the
 * gate's own 409 carries a `reason` in the body - but `apiClient` does not surface `reason`
 * (it reads only `error`/`code`), so the reason is not available client-side today. What IS
 * available, and what this function uses, is the code plus the message. Returning a fixed
 * shape means the preview renders the same text every time instead of formatting an
 * unknown error differently in two places.
 */
export function renderPortRefusal(caught: unknown): StudioRenderRefusal {
  const anyCaught = caught as
    | { statusCode?: number; code?: string; message?: string; reason?: string }
    | null;
  const code = typeof anyCaught?.code === "string" ? anyCaught.code : "render_failed";
  const message =
    typeof anyCaught?.message === "string" && anyCaught.message.length > 0
      ? anyCaught.message
      : "the render could not be produced";
  return {
    code,
    message,
    reason: typeof anyCaught?.reason === "string" ? anyCaught.reason : undefined,
  };
}

export default studioApi;