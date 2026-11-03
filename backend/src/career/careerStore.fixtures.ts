// =====================================================================================
// career/careerStore.fixtures.ts - in-memory `CareerStore` for the career service tests.
//
// WHY A FAKE, NOT `embedded-postgres`: the ADR-036 guarantee under test is a SERVICE
// layer property ("user_confirmed is only ever written together with a
// ClaimVerification row", "re-observation is a no-op"). It is proven by observing the
// writes a service performs, which is exactly what a fake records - and it must be
// runnable with no database at all (`npm test` on a clean checkout, in CI, in review).
// The database side of the same invariant (enum vocabulary, `(profileId, fingerprint)`
// uniqueness) was proven against real Postgres by T1010; this suite covers the other
// half, and deliberately does NOT pretend to be a database.
//
// The fake is deliberately strict where the schema is strict:
// - it enforces `@@unique([profileId, fingerprint])` and
//   `@@unique([profileId, contentHash])` (P2002-shaped error),
// - it enforces `@@unique([id])` on update (P2025-shaped error),
// - `$transaction` snapshots and ROLLS BACK on a throw, so the atomicity claim
//   ("the status change and its audit row commit together") is testable.
//
// `writes` records every mutating call in order, so "re-observation writes NOTHING" is
// an assertion, not an inference. `matcher.fixtures.ts` is the precedent for a
// fixtures module in this repo (imported by tests only).
// =====================================================================================

import {
  ClaimProvenance,
  ClaimStatus,
  ResumeChangeSource,
  ResumeUsage,
  type PrismaClient,
  type ResumeClaimUsage,
  type ResumeRevision,
} from '@prisma/client';
import {
  claimFingerprint,
  type CareerClaimRow,
  type CareerStore,
  type CareerTxStore,
  type ClaimVerificationRow,
  type EvidenceSourceRow,
} from './claims.js';
import type { ResumeClaimUsageStore } from './claimUsage.js';
import type { ResumeRevisionStore } from '../resume/revisions.js';
import type { ResumeProjectionStore } from '../resume/json/project.js';

// Compile-time only: the real client must satisfy the injected seam, otherwise the
// route layer (a later task) would need a cast to hand `prisma` to these services.
// `npx tsc --noEmit` proves this line; nothing runs it.
//
// The resume-derivation seams (T1030) are checked here too, for the same reason: a
// service whose seam the real client does not satisfy is a service every route will
// have to `as unknown as`, which is how a column name starts drifting from its use.
type RealClientSatisfiesSeam = PrismaClient extends CareerStore ? true : false;
type RealClientSatisfiesUsageSeam = PrismaClient extends ResumeClaimUsageStore ? true : false;
type RealClientSatisfiesRevisionSeam = PrismaClient extends ResumeRevisionStore ? true : false;
type RealClientSatisfiesProjectionSeam = PrismaClient extends ResumeProjectionStore ? true : false;
const SEAM_TYPECHECK: [
  RealClientSatisfiesSeam,
  RealClientSatisfiesUsageSeam,
  RealClientSatisfiesRevisionSeam,
  RealClientSatisfiesProjectionSeam,
] = [true, true, true, true];
void SEAM_TYPECHECK;

export class FakeUniqueViolation extends Error {
  readonly code = 'P2002';

  constructor(message: string) {
    super(message);
    this.name = 'FakeUniqueViolation';
  }
}

export class FakeRecordNotFound extends Error {
  readonly code = 'P2025';

  constructor(message: string) {
    super(message);
    this.name = 'FakeRecordNotFound';
  }
}

type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

function matchesWhere(row: Row, where: Where): boolean {
  if (where === undefined || where === null) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;
    const actual = row[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
      continue;
    }
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const condition = expected as { in?: unknown; equals?: unknown };
      if (Array.isArray(condition.in)) {
        if (!condition.in.includes(actual)) return false;
        continue;
      }
      if ('equals' in condition) {
        if (actual !== condition.equals) return false;
        continue;
      }
      throw new Error(`FakeCareerStore: unsupported condition on "${key}"`);
    }
    if (actual !== expected) return false;
  }
  return true;
}

function applyOrderBy(rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined || orderBy === null) return rows;
  const spec = orderBy as Row;
  const keys = Object.keys(spec);
  if (keys.length !== 1) throw new Error('FakeCareerStore: orderBy must name exactly one field');
  const field = keys[0];
  const direction = String(spec[field]).toLowerCase() === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[field] as never;
    const right = b[field] as never;
    if (left === right) return 0;
    return (left > right ? 1 : -1) * direction;
  });
}

function clone<T>(row: T): T {
  return { ...(row as Row) } as T;
}

const CLAIM_NULLABLE_COLUMNS = [
  'experienceId',
  'educationId',
  'projectId',
  'skillId',
  'certificationId',
  'achievementId',
  'confidence',
  'inferenceMethod',
  'producedByModel',
  'evidenceSourceId',
  'supersedesClaimId',
  'confirmedAt',
  'rejectedAt',
  'rejectedReason',
  'jobRelevance',
] as const;

export class FakeCareerStore {
  readonly claims = new Map<string, CareerClaimRow>();
  readonly verifications = new Map<string, ClaimVerificationRow>();
  readonly evidence = new Map<string, EvidenceSourceRow>();
  // The resume-derivation tables (T1030). Same reasoning as the three above: the
  // invariant under test is a service-layer property, and observing the writes a
  // service performs is how it is proven with no database.
  readonly revisions = new Map<string, ResumeRevision>();
  readonly usages = new Map<string, ResumeClaimUsage>();
  readonly changes = new Map<string, Row>();

  /** Mutating calls, in order: `claim.create`, `claim.update`, `verification.create`, ... */
  readonly writes: string[] = [];
  /** Read calls, in order. */
  readonly reads: string[] = [];
  /** How many `$transaction` calls ran (successfully or not). */
  transactions = 0;
  /** Make the audit-row insert blow up, to prove the status write rolls back with it. */
  failVerificationCreate = false;
  /** Make a claim update blow up. */
  failClaimUpdate = false;

  private seq = 0;
  private tick = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private stamp(): Date {
    this.tick += 1;
    return new Date(Date.UTC(2026, 8, 30, 12, 0, this.tick));
  }

  private snapshot(): {
    claims: Row[];
    verifications: Row[];
    evidence: Row[];
    revisions: Row[];
    usages: Row[];
    changes: Row[];
  } {
    return {
      claims: [...this.claims.values()].map(clone),
      verifications: [...this.verifications.values()].map(clone),
      evidence: [...this.evidence.values()].map(clone),
      revisions: [...this.revisions.values()].map(clone),
      usages: [...this.usages.values()].map(clone),
      changes: [...this.changes.values()].map(clone),
    };
  }

  private restore(snapshot: {
    claims: Row[];
    verifications: Row[];
    evidence: Row[];
    revisions: Row[];
    usages: Row[];
    changes: Row[];
  }): void {
    const fill = <T>(map: Map<string, T>, rows: Row[]): void => {
      map.clear();
      for (const row of rows) map.set(row.id as string, row as T);
    };
    fill(this.claims, snapshot.claims);
    fill(this.verifications, snapshot.verifications);
    fill(this.evidence, snapshot.evidence);
    fill(this.revisions, snapshot.revisions);
    fill(this.usages, snapshot.usages);
    fill(this.changes, snapshot.changes);
  }

  // -- careerClaim ------------------------------------------------------------

  careerClaim = {
    create: async (args: { data: Row }): Promise<CareerClaimRow> => {
      this.writes.push('claim.create');
      const data = args.data;
      for (const [otherId, other] of this.claims) {
        if (other.profileId === data.profileId && other.fingerprint === data.fingerprint) {
          throw new FakeUniqueViolation(
            `Unique constraint failed on the fields: (\`profileId\`,\`fingerprint\`) (claim ${otherId})`,
          );
        }
      }
      const now = this.stamp();
      const row: CareerClaimRow = {
        id: this.nextId('clm'),
        createdAt: now,
        updatedAt: now,
        ...Object.fromEntries(CLAIM_NULLABLE_COLUMNS.map((column) => [column, null])),
        ...data,
      } as unknown as CareerClaimRow;
      this.claims.set(row.id, row);
      return row;
    },
    findFirst: async (args: { where: Where }): Promise<CareerClaimRow | null> => {
      this.reads.push('claim.findFirst');
      for (const row of this.claims.values()) {
        if (matchesWhere(row as Row, args.where)) return row;
      }
      return null;
    },
    findMany: async (args: {
      where?: Where;
      orderBy?: unknown;
      take?: number;
      skip?: number;
    }): Promise<CareerClaimRow[]> => {
      this.reads.push('claim.findMany');
      const matched = [...this.claims.values()].filter((row) => matchesWhere(row as Row, args.where));
      const ordered = applyOrderBy(matched as Row[], args.orderBy) as CareerClaimRow[];
      const start = args.skip ?? 0;
      return args.take === undefined ? ordered.slice(start) : ordered.slice(start, start + args.take);
    },
    update: async (args: { where: Where; data: Row }): Promise<CareerClaimRow> => {
      this.writes.push('claim.update');
      if (this.failClaimUpdate) throw new Error('fake: claim update failed');
      const id = args.where?.id;
      const existing = typeof id === 'string' ? this.claims.get(id) : undefined;
      if (!existing) throw new FakeRecordNotFound('No CareerClaim found to update');
      const next = {
        ...(existing as Row),
        ...args.data,
        updatedAt: this.stamp(),
      } as unknown as CareerClaimRow;
      this.claims.set(next.id, next);
      return next;
    },
  };

  // -- claimVerification ------------------------------------------------------

  claimVerification = {
    create: async (args: { data: Row }): Promise<ClaimVerificationRow> => {
      this.writes.push('verification.create');
      if (this.failVerificationCreate) throw new Error('fake: audit row insert failed');
      const row = {
        id: this.nextId('ver'),
        ...args.data,
      } as unknown as ClaimVerificationRow;
      this.verifications.set(row.id, row);
      return row;
    },
    findMany: async (args: {
      where?: Where;
      orderBy?: unknown;
      take?: number;
      skip?: number;
    }): Promise<ClaimVerificationRow[]> => {
      this.reads.push('verification.findMany');
      const matched = [...this.verifications.values()].filter((row) =>
        matchesWhere(row as Row, args.where),
      );
      const ordered = applyOrderBy(matched as Row[], args.orderBy) as ClaimVerificationRow[];
      const start = args.skip ?? 0;
      return args.take === undefined ? ordered.slice(start) : ordered.slice(start, start + args.take);
    },
  };

  // -- evidenceSource ---------------------------------------------------------

  evidenceSource = {
    create: async (args: { data: Row }): Promise<EvidenceSourceRow> => {
      this.writes.push('evidence.create');
      const data = args.data;
      for (const [otherId, other] of this.evidence) {
        if (other.profileId === data.profileId && other.contentHash === data.contentHash) {
          throw new FakeUniqueViolation(
            `Unique constraint failed on the fields: (\`profileId\`,\`contentHash\`) (source ${otherId})`,
          );
        }
      }
      const now = this.stamp();
      const row: EvidenceSourceRow = {
        id: this.nextId('evd'),
        createdAt: now,
        url: null,
        mimeType: null,
        storageKey: null,
        byteSize: null,
        uploadedFileId: null,
        extractedText: null,
        trustLevel: 1,
        capturedAt: now,
        ...data,
      } as unknown as EvidenceSourceRow;
      this.evidence.set(row.id, row);
      return row;
    },
    findFirst: async (args: { where: Where }): Promise<EvidenceSourceRow | null> => {
      this.reads.push('evidence.findFirst');
      for (const row of this.evidence.values()) {
        if (matchesWhere(row as Row, args.where)) return row;
      }
      return null;
    },
    findMany: async (args: {
      where?: Where;
      orderBy?: unknown;
      take?: number;
      skip?: number;
    }): Promise<EvidenceSourceRow[]> => {
      this.reads.push('evidence.findMany');
      const matched = [...this.evidence.values()].filter((row) => matchesWhere(row as Row, args.where));
      const ordered = applyOrderBy(matched as Row[], args.orderBy) as EvidenceSourceRow[];
      const start = args.skip ?? 0;
      return args.take === undefined ? ordered.slice(start) : ordered.slice(start, start + args.take);
    },
  };

  // -- resumeRevision (T1030) -------------------------------------------------
  //
  // There is NO `update` and NO `delete` on this delegate, and that is the point, not
  // an omission. 05 sec.6.2: "Revisions are immutable. Editing produces revision N+1."
  // A fake that implemented `update` would let a test prove immutability by asserting
  // "nothing called it", which is a much weaker statement than "it is not reachable".
  // The matching type-level guarantee is `ResumeRevisionWriteSeam` in
  // `resume/revisions.ts`; this is its runtime twin.

  resumeRevision = {
    create: async (args: { data: Row }): Promise<ResumeRevision> => {
      this.writes.push('revision.create');
      const data = args.data;
      // `@@unique([resumeId, revisionNumber])` - two creators of revision N+1 produce
      // one row and one P2002, not a silently interleaved history.
      for (const other of this.revisions.values()) {
        if (other.resumeId === data.resumeId && other.revisionNumber === data.revisionNumber) {
          throw new FakeUniqueViolation(
            `Unique constraint failed on the fields: (\`resumeId\`,\`revisionNumber\`) (revision ${other.id})`,
          );
        }
      }
      const row = {
        id: this.nextId('rev'),
        createdAt: this.stamp(),
        enginePins: {},
        createdByUserId: null,
        reason: null,
        ...data,
      } as unknown as ResumeRevision;
      this.revisions.set(row.id, row);
      return row;
    },
    findFirst: async (args: { where?: Where; orderBy?: unknown }): Promise<ResumeRevision | null> => {
      this.reads.push('revision.findFirst');
      const matched = [...this.revisions.values()].filter((row) =>
        matchesWhere(row as Row, args.where),
      );
      const ordered = applyOrderBy(matched as Row[], args.orderBy) as ResumeRevision[];
      return ordered[0] ?? null;
    },
    findMany: async (args: {
      where?: Where;
      orderBy?: unknown;
      take?: number;
      skip?: number;
    }): Promise<ResumeRevision[]> => {
      this.reads.push('revision.findMany');
      const matched = [...this.revisions.values()].filter((row) => matchesWhere(row as Row, args.where));
      const ordered = applyOrderBy(matched as Row[], args.orderBy) as ResumeRevision[];
      const start = args.skip ?? 0;
      return args.take === undefined ? ordered.slice(start) : ordered.slice(start, start + args.take);
    },
    findUnique: async (args: { where: Where }): Promise<ResumeRevision | null> => {
      this.reads.push('revision.findUnique');
      for (const row of this.revisions.values()) {
        if (matchesWhere(row as Row, args.where)) return row;
      }
      return null;
    },
  };

  // -- resumeChange (T1030) ---------------------------------------------------

  resumeChange = {
    create: async (args: { data: Row }): Promise<Row> => {
      this.writes.push('change.create');
      const row = { id: this.nextId('chg'), accepted: true, ...args.data };
      this.changes.set(row.id as string, row);
      return row;
    },
    findMany: async (args: { where?: Where; orderBy?: unknown }): Promise<Row[]> => {
      this.reads.push('change.findMany');
      const matched = [...this.changes.values()].filter((row) => matchesWhere(row, args.where));
      return applyOrderBy(matched, args.orderBy);
    },
  };

  // -- resumeClaimUsage (T1030) -----------------------------------------------

  resumeClaimUsage = {
    create: async (args: { data: Row }): Promise<ResumeClaimUsage> => {
      this.writes.push('usage.create');
      const data = args.data;
      // `@@unique([revisionId, claimId])`: re-recording a usage is a no-op, not a
      // second row. A revision's usage is fixed at authoring time.
      for (const other of this.usages.values()) {
        if (other.revisionId === data.revisionId && other.claimId === data.claimId) {
          throw new FakeUniqueViolation(
            `Unique constraint failed on the fields: (\`revisionId\`,\`claimId\`) (usage ${other.id})`,
          );
        }
      }
      const row = {
        id: this.nextId('usg'),
        createdAt: this.stamp(),
        renderedText: null,
        ...data,
      } as unknown as ResumeClaimUsage;
      this.usages.set(row.id, row);
      return row;
    },
    findMany: async (args: {
      where?: Where;
      orderBy?: unknown;
      take?: number;
      skip?: number;
    }): Promise<ResumeClaimUsage[]> => {
      this.reads.push('usage.findMany');
      const matched = [...this.usages.values()].filter((row) => matchesWhere(row as Row, args.where));
      const ordered = applyOrderBy(matched as Row[], args.orderBy) as ResumeClaimUsage[];
      const start = args.skip ?? 0;
      return args.take === undefined ? ordered.slice(start) : ordered.slice(start, start + args.take);
    },
  };

  // -- transaction ------------------------------------------------------------

  $transaction = async <T>(fn: (tx: CareerTxStore) => Promise<T>): Promise<T> => {
    this.transactions += 1;
    const before = this.snapshot();
    try {
      return await fn(this as unknown as CareerTxStore);
    } catch (error) {
      this.restore(before);
      throw error;
    }
  };

  /** The seam a service actually takes. */
  asStore(): CareerStore {
    return this as unknown as CareerStore;
  }

  /** The seam the pre-render gate and the usage recorder take (T1030). */
  asUsageStore(): ResumeClaimUsageStore {
    return this as unknown as ResumeClaimUsageStore;
  }

  /** The seam the revision writer takes (T1030). */
  asRevisionStore(): ResumeRevisionStore {
    return this as unknown as ResumeRevisionStore;
  }

  // -- helpers for tests ------------------------------------------------------

  /** All rows for a profile, in insertion order. */
  claimsFor(profileId: string): CareerClaimRow[] {
    return [...this.claims.values()].filter((row) => row.profileId === profileId);
  }

  /** All audit rows for a claim, in insertion order. */
  verificationsFor(claimId: string): ClaimVerificationRow[] {
    return [...this.verifications.values()].filter((row) => row.claimId === claimId);
  }

  /** All usage rows of a revision, in insertion order. */
  usagesFor(revisionId: string): ResumeClaimUsage[] {
    return [...this.usages.values()].filter((row) => row.revisionId === revisionId);
  }

  /** Every revision of a resume, ascending by revision number. */
  revisionsFor(resumeId: string): ResumeRevision[] {
    return [...this.revisions.values()]
      .filter((row) => row.resumeId === resumeId)
      .sort((a, b) => a.revisionNumber - b.revisionNumber);
  }

  /**
   * Direct row seeding, for a test that is about the GATE rather than about the
   * recorder. Going through `recordClaimUsages` would apply the write-time guards,
   * which is correct behaviour but would mean the gate could never be exercised with
   * the states the recorder refuses to create - and the gate is the control.
   */
  addUsage(
    revisionId: string,
    data: { claimId: string; usage: ResumeUsage; renderedText?: string | null },
  ): ResumeClaimUsage {
    const row = {
      id: this.nextId('usg'),
      revisionId,
      claimId: data.claimId,
      usage: data.usage,
      renderedText: data.renderedText ?? null,
      createdAt: this.stamp(),
    } as unknown as ResumeClaimUsage;
    this.usages.set(row.id, row);
    return row;
  }

  /** Replace a revision's stored document, bypassing every writer (T1030 tests). */
  setRevisionJson(revisionId: string, json: unknown): void {
    const existing = this.revisions.get(revisionId);
    if (!existing) throw new FakeRecordNotFound(`No ResumeRevision found: ${revisionId}`);
    this.revisions.set(revisionId, { ...existing, resumeJson: json as never });
  }
}

/**
 * A claim row at an ARBITRARY status, for the gate's truth-table tests.
 *
 * `fakeInferredClaim` is the honest way to make a claim; this one exists because the
 * gate has to be exercised at `contextual`, `rejected` and `superseded` too, and the
 * honest way to reach `rejected` is `verification.rejectClaim` (which needs a
 * confirmed claim first). Writing the status directly is the right call HERE precisely
 * because the thing under test is the gate's HANDLING of a status, not the transition
 * that produced it. Where the transition is the thing under test, the test uses
 * `verification.ts` and the audit rows it writes are asserted.
 */
export function fakeClaimAtStatus(
  store: FakeCareerStore,
  status: ClaimStatus,
  overrides: Partial<CareerClaimRow> = {},
): CareerClaimRow {
  return fakeInferredClaim(store, { ...overrides, status });
}

/**
 * A `user_confirmed` claim.
 *
 * A CONFIRMED claim is not a thing a test may simply declare: `user_confirmed` is
 * reachable only through `career/verification.ts` together with a `ClaimVerification`
 * row (ADR-036 item 3), and that rule is the reason this module exists. So a test that
 * needs a confirmed claim either (a) calls `confirmClaim` and asserts the audit row -
 * which is the honest path and what the gate's "allowed" tests should do - or (b) uses
 * this helper, which is a DELIBERATE, DOCUMENTED hole in the fake for the tests whose
 * subject is the gate's branch rather than the transition.
 *
 * `seedConfirmedClaim` is `fakeClaimAtStatus(store, user_confirmed, overrides)`. It is
 * named to make the bypass visible at every call site: a reviewer reading a test that
 * says `seedConfirmedClaim` knows the claim did not go through the real transition.
 */
export function seedConfirmedClaim(
  store: FakeCareerStore,
  overrides: Partial<CareerClaimRow> = {},
): CareerClaimRow {
  return fakeClaimAtStatus(store, ClaimStatus.user_confirmed, overrides);
}

/** Seed a `ResumeRevision` row directly (T1030). */
export function seedRevision(
  store: FakeCareerStore,
  resumeId: string,
  revisionNumber: number,
  overrides: Partial<ResumeRevision> = {},
): ResumeRevision {
  const now = new Date('2026-09-30T12:00:00.000Z');
  const row = {
    id: `rev-${resumeId}-${revisionNumber}`,
    resumeId,
    revisionNumber,
    resumeJson: { basics: { name: 'Seed' } },
    jsonHash: 'seed',
    enginePins: {},
    createdBy: ResumeChangeSource.user,
    createdByUserId: null,
    reason: null,
    createdAt: now,
    ...overrides,
  } as unknown as ResumeRevision;
  store.revisions.set(row.id, row);
  return row;
}

/** An `inferred` claim row factory for the tests that need a starting point. */
export function fakeInferredClaim(
  store: FakeCareerStore,
  overrides: Partial<CareerClaimRow> = {},
): CareerClaimRow {
  const now = new Date('2026-09-30T09:00:00.000Z');
  const statement = overrides.statement ?? 'Cut CI build time by 40%';
  const kind = overrides.kind ?? 'achievement';
  const row: CareerClaimRow = {
    id: overrides.id ?? 'clm-seed',
    profileId: overrides.profileId ?? 'profile-1',
    kind,
    statement,
    // The REAL fingerprint by default, so a re-observation of the same statement really
    // does dedupe against this row (that is what most career tests are about).
    fingerprint: overrides.fingerprint ?? claimFingerprint(kind, statement),
    experienceId: null,
    educationId: null,
    projectId: null,
    skillId: null,
    certificationId: null,
    achievementId: null,
    status: overrides.status ?? ClaimStatus.inferred,
    provenance: overrides.provenance ?? ClaimProvenance.llm_inferred,
    confidence: overrides.confidence ?? 0.7,
    inferenceMethod: 'resume_import',
    producedByModel: null,
    evidenceSourceId: null,
    supersedesClaimId: null,
    confirmedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    jobRelevance: null,
    createdAt: now,
    updatedAt: now,
  } as unknown as CareerClaimRow;
  store.claims.set(row.id, row);
  return row;
}
