// =====================================================================================
// match/potential.ts - the PROPOSAL stage (T1070; 06-design sec. E.2, E.8 stage 5, E.9).
//
// WHAT THIS MODULE IS. The only place in the system where an inference may be WRITTEN -
// and what it writes is `PotentialMatch(status = pending)` rows. That is the whole of it.
// There is no path here by which a model adds, changes or confirms a `CareerClaim`, and
// the type system says so: the store seam below exposes `careerClaim.findMany` and no
// write method at all, so `careerClaim.create(...)` does not compile in this file. The
// guard test in `potential.test.ts` asserts that shape AND greps the source, because a
// guarantee that depends on nobody retyping the type is a comment.
//
// NO PROVIDER IS NOT AN ERROR (ADR-041 decision 5, the ruling for this task). With no key
// the DIRECT bucket and the NAMED GAPS are still computed deterministically by
// `match/levels.ts`; only this stage is missing, and the report says so in words
// (`no_ai_provider_configured`) rather than pretending nothing was skipped. A proposal is
// NEVER fabricated to fill the gap: `proposeContextualMatches` writes zero rows on that
// path, and "we did not guess" is a result the caller can render.
//
// EVERY LINK PASSES THE SAME DETERMINISTIC GUARDS, AND A MODEL HAS NO PRIVILEGED PATH
// (E.8's table, "stage 5 Matching"):
//   - `requirementId` must be a requirement OF THIS JOB, and must not already be `direct`
//     (a proposal for something a confirmed claim already states is noise, and the join is
//     the server's answer, not the model's);
//   - `claimId` must EXIST and must be CONFIRMED - checked here with the career layer's own
//     predicate, never against a list the prompt carried;
//   - `level` must be `contextual` or `potential` - never `direct` (that is a fact) and
//     never `unsupported` (that is a gap, reported by name);
//   - a rationale must be present, because a suggestion the user cannot audit is a
//     suggestion they cannot refuse;
//   - duplicates are dropped.
//
// `proposedEvidence` IS WRITTEN FROM THE CLAIM'S OWN STATEMENT, not from the model's text.
// The model proposes the LINK; the words the user reads as evidence are the user's own
// confirmed words. That removes paraphrase-laundering - a model cannot turn "helped with
// Docker" into "container orchestration experience" by writing it in the right field.
//
// INJECTION POSTURE (E.9). The requirement text and the claim statements go into the USER
// message as DATA (`ats/promptLoader` renders the template; the system message is a static
// string with no interpolated content), the response must parse against a zod schema, and
// no requirement text can select a tool, a URL or a database operation. Even a perfectly
// obedient model cannot promote anything: the worst a hostile input can do is spend a
// proposal slot, and the user sees the requirement and the claim side by side.
// =====================================================================================

import { z } from 'zod';
import type { EvidenceLevel, PrismaClient } from '@prisma/client';
import { loadAndRender } from '../ats/promptLoader.js';
import { isRateLimitError, leaseNextLlmKey, markKeyFailure, markKeySuccess } from '../ai/keyManager.js';
import { createLlmClient, getProviderModel, runLlmCompletion } from '../ai/providerModels.js';
import {
  isConfirmedClaim,
  type MatchClaimRow,
  type MatchRequirementRow,
} from './levels.js';

// ---------------------------------------------------------------------------
// The store seam: read-only on claims, write-only on potential matches
// ---------------------------------------------------------------------------

/**
 * `careerClaim` is narrowed to `findMany` and `jobRequirement` to `findMany`, so this
 * module CANNOT write a claim: the delegates it holds have no `create`, `update`,
 * `upsert` or `deleteMany` member, and `Pick` is computed from the real client so the
 * narrowing cannot rot. `potentialMatch` is the one writable model, and it is the one the
 * task permits.
 */
export type PotentialProposalStore = Pick<PrismaClient, 'potentialMatch'> & {
  careerClaim: Pick<PrismaClient['careerClaim'], 'findMany'>;
  jobRequirement: Pick<PrismaClient['jobRequirement'], 'findMany'>;
};

/** Compile-time proof that the real client still satisfies the seam (nothing calls this). */
type RealClientSatisfiesProposalStore = PrismaClient extends PotentialProposalStore ? true : false;
const PROPOSAL_STORE_TYPECHECK: [RealClientSatisfiesProposalStore] = [true];
void PROPOSAL_STORE_TYPECHECK;

// ---------------------------------------------------------------------------
// Bounds (E.9 data minimization: one call, a bounded slice)
// ---------------------------------------------------------------------------

/** Cap on the requirement lines sent to the provider, and on the proposals accepted back. */
export const MAX_PROPOSAL_REQUIREMENTS = 40;
/** Cap on the confirmed statements sent to the provider. */
export const MAX_PROPOSAL_CLAIMS = 40;
/** A rationale longer than this is truncated; a shorter one is dropped as unusable. */
const MAX_RATIONALE_CHARS = 400;

// ---------------------------------------------------------------------------
// The proposal response
// ---------------------------------------------------------------------------

const linkSchema = z.object({
  requirementId: z.string().optional().nullable(),
  claimId: z.string().optional().nullable(),
  level: z.string().optional().nullable(),
  proposedEvidence: z.string().optional().nullable(),
  rationale: z.string().optional().nullable(),
});

const proposalSchema = z.object({
  schemaVersion: z.string().optional(),
  links: z.array(linkSchema).optional(),
});

export type ProposalResponse = z.infer<typeof proposalSchema>;

export type ProposalReason =
  | 'ok'
  | 'no_ai_provider_configured'
  | 'provider_unavailable'
  | 'no_requirements_to_propose'
  | 'no_confirmed_claims'
  /**
   * Reported by a READ, never by a run: the endpoint did not ask a provider anything, so
   * saying `no_ai_provider_configured` would be a claim about the user's configuration that
   * this request never checked.
   */
  | 'not_evaluated';

export interface ProposalOutcome {
  status: 'applied' | 'skipped';
  reason: ProposalReason;
  provider: string | null;
  model: string | null;
  response: ProposalResponse | null;
}

/** The provider stage as a function of (requirements, confirmed claims, user). */
export type ContextualProposer = (input: {
  requirements: readonly MatchRequirementRow[];
  claims: readonly MatchClaimRow[];
  userId: string;
}) => Promise<ProposalOutcome>;

function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const end = trimmed.lastIndexOf('}');
    return end > 0 ? trimmed.slice(0, end + 1) : null;
  }
  const match = /\{[\s\S]*\}/.exec(trimmed);
  return match ? match[0] : null;
}

/** One schema retry, then give the stage up (E.8: "one retry on schema failure"). */
const LLM_SCHEMA_ATTEMPTS = 2;

/**
 * Render the two lists for the prompt.
 *
 * `id | kind | importance | text` per requirement and `id | kind | statement` per claim -
 * the minimum a reviewer needs to make the judgement, and nothing else about the person
 * (no profile, no entities, no evidence sources).
 */
export function renderProposalContext(
  requirements: readonly MatchRequirementRow[],
  claims: readonly MatchClaimRow[],
): { requirements: string; confirmedClaims: string } {
  const requirementLines = requirements
    .slice(0, MAX_PROPOSAL_REQUIREMENTS)
    .map((row) => `${row.id} | ${row.kind} | ${row.importance} | ${row.text}`);
  const claimLines = claims
    .slice(0, MAX_PROPOSAL_CLAIMS)
    .map((row) => `${row.id} | ${row.kind} | ${row.statement}`);
  return {
    requirements: requirementLines.length > 0 ? requirementLines.join('\n') : '(none)',
    confirmedClaims: claimLines.length > 0 ? claimLines.join('\n') : '(none)',
  };
}

async function defaultProposer(input: {
  requirements: readonly MatchRequirementRow[];
  claims: readonly MatchClaimRow[];
  userId: string;
}): Promise<ProposalOutcome> {
  let key;
  try {
    key = await leaseNextLlmKey(input.userId);
  } catch {
    // No key configured. NOT a failure: the deterministic levels are already computed, and
    // this report says the proposal stage was skipped rather than implying it agreed.
    return {
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      provider: null,
      model: null,
      response: null,
    };
  }
  const provider = key.provider;
  let model: string | null = null;

  try {
    const resolvedModel = await getProviderModel(key.provider, {
      envOverride: process.env.MATCH_CONTEXTUAL_MODEL,
    });
    model = resolvedModel;
    const client = createLlmClient(key);
    const context = renderProposalContext(input.requirements, input.claims);
    // Both lists go in the USER message as data. The system message is a static string
    // with no list content in it, so a job description cannot be read as an instruction by
    // construction (E.9 mitigation 1).
    const prompt = loadAndRender('match_contextual_v1', {
      requirements: context.requirements,
      confirmed_claims: context.confirmedClaims,
      max_links: String(MAX_PROPOSAL_REQUIREMENTS),
    });

    for (let attempt = 1; attempt <= LLM_SCHEMA_ATTEMPTS; attempt += 1) {
      const response = await runLlmCompletion(key.provider, resolvedModel, () =>
        client.chat.completions.create({
          model: resolvedModel,
          max_tokens: 2000,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: 'You are a match-evidence reviewer. Reply with one JSON object.',
            },
            { role: 'user', content: prompt },
          ],
        }),
      );
      const content = response.choices[0]?.message?.content ?? '';
      const json = extractJson(content);
      if (json) {
        try {
          const parsed = proposalSchema.safeParse(JSON.parse(json));
          if (parsed.success) {
            await markKeySuccess(key).catch(() => {});
            return { status: 'applied', reason: 'ok', provider, model, response: parsed.data };
          }
        } catch {
          // Unparseable JSON: fall through to the retry, then to `provider_unavailable`.
        }
      }
    }
    await markKeyFailure(key, false).catch(() => {});
    return {
      status: 'skipped',
      reason: 'provider_unavailable',
      provider,
      model,
      response: null,
    };
  } catch (error) {
    await markKeyFailure(key, isRateLimitError(error)).catch(() => {});
    return { status: 'skipped', reason: 'provider_unavailable', provider, model, response: null };
  }
}

let proposer: ContextualProposer = defaultProposer;

/**
 * Install a different proposal stage (an adapter, a test). `null` restores the shipped
 * default, so there is no configuration in which the stage is silently absent.
 */
export function setContextualProposer(next: ContextualProposer | null): void {
  proposer = next ?? defaultProposer;
}

/** Re-exported so a test or an adapter can reach the shipped default directly. */
export const defaultContextualProposer = defaultProposer;

// ---------------------------------------------------------------------------
// The deterministic guard
// ---------------------------------------------------------------------------

export type DropReason =
  | 'no_requirement_id'
  | 'unknown_requirement'
  | 'already_direct'
  | 'no_claim_id'
  | 'unknown_claim'
  | 'unconfirmed_claim'
  | 'bad_level'
  | 'no_rationale'
  | 'duplicate';

export interface DroppedProposal {
  reason: DropReason;
  detail: string;
}

export interface AcceptedProposal {
  requirementId: string;
  claimId: string;
  level: Extract<EvidenceLevel, 'contextual' | 'potential'>;
  /** The claim's OWN statement. Never the model's wording. */
  proposedEvidence: string;
  rationale: string;
}

function normalizeLevel(value: unknown): Extract<EvidenceLevel, 'contextual' | 'potential'> | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim().toLowerCase();
  return candidate === 'contextual' || candidate === 'potential' ? candidate : null;
}

function normalizeRationale(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_RATIONALE_CHARS);
}

/**
 * The whole guard, as one pure function, so every rule is testable with literals and the
 * order is visible: existence, then confirmation, then level, then rationale, then
 * duplicates.
 */
export function validateProposal(
  link: {
    requirementId?: string | null;
    claimId?: string | null;
    level?: string | null;
    proposedEvidence?: string | null;
    rationale?: string | null;
  },
  context: {
    requirements: ReadonlyMap<string, MatchRequirementRow>;
    claims: ReadonlyMap<string, MatchClaimRow>;
    directRequirementIds: ReadonlySet<string>;
    seen: ReadonlySet<string>;
  },
): { accepted: AcceptedProposal } | { dropped: DroppedProposal } {
  const requirementId = typeof link.requirementId === 'string' ? link.requirementId.trim() : '';
  if (requirementId.length === 0) {
    return { dropped: { reason: 'no_requirement_id', detail: '(missing)' } };
  }
  const requirement = context.requirements.get(requirementId);
  if (!requirement) {
    return { dropped: { reason: 'unknown_requirement', detail: requirementId } };
  }
  if (context.directRequirementIds.has(requirementId)) {
    return { dropped: { reason: 'already_direct', detail: requirementId } };
  }

  const claimId = typeof link.claimId === 'string' ? link.claimId.trim() : '';
  if (claimId.length === 0) {
    return { dropped: { reason: 'no_claim_id', detail: requirementId } };
  }
  const claim = context.claims.get(claimId);
  if (!claim) {
    return { dropped: { reason: 'unknown_claim', detail: claimId } };
  }
  // The guard E.8 names: the referenced claim must EXIST and must be one the user has
  // CONFIRMED. Asked of `career/claimUsage.ts#isRenderableClaimStatus`, the career layer's
  // own predicate - which is also why this module spells no status literal of its own:
  // `career/claimWriterAI.test.ts` guards that, and the vocabulary belongs to the career
  // layer.
  if (!isConfirmedClaim(claim)) {
    return { dropped: { reason: 'unconfirmed_claim', detail: claimId } };
  }

  const level = normalizeLevel(link.level);
  if (level === null) {
    return { dropped: { reason: 'bad_level', detail: String(link.level ?? '(missing)') } };
  }

  const rationale = normalizeRationale(link.rationale);
  if (rationale === null) {
    return { dropped: { reason: 'no_rationale', detail: `${requirementId}/${claimId}` } };
  }

  const fingerprint = `${requirementId}|${claimId}|${level}`;
  if (context.seen.has(fingerprint)) {
    return { dropped: { reason: 'duplicate', detail: fingerprint } };
  }

  return {
    accepted: {
      requirementId,
      claimId,
      level,
      proposedEvidence: claim.statement,
      rationale,
    },
  };
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

export interface ProposalInput {
  userId: string;
  matchReportId: string;
  /** The requirements still open: everything not already `direct`. */
  requirements: readonly MatchRequirementRow[];
  /** EVERY claim of the profile. The guard, not the prompt, decides which are usable. */
  claims: readonly MatchClaimRow[];
  /** Requirements a confirmed claim already covers. A proposal for one is dropped. */
  directRequirementIds: readonly string[];
  /**
   * Proposals already waiting on this report. Seeded into the duplicate guard so a re-run
   * cannot stack a second identical row under the same requirement - and so a person is
   * never shown the same suggestion twice.
   */
  existingPending?: ReadonlyArray<{ requirementId: string; claimId: string; level: EvidenceLevel }>;
}

export interface ProposalResult {
  status: 'applied' | 'skipped';
  reason: ProposalReason;
  provider: string | null;
  model: string | null;
  /** The `PotentialMatch` rows written, in order. Always `status = pending`. */
  created: Array<{
    id: string;
    requirementId: string;
    claimId: string;
    level: string;
    proposedEvidence: string;
    rationale: string;
    status: string;
  }>;
  /** Everything the guards refused, with the reason. Never silently discarded. */
  dropped: DroppedProposal[];
}

function nothingToPropose(reason: ProposalReason): ProposalResult {
  return {
    status: 'skipped',
    reason,
    provider: null,
    model: null,
    created: [],
    dropped: [],
  };
}

/**
 * Propose contextual/potential links and persist the ones that survive the guards.
 *
 * ORDER: work out what is still open, then (only if there is something to say) call the
 * provider, then validate EVERY link, then write. With no provider, or nothing to propose
 * from, this returns a `skipped` result and writes nothing at all - the caller's direct
 * bucket and gaps are unaffected, because they were derived before this ran.
 */
export async function proposeContextualMatches(
  input: ProposalInput,
  store: PotentialProposalStore,
): Promise<ProposalResult> {
  // The direct requirements are dropped HERE rather than trusted to the caller to have
  // dropped them, so the "never propose for something already evidenced" rule holds for
  // every caller instead of only the one that remembered.
  const direct = new Set(input.directRequirementIds);
  const openRequirements = input.requirements.filter((row) => !direct.has(row.id));
  const requirements = openRequirements.slice(0, MAX_PROPOSAL_REQUIREMENTS);
  if (requirements.length === 0) {
    return nothingToPropose('no_requirements_to_propose');
  }
  const claims = input.claims.filter(isConfirmedClaim);
  if (claims.length === 0) {
    // Nothing confirmed means nothing to anchor a hypothesis on. Asking a model to invent
    // one is the fabrication this stage exists to avoid.
    return nothingToPropose('no_confirmed_claims');
  }

  const outcome = await proposer({ requirements, claims, userId: input.userId });
  if (outcome.status !== 'applied' || !outcome.response) {
    return {
      status: 'skipped',
      reason: outcome.reason,
      provider: outcome.provider,
      model: outcome.model,
      created: [],
      dropped: [],
    };
  }

  const requirementById = new Map(requirements.map((row) => [row.id, row] as const));
  const claimById = new Map(claims.map((row) => [row.id, row] as const));
  const seen = new Set<string>(
    (input.existingPending ?? []).map(
      (row) => `${row.requirementId}|${row.claimId}|${row.level}`,
    ),
  );
  const accepted: AcceptedProposal[] = [];
  const dropped: DroppedProposal[] = [];

  for (const link of outcome.response.links ?? []) {
    const verdict = validateProposal(link, {
      requirements: requirementById,
      claims: claimById,
      directRequirementIds: direct,
      seen,
    });
    if ('dropped' in verdict) {
      dropped.push(verdict.dropped);
      continue;
    }
    seen.add(`${verdict.accepted.requirementId}|${verdict.accepted.claimId}|${verdict.accepted.level}`);
    accepted.push(verdict.accepted);
  }

  const created: ProposalResult['created'] = [];
  for (const proposal of accepted) {
    const row = await store.potentialMatch.create({
      data: {
        matchReportId: input.matchReportId,
        requirementId: proposal.requirementId,
        claimId: proposal.claimId,
        level: proposal.level,
        proposedEvidence: proposal.proposedEvidence,
        rationale: proposal.rationale,
        // PENDING IS NOT A STATUS A CALLER MAY CHOOSE. Every proposal this module writes
        // waits for a person; `match/report.ts` is the only writer of the other two states,
        // and it does so from a Confirm or a Reject.
        status: 'pending',
      },
      select: {
        id: true,
        requirementId: true,
        claimId: true,
        level: true,
        proposedEvidence: true,
        rationale: true,
        status: true,
      },
    });
    created.push({
      id: row.id,
      requirementId: row.requirementId,
      claimId: row.claimId ?? '',
      level: row.level,
      proposedEvidence: row.proposedEvidence,
      rationale: row.rationale,
      status: row.status,
    });
  }

  return {
    status: 'applied',
    reason: 'ok',
    provider: outcome.provider,
    model: outcome.model,
    created,
    dropped,
  };
}