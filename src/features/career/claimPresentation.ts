// Pure presentation rules for the career verification surface (T1020).
//
// Runner-compatible by construction: no React, no JSX, no network, no clock - this is the
// shape the repo's frontend tests can actually assert (ADR-031 decision 3: node
// environment, pure modules only, no `.test.tsx`). The components
// (`StatusCounter.tsx`, `ProvenanceBadge.tsx`, `ClaimList.tsx`) stay thin and read from
// here, so the rules that matter are testable rather than merely visible.
//
// THE ONE RULE THIS MODULE EXISTS TO MAKE UNBREAKABLE (06 E.11 "unconfirmed vs confirmed"):
// STATUS IS CONVEYED BY ICON + TEXT, NEVER BY COLOUR ALONE. Every function here returns a
// LABEL as well as a tone, and the tone is a NAME (`'confirmed' | 'pending' | 'decided'`)
// rather than a colour - the component maps names to Tailwind classes in one place, so a
// second stylesheet cannot introduce a colour-only path, and a user who cannot perceive
// the colour still reads the whole state from the words and the glyph.
//
// The counter is derived from the same `UNCONFIRMED_STATUSES` rule the server uses
// (`backend/src/career/claimCounts.ts`), because a client that disagreed with the server
// about what "unconfirmed" means would show a number the user could not reconcile with
// the page.

import type {
  CareerClaim,
  CareerClaimCounts,
  CareerClaimKind,
  CareerClaimProvenance,
  CareerClaimStatus,
} from "@/services/api/career";

/** The wire statuses, in the order the status filter offers them. */
export const CLAIM_STATUSES: readonly CareerClaimStatus[] = [
  "inferred",
  "contextual",
  "user_confirmed",
  "rejected",
  "superseded",
] as const;

/** The wire kinds, in the order the kind filter offers them. */
export const CLAIM_KINDS: readonly CareerClaimKind[] = [
  "role",
  "achievement",
  "metric",
  "skill",
  "technology",
  "domain",
  "education",
  "certification",
  "project",
  "language",
  "responsibility",
  "soft_skill",
] as const;

/**
 * The statuses a claim is in while the USER still owes a decision.
 *
 * Deliberately a POSITIVE list, matching the server's rule exactly: `rejected` is
 * excluded because the user has already decided about that claim (counting it would make
 * the number go UP as a result of acting on it), and `superseded` because it is not the
 * live text any more. See `backend/src/career/claimCounts.ts` for the full argument.
 */
export const UNCONFIRMED_STATUSES: readonly CareerClaimStatus[] = ["inferred", "contextual"];

/** The one status whose claims may enter a rendered resume. Mirrors the server. */
export const CONFIRMED_STATUS: CareerClaimStatus = "user_confirmed";

export type StatusTone = "confirmed" | "pending" | "decided";

export interface StatusPresentation {
  /** A stable glyph name, mapped to a lucide icon by the component. */
  icon: "shield-check" | "sparkles" | "circle-slash" | "replace" | "help-circle";
  /** NEVER empty. This is the accessible half of the status. */
  label: string;
  /** One line a screen reader and a tooltip can both use. */
  description: string;
  tone: StatusTone;
}

const STATUS_PRESENTATION: Record<CareerClaimStatus, StatusPresentation> = {
  user_confirmed: {
    icon: "shield-check",
    label: "Confirmed",
    description: "You confirmed this. It is the only kind of claim that can enter a resume.",
    tone: "confirmed",
  },
  inferred: {
    icon: "sparkles",
    label: "Inferred - not confirmed",
    description: "We read this out of a file or a model. It is not your experience yet.",
    tone: "pending",
  },
  contextual: {
    icon: "sparkles",
    label: "Inferred - needs your check",
    description: "A model saw corroborating context here. Confirm it before it counts.",
    tone: "pending",
  },
  rejected: {
    icon: "circle-slash",
    label: "Rejected",
    description: "You rejected this, so it is excluded. Reopen it to decide again.",
    tone: "decided",
  },
  superseded: {
    icon: "replace",
    label: "Superseded",
    description: "A newer claim replaced this one.",
    tone: "decided",
  },
};

/**
 * What a status looks like. An unrecognised status is `UNKNOWN_STATUS`, never a default
 * that could be read as "fine".
 *
 * This matters more than it looks: a status this build has never seen must NOT fall
 * through to a permissive rendering, because the two states a user acts on are "confirmed,
 * safe to use" and "not confirmed, do not use yet". Defaulting an unknown status to
 * anything confirmed-shaped would put an unverified fact into a resume's way.
 */
export const UNKNOWN_STATUS: StatusPresentation = {
  icon: "help-circle",
  label: "Unknown status",
  description:
    "This claim's status is not one this version of Clearance understands. Treat it as unconfirmed.",
  tone: "pending",
};

export function statusPresentation(status: string | null | undefined): StatusPresentation {
  if (typeof status !== 'string') return UNKNOWN_STATUS;
  return STATUS_PRESENTATION[status as CareerClaimStatus] ?? UNKNOWN_STATUS;
}

/** Whether a claim in this status still needs the user's decision. */
export function isUnconfirmed(status: string | null | undefined): boolean {
  return typeof status === 'string' && UNCONFIRMED_STATUSES.includes(status as CareerClaimStatus);
}

export interface ProvenancePresentation {
  icon: "user" | "file-text" | "sparkles" | "git-branch" | "badge-check" | "layers" | "help-circle";
  label: string;
  description: string;
}

const PROVENANCE_PRESENTATION: Record<CareerClaimProvenance, ProvenancePresentation> = {
  user_entered: {
    icon: "user",
    label: "You entered this",
    description: "Typed into Clearance. Still needs confirming before it can be used.",
  },
  document_import: {
    icon: "file-text",
    label: "From a document",
    description: "Extracted from a file you uploaded. Not yet confirmed.",
  },
  llm_inferred: {
    icon: "sparkles",
    label: "Suggested by a model",
    description: "A language model wrote this. Not your words until you confirm it.",
  },
  derived: {
    icon: "layers",
    label: "Derived from other claims",
    description: "Composed from facts you confirmed.",
  },
  github_derived: {
    icon: "git-branch",
    label: "From a public repository",
    description: "Derived from a public repo. Not yet confirmed.",
  },
  external_verified: {
    icon: "badge-check",
    label: "Verified out of band",
    description: "Checked against something outside this document.",
  },
};

export const UNKNOWN_PROVENANCE: ProvenancePresentation = {
  icon: "help-circle",
  label: "Unknown source",
  description: "This claim's source is not one this version of Clearance understands.",
};

export function provenancePresentation(
  provenance: string | null | undefined,
): ProvenancePresentation {
  if (typeof provenance !== 'string') return UNKNOWN_PROVENANCE;
  return PROVENANCE_PRESENTATION[provenance as CareerClaimProvenance] ?? UNKNOWN_PROVENANCE;
}

/** The kind, in the words a user would use. Falls back to the raw value. */
export function kindLabel(kind: string | null | undefined): string {
  if (typeof kind !== 'string' || kind.length === 0) return 'Statement';
  switch (kind) {
    case 'role':
      return 'Role';
    case 'achievement':
      return 'Achievement';
    case 'metric':
      return 'Metric';
    case 'skill':
      return 'Skill';
    case 'technology':
      return 'Technology';
    case 'domain':
      return 'Domain';
    case 'education':
      return 'Education';
    case 'certification':
      return 'Certification';
    case 'project':
      return 'Project';
    case 'language':
      return 'Language';
    case 'responsibility':
      return 'Responsibility';
    case 'soft_skill':
      return 'Summary';
    default:
      return kind;
  }
}

/** A zeroed counter of the full shape, so no status key is ever `undefined`. */
export function emptyClaimCounts(): CareerClaimCounts {
  const counts = { total: 0, unconfirmed: 0 } as CareerClaimCounts;
  for (const status of CLAIM_STATUSES) counts[status] = 0;
  return counts;
}

/**
 * Tally a claim list into the counter.
 *
 * Same rule as the server (`careerClaimCountsFromRows`), derived from the same
 * `UNCONFIRMED_STATUSES`, so the header number on this page and the `counts` the API
 * returns can never disagree. A status this build does not know lands in `total` and in
 * NO other field - and, because `isUnconfirmed` is false for it, it does not inflate the
 * work-to-do number either.
 */
export function summarizeClaims(claims: readonly CareerClaim[] | null | undefined): CareerClaimCounts {
  const counts = emptyClaimCounts();
  for (const claim of claims ?? []) {
    if (!claim || typeof claim.status !== 'string') continue;
    const status = claim.status as CareerClaimStatus;
    if (status in counts) counts[status] += 1;
    counts.total += 1;
  }
  counts.unconfirmed = UNCONFIRMED_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  return counts;
}

/**
 * The number the header shows: how many claims still owe the user a decision.
 *
 * The SERVER's count whenever there is one. That is deliberate: `GET /career/claims`
 * returns the WHOLE profile's counts alongside a possibly FILTERED list, precisely so the
 * counter stays put while the user changes a filter. Tallying the visible rows instead
 * would make the number jump every time a filter changed, which is the bug the server's
 * behaviour exists to prevent. The local tally is the fallback for a response carrying
 * claims but no counts - an import result, before the list refetches.
 */
export function unconfirmedCount(
  claims: readonly CareerClaim[] | null | undefined,
  serverCounts?: CareerClaimCounts | null,
): number {
  if (typeof serverCounts?.unconfirmed === 'number') return serverCounts.unconfirmed;
  return summarizeClaims(claims).unconfirmed;
}

/**
 * The confirmation progress string 06 E.11 asks for: "12 of 30 confirmed".
 *
 * `total` is every claim, and the copy says so - "x of y confirmed" reads as "y things to
 * do" unless the user is told what y counts. Rejected claims are included in `total`
 * deliberately: they were decided, so dropping them would make a finished list look
 * unfinished forever.
 */
export function confirmationProgress(counts: CareerClaimCounts): string {
  const confirmed = counts[CONFIRMED_STATUS] ?? 0;
  return `${confirmed} of ${counts.total} confirmed`;
}

/**
 * The empty-state line, in the spec's words (06 E.11 flow 1).
 *
 * DISTINGUISHES the two empties, because they need different actions: nothing imported
 * yet is "import a file", while a full list with nothing confirmed is "start confirming".
 * A single "nothing here" would send the second user to upload a second resume.
 */
export function emptyStateMessage(counts: CareerClaimCounts): string {
  if (counts.total === 0) {
    return 'Nothing here yet. Drop in a resume or notes file and we will list what we found, as unconfirmed statements you can check one by one.';
  }
  if ((counts[CONFIRMED_STATUS] ?? 0) === 0) {
    return 'Nothing confirmed yet - a resume built now would be empty. Confirm the statements below, or reject the ones that are not yours.';
  }
  return '';
}

/** Whether a rejected claim should start collapsed (06 E.11 flow 3). */
export function startsCollapsed(claim: CareerClaim): boolean {
  return claim.status === 'rejected';
}

/**
 * A UI action the claim row can offer.
 *
 * `edit` covers BOTH server verbs - `POST /career/claims {id, statement}` with
 * `confirm: false` is `edit`, with `confirm: true` is `edit_confirm` - and `confirm`
 * covers `confirm` and `edit_confirm` (the confirm route accepts an optional
 * `statement`). The cross-check test therefore maps a UI action to the set of backend
 * verbs it can reach and requires at least one of them to be legal from the status.
 */
export type ClaimAction = 'confirm' | 'edit' | 'reject' | 'reopen';

/**
 * EXACTLY what the backend accepts, per status.
 *
 * MIRRORS `CLAIM_TRANSITIONS` in `backend/src/career/verification.ts` - it is a mirror,
 * not a guess, and `claimPresentation.test.ts` proves it by parsing that table out of the
 * backend source and asserting every entry here is accepted from its status. An earlier
 * version of this function returned `['edit', 'reject']` for `user_confirmed`; both verbs
 * are refused from that status (`edit.from = [inferred, contextual, superseded]`,
 * `edit_confirm.from = [inferred, contextual]`), so the Edit button was a guaranteed 409.
 * The cross-check exists because a pure presentation module has no way to notice that on
 * its own, and a node-environment runner has no server to ask.
 *
 * Per status:
 * - `inferred` / `contextual`: the full set. Both can be confirmed, re-worded, or
 *   rejected.
 * - `user_confirmed`: **reject only.** Confirming again is illegal, and re-wording is
 *   illegal in both variants - `updateClaimAttributes` refuses a `user_confirmed` row
 *   outright, and `verification.ts` refuses the `edit` transition from it. This is a
 *   DELIBERATE asymmetry, not an oversight: a confirmed claim's audit row must keep
 *   describing the words the user actually approved, so the only way to change them is to
 *   reject (which clears `confirmedAt`) and confirm the replacement. Widening the
 *   transition table is an architect decision, not a UI one.
 * - `rejected`: **reopen only.** `reject` is technically legal from here but
 *   `alreadyApplied` makes it an idempotent no-op, so a Reject button would be a control
 *   that appears to do something and does nothing.
 * - `superseded`: edit and reject. Neither `confirm` nor `edit_confirm` nor `reopen` is
 *   legal from `superseded`, so offering Confirm would be the same dead button F1 was.
 * - an UNKNOWN status: the full pending set. Fail-OPEN on the action and fail-CLOSED on
 *   the badge - the row still says "Unknown status", but the user is not locked out of
 *   deciding about a claim they cannot classify.
 */
const ACTIONS_BY_STATUS: Readonly<Record<string, readonly ClaimAction[]>> = {
  inferred: ['confirm', 'edit', 'reject'],
  contextual: ['confirm', 'edit', 'reject'],
  user_confirmed: ['reject'],
  rejected: ['reopen'],
  superseded: ['edit', 'reject'],
};

const PENDING_ACTIONS: readonly ClaimAction[] = ['confirm', 'edit', 'reject'];

/**
 * The actions a claim in this status offers, in the order they should appear.
 *
 * The return type is `readonly ClaimAction[]` on purpose: `ClaimList.tsx` only ever reads
 * it, and a mutable array here would invite a caller to splice a new action onto a set
 * that has not been checked against the backend.
 */
export function availableActions(status: string | null | undefined): readonly ClaimAction[] {
  if (typeof status !== 'string') return PENDING_ACTIONS;
  return ACTIONS_BY_STATUS[status] ?? PENDING_ACTIONS;
}

/**
 * Steps the import wizard shows: drop a file, review what we found, confirm each one.
 *
 * The wizard renders steps 1-2 and the verification list is step 3, so the stepper is a
 * progress indicator rather than a set of tabs - a user who has confirmed everything
 * should not be invited back into the wizard.
 */
export const IMPORT_WIZARD_STEPS = 3;

/**
 * Human wording for the import's `enrichment` outcome.
 *
 * A machine code alone would be technically accurate and practically useless at this
 * point in the flow: the user has just uploaded a file and wants to know whether
 * something was missed. `no_ai_provider_configured` in particular is the COMMON case
 * (ADR-041 D5 makes provider-free a supported mode), so it is worded as a fact about the
 * import that completed - never as a missing feature, and never as an error.
 *
 * Returns `null` only when there is genuinely nothing to add, which the wizard renders as
 * no extra line rather than an empty paragraph.
 */
export function enrichmentMessage(enrichment: {
  status: string;
  reason: string;
  provider: string;
  created: number;
}): string | null {
  if (enrichment.status === 'applied') {
    const added = enrichment.created;
    return `The AI pass (${enrichment.provider}) added ${added} more statement${
      added === 1 ? '' : 's'
    }. They are unconfirmed like everything else.`;
  }
  switch (enrichment.reason) {
    case 'no_ai_provider_configured':
    case 'no_enricher_configured':
      return 'Imported without an AI provider. Everything below was read straight out of your file.';
    case 'provider_unavailable':
      return 'The AI provider could not be reached, so only the deterministic pass ran. Everything below was read straight out of your file.';
    default:
      return `The AI pass did not run (${enrichment.reason}). Everything below was read straight out of your file.`;
  }
}
