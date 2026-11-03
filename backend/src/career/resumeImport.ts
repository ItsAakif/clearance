// =====================================================================================
// career/resumeImport.ts - an imported resume becomes an EvidenceSource + INFERRED claims
// (T1020, ADR-036 item 2, ADR-041 D5, ADR-043 R-SUMMARY).
//
// This is the career layer's half of `POST /career/import/resume`: everything that has
// to be TRUE about a career import lives here, and the route is left with envelope
// validation, ownership and status codes. That split is not cosmetic - it is what lets
// the invariant be enforced by a type rather than by care at a call site:
//
//   1. AN IMPORT PRODUCES ONLY INFERRED CLAIMS (ADR-036 item 2, 05 sec.7.7). Every
//      deterministic claim is written through `createClaim` with
//      `status: IMPORTED_CLAIM_STATUS` and `provenance: IMPORTED_CLAIM_PROVENANCE`, both
//      constants this directory owns. `ClaimCreateInput` has no confirming member at
//      all, so `user_confirmed` is not merely refused here - it does not compile.
//   2. AI OUTPUT IS WRITTEN BY THE ONE AI WRITER. `writeEnrichedResumeClaims` below is
//      the ONLY bridge from a model's parse to a claim row, and it goes through
//      `claimWriterAI#writeInferredClaims`, which hard-codes `status = inferred` and
//      `provenance = llm_inferred`. A model-written sentence labelled `document_import`
//      would read to the user as "this was in your document", which is a fabrication
//      surface of its own - so the two provenance values stay distinguishable
//      afterwards, and a re-run can tell a document's text from a model's.
//   3. NO PROVIDER IS REQUIRED (ADR-041 D5). The deterministic extractor is the PRIMARY
//      path and needs no key at all. Enrichment is a parameter with a default that does
//      nothing, and whatever it reports lands in the response as `enrichment` - so
//      "the import was thinner than I expected" always has an answer attached.
//
// The DB seam is INJECTED (`CareerStore`); no module under `backend/src/career/` imports
// the `prisma` singleton. This one also imports nothing about HTTP, file formats or
// providers: the extractor is typed against a narrow structural shape, so the career layer
// does not depend on the PDF/DOCX library, and the provider policy is the CALLER's seam.
// =====================================================================================

import {
  ClaimKind,
  EvidenceKind,
  type CareerClaim,
  type EvidenceSource,
} from '@prisma/client';
import {
  createClaim,
  type CareerClaimStore,
  type CareerStore,
  type ClaimCreateInput,
} from './claims.js';
import { createEvidenceSource } from './evidence.js';
import { writeInferredClaims } from './claimWriterAI.js';
import {
  IMPORTED_CLAIM_PROVENANCE,
  IMPORTED_CLAIM_STATUS,
} from './claimUsage.js';

// ---------------------------------------------------------------------------
// The narrow structural shape the extractor reads
// ---------------------------------------------------------------------------

/**
 * The subset of the V1 parser's `ParsedResume` that a career import actually reads.
 *
 * STRUCTURAL, not the imported type, on purpose: the career layer must not depend on
 * `resume/parser.ts` (and therefore on `pdf-parse`/`mammoth`) to know what an experience
 * entry looks like. `ParsedResume` is assignable to this shape as-is, so the production
 * parser satisfies it with no cast, and a test can pass a plain literal.
 */
export interface ResumeExtractionExperience {
  title?: string | null;
  company?: string | null;
  bullets?: ReadonlyArray<string | null | undefined>;
}

export interface ResumeExtractionEducation {
  degree?: string | null;
  institution?: string | null;
}

export interface ResumeExtractionProject {
  title?: string | null;
  tech?: ReadonlyArray<string | null | undefined>;
  bullets?: ReadonlyArray<string | null | undefined>;
}

export interface ResumeExtraction {
  summary?: string | null;
  experience?: ReadonlyArray<ResumeExtractionExperience | null | undefined>;
  education?: ReadonlyArray<ResumeExtractionEducation | null | undefined>;
  projects?: ReadonlyArray<ResumeExtractionProject | null | undefined>;
  skills?: ReadonlyArray<string | null | undefined>;
  languages?: ReadonlyArray<string | null | undefined>;
}

export interface CandidateClaim {
  kind: ClaimKind;
  statement: string;
}

/** Trimmed text, or `null`. A blank line is not a claim; it is noise from the parser. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Every atomic career fact the DETERMINISTIC extractor can see in a parsed resume.
 *
 * A pure function of the parse: it creates nothing and writes nothing, so the exact claim
 * set a fixture produces is directly assertable and the route stays a shell around it.
 * The mapping mirrors the two lowerings that already exist and are reviewed -
 * `legacyResumeToClaimDrafts` (`resume/json/project.ts:649`) for the
 * experience/skills/summary shape and `lowerResumeJson` (`resume/json/jsonresume.ts`) for
 * the projects/education/languages shape - so a claim created here means the same thing as
 * a claim created by either of those.
 *
 * WHAT BECOMES A CLAIM, and what deliberately does not:
 * - every experience `title` -> `role` ("<title> at <company>", the legacy model's exact
 *   wording, so the FINGERPRINT matches a backfilled claim for the same fact and the two
 *   paths reconcile instead of forking a second row);
 * - every experience `bullets` entry -> `achievement`;
 * - every `education` entry -> `education` ("<degree> at <institution>");
 * - every `projects[].title` -> `project`, its `bullets` -> `achievement`, its `tech` ->
 *   `technology`;
 * - every `skills` entry -> `skill`; every `languages` entry -> `language`;
 * - the professional `summary` -> `soft_skill`. THIS ONE IS A NAMED REQUIREMENT, not an
 *   extra: ADR-043's R-SUMMARY residual records that `basics.summary` renders with no
 *   claim and that its compensating control is "T1020/T1021 MUST create a `soft_skill`
 *   claim for `CareerProfile.summary` at ingest", with the legacy backfill's own model
 *   (`project.ts:639-648`) as the precedent. Creating it here means the belt can later
 *   re-widen to `basics.summary` without T1080's `reword_summary` being free prose that
 *   the user never approved.
 * - CONTACT DETAILS AND DATES ARE NOT CLAIMS. A phone number is not a career assertion,
 *   and gating it would make the invariant meaningless - 05 sec.7.7 says the same about
 *   dates. They stay profile columns.
 */
export function resumeToCandidateClaims(parsed: ResumeExtraction): CandidateClaim[] {
  const claims: CandidateClaim[] = [];
  const push = (kind: ClaimKind, statement: unknown): void => {
    const text = textOrNull(statement);
    if (text !== null) claims.push({ kind, statement: text });
  };

  for (const entry of parsed?.experience ?? []) {
    const title = textOrNull(entry?.title);
    const company = textOrNull(entry?.company);
    if (title !== null) push(ClaimKind.role, company === null ? title : `${title} at ${company}`);
    for (const bullet of entry?.bullets ?? []) push(ClaimKind.achievement, bullet);
  }

  for (const entry of parsed?.education ?? []) {
    const degree = textOrNull(entry?.degree);
    const institution = textOrNull(entry?.institution);
    if (degree === null && institution === null) continue;
    push(
      ClaimKind.education,
      degree === null
        ? institution
        : institution === null
          ? degree
          : `${degree} at ${institution}`,
    );
  }

  for (const entry of parsed?.projects ?? []) {
    push(ClaimKind.project, entry?.title);
    for (const bullet of entry?.bullets ?? []) push(ClaimKind.achievement, bullet);
    for (const tech of entry?.tech ?? []) push(ClaimKind.technology, tech);
  }

  for (const skill of parsed?.skills ?? []) push(ClaimKind.skill, skill);
  for (const language of parsed?.languages ?? []) push(ClaimKind.language, language);

  // R-SUMMARY - see the docstring. Emitted last, so a summary that restates an earlier
  // bullet dedupes against it (the fingerprint is kind + statement, so a different kind
  // is a different claim and both are honest readings of the same words).
  push(ClaimKind.soft_skill, parsed?.summary);

  return claims;
}

// ---------------------------------------------------------------------------
// The optional enrichment seam
// ---------------------------------------------------------------------------

export interface CareerEnrichmentOutcome {
  /** The provider id, or `'unknown'` when none was reached. Never a secret. */
  provider: string;
  status: 'applied' | 'skipped';
  /** Machine-readable: why it was skipped, or `'ok'`. The UI branches on this. */
  reason: string;
  created: number;
  deduped: number;
}

/**
 * What the route hands the career layer for the OPTIONAL second pass.
 *
 * `provider` is recorded on the claim row as `producedByModel`, so a user reading the
 * provenance badge can always tell which claims a model wrote - it is audit data, and
 * ADR-036 item 2's whole point is that the two provenances are distinguishable.
 */
export interface CareerEnrichmentArgs {
  profileId: string;
  evidenceSourceId: string;
  /** The extracted document text, for a provider that takes the raw document. */
  rawText: string;
  userId: string;
}

export type CareerResumeEnricher = (
  args: CareerEnrichmentArgs,
) => Promise<CareerEnrichmentOutcome>;

/**
 * The default: no enrichment at all, and SAY SO.
 *
 * Chosen over "attempt and fail" because ADR-041 D5 requires the deterministic stages to
 * work with no provider configured, and a caller with no provider must get a COMPLETE
 * import plus an explicit `enrichment` record - never an exception, and never a silent
 * omission that a user would read as "there was nothing more to find".
 */
export const noCareerEnrichment: CareerResumeEnricher = async () => ({
  provider: 'none',
  status: 'skipped',
  reason: 'no_enricher_configured',
  created: 0,
  deduped: 0,
});

// ---------------------------------------------------------------------------
// The import itself
// ---------------------------------------------------------------------------

/** `InferenceMethod` for the deterministic half of a resume import (05 sec.4). */
export const RESUME_IMPORT_INFERENCE_METHOD = 'resume_import';

/** ...and for the AI half, so the two are distinguishable in the row. */
export const RESUME_IMPORT_AI_INFERENCE_METHOD = 'resume_import_ai';

export interface ImportResumeEvidence {
  title: string;
  mimeType?: string | null;
  /** Metadata only. The bytes live in the storage abstraction, never in Postgres (D2). */
  byteSize?: number | null;
  /** A soft link to a pre-existing `UploadedFile`; no FK (legacy table). */
  uploadedFileId?: string | null;
  url?: string | null;
}

export interface ImportResumeClaimsInput {
  profileId: string;
  /** The extracted document text: hashed into `contentHash` and stored (capped). */
  rawText: string;
  parsed: ResumeExtraction;
  evidence: ImportResumeEvidence;
  userId: string;
  /** Optional second pass. Defaults to `noCareerEnrichment`. */
  enrich?: CareerResumeEnricher;
  /** Cap on the STORED copy of the text. The hash always covers the full text. */
  maxStoredText?: number;
}

export interface ImportResumeClaimsResult {
  source: EvidenceSource;
  sourceOutcome: 'created' | 'deduped';
  extracted: number;
  created: number;
  deduped: number;
  items: CareerClaim[];
  enrichment: CareerEnrichmentOutcome;
}

const DEFAULT_MAX_STORED_TEXT = 200_000;

/**
 * Register the evidence source and write the candidate claims.
 *
 * The ORDER is the design, and it is the same order `POST /career/import/json` uses:
 *   1. VALIDATE, before anything is written. An empty document or a document with no
 *      career statements is refused HERE, by the caller, so a source row never exists
 *      that yields zero claims - which a user cannot tell apart from a failed import.
 *   2. REGISTER the `EvidenceSource`: the provenance anchor. `@@unique([profileId,
 *      contentHash])` makes re-importing the same document a NO-OP on this row, so the
 *      claims pointing at it keep pointing at the same source.
 *   3. WRITE every claim through `createClaim`, the single dedupe point. Re-importing
 *      dedupes on `(profileId, fingerprint)` and never touches an existing claim, so a
 *      re-run cannot duplicate one, cannot change one's status, and cannot resurrect a
 *      `rejected` one (ADR-036 items 4-5).
 *   4. RUN the optional enrichment and RECORD its outcome either way.
 */
export async function importResumeClaims(
  input: ImportResumeClaimsInput,
  store: CareerStore,
): Promise<ImportResumeClaimsResult> {
  const candidates = resumeToCandidateClaims(input.parsed);
  const rawText = input.rawText ?? '';

  const source = await createEvidenceSource(
    {
      profileId: input.profileId,
      kind: EvidenceKind.document,
      title: input.evidence.title,
      // The FULL text is what gets hashed, so two files differing only past the storage
      // cap are still two sources; only the STORED copy is capped.
      text: rawText,
      mimeType: input.evidence.mimeType ?? null,
      byteSize: input.evidence.byteSize ?? null,
      uploadedFileId: input.evidence.uploadedFileId ?? null,
      url: input.evidence.url ?? null,
      extractedText: rawText.slice(0, input.maxStoredText ?? DEFAULT_MAX_STORED_TEXT),
    },
    store,
  );

  let created = 0;
  let deduped = 0;
  const items: CareerClaim[] = [];
  for (const candidate of candidates) {
    const claimInput: ClaimCreateInput = {
      profileId: input.profileId,
      kind: candidate.kind,
      statement: candidate.statement,
      // Both constants are literals this directory owns, and `ClaimCreateInput` has no
      // confirming member - so the status of every row this writes is `inferred` BY
      // CONSTRUCTION, whatever the document said.
      status: IMPORTED_CLAIM_STATUS,
      provenance: IMPORTED_CLAIM_PROVENANCE,
      confidence: null,
      inferenceMethod: RESUME_IMPORT_INFERENCE_METHOD,
      evidenceSourceId: source.source.id,
      // Entity attachments are NOT derived from the document. Attaching a claim to an
      // `Experience` row requires that row to exist, and creating entities out of an
      // unverified document is exactly the line 05 sec.2.2 draws: the claim exists and is
      // unconfirmed, and the user attaches it.
      experienceId: null,
      educationId: null,
      projectId: null,
      skillId: null,
      certificationId: null,
      achievementId: null,
    };
    const result = await createClaim(claimInput, store);
    if (result.outcome === 'created') created += 1;
    else deduped += 1;
    items.push(result.claim);
  }

  const enrichment = await runEnrichment(input, source.source.id);

  return {
    source: source.source,
    sourceOutcome: source.outcome,
    extracted: candidates.length,
    created,
    deduped,
    items,
    enrichment,
  };
}

/**
 * Run the enrichment, and NEVER let it fail the import.
 *
 * The deterministic claims are already committed by the time this runs, and ADR-041 D5
 * requires the pipeline to degrade to "unavailable" rather than blocking - so a thrown
 * enricher becomes a `skipped` outcome with a machine-readable reason, and the caller
 * still gets a complete import. The reason carries the error's NAME, never its message:
 * an enricher that throws a provider error would otherwise put a key-adjacent string
 * into an API response.
 */
async function runEnrichment(
  input: ImportResumeClaimsInput,
  evidenceSourceId: string,
): Promise<CareerEnrichmentOutcome> {
  const enrich = input.enrich ?? noCareerEnrichment;
  try {
    return await enrich({
      profileId: input.profileId,
      evidenceSourceId,
      rawText: input.rawText ?? '',
      userId: input.userId,
    });
  } catch (error) {
    return {
      provider: 'unknown',
      status: 'skipped',
      reason: `enrichment_failed:${error instanceof Error ? error.name : 'unknown'}`,
      created: 0,
      deduped: 0,
    };
  }
}

/**
 * Write a MODEL's parse as claims - the ONLY bridge from `writeInferredClaims` to this
 * surface, and deliberately the only one.
 *
 * Exported (rather than inlined in `importResumeClaims`) because the ENRICHER is the
 * caller's seam: the route owns the provider policy, and it must reach the claim writer
 * through this function instead of importing `claimWriterAI` itself. That is not
 * ceremony - `career/claimWriterAI.test.ts` guards that no route may import the AI writer
 * or the status writer, because a route that could call either directly could write a
 * claim or confirm one straight from an HTTP body. Routing the model's output through
 * here keeps the provenance hard-coded in the career layer, where ADR-036 item 2 says it
 * belongs.
 */
export async function writeEnrichedResumeClaims(
  args: {
    profileId: string;
    evidenceSourceId: string;
    provider: string;
    parsed: ResumeExtraction;
  },
  store: CareerClaimStore,
): Promise<{ created: number; deduped: number }> {
  const candidates = resumeToCandidateClaims(args.parsed);
  return writeInferredClaims(
    args.profileId,
    candidates.map((candidate) => ({
      kind: candidate.kind,
      statement: candidate.statement,
      // NO `status` member: the writer's default is `inferred`, which is also the only
      // status an imported claim may ever carry. `provenance` is not a member of
      // `InferredClaimInput` at all - the writer hard-codes it - so a caller cannot
      // re-label a model's sentence as something it is not.
      inferenceMethod: RESUME_IMPORT_AI_INFERENCE_METHOD,
      producedByModel: args.provider,
      evidenceSourceId: args.evidenceSourceId,
    })),
    store,
  );
}

/** What the route echoes so a client can prove the import decided nothing. */
export const RESUME_IMPORT_STATUS = IMPORTED_CLAIM_STATUS;
export const RESUME_IMPORT_PROVENANCE = IMPORTED_CLAIM_PROVENANCE;
