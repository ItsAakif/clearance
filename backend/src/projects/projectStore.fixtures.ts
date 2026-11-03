// =====================================================================================
// projects/projectStore.fixtures.ts - the in-memory `ProjectStore` for the project-engine
// service tests (T1100).
//
// WHY A FAKE AND NOT A DATABASE. The invariants these tests protect are SERVICE-LAYER
// properties, and the two that matter most are observed by WATCHING WRITES:
//
//   1. "nothing auto-confirms" - the claims table must be byte-for-byte unchanged after a
//      `complete`, which is a statement about what was NOT written. No assertion about a row
//      that does not exist can be made against a real database without a second query whose
//      absence is the same fact; here it is `expect(store.claimsFor(profileId)).toEqual([])`.
//
//   2. "every reference carries a licence and an activity snapshot" - again a property of the
//      write, and the fake records each `projectReference.create` verbatim so a row without a
//      licence cannot hide.
//
// It EXTENDS `career/careerStore.fixtures.ts`'s `FakeCareerStore` rather than re-implementing
// the career layer, because `confirm` reaches the career layer through the REAL service
// (`career/userDecisions.ts`), and a second hand-written claim table would mean two fakes
// disagreeing about fingerprint dedupe and audit rows. The career tables therefore behave
// exactly as the T1010/T1020 suites make them behave.
//
// IT IS A TEST FIXTURE, NOT A PRETEND DATABASE. It does not enforce Prisma's enums, its
// `@@index`es or its foreign keys, and the queries ignore `select` (a row is returned whole,
// which every reader here projects itself). What it DOES enforce is the shape of the seam: an
// unknown `where` finds nothing, and a `create` records the data it was handed.
// =====================================================================================

import type { PrismaClient } from '@prisma/client';

import { FakeCareerStore } from '../career/careerStore.fixtures.js';
import type { ProjectStore } from './lifecycle.js';

type Row = Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

/** Compile-time proof that the real client still satisfies the seam `lifecycle.ts` takes. */
type RealClientSatisfiesProjectStore = PrismaClient extends ProjectStore ? true : false;
const PROJECT_STORE_TYPECHECK: [RealClientSatisfiesProjectStore] = [true];
void PROJECT_STORE_TYPECHECK;

function matchesWhere(row: Row, where: Where): boolean {
  if (where === undefined || where === null) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;
    if (Array.isArray(expected)) {
      if (!expected.includes(row[key])) return false;
      continue;
    }
    if (row[key] !== expected) return false;
  }
  return true;
}

/**
 * `orderBy`, including the ARRAY form `projects/lifecycle.ts` uses
 * (`[{ importance: 'asc' }, { normalizedKey: 'asc' }]`).
 *
 * The career fixture's own helper takes exactly one field and throws otherwise; a run that
 * asks for more than one sort key is ordinary here, so the project fake spells the whole thing
 * out rather than delegating.
 */
function applyOrderBy(rows: Row[], orderBy: unknown): Row[] {
  if (orderBy === undefined || orderBy === null) return rows;
  const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of keys as Row[]) {
      for (const [field, direction] of Object.entries(spec)) {
        const left = a[field];
        const right = b[field];
        const text = String(left ?? '').localeCompare(String(right ?? ''));
        const compared = direction === 'desc' ? -text : text;
        if (compared !== 0) return compared;
      }
    }
    return 0;
  });
}

export class FakeProjectStore extends FakeCareerStore {
  // -- the tables the project engine owns -------------------------------------

  readonly opportunities = new Map<string, Row>();
  readonly references = new Map<string, Row>();
  readonly matchReports = new Map<string, Row>();
  readonly jobs = new Map<string, Row>();
  readonly requirements = new Map<string, Row>();
  readonly profiles = new Map<string, Row>();
  readonly potentialMatches = new Map<string, Row>();

  private projectSeq = 0;

  /**
   * `careerClaim.findUnique`, added to the inherited delegate.
   *
   * `FakeCareerStore` predates the project engine, whose idempotent confirm reads the existing
   * claim back by id. It is added by EXTENDING the inherited object rather than replacing it,
   * so the create/find/update behaviour the career suites rely on is untouched.
   */
  constructor() {
    super();
    Object.assign(this.careerClaim, {
      findUnique: async (args: { where: Where }) => {
        this.reads.push('claim.findUnique');
        for (const row of this.claims.values()) {
          if (matchesWhere(row as Row, args.where)) return row;
        }
        return null;
      },
    });
  }

  private nextProjectId(prefix: string): string {
    this.projectSeq += 1;
    return `${prefix}-${this.projectSeq}`;
  }

  private rowsOf(map: Map<string, Row>): Row[] {
    return [...map.values()];
  }

  private insert(map: Map<string, Row>, prefix: string, data: Row): Row {
    const row: Row = {
      // Postgres default: a Date, so a reader that calls `toISOString()` works without seeding.
      createdAt: new Date('2026-10-06T09:00:00.000Z'),
      updatedAt: new Date('2026-10-06T09:00:00.000Z'),
      completedAt: null,
      verifiedClaimId: null,
      retrievedAt: new Date('2026-10-06T09:00:00.000Z'),
      ...data,
      id: typeof data.id === 'string' ? data.id : this.nextProjectId(prefix),
    };
    map.set(row.id as string, row);
    return row;
  }

  // -- careerProfile ------------------------------------------------------------

  careerProfile = {
    findUnique: async (args: { where: Where }) => {
      this.reads.push('profile.findUnique');
      return this.rowsOf(this.profiles).find((row) => matchesWhere(row, args.where)) ?? null;
    },
    create: async (args: { data: Row }) => {
      this.writes.push('profile.create');
      return this.insert(this.profiles, 'prof', args.data);
    },
  };

  // -- job / jobRequirement / matchReport / potentialMatch -----------------------

  job = {
    findUnique: async (args: { where: Where }) => {
      this.reads.push('job.findUnique');
      return this.rowsOf(this.jobs).find((row) => matchesWhere(row, args.where)) ?? null;
    },
  };

  jobRequirement = {
    findMany: async (args: { where?: Where; orderBy?: unknown } = {}) => {
      this.reads.push('req.findMany');
      const matched = this.rowsOf(this.requirements).filter((row) => matchesWhere(row, args.where));
      return applyOrderBy(matched, args.orderBy);
    },
  };

  matchReport = {
    findUnique: async (args: { where: Where }) => {
      this.reads.push('report.findUnique');
      return this.rowsOf(this.matchReports).find((row) => matchesWhere(row, args.where)) ?? null;
    },
  };

  potentialMatch = {
    findMany: async (args: { where?: Where; orderBy?: unknown } = {}) => {
      this.reads.push('pm.findMany');
      const matched = this.rowsOf(this.potentialMatches).filter((row) =>
        matchesWhere(row, args.where),
      );
      return applyOrderBy(matched, args.orderBy);
    },
  };

  // -- projectOpportunity --------------------------------------------------------

  projectOpportunity = {
    create: async (args: { data: Row }) => {
      this.writes.push('opportunity.create');
      return this.insert(this.opportunities, 'opp', args.data);
    },
    findUnique: async (args: { where: Where }) => {
      this.reads.push('opportunity.findUnique');
      return this.rowsOf(this.opportunities).find((row) => matchesWhere(row, args.where)) ?? null;
    },
    findMany: async (args: { where?: Where; orderBy?: unknown } = {}) => {
      this.reads.push('opportunity.findMany');
      const matched = this.rowsOf(this.opportunities).filter((row) => matchesWhere(row, args.where));
      return applyOrderBy(matched, args.orderBy);
    },
    update: async (args: { where: Where; data: Row }) => {
      this.writes.push('opportunity.update');
      const id = args.where?.id;
      const existing = typeof id === 'string' ? this.opportunities.get(id) : undefined;
      if (!existing) throw new Error(`fake: no projectOpportunity ${String(id)}`);
      const merged: Row = { ...existing, ...args.data, updatedAt: new Date() };
      this.opportunities.set(merged.id as string, merged);
      return merged;
    },
  };

  // -- projectReference ----------------------------------------------------------

  projectReference = {
    create: async (args: { data: Row }) => {
      this.writes.push('reference.create');
      return this.insert(this.references, 'ref', args.data);
    },
    findMany: async (args: { where?: Where; orderBy?: unknown } = {}) => {
      this.reads.push('reference.findMany');
      const matched = this.rowsOf(this.references).filter((row) => matchesWhere(row, args.where));
      return applyOrderBy(matched, args.orderBy);
    },
  };

  // -- the seam `projects/lifecycle.ts` takes -------------------------------------

  /**
   * The seam. A cast rather than a hand-written interface for the same reason
   * `careerStore.fixtures.ts` casts: the generated client already proves the real thing
   * satisfies it (the TYPECHECK above), and a second declaration of the seam would be a second
   * thing to keep in step with the schema.
   *
   * `$transaction` is the INHERITED one, and it is correct here for a non-obvious reason: it
   * passes `this` as the transaction handle, and `this` carries the seven project delegates as
   * own properties - so `confirm`'s `tx.projectOpportunity.update(...)` resolves. Its snapshot
   * covers the career tables only, which is what the career suites' atomicity claim needs and
   * all this file claims for it.
   */
  asProjectStore(): ProjectStore {
    return this as unknown as ProjectStore;
  }

  // -- helpers for the tests -----------------------------------------------------

  /** Every stored opportunity, oldest first. */
  allOpportunities(): Row[] {
    return [...this.opportunities.values()];
  }

  /** The references recorded against one opportunity, oldest first. */
  referencesFor(opportunityId: string): Row[] {
    return [...this.references.values()].filter((row) => row.opportunityId === opportunityId);
  }

  /** Seed a row directly, for a test that is about the GATE rather than about the writer. */
  seed(table: 'opportunities' | 'references' | 'jobs' | 'requirements' | 'profiles', row: Row): Row {
    const map =
      table === 'opportunities'
        ? this.opportunities
        : table === 'references'
          ? this.references
          : table === 'jobs'
            ? this.jobs
            : table === 'requirements'
              ? this.requirements
              : this.profiles;
    const seeded: Row = {
      // Postgres defaults, so a reader that calls `toISOString()` on a seeded row works.
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      completedAt: null,
      verifiedClaimId: null,
      id: `seed-${map.size + 1}`,
      ...row,
    };
    map.set(seeded.id as string, seeded);
    return seeded;
  }
}