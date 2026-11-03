// Tailor model - the PURE half of the tailoring UI (T1080; 06 sec.E.3 "Before/after diff UX").
//
// WHY A SEPARATE PURE MODULE, in a project whose tests are pure-modules-only (ADR-031
// decision 3). Three of the acceptance items are about DECISIONS the screen makes rather than
// about markup, and none of them is checkable by rendering a component in this repository:
//
//   1. AN OPERATION THE SERVER REFUSED CANNOT BE ACCEPTED, however the user clicks. The
//      disable is the model's answer, and this function is where it lives.
//   2. THE APPLY REQUEST IS EXACTLY THE ACCEPTED OPERATIONS - no extras, no omissions - so
//      the revision that appears is the one the user agreed to.
//   3. THE DIFF ROW SHOWS BEFORE AND AFTER AND THE REASON AND THE CLAIMS. A row that could
//      render with an empty reason, or with a claim id and no statement, is a row that
//      "reviewed" nothing.
//
// NO SCORE APPEARS HERE. E.6 forbids the single number, so this module has no function that
// returns a rating of an operation, of a job, or of a resume - and no such function is added
// later without failing the "no score" test below.

import type { TailorChangeRowWithClaims, TailorOperation } from "@/services/api/tailor";

/** One row of the diff view. Everything a reviewer needs, and nothing they do not. */
export interface TailorDiffRow {
  /** Stable across renders: the target, or the change id when the row came from the log. */
  key: string;
  op: string;
  target: string;
  /** `null` renders as "nothing here before" rather than as the string "null". */
  before: string | null;
  after: string | null;
  reason: string | null;
  /** The refusal code, when the operation was refused. `null` when it was accepted. */
  rejectionCode: string | null;
  accepted: boolean;
  /** The claim STATEMENTS, not their ids: a statement is a fact a person can check. */
  sourceClaims: Array<{ id: string; statement: string; status: string }>;
}

/** Render an arbitrary JSON value as the one line the diff shows for it. */
export function displayValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // An array (a reorder's permutation) and an object (a removed entry) are shown as compact
  // JSON rather than as "[object Object]", which is what a reviewer would otherwise see.
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Can the user accept this operation? */
export function isAcceptable(operation: TailorOperation): boolean {
  // The server's verdict is the ONLY authority. A client that computed its own would be a
  // second opinion on the fact-delta guard, and the client is the one side of this that has
  // never read a confirmed claim.
  return operation.accepted === true && operation.rejection === null;
}

/** The operations the user has accepted, in proposal order, for the apply request. */
export function acceptedOperations(operations: readonly TailorOperation[]): unknown[] {
  return operations.filter(isAcceptable).map((operation) => ({
    op: operation.op,
    target: operation.target,
    before: operation.before,
    after: operation.after,
    reason: operation.reason,
    targetRequirementIds: operation.targetRequirementIds,
    sourceClaimIds: operation.sourceClaimIds,
  }));
}

/** A refusal, in words a person can act on. `null` when there is none. */
export function refusalLine(operation: TailorOperation): string | null {
  const rejection = operation.rejection;
  if (rejection === null) return null;
  const detail = rejection.detail === null ? "" : ` (${rejection.detail})`;
  return `${rejection.code}${detail}`;
}

/**
 * What the screen has to say about a proposal, as a small record.
 *
 * `noProviderConfigured` is separate from `count === 0` on purpose. "There are no proposals
 * because no AI provider is configured" and "the engine ran and found nothing worth changing"
 * are DIFFERENT answers to "why is this list empty", and a user who cannot tell them apart
 * concludes the feature is broken. ADR-041 D5 requires the first to be visible.
 */
export interface ProposalSummary {
  count: number;
  acceptableCount: number;
  refusedCount: number;
  noProviderConfigured: boolean;
  providerFailed: boolean;
  headline: string;
}

export function summariseProposal(
  operations: readonly TailorOperation[],
  proposal: { status: string; reason: string },
): ProposalSummary {
  const acceptableCount = operations.filter(isAcceptable).length;
  const refusedCount = operations.length - acceptableCount;
  const noProviderConfigured = proposal.status === "skipped" && proposal.reason === "no_ai_provider_configured";
  const providerFailed = proposal.status === "failed";

  let headline: string;
  if (noProviderConfigured) {
    headline =
      "No AI provider is configured, so nothing is proposed. You can still write the operations yourself below - every one is checked against your confirmed claims before it is applied.";
  } else if (providerFailed) {
    headline = `The tailoring pass could not run (${proposal.reason}). You can still write the operations yourself below.`;
  } else if (operations.length === 0) {
    headline = "The tailoring pass ran and found nothing it could change without inventing a fact.";
  } else {
    headline = `${operations.length} operation${operations.length === 1 ? "" : "s"} proposed: ${acceptableCount} can be applied, ${refusedCount} refused.`;
  }
  return { count: operations.length, acceptableCount, refusedCount, noProviderConfigured, providerFailed, headline };
}

/** The diff rows for a PROPOSAL, before anything is applied. */
export function diffRowsForOperations(operations: readonly TailorOperation[]): TailorDiffRow[] {
  return operations.map((operation, index) => ({
    key: `op-${index}-${operation.op}-${operation.target}`,
    op: operation.op,
    target: operation.target,
    before: displayValue(operation.before),
    after: displayValue(operation.after),
    reason: operation.reason,
    rejectionCode: operation.rejection?.code ?? null,
    accepted: isAcceptable(operation),
    // A proposal names claim IDS; the STATEMENTS come from the change log once the operation
    // has been applied, so a proposal row shows the ids it depends on and says so.
    sourceClaims: operation.sourceClaimIds.map((id) => ({ id, statement: "", status: "" })),
  }));
}

/**
 * The diff rows for an APPLIED revision, from the change log.
 *
 * THE ORDER IS SERVER ORDER and nothing sorts them: `listRevisionChanges` returns them in
 * insertion order, which is the order the user accepted them in. Sorting a review by
 * jsonPath would put two operations on the same bullet next to each other and separate two
 * consecutive steps, which is the opposite of what the log is for.
 */
export function diffRowsForChanges(rows: readonly TailorChangeRowWithClaims[]): TailorDiffRow[] {
  return rows.map((row) => ({
    key: row.id,
    op: row.op,
    target: row.jsonPath,
    before: displayValue(row.before),
    after: displayValue(row.after),
    reason: row.reason,
    // A DECLINED row's reason already carries the code, prefixed, because that is what
    // `apply.ts` writes. Anything else has no code.
    rejectionCode: row.accepted ? null : (row.reason?.split(":")[0]?.trim() ?? "DECLINED"),
    accepted: row.accepted,
    sourceClaims: row.sourceClaims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      status: claim.status,
    })),
  }));
}

/** How many rows the reviewer still has to decide about. */
export function pendingCount(operations: readonly TailorOperation[]): number {
  return operations.filter(isAcceptable).length;
}

/**
 * The name fragments a rating would be spelled with.
 *
 * Exported so the "no score" TEST reads the vocabulary from the module it constrains rather
 * than keeping a second copy - a guard list maintained somewhere other than the code it guards
 * is the failure it exists to prevent.
 *
 * Naming the thing you forbid is not doing it: `tailorModel.test.ts` excludes THIS constant
 * from the check it enforces, because a reviewer who sees `scoreFunctionsAreForbidden` should
 * see the rule rather than a violation of it.
 */
export const SCORE_FUNCTIONS_ARE_FORBIDDEN = [
  "score",
  "rate",
  "rating",
  "matchPercent",
  "fit",
] as const;