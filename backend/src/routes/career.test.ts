// routes/career.test.ts - the HTTP surface of the career import + verification (T1020).
//
// WHAT IS PROVEN HERE, AND WHY IT IS NOT A DUPLICATE OF THE SERVICE SUITES
// (`career/claims.test.ts`, `career/verification.test.ts`, `career/evidence.test.ts`):
//   1. AN IMPORT PRODUCES ONLY INFERRED CLAIMS. Every `careerClaim.create` call the
//      import makes is inspected for its `status` AND its `provenance`, so "the
//      deterministic path wrote `document_import` and the AI path wrote
//      `llm_inferred`" is a fact about the calls, not a fact about the source.
//   2. NO AUTO-CONFIRM PATH EXISTS. Two independent mechanisms, because either alone is
//      one refactor away from being deleted: (a) the import writes NO
//      `ClaimVerification` row at all - asserted on the mock, so the row is absent even
//      in principle; (b) a SOURCE GUARD over this router's own file proves the string
//      `user_confirmed` never appears in it outside that one comment.
//   3. THE IMPORT WORKS WITH NO AI PROVIDER (ADR-041 D5). The key manager refuses to
//      lease, and the import still answers 201 with claims, `enrichment.status =
//      'skipped'` and a machine-readable reason.
//   4. EVERY STATUS CHANGE IS PAIRED WITH AN AUDIT ROW (ADR-036 item 3). confirm /
//      reject / reopen each assert BOTH the claim's new status and the exact
//      `ClaimVerification.create` payload - including the non-null `actorUserId` and the
//      action name - so "the audit row" is not a claim about the service.
//   5. THE UNCONFIRMED COUNTER IS ACCURATE, over the HTTP response, for the statuses
//      that make it non-trivial (`rejected` and `superseded` must not inflate it).
//   6. CROSS-TENANT REFUSALS: another user's profile is a 403, another user's claim is
//      a 403 on every decision route, and their file's stored text is never read.
//
// Mock style follows `routes/resumes.test.ts`: `vi.hoisted` for shared state, `vi.mock`
// for `requireAuth` and the prisma singleton, the real router.
//
// The real `resume/parser.ts` is kept intact EXCEPT for `parseResumeWithLLM` (the one
// function that would open a network connection): `importOriginal` supplies the real
// `parseUploadedResume`, so the deterministic extractor under test is the production one.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaimKind, ClaimProvenance, ClaimStatus, EvidenceKind } from '@prisma/client';

const { mockUserId, prismaMocks, keyMocks, llmMocks, providerMocks, store } = vi.hoisted(() => {
  // A tiny in-memory careerClaim store, so the dedupe (`findFirst` on
  // `(profileId, fingerprint)`) and the verification transaction behave like the real
  // ones. A `vi.fn()` that returns `null` for every `findFirst` would make a re-import
  // silently "create" the same claim twice and would hide the whole point of the
  // fingerprint, and the `$transaction` has to hand back a store that shares the rows.
  const rows: Array<Record<string, unknown>> = [];
  let counter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++counter}`;

  const claimStore = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: nextId('clm'),
        experienceId: null,
        educationId: null,
        projectId: null,
        skillId: null,
        certificationId: null,
        achievementId: null,
        supersedesClaimId: null,
        confidence: null,
        inferenceMethod: null,
        producedByModel: null,
        evidenceSourceId: null,
        confirmedAt: null,
        rejectedAt: null,
        rejectedReason: null,
        jobRelevance: null,
        createdAt: new Date('2026-10-03T09:00:00.000Z'),
        updatedAt: new Date('2026-10-03T09:00:00.000Z'),
        ...data,
      };
      rows.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        rows.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ) ?? null
      );
    }),
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (!where) return [...rows];
      return rows.filter((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value),
      );
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const index = rows.findIndex((entry) => entry.id === where.id);
      if (index === -1) throw new Error(`no claim ${where.id}`);
      // NON-MUTATING on purpose. `career/verification.ts` serialises the `before`
      // snapshot from the row it read and the `after` snapshot from the row `update`
      // returned; a mock that assigns in place would hand back the SAME object and make
      // `before` silently equal `after`, which would hide the very audit-trail property
      // these tests assert.
      const merged = { ...rows[index], ...data, updatedAt: new Date('2026-10-03T10:00:00.000Z') };
      rows[index] = merged;
      return merged;
    }),
    groupBy: vi.fn(),
    // deleteCareerEntity in career/entities.ts counts the claims that named the row it is
    // about to delete, so the UI can report how many statements lost their placement.
    count: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      rows.filter((row) =>
        where === undefined
          ? true
          : Object.entries(where).every(([key, value]) => row[key] === value),
      ).length,
    ),
  };

  const evidenceRows: Array<Record<string, unknown>> = [];
  const evidenceSource = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: 'evd-1', capturedAt: new Date('2026-10-03T09:00:00.000Z'), createdAt: new Date('2026-10-03T09:00:00.000Z'), ...data };
      evidenceRows.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        evidenceRows.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ) ?? null
      );
    }),
    findMany: vi.fn(async () => [...evidenceRows]),
  };

  const verifications: Array<Record<string, unknown>> = [];
  const claimVerification = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: nextId('ver'),
        before: null,
        after: null,
        note: null,
        createdAt: new Date('2026-10-03T09:30:00.000Z'),
        ...data,
      };
      verifications.push(row);
      return row;
    }),
    findMany: vi.fn(async () => [...verifications]),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
      verifications.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)).length,
    ),
  };

  // ---------------------------------------------------------------------------
  // The six ENTITY delegates (T1054)
  // ---------------------------------------------------------------------------
  // A real in-memory table per kind, with the two behaviours the routes depend on:
  //
  //   - `findFirst`/`findMany` filter on EVERY key of `where`, so `where: {id, profileId}`
  //     scopes exactly as `@@index([profileId])` + a primary key do. That is what makes the
  //     "a foreign id is a 404" assertions real rather than rigged: a fake that ignored
  //     `profileId` would answer 200 for somebody else's row and the test would pass for the
  //     wrong reason.
  //   - `orderBy` is honoured, so "the list is in the order the projector places them" is
  //     observable instead of being an accident of insertion order.
  const entityTables: Record<string, Array<Record<string, unknown>>> = {
    experience: [],
    education: [],
    project: [],
    skill: [],
    certification: [],
    achievement: [],
  };

  function entityDelegate(kind: string) {
    const table = entityTables[kind];
    const matches = (row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean =>
      where === undefined
        ? true
        : Object.entries(where).every(([key, value]) => row[key] === value);
    const sorted = (list: Array<Record<string, unknown>>, orderBy: unknown): Array<Record<string, unknown>> => {
      if (!Array.isArray(orderBy) || orderBy.length === 0) return list;
      const keys = orderBy as Array<Record<string, unknown>>;
      return [...list].sort((a, b) => {
        for (const clause of keys) {
          const [key, direction] = Object.entries(clause)[0] ?? [];
          if (key === undefined) continue;
          const left = a[key];
          const right = b[key];
          if (left === right) continue;
          const delta = left == null ? -1 : right == null ? 1 : left < right ? -1 : 1;
          return direction === 'desc' ? -delta : delta;
        }
        return 0;
      });
    };
    return {
      findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        table.find((row) => matches(row, where)) ?? null,
      ),
      findMany: vi.fn(
        async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown } = {}) =>
          sorted(table.filter((row) => matches(row, where)), orderBy),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: nextId(kind.slice(0, 3)),
          createdAt: new Date('2026-10-03T08:00:00.000Z'),
          updatedAt: new Date('2026-10-03T08:00:00.000Z'),
          ...data,
        };
        table.push(row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const index = table.findIndex((row) => row.id === where.id);
        if (index === -1) throw new Error(`no ${kind} ${where.id}`);
        const merged = { ...table[index], ...data, updatedAt: new Date('2026-10-03T11:00:00.000Z') };
        table[index] = merged;
        return { ...merged };
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = table.findIndex((row) => row.id === where.id);
        if (index === -1) throw new Error(`no ${kind} ${where.id}`);
        const [removed] = table.splice(index, 1);
        // `onDelete: SetNull` is the schema's own rule for CareerClaim's six entity FKs, and
        // the DATABASE is what applies it - so the fake applies it too. Without this line the
        // "deleting an entry keeps the statement" assertion would be testing the fixture
        // instead of the behaviour the API depends on.
        const field = `${kind}Id`;
        for (const claim of rows) {
          if (claim[field] === where.id) claim[field] = null;
        }
        return { ...removed };
      }),
      count: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        table.filter((row) => matches(row, where)).length,
      ),
    };
  }

  const entities = {
    experience: entityDelegate('experience'),
    education: entityDelegate('education'),
    project: entityDelegate('project'),
    skill: entityDelegate('skill'),
    certification: entityDelegate('certification'),
    achievement: entityDelegate('achievement'),
  };

  return {
    mockUserId: { value: 'user-1' },
    keyMocks: { leaseNextLlmKey: vi.fn() },
    llmMocks: { parseResumeWithLLM: vi.fn() },
    /**
     * T1021: the Career Interview's provider seam. `runLlmCompletion` is handed the call
     * thunk and the tests answer it, so the interview's REAL prompt loading, REAL schema
     * parse and REAL hard-failure path all run - only the network hop is replaced. The
     * completion's shape is `{choices:[{message:{content}}]}`, which is what
     * `runLlmCompletion` returns to the stage.
     */
    providerMocks: {
      getProviderModel: vi.fn(async () => 'test-model'),
      createLlmClient: vi.fn(() => ({
        chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: '' } }] })) } },
      })),
      runLlmCompletion: vi.fn(
        async (_provider: string, _model: string, call: () => Promise<unknown>) => call(),
      ),
    },
    store: { rows, evidenceRows, verifications, entityTables, entities },
    prismaMocks: {
      careerClaim: claimStore,
      evidenceSource,
      claimVerification,
      careerProfile: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      uploadedFile: { findUnique: vi.fn() },
      ...entities,
      /**
       * The interactive transaction `career/verification.ts` runs each decision in. It
       * hands back the SAME models, so a decision reads and writes the same rows the
       * import did - which is what makes "one transaction: the status change and the
       * audit row commit together" observable in this suite rather than assumed.
       */
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMocks)),
    },
  };
});

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { id: mockUserId.value, email: 'test@example.com', isAdmin: false };
    next();
  },
}));

vi.mock('../lib/prisma.js', () => ({ default: prismaMocks }));

// The key manager is the ONLY thing that decides whether a provider exists. Mocking it
// (rather than a flag) keeps the "no provider" path a real code path through the real
// enricher: `leaseNextLlmKey` throws, the enricher returns `skipped`, and the route
// still answers 201.
vi.mock('../ai/keyManager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/keyManager.js')>()),
  leaseNextLlmKey: keyMocks.leaseNextLlmKey,
}));

// `parseResumeWithLLM` is the only function here that would reach a provider. Everything
// else in the module - including the deterministic `parseUploadedResume` the import
// actually uses - stays the production implementation.
vi.mock('../resume/parser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../resume/parser.js')>()),
  parseResumeWithLLM: llmMocks.parseResumeWithLLM,
}));

// T1021: the Career Interview reaches a provider through `ai/providerModels.ts`. Mocked so
// the no-network property is a fact about this suite rather than a hope: `createLlmClient`
// would build a real SDK client pointed at a real base URL. The interview's DETERMINISTIC
// halves - the questionnaire, the answers validation, the guard - are all still the
// production ones, because none of them is behind this module.
vi.mock('../ai/providerModels.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/providerModels.js')>()),
  getProviderModel: providerMocks.getProviderModel,
  createLlmClient: providerMocks.createLlmClient,
  runLlmCompletion: providerMocks.runLlmCompletion,
}));

import careerRouter, {
  careerClaimCountsFromRows,
  emptyCareerClaimCounts,
  resumeToCandidateClaims,
  setCareerImportEnricher,
  MAX_CAREER_IMPORT_TEXT,
} from './career.js';
import { RESUME_IMPORT_INFERENCE_METHOD, RESUME_IMPORT_AI_INFERENCE_METHOD } from '../career/resumeImport.js';
import type { ResumeExtraction } from '../career/resumeImport.js';
import {
  CAREER_INTERVIEW_INFERENCE_METHOD,
  CAREER_INTERVIEW_TOTAL_STEPS,
  createInterviewSessionId,
  setCareerInterviewExtractor,
} from '../career/interview.js';
import {
  CAREER_ENTITY_KINDS,
  ENTITY_CLAIM_KINDS,
  ENTITY_KIND_CLAIM_FIELD,
  isCompatiblePairing,
  entityKindsForClaimKind,
  normalizeSkillName,
} from '../career/entities.js';
import { loadProjectionInput, projectResumeJson } from '../resume/json/project.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/career', careerRouter);
  return app;
}

const app = makeApp();

/**
 * A realistic TXT resume. The deterministic extractor reads `Summary`, `Experience`,
 * `Education`, `Projects`, `Skills` and `Languages` headers, so the fixture speaks that
 * dialect: it produces a claim of every kind the import is responsible for, INCLUDING
 * the `soft_skill` summary claim ADR-043's R-SUMMARY requires.
 */
const RESUME_TEXT = [
  'Ada Lovelace',
  'ada@example.invalid | London, UK',
  '',
  'Summary',
  'Backend engineer who has spent eight years on payment infrastructure and data pipelines.',
  '',
  'Experience',
  'Senior Engineer at Acme 2021 - Present',
  '- Cut the CI build time by 40% by caching the dependency layer.',
  '- Owned the ledger reconciliation service end to end.',
  '',
  'Experience',
  'Engineer at Globex 2018 - 2021',
  '- Migrated the reporting stack to Postgres.',
  '',
  'Education',
  'BSc Computer Science - University of London',
  '',
  'Projects',
  'LedgerKit',
  '- Wrote a reconciliation library used by three teams.',
  '- Tech: TypeScript, Postgres',
  '',
  'Skills',
  'TypeScript, Postgres, Kubernetes',
  '',
  'Languages',
  'English, Hindi',
].join('\n');

const PROFILE = { id: 'profile-1', userId: 'user-1' };
/** Another tenant's profile. Its rows exist, and none of them may ever be reachable. */
const FOREIGN_PROFILE = { id: 'profile-foreign', userId: 'user-2' };

/** A parsed-resume fixture, as the narrow structural shape the extractor reads. */
function parsedFixture(overrides: Partial<ResumeExtraction> = {}): ResumeExtraction {
  return {
    summary: 'Backend engineer who has spent eight years on payment infrastructure.',
    experience: [
      {
        title: 'Senior Engineer',
        company: 'Acme',
        bullets: ['Cut the CI build time by 40% by caching the dependency layer.'],
      },
    ],
    education: [{ degree: 'BSc Computer Science', institution: 'University of London' }],
    projects: [
      {
        title: 'LedgerKit',
        tech: ['TypeScript'],
        bullets: ['Wrote a reconciliation library used by three teams.'],
      },
    ],
    skills: ['Postgres', 'Kubernetes'],
    languages: ['English'],
    ...overrides,
  };
}

const CONTACT = {
  fullName: 'Ada Lovelace',
  email: 'ada@example.invalid',
  phone: '',
  location: 'London',
};

beforeEach(() => {
  vi.clearAllMocks();
  store.rows.length = 0;
  store.evidenceRows.length = 0;
  store.verifications.length = 0;
  for (const kind of Object.keys(store.entityTables)) {
    store.entityTables[kind].length = 0;
  }
  mockUserId.value = 'user-1';
  setCareerImportEnricher(null);
  setCareerInterviewExtractor(null);

  // One profile, owned by `user-1`. Looked up by id OR by userId, so the ownership
  // checks under test are `ensureOwnership('user-2', 'user-1')` against a REAL row - the
  // fixture is not rigged to refuse, which would make the 403 tests vacuous. A SECOND
  // profile belongs to `user-2`: it exists so the entity scoping tests have a foreign row
  // to be refused, which is what "no existence oracle" has to mean in practice.
  prismaMocks.careerProfile.findUnique.mockImplementation(async ({ where }: any) => {
    if (where?.id === PROFILE.id) return PROFILE;
    if (where?.userId === PROFILE.userId) return PROFILE;
    if (where?.id === FOREIGN_PROFILE.id) return FOREIGN_PROFILE;
    if (where?.userId === FOREIGN_PROFILE.userId) return FOREIGN_PROFILE;
    return null;
  });
  prismaMocks.careerProfile.create.mockResolvedValue(PROFILE);
  prismaMocks.uploadedFile.findUnique.mockResolvedValue(null);

  // Default: NO provider configured. Every test that wants the AI path says so.
  keyMocks.leaseNextLlmKey.mockRejectedValue(new Error('No LLM API keys configured.'));
  llmMocks.parseResumeWithLLM.mockResolvedValue(null);

  // `groupBy` reads the SAME rows `findFirst`/`update` see, so the counter a test
  // asserts is derived from real state rather than a hand-written answer.
  prismaMocks.careerClaim.groupBy.mockImplementation(async ({ where }: any) => {
    const rows = store.rows.filter((row) => row.profileId === where.profileId);
    const byStatus = new Map<string, number>();
    for (const row of rows) byStatus.set(row.status as string, (byStatus.get(row.status as string) ?? 0) + 1);
    return [...byStatus.entries()].map(([status, n]) => ({ status, _count: { _all: n } }));
  });
});

afterEach(() => {
  setCareerImportEnricher(null);
  setCareerInterviewExtractor(null);
});

function txtUpload(text = RESUME_TEXT, filename = 'ada-resume.txt') {
  return request(app)
    .post('/career/import/resume')
    .field('title', 'Ada resume')
    .attach('file', Buffer.from(text, 'utf-8'), { filename, contentType: 'text/plain' });
}

// ---------------------------------------------------------------------------
// resumeToCandidateClaims - the PURE extractor
// ---------------------------------------------------------------------------

describe('resumeToCandidateClaims - the deterministic extractor', () => {
  it('emits one claim per atomic fact, of the documented kinds', () => {
    const claims = resumeToCandidateClaims(parsedFixture());
    // No kind outside the schema's own vocabulary, on any entry.
    const allowed = new Set(Object.values(ClaimKind));
    for (const claim of claims) expect(allowed.has(claim.kind)).toBe(true);
    expect(claims).toEqual([
      { kind: ClaimKind.role, statement: 'Senior Engineer at Acme' },
      { kind: ClaimKind.achievement, statement: 'Cut the CI build time by 40% by caching the dependency layer.' },
      { kind: ClaimKind.education, statement: 'BSc Computer Science at University of London' },
      { kind: ClaimKind.project, statement: 'LedgerKit' },
      { kind: ClaimKind.achievement, statement: 'Wrote a reconciliation library used by three teams.' },
      { kind: ClaimKind.technology, statement: 'TypeScript' },
      { kind: ClaimKind.skill, statement: 'Postgres' },
      { kind: ClaimKind.skill, statement: 'Kubernetes' },
      { kind: ClaimKind.language, statement: 'English' },
      { kind: ClaimKind.soft_skill, statement: 'Backend engineer who has spent eight years on payment infrastructure.' },
    ]);
  });

  it('R-SUMMARY: creates the soft_skill claim for the professional summary (ADR-043)', () => {
    const claims = resumeToCandidateClaims(parsedFixture());
    const summaries = claims.filter((c) => c.kind === ClaimKind.soft_skill);
    expect(summaries).toHaveLength(1);
    // The statement IS the summary, verbatim - the same model the legacy backfill uses
    // (`resume/json/project.ts:709-719`), so the fingerprint it gets is the one a
    // backfilled claim for the same text would get.
    expect(summaries[0].statement).toBe(parsedFixture().summary);
  });

  it('omits the summary claim entirely when there is no summary', () => {
    const claims = resumeToCandidateClaims(parsedFixture({ summary: '   ' }));
    expect(claims.some((c) => c.kind === ClaimKind.soft_skill)).toBe(false);
  });

  it('never emits a contact detail or an employment date as its own claim', () => {
    const statements = resumeToCandidateClaims(parsedFixture()).map((c) => c.statement);
    // A phone number, an email, a location and an employment date are profile columns,
    // not career assertions (05 sec.7.7 says the same of dates); gating them would make
    // the invariant meaningless. Asserted per-statement so an institution whose NAME
    // happens to contain the city is not a false positive.
    expect(statements).not.toContain(CONTACT.email);
    expect(statements).not.toContain(CONTACT.location);
    expect(statements.some((s) => s.trim() === CONTACT.location)).toBe(false);
    expect(statements.some((s) => /^\s*(19|20)\d\d(\s*-\s*(19|20)\d\d|Present)?\s*$/.test(s))).toBe(false);
    // The role claim carries the position and the employer, never the dates.
    expect(statements).toContain('Senior Engineer at Acme');
  });

  it('drops blank entries instead of writing empty statements', () => {
    const claims = resumeToCandidateClaims(
      parsedFixture({
        experience: [
          { title: '  ', company: ' ', bullets: ['', '   '] },
        ],
        skills: ['', '  '],
        languages: [],
        projects: [],
        education: [],
      }),
    );
    expect(claims).toEqual([{ kind: ClaimKind.soft_skill, statement: 'Backend engineer who has spent eight years on payment infrastructure.' }]);
  });
});

// ---------------------------------------------------------------------------
// The unconfirmed counter
// ---------------------------------------------------------------------------

describe('careerClaimCountsFromRows - the unconfirmed counter', () => {
  it('counts inferred + contextual as unconfirmed and excludes rejected/superseded', () => {
    const counts = careerClaimCountsFromRows([
      { status: ClaimStatus.inferred, _count: { _all: 3 } },
      { status: ClaimStatus.contextual, _count: { _all: 2 } },
      { status: ClaimStatus.user_confirmed, _count: { _all: 12 } },
      { status: ClaimStatus.rejected, _count: { _all: 4 } },
      { status: ClaimStatus.superseded, _count: { _all: 1 } },
    ]);
    expect(counts).toEqual({
      inferred: 3,
      contextual: 2,
      user_confirmed: 12,
      rejected: 4,
      superseded: 1,
      total: 22,
      unconfirmed: 5,
    });
  });

  it('is zero for no rows, and reports every status key (never undefined)', () => {
    expect(careerClaimCountsFromRows([])).toEqual(emptyCareerClaimCounts());
    expect(emptyCareerClaimCounts().user_confirmed).toBe(0);
    expect(emptyCareerClaimCounts().unconfirmed).toBe(0);
  });

  it('accepts a plain { count } row as well as a Prisma _count row', () => {
    expect(careerClaimCountsFromRows([{ status: ClaimStatus.inferred, count: 7 }]).unconfirmed).toBe(7);
  });

  it('does NOT equal total - confirmed, and says why in the difference', () => {
    // The two answers are equal only when nothing has been rejected or superseded.
    // A counter defined as "total minus confirmed" would report 9 here - five claims
    // still to decide, inflated by four the user already rejected, so acting on the
    // number would send them to work they had already finished.
    const rows = [
      { status: ClaimStatus.inferred, _count: { _all: 3 } },
      { status: ClaimStatus.contextual, _count: { _all: 2 } },
      { status: ClaimStatus.user_confirmed, _count: { _all: 12 } },
      { status: ClaimStatus.rejected, _count: { _all: 4 } },
    ];
    const counts = careerClaimCountsFromRows(rows);
    expect(counts.unconfirmed).toBe(5);
    expect(counts.total - counts.user_confirmed).toBe(9);
    expect(counts.unconfirmed).not.toBe(counts.total - counts.user_confirmed);
  });
});

// ---------------------------------------------------------------------------
// POST /career/import/resume
// ---------------------------------------------------------------------------

describe('POST /career/import/resume - no AI provider configured (ADR-041 D5)', () => {
  it('imports and answers 201 with claims, an evidence source and a skip reason', async () => {
    const res = await txtUpload();

    expect(res.status).toBe(201);
    expect(res.body.evidenceSourceId).toBe('evd-1');
    expect(res.body.evidenceSource).toBe('created');
    expect(res.body.claims.extracted).toBeGreaterThan(0);
    expect(res.body.claims.created).toBe(res.body.claims.extracted);
    // THE D5 ASSERTION: the import is COMPLETE without a provider, and says so in a
    // machine-readable way rather than failing or silently pretending it ran.
    expect(res.body.enrichment).toMatchObject({
      status: 'skipped',
      reason: 'no_ai_provider_configured',
      created: 0,
    });
    expect(res.body.counts.unconfirmed).toBe(res.body.claims.created);
    expect(res.body.counts.user_confirmed).toBe(0);
  });

  it('writes EVERY claim as inferred + document_import', async () => {
    await txtUpload();

    const creates = prismaMocks.careerClaim.create.mock.calls;
    expect(creates.length).toBeGreaterThan(0);
    for (const [arg] of creates) {
      expect(arg.data.status).toBe(ClaimStatus.inferred);
      expect(arg.data.provenance).toBe(ClaimProvenance.document_import);
      expect(arg.data.evidenceSourceId).toBe('evd-1');
      expect(arg.data.inferenceMethod).toBe(RESUME_IMPORT_INFERENCE_METHOD);
    }
  });

  it('NO AUTO-CONFIRM: the import writes ZERO ClaimVerification rows', async () => {
    await txtUpload();

    // Not "the rows are inferred" - the rows are inferred AND there is no audit row,
    // because there was no decision to audit. A confirmation the user never made would
    // need one, and there is none.
    expect(prismaMocks.claimVerification.create).not.toHaveBeenCalled();
    expect(store.verifications).toHaveLength(0);
    expect(store.rows.every((row) => row.status === ClaimStatus.inferred)).toBe(true);
    expect(store.rows.some((row) => row.status === ClaimStatus.user_confirmed)).toBe(false);
  });

  it('R-SUMMARY: persists the soft_skill summary claim against the evidence source', async () => {
    await txtUpload();

    const summary = store.rows.filter((row) => row.kind === ClaimKind.soft_skill);
    expect(summary).toHaveLength(1);
    expect(String(summary[0].statement)).toContain('Backend engineer who has spent eight years');
    expect(summary[0].status).toBe(ClaimStatus.inferred);
    expect(summary[0].provenance).toBe(ClaimProvenance.document_import);
    expect(summary[0].evidenceSourceId).toBe('evd-1');
  });

  it('registers the evidence source from the file text, storing no bytes (ADR-041 D2)', async () => {
    await txtUpload();

    const [call] = prismaMocks.evidenceSource.create.mock.calls;
    expect(call[0].data.kind).toBe(EvidenceKind.document);
    expect(call[0].data.title).toBe('Ada resume');
    expect(call[0].data.mimeType).toBe('text/plain');
    expect(call[0].data.byteSize).toBe(Buffer.byteLength(RESUME_TEXT, 'utf-8'));
    // No binary anywhere in the write: the row is metadata + a hash + capped text.
    expect(Object.keys(call[0].data)).not.toContain('fileBytes');
    expect(call[0].data.extractedText).toBe(RESUME_TEXT.slice(0, MAX_CAREER_IMPORT_TEXT));
    expect(call[0].data.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-importing the same document dedupes: no new source, no new claims', async () => {
    await txtUpload();
    const createdAfterFirst = store.rows.length;

    const second = await txtUpload();

    expect(second.status).toBe(201);
    expect(second.body.evidenceSource).toBe('deduped');
    expect(second.body.claims.created).toBe(0);
    expect(second.body.claims.deduped).toBe(createdAfterFirst);
    // ADR-036 item 4: re-observation is a no-op. The second run did not touch a row,
    // so it could not have upgraded one.
    expect(store.rows).toHaveLength(createdAfterFirst);
    expect(prismaMocks.evidenceSource.create).toHaveBeenCalledTimes(1);
  });

  it('imports a stored uploadedFileId through the same deterministic extractor', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue({
      id: 'uf-1',
      userId: 'user-1',
      fileName: 'stored.txt',
      fileType: 'text/plain',
      extractedText: RESUME_TEXT,
    });

    const res = await request(app).post('/career/import/resume').field('uploadedFileId', 'uf-1');

    expect(res.status).toBe(201);
    expect(res.body.claims.created).toBeGreaterThan(0);
    const [call] = prismaMocks.evidenceSource.create.mock.calls;
    expect(call[0].data.uploadedFileId).toBe('uf-1');
    expect(call[0].data.title).toBe('stored.txt');
  });

  it('refuses an uploadedFileId with no extractable text BEFORE writing anything', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue({
      id: 'uf-2',
      userId: 'user-1',
      fileName: 'scan.pdf',
      fileType: 'application/pdf',
      extractedText: '   ',
    });

    const res = await request(app).post('/career/import/resume').field('uploadedFileId', 'uf-2');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No text');
    expect(prismaMocks.evidenceSource.create).not.toHaveBeenCalled();
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
  });

  it('refuses a disallowed file type and writes nothing', async () => {
    const res = await request(app)
      .post('/career/import/resume')
      .attach('file', Buffer.from('#!/bin/sh\nrm -rf /'), {
        filename: 'evil.sh',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(400);
    expect(prismaMocks.evidenceSource.create).not.toHaveBeenCalled();
  });

  it('refuses a request naming neither a file nor an uploadedFileId', async () => {
    const res = await request(app).post('/career/import/resume');
    expect(res.status).toBe(400);
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
  });

  // F5: the name said "and writes nothing" and the body never proved it. The two
  // `not.toHaveBeenCalled()` assertions now live in the sibling uploadedFileId test below,
  // where they were always meant to be; this test keeps what it actually asserts - the
  // status code and the refusal - and says so.
  it('403s another tenant\'s profileId', async () => {
    const res = await request(app)
      .post('/career/import/resume')
      .field('profileId', 'profile-1')
      .attach('file', Buffer.from(RESUME_TEXT, 'utf-8'), {
        filename: 'a.txt',
        contentType: 'text/plain',
      });
    // The shared fixture profile belongs to user-1; asking as user-2 is the cross-tenant case.
    mockUserId.value = 'user-2';
    const crossed = await request(app)
      .post('/career/import/resume')
      .field('profileId', 'profile-1')
      .attach('file', Buffer.from(RESUME_TEXT, 'utf-8'), {
        filename: 'a.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(201);
    expect(crossed.status).toBe(403);
    expect(crossed.body.error).toBe('Access denied');
  });

  it('403s another tenant\'s uploadedFileId and never reads their text', async () => {
    prismaMocks.uploadedFile.findUnique.mockResolvedValue({
      id: 'uf-foreign',
      userId: 'user-2',
      fileName: 'theirs.txt',
      fileType: 'text/plain',
      extractedText: 'Someone elses confidential resume text.',
    });
    mockUserId.value = 'user-1';

    const res = await request(app).post('/career/import/resume').field('uploadedFileId', 'uf-foreign');

    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('confidential');
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
  });
});

describe('POST /career/import/resume - with an AI provider configured', () => {
  beforeEach(() => {
    keyMocks.leaseNextLlmKey.mockResolvedValue({ id: 'k1', provider: 'groq', apiKey: 'x', source: 'env', userId: null });
    llmMocks.parseResumeWithLLM.mockResolvedValue({
      experience: [
        { title: 'Staff Engineer', company: 'Initech', bullets: ['Rebuilt the ingestion pipeline.'] },
      ],
      skills: ['Rust'],
      projects: [],
      education: [],
      languages: [],
      summary: '',
    });
  });

  it('applies the enrichment through claimWriterAI and reports it', async () => {
    const res = await txtUpload();

    expect(res.status).toBe(201);
    expect(res.body.enrichment).toMatchObject({
      status: 'applied',
      reason: 'ok',
      provider: 'groq',
    });
    expect(res.body.enrichment.created).toBeGreaterThan(0);
  });

  it('writes the AI-produced claims as inferred + llm_inferred, NEVER document_import', async () => {
    await txtUpload();

    const creates = prismaMocks.careerClaim.create.mock.calls.map(([arg]) => arg.data);
    const aiClaims = creates.filter((data) => data.inferenceMethod === RESUME_IMPORT_AI_INFERENCE_METHOD);
    expect(aiClaims.length).toBeGreaterThan(0);
    for (const data of aiClaims) {
      // ADR-036 item 2 in full: the ONE AI writer hard-codes inferred + llm_inferred.
      // A model-written sentence labelled `document_import` would read to the user as
      // "this was in your document", which is a fabrication surface of its own.
      expect(data.status).toBe(ClaimStatus.inferred);
      expect(data.provenance).toBe(ClaimProvenance.llm_inferred);
      expect(data.producedByModel).toBe('groq');
    }
    // And the deterministic claims keep their own provenance, so the two are
    // distinguishable afterwards.
    for (const data of creates.filter((d) => d.inferenceMethod === RESUME_IMPORT_INFERENCE_METHOD)) {
      expect(data.provenance).toBe(ClaimProvenance.document_import);
    }
  });

  it('the AI path STILL writes no ClaimVerification row', async () => {
    await txtUpload();
    expect(prismaMocks.claimVerification.create).not.toHaveBeenCalled();
    expect(store.rows.some((row) => row.status === ClaimStatus.user_confirmed)).toBe(false);
  });

  it('a provider that returns nothing usable degrades to skipped, and keeps the import', async () => {
    llmMocks.parseResumeWithLLM.mockResolvedValue(null);

    const res = await txtUpload();

    expect(res.status).toBe(201);
    expect(res.body.enrichment).toMatchObject({ status: 'skipped', reason: 'provider_unavailable' });
    expect(res.body.claims.created).toBeGreaterThan(0);
  });

  it('a provider that THROWS degrades to skipped, and keeps the import', async () => {
    setCareerImportEnricher(async () => {
      throw new Error('provider exploded');
    });

    const res = await txtUpload();

    expect(res.status).toBe(201);
    expect(res.body.enrichment.status).toBe('skipped');
    expect(res.body.enrichment.reason).toContain('enrichment_failed');
    expect(res.body.claims.created).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// GET /career/profile, /career/sources, /career/claims
// ---------------------------------------------------------------------------

describe('GET /career/profile', () => {
  it('answers 200 with a zeroed counter and a null profile when there is none', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/career/profile');

    expect(res.status).toBe(200);
    // An EMPTY STATE is an answer, not an error (06 E.11: "Nothing confirmed yet - a
    // resume built now would be empty"). The client renders this without catching.
    expect(res.body.profile).toBeNull();
    expect(res.body.counts).toEqual(emptyCareerClaimCounts());
    expect(res.body.unconfirmed).toBe(0);
  });

  it('reports the profile plus the accurate counter after an import', async () => {
    await txtUpload();

    const res = await request(app).get('/career/profile');

    expect(res.status).toBe(200);
    expect(res.body.profile.id).toBe('profile-1');
    expect(res.body.counts.inferred).toBe(store.rows.length);
    expect(res.body.counts.user_confirmed).toBe(0);
    expect(res.body.unconfirmed).toBe(store.rows.length);
  });
});

describe('GET /career/sources', () => {
  it('answers an empty list, not a 404, when there is no profile', async () => {
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/career/sources');

    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([]);
  });

  it('lists the registered evidence sources with no stored bytes', async () => {
    await txtUpload();

    const res = await request(app).get('/career/sources');

    expect(res.status).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({ id: 'evd-1', kind: EvidenceKind.document, title: 'Ada resume' });
    expect(Object.keys(res.body.sources[0])).not.toContain('extractedText');
  });
});

describe('GET /career/claims', () => {
  it('lists claims with provenance, and reports the UNFILTERED counts', async () => {
    await txtUpload();
    const created = store.rows.length;

    const res = await request(app).get('/career/claims');

    expect(res.status).toBe(200);
    expect(res.body.claims).toHaveLength(created);
    expect(res.body.claims[0]).toMatchObject({
      status: ClaimStatus.inferred,
      provenance: ClaimProvenance.document_import,
      evidenceSourceId: 'evd-1',
    });
    expect(res.body.unconfirmed).toBe(created);
  });

  it('filters by status and by kind', async () => {
    await txtUpload();

    const byKind = await request(app).get('/career/claims').query({ kind: ClaimKind.soft_skill });
    expect(byKind.status).toBe(200);
    expect(byKind.body.claims).toHaveLength(1);
    expect(byKind.body.claims[0].kind).toBe(ClaimKind.soft_skill);

    // The counts stay whole-profile even when the list is filtered: a counter that
    // changes when the user changes a filter is not a counter.
    expect(byKind.body.counts.inferred).toBe(store.rows.length);

    const byStatus = await request(app).get('/career/claims').query({ status: ClaimStatus.user_confirmed });
    expect(byStatus.body.claims).toEqual([]);
    expect(byStatus.body.unconfirmed).toBe(store.rows.length);
  });

  it('400s an unknown status rather than silently listing everything', async () => {
    const res = await request(app).get('/career/claims').query({ status: 'nonsense' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /career/claims - create and edit
// ---------------------------------------------------------------------------

describe('POST /career/claims', () => {
  it('creates a hand-entered claim UNCONFIRMED (typing is not confirming)', async () => {
    const res = await request(app).post('/career/claims').send({
      kind: ClaimKind.skill,
      statement: 'Rust',
    });

    expect(res.status).toBe(201);
    expect(res.body.claim).toMatchObject({
      status: ClaimStatus.inferred,
      provenance: ClaimProvenance.user_entered,
    });
    expect(res.body.verification).toBeNull();
    expect(store.verifications).toHaveLength(0);
  });

  it('creates AND confirms when the user says confirm:true - with an audit row', async () => {
    const res = await request(app).post('/career/claims').send({
      kind: ClaimKind.skill,
      statement: 'Rust',
      confirm: true,
      note: 'I have used this for three years',
    });

    expect(res.status).toBe(201);
    expect(res.body.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(store.verifications).toHaveLength(1);
    expect(store.verifications[0]).toMatchObject({
      action: 'confirm',
      actorUserId: 'user-1',
      claimId: res.body.claim.id,
    });
  });

  it('edits a claim WITHOUT confirming it (action=edit, status unchanged)', async () => {
    const created = await request(app).post('/career/claims').send({ kind: ClaimKind.achievement, statement: 'Cut CI time by 40%' });
    const id = created.body.claim.id;

    const res = await request(app).post('/career/claims').send({ id, statement: 'Cut CI time by 55%' });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('edit');
    expect(res.body.claim.status).toBe(ClaimStatus.inferred);
    expect(res.body.claim.statement).toBe('Cut CI time by 55%');
    expect(store.verifications[0]).toMatchObject({ action: 'edit', actorUserId: 'user-1' });
  });

  it('edits AND confirms in one gesture (edit_confirm), and the audit row matches the text', async () => {
    const created = await request(app).post('/career/claims').send({ kind: ClaimKind.achievement, statement: 'Cut CI time by 40%' });
    const id = created.body.claim.id;

    const res = await request(app).post('/career/claims').send({ id, statement: 'Cut CI time by 55%', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('edit_confirm');
    expect(res.body.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(res.body.claim.statement).toBe('Cut CI time by 55%');
    // The audit snapshot's `after` describes the text the user approved - the whole
    // point of `edit_confirm` over an edit followed by a confirm.
    const after = store.verifications[0].after as { statement: string; status: string };
    expect(after.statement).toBe('Cut CI time by 55%');
    expect(after.status).toBe(ClaimStatus.user_confirmed);
  });

  it('400s a create with no kind', async () => {
    const res = await request(app).post('/career/claims').send({ statement: 'Something' });
    expect(res.status).toBe(400);
  });

  it('403s an edit of another tenant\'s claim and writes nothing', async () => {
    await txtUpload();
    const foreign = store.rows[0].id;
    mockUserId.value = 'user-2';

    const res = await request(app).post('/career/claims').send({ id: foreign, statement: 'Rewritten by a stranger' });

    expect(res.status).toBe(403);
    expect(store.rows[0].statement).not.toBe('Rewritten by a stranger');
    expect(store.verifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The three decisions: confirm / reject / reopen
// ---------------------------------------------------------------------------

describe('POST /career/claims/:id/confirm', () => {
  it('changes the status AND writes exactly one ClaimVerification row', async () => {
    await txtUpload();
    const id = store.rows[0].id;

    const res = await request(app).post(`/career/claims/${id}/confirm`).send({ note: 'That is mine' });

    expect(res.status).toBe(200);
    expect(res.body.claim.status).toBe(ClaimStatus.user_confirmed);
    expect(res.body.changed).toBe(true);
    expect(res.body.action).toBe('confirm');
    // The audit row is asserted in full, because "a status changed" and "the row was
    // written" are the same event only if the route really went through the service.
    expect(store.verifications).toHaveLength(1);
    expect(store.verifications[0]).toMatchObject({
      action: 'confirm',
      targetType: 'career_claim',
      targetId: id,
      claimId: id,
      actorUserId: 'user-1',
      userId: 'user-1',
      note: 'That is mine',
    });
    const before = store.verifications[0].before as { status: string };
    expect(before.status).toBe(ClaimStatus.inferred);
  });

  it('is idempotent: a second confirm writes NO second audit row', async () => {
    await txtUpload();
    const id = store.rows[0].id;

    await request(app).post(`/career/claims/${id}/confirm`).send({});
    const res = await request(app).post(`/career/claims/${id}/confirm`).send({});

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.verification).toBeNull();
    expect(store.verifications).toHaveLength(1);
  });

  it('a `statement` in the body makes it an edit_confirm', async () => {
    await txtUpload();
    const id = store.rows[0].id;

    const res = await request(app).post(`/career/claims/${id}/confirm`).send({ statement: 'The corrected wording' });

    expect(res.status).toBe(200);
    expect(res.body.action).toBe('edit_confirm');
    expect(res.body.claim.statement).toBe('The corrected wording');
    expect(store.verifications[0]).toMatchObject({ action: 'edit_confirm', actorUserId: 'user-1' });
  });

  it('409s confirming a REJECTED claim (a rejection is never laundered)', async () => {
    await txtUpload();
    const id = store.rows[0].id;
    await request(app).post(`/career/claims/${id}/reject`).send({ reason: 'Not mine' });

    const res = await request(app).post(`/career/claims/${id}/confirm`).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('illegal_transition');
    expect(String(store.rows.find((r) => r.id === id)?.status)).toBe(ClaimStatus.rejected);
  });

  it('404s a claim that does not exist', async () => {
    const res = await request(app).post('/career/claims/clm-missing/confirm').send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('claim_not_found');
  });

  it('403s another tenant\'s claim, and writes no audit row', async () => {
    await txtUpload();
    const id = store.rows[0].id;
    mockUserId.value = 'user-2';

    const res = await request(app).post(`/career/claims/${id}/confirm`).send({});

    expect(res.status).toBe(403);
    expect(store.verifications).toHaveLength(0);
    expect(store.rows[0].status).toBe(ClaimStatus.inferred);
  });
});

describe('POST /career/claims/:id/reject', () => {
  it('changes the status AND writes the audit row, with the reason', async () => {
    await txtUpload();
    const id = store.rows[0].id;

    const res = await request(app).post(`/career/claims/${id}/reject`).send({ reason: 'A different project' });

    expect(res.status).toBe(200);
    expect(res.body.claim.status).toBe(ClaimStatus.rejected);
    expect(res.body.claim.rejectedReason).toBe('A different project');
    expect(store.verifications).toHaveLength(1);
    expect(store.verifications[0]).toMatchObject({ action: 'reject', actorUserId: 'user-1', claimId: id });
  });

  it('removes the claim from the unconfirmed counter but keeps it in `rejected`', async () => {
    await txtUpload();
    const before = store.rows.length;
    const id = store.rows[0].id;

    await request(app).post(`/career/claims/${id}/reject`).send({ reason: 'No' });
    const profile = await request(app).get('/career/profile');

    // THE COUNTER ASSERTION, over HTTP: one fewer thing to confirm, and NOT one fewer
    // total - so the number moved because a decision was made, not because a row
    // vanished.
    expect(profile.body.counts.rejected).toBe(1);
    expect(profile.body.counts.inferred).toBe(before - 1);
    expect(profile.body.counts.total).toBe(before);
    expect(profile.body.unconfirmed).toBe(before - 1);
  });

  it('403s another tenant\'s claim', async () => {
    await txtUpload();
    const id = store.rows[0].id;
    mockUserId.value = 'user-2';

    const res = await request(app).post(`/career/claims/${id}/reject`).send({});

    expect(res.status).toBe(403);
    expect(store.verifications).toHaveLength(0);
  });
});

describe('POST /career/claims/:id/reopen', () => {
  it('returns a rejected claim to INFERRED - not to confirmed - with an audit row', async () => {
    await txtUpload();
    const id = store.rows[0].id;
    await request(app).post(`/career/claims/${id}/reject`).send({ reason: 'typo in my entry' });

    const res = await request(app).post(`/career/claims/${id}/reopen`).send({});

    expect(res.status).toBe(200);
    // A reopen CLEARS the rejection. It does not confirm: confirming is a second,
    // separate decision, and a reopen that confirmed would be the auto-confirm path ADR-036
    // exists to prevent wearing a different hat.
    expect(res.body.claim.status).toBe(ClaimStatus.inferred);
    expect(res.body.claim.rejectedReason).toBeNull();
    expect(res.body.action).toBe('reopen');
    expect(store.verifications.map((row) => row.action)).toEqual(['reject', 'reopen']);
    expect(store.verifications[1]).toMatchObject({ actorUserId: 'user-1', claimId: id });
  });

  it('puts the claim back in the unconfirmed counter', async () => {
    await txtUpload();
    const total = store.rows.length;
    const id = store.rows[0].id;
    await request(app).post(`/career/claims/${id}/reject`).send({});

    await request(app).post(`/career/claims/${id}/reopen`).send({});
    const profile = await request(app).get('/career/profile');

    expect(profile.body.unconfirmed).toBe(total);
    expect(profile.body.counts.rejected).toBe(0);
  });

  it('409s reopening a claim that was never rejected', async () => {
    await txtUpload();
    const id = store.rows[0].id;

    const res = await request(app).post(`/career/claims/${id}/reopen`).send({});

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('illegal_transition');
  });

  it('403s another tenant\'s claim', async () => {
    await txtUpload();
    const id = store.rows[0].id;
    mockUserId.value = 'user-2';

    const res = await request(app).post(`/career/claims/${id}/reopen`).send({});

    expect(res.status).toBe(403);
    expect(store.verifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Source guards - the invariants the file must hold as TEXT, not as behaviour
// ---------------------------------------------------------------------------

describe('routes/career.ts - source guards', () => {
  // `__dirname` is available both when compiled to CJS and under tsx/vitest - the same
  // reason `jobSources/sourceContract.test.ts` uses it.
  const SOURCE = readFileSync(path.join(__dirname, 'career.ts'), 'utf8');
  // Strip comments before the guards run, so prose ABOUT the invariant (which necessarily
  // spells the status names) cannot satisfy or break them.
  const CODE = SOURCE.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('NO AUTO-CONFIRM PATH: the confirming status is never ASSIGNED in code', () => {
    // Behavioural tests can only prove that the paths they exercised did not confirm
    // anything. This proves that a path nobody exercised cannot either: there is no
    // `status: <confirming status>` anywhere in the router's executable text.
    //
    // The router names NO claim status at all - the tally lives in `career/claimCounts.ts`
    // and the decisions in `career/userDecisions.ts` (T1020 fix round 2, F4: the earlier
    // version of this comment excused two reads that a refactor had since moved out, and
    // a guard that has to be excused is a guard nobody reads). What is left to forbid is
    // therefore the simple, absolute form: no `status:` whose value is a confirming
    // status, however it is spelled.
    const CONFIRMING = '(user_confirmed|rejected|superseded)';
    expect(CODE).not.toMatch(new RegExp(`status\\s*:\\s*ClaimStatus\\.${CONFIRMING}`));
    expect(CODE).not.toMatch(new RegExp(`status\\s*:\\s*['"\`]${CONFIRMING}['"\`]`));
    expect(CODE).not.toMatch(new RegExp(`\\b${CONFIRMING}\\s*:\\s*ClaimStatus\\.`));
    // And it does not spell a status enum member at all, which is what makes the three
    // patterns above exhaustive rather than a sample.
    expect(CODE).not.toContain('ClaimStatus.');
    expect(CODE).not.toContain('ClaimProvenance.');
    // And the decision routes are the only writers: no bare prisma update of a claim.
    expect(CODE).not.toMatch(/careerClaim\.(update|updateMany|upsert)/);
  });

  it('never writes CareerClaim.status directly outside the verification service', () => {
    // The three decisions must delegate. A `careerClaim.update` in this file would be a
    // status write with no audit row in the same transaction.
    expect(CODE).not.toMatch(/careerClaim\.update\b/);
  });

  it('routes every decision through the career layer, never the writers directly', () => {
    // The route calls the five user-decision functions and nothing lower. `verification.js`
    // and `claimWriterAI.js` are FORBIDDEN imports for a route (asserted by
    // `career/claimWriterAI.test.ts` and re-asserted below): a route holding either could
    // confirm a claim or write one straight out of an HTTP body, which is the failure
    // ADR-036 item 2 is about.
    expect(CODE).toContain('confirmUserClaim(');
    expect(CODE).toContain('rejectUserClaim(');
    expect(CODE).toContain('reopenUserClaim(');
    expect(CODE).not.toMatch(/from '\.\.\/career\/(verification|claimWriterAI)\.js'/);
  });

  it("writes AI output only through the career layer's single AI bridge", () => {
    // `writeEnrichedResumeClaims` is the only path from a model's parse to a claim row,
    // and it is the CAREER LAYER that calls `writeInferredClaims` - so
    // `provenance = llm_inferred` is hard-coded where ADR-036 item 2 says it belongs. A
    // route that called the AI writer itself, or hand-wrote the provenance, would be a
    // second writer.
    expect(CODE).toContain('writeEnrichedResumeClaims(');
    expect(CODE).not.toContain('ClaimProvenance.llm_inferred');
    expect(CODE).not.toMatch(/from '\.\.\/career\/claimWriterAI\.js'/);
  });

  it('T1021: the interview routes go through career/interview.js and name no status', () => {
    // The interview is a second writer of claims, so the SAME two guards apply to it: the
    // route reaches the AI writer only through the career layer (`recordInterviewClaims`,
    // which is where `status = inferred` and `provenance = llm_inferred` are hard-coded),
    // and it spells neither itself. The two echoed constants are IMPORTED NAMES, which is
    // why the guard can still say the router contains no `ClaimStatus.` at all.
    expect(CODE).toContain("from '../career/interview.js'");
    expect(CODE).toContain('recordInterviewClaims(');
    expect(CODE).toContain('leaseInterviewProvider(');
    expect(CODE).not.toContain('ClaimStatus.');
    expect(CODE).not.toContain('ClaimProvenance.');
    // And the interview is not a resume generator in disguise: the router names no `Resume`
    // model on this path, and neither does the service it delegates to (asserted in
    // `career/interview.test.ts`).
    expect(CODE).not.toMatch(/prisma\.resume\./);
  });
});

// ---------------------------------------------------------------------------
// T1021 - the Career Interview, over real HTTP
// ---------------------------------------------------------------------------
//
// WHAT IS PROVEN HERE THAT `career/interview.test.ts` CANNOT SEE: the STATUS CODES and the
// wire shapes. The service suite pins the rules; this one pins the four answers a client
// has to be able to tell apart - no provider (503), schema-invalid (502), bad submission
// (400) and applied (201) - plus the two properties that are only observable over HTTP:
// every claim that lands is `inferred` + `llm_inferred`, and NOT ONE `ClaimVerification`
// row is written by either route.
//
// THE PROVIDER IS REACHED THROUGH THE REAL PROMPT PATH. The default extractor is left in
// place and `runLlmCompletion` is what answers it, so `promptLoader` really loads
// `career_interview_v1` + `claim_extract_v1` and `CLAIM_EXTRACT_SCHEMA` really parses (or
// really refuses). That is why a schema-invalid response is a 502 here rather than a
// property of a stub.

const INTERVIEW_ANSWERS = [
  { stepId: 'roles', fieldId: 'roles', value: 'Senior Engineer at Acme from 2021, Engineer at Globex from 2018' },
  { stepId: 'tools', fieldId: 'technologies', value: 'TypeScript, Postgres, Kubernetes' },
  { stepId: 'work', fieldId: 'achievements', value: 'Cut the CI build time by 40% by caching the dependency layer' },
  { stepId: 'working', fieldId: 'working_style', value: 'I prefer small PRs and I wrote the runbooks' },
];

function answerBody(extra: Record<string, string> = {}) {
  const merged: Record<string, string> = {};
  for (const answer of INTERVIEW_ANSWERS) merged[`${answer.stepId}.${answer.fieldId}`] = answer.value;
  return {
    answers: Object.entries({ ...merged, ...extra }).map(([key, value]) => {
      const [stepId, fieldId] = key.split('.');
      return { stepId, fieldId, value };
    }),
  };
}

const startInterview = () => request(app).post('/career/interview/start').send({});
const submitAnswers = (body: object, sessionId = createInterviewSessionId()) =>
  request(app).post(`/career/interview/${sessionId}/answers`).send(body);

/** A provider that leases, resolves a model, and answers with this completion content. */
function withProviderAnswer(content: string): void {
  keyMocks.leaseNextLlmKey.mockResolvedValue({
    id: 'k1',
    provider: 'groq',
    apiKey: 'x',
    source: 'env',
    userId: null,
  });
  providerMocks.createLlmClient.mockReturnValue({
    chat: {
      completions: {
        create: vi.fn(async () => ({ choices: [{ message: { content } }] })),
      },
    },
  });
}

const VALID_MODEL_RESPONSE = JSON.stringify({
  schemaVersion: 'claim_extract_v1',
  claims: [
    { kind: 'role', statement: 'Senior Engineer at Acme', confidence: 0.9 },
    { kind: 'achievement', statement: 'Cut the CI build time by 40% by caching the dependency layer', confidence: 0.8 },
  ],
});

describe('POST /career/interview/start - the honest refusal comes FIRST', () => {
  it('503s with interview_provider_required and a pointer to the manual path, writing NOTHING', async () => {
    const res = await startInterview();

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('interview_provider_required');
    expect(res.body.error).toMatch(/needs an AI provider/);
    // The pointer is a design decision about THIS code and nothing else, so it is on the
    // wire rather than buried in prose.
    expect(res.body.manualPath).toBe('/career/claims');
    // NOTHING was written: not a profile, not a claim, not a source.
    expect(prismaMocks.careerProfile.create).not.toHaveBeenCalled();
    expect(prismaMocks.careerClaim.create).not.toHaveBeenCalled();
    expect(prismaMocks.evidenceSource.create).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });

  it('does not fall back to a template questionnaire: no questions, no session, no claims', async () => {
    const res = await startInterview();
    // The tell-tale of the fabricating wizard is a questionnaire that APPEARS to work.
    // Here there is no `steps` member at all, so a client cannot render a fake interview
    // and a user is never asked to type into one.
    expect(res.body.steps).toBeUndefined();
    expect(res.body.sessionId).toBeUndefined();
    expect(res.body.totalSteps).toBeUndefined();
  });

  it('201s with the questionnaire, the provider, and the status the rows will carry', async () => {
    withProviderAnswer(VALID_MODEL_RESPONSE);
    const res = await startInterview();

    expect(res.status).toBe(201);
    expect(res.body.provider).toBe('groq');
    expect(res.body.model).toBe('test-model');
    expect(res.body.profileId).toBe(PROFILE.id);
    expect(res.body.sessionId).toMatch(/^iv1\.[0-9a-f]{32}$/);
    expect(res.body.totalSteps).toBe(CAREER_INTERVIEW_TOTAL_STEPS);
    expect(res.body.steps).toHaveLength(CAREER_INTERVIEW_TOTAL_STEPS);
    // Every step is answerable: an id, a title, and at least one field with a label.
    for (const step of res.body.steps) {
      expect(step.id).toBeTruthy();
      expect(step.title).toBeTruthy();
      expect(step.fields.length).toBeGreaterThan(0);
    }
    // The status/provenance the rows WILL carry, echoed from the career layer.
    expect(res.body.statusAssigned).toBe(ClaimStatus.inferred);
    expect(res.body.provenanceAssigned).toBe(ClaimProvenance.llm_inferred);
    expect(res.body.inferenceMethod).toBe(CAREER_INTERVIEW_INFERENCE_METHOD);
    // Stated plainly rather than implied: this stage needs a provider, and a start is not
    // a confirmation.
    expect(res.body.requiresProvider).toBe(true);
  });

  it('BOTH routes go through requireAuth, and the router names no other guard', () => {
    // `requireAuth` is the only middleware either interview route carries. That matters
    // because the answers route resolves a profile from the session: a route without it
    // would have no user to resolve one for.
    const source = readFileSync(path.join(__dirname, 'career.ts'), 'utf8');
    const declared = source.match(/router\.post\('\/interview[^']*',\s*([^,]+),/g) ?? [];
    expect(declared).toHaveLength(2);
    for (const declaration of declared) {
      expect(declaration).toContain('requireAuth');
    }
  });
});

describe('POST /career/interview/:sessionId/answers - candidate claims, never a resume', () => {
  it('201s, writes inferred + llm_inferred claims, and writes NO audit row', async () => {
    withProviderAnswer(VALID_MODEL_RESPONSE);
    const res = await submitAnswers(answerBody());

    expect(res.status).toBe(201);
    expect(res.body.claims).toMatchObject({ extracted: 2, accepted: 2, created: 2, deduped: 0 });
    expect(res.body.statusAssigned).toBe(ClaimStatus.inferred);
    expect(res.body.provenanceAssigned).toBe(ClaimProvenance.llm_inferred);
    expect(res.body.nextPath).toBe('/app/career');

    // Every row the interview created, inspected on its OWN data - not on the source.
    const created = prismaMocks.careerClaim.create.mock.calls.map(([arg]) => arg.data);
    expect(created).toHaveLength(2);
    for (const data of created) {
      expect(data.status).toBe(ClaimStatus.inferred);
      expect(data.provenance).toBe(ClaimProvenance.llm_inferred);
      expect(data.inferenceMethod).toBe(CAREER_INTERVIEW_INFERENCE_METHOD);
      expect(data.producedByModel).toBe('groq');
      // No confirming columns at all: `claims.ts#claimCreateData` never renders them, so a
      // model-produced claim cannot arrive pre-confirmed even if a payload asked.
      expect(Object.keys(data)).not.toContain('confirmedAt');
      expect(data.supersedesClaimId ?? null).toBeNull();
    }
    // THE INVARIANT, over HTTP: no confirmation, so no audit row. The mock would have
    // recorded one if either route had written it.
    expect(prismaMocks.claimVerification.create).not.toHaveBeenCalled();
    expect(store.verifications).toHaveLength(0);
    expect(store.rows.some((row) => row.status === ClaimStatus.user_confirmed)).toBe(false);
    // And no Resume anywhere: the mock exposes no `resume` delegate, so a write would have
    // thrown. Asserted explicitly so the reason is on the record.
    expect('resume' in prismaMocks).toBe(false);
  });

  it('the unconfirmed counter in the response matches the rows, and the list can read them back', async () => {
    withProviderAnswer(VALID_MODEL_RESPONSE);
    const submitted = await submitAnswers(answerBody());
    expect(submitted.body.counts.unconfirmed).toBe(2);

    // The hand-off the wizard performs: the verification list is the SAME rows.
    const list = await request(app).get('/career/claims');
    expect(list.status).toBe(200);
    expect(list.body.claims).toHaveLength(2);
    expect(list.body.unconfirmed).toBe(2);
    for (const claim of list.body.claims) {
      expect(claim.status).toBe(ClaimStatus.inferred);
      expect(claim.provenance).toBe(ClaimProvenance.llm_inferred);
    }
  });

  it('drops a FABRICATED claim with its reason, and keeps the honest one', async () => {
    withProviderAnswer(
      JSON.stringify({
        schemaVersion: 'claim_extract_v1',
        claims: [
          { kind: 'role', statement: 'Senior Engineer at Acme', confidence: 0.9 },
          { kind: 'achievement', statement: 'Led the payments migration at Initech', confidence: 0.9 },
        ],
      }),
    );
    const res = await submitAnswers(answerBody());

    expect(res.status).toBe(201);
    expect(res.body.claims).toMatchObject({ extracted: 2, accepted: 1, created: 1 });
    expect(res.body.dropped).toHaveLength(1);
    expect(res.body.dropped[0].reason).toBe('invented_entity');
    expect(res.body.dropped[0].detail).toContain('Initech');
    expect(res.body.dropped[0].invented.length).toBeGreaterThan(0);
    // The fabricated sentence is nowhere in the database, not merely hidden from the UI.
    const statements = store.rows.map((row) => row.statement as string);
    expect(statements.some((statement) => statement.includes('Initech'))).toBe(false);
    expect(statements).toContain('Senior Engineer at Acme');
  });

  it('502s on a SCHEMA-INVALID response and writes nothing at all', async () => {
    // A response that is not `{claims:[{kind,statement,confidence}]}`. Three shapes of the
    // same failure, and none of them is salvaged.
    for (const content of [
      'I could not do that.',
      '{"summary":"here is your interview"}',
      '{"claims":{"role":"Senior Engineer at Acme"}}',
      '{"claims":[{"kind":"role","statement":"Senior Engineer at Acme","confidence":"high"}]}',
    ]) {
      vi.clearAllMocks();
      store.rows.length = 0;
      withProviderAnswer(content);

      const res = await submitAnswers(answerBody());

      expect(res.status, content).toBe(502);
      expect(res.body.code, content).toBe('interview_schema_invalid');
      // Not one claim, and not one guess: the two words the provider DID give us are not
      // rescued into a claim.
      expect(store.rows, content).toHaveLength(0);
      expect(prismaMocks.careerClaim.create, content).not.toHaveBeenCalled();
      expect(prismaMocks.claimVerification.create, content).not.toHaveBeenCalled();
    }
  });

  it('asks the provider ONCE on a schema failure - there is no retry to talk it round', async () => {
    withProviderAnswer('not json at all');
    await submitAnswers(answerBody());
    // The number of provider calls is the mechanism behind "a hard failure": a stage that
    // could keep trying would eventually be argued into a shape it should never accept.
    expect(providerMocks.runLlmCompletion).toHaveBeenCalledTimes(1);
  });

  it('502s when the provider throws, writing nothing', async () => {
    keyMocks.leaseNextLlmKey.mockResolvedValue({
      id: 'k1', provider: 'groq', apiKey: 'x', source: 'env', userId: null,
    });
    providerMocks.runLlmCompletion.mockRejectedValueOnce(new Error('socket hang up'));

    const res = await submitAnswers(answerBody());

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('interview_provider_unavailable');
    expect(store.rows).toHaveLength(0);
  });

  it('503s when the key vanished between start and answers, so a run cannot start without one', async () => {
    // The refusal is repeated on the ANSWERS call as well as the start, because "is there a
    // provider" is a fact about the moment of the request.
    const res = await submitAnswers(answerBody());

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('interview_provider_required');
    expect(res.body.manualPath).toBe('/career/claims');
    expect(store.rows).toHaveLength(0);
  });

  it('400s a submission that cannot be acted on, and names what is wrong', async () => {
    for (const body of [
      {},
      { answers: [] },
      { answers: [{ stepId: 'roles', fieldId: 'salary', value: 'x' }] },
      { answers: [{ stepId: 'roles', fieldId: 'roles', value: 'Senior Engineer at Acme' }] },
    ]) {
      const res = await submitAnswers(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code, JSON.stringify(body)).toBe('interview_invalid_input');
    }
    expect(store.rows).toHaveLength(0);
  });

  it('400s a session id that is not one', async () => {
    const res = await submitAnswers(answerBody(), 'not-a-session');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('interview_invalid_input');
    expect(store.rows).toHaveLength(0);
  });

  it('an EMPTY claims array is a 201 with zero claims, not a failure', async () => {
    withProviderAnswer(JSON.stringify({ schemaVersion: 'claim_extract_v1', claims: [] }));
    const res = await submitAnswers(answerBody());

    expect(res.status).toBe(201);
    expect(res.body.claims).toMatchObject({ extracted: 0, accepted: 0, created: 0 });
    expect(res.body.dropped).toEqual([]);
    expect(res.body.unconfirmed).toBe(0);
  });

  it('re-running the interview DEDUPES: no duplicate row and no status change', async () => {
    withProviderAnswer(VALID_MODEL_RESPONSE);
    const first = await submitAnswers(answerBody());
    expect(first.body.claims.created).toBe(2);

    const second = await submitAnswers(answerBody());
    expect(second.status).toBe(201);
    expect(second.body.claims).toMatchObject({ extracted: 2, accepted: 2, created: 0, deduped: 2 });
    expect(store.rows).toHaveLength(2);
    expect(store.verifications).toHaveLength(0);
  });

  it('a claim the user already REJECTED is not resurrected by re-running the interview', async () => {
    withProviderAnswer(VALID_MODEL_RESPONSE);
    await submitAnswers(answerBody());
    const role = store.rows.find((row) => row.statement === 'Senior Engineer at Acme')!;
    await request(app).post(`/career/claims/${role.id}/reject`).send({ reason: 'wrong employer' });

    const again = await submitAnswers(answerBody());

    expect(again.status).toBe(201);
    expect(again.body.claims.created).toBe(0);
    // The rejection stands, and the audit still holds exactly the one decision the user
    // made - the machine added nothing to it.
    expect(store.rows.find((row) => row.id === role.id)?.status).toBe(ClaimStatus.rejected);
    expect(store.verifications).toHaveLength(1);
  });

  it('answers land in the CALLER\'s profile; naming another tenant\'s is a 403', async () => {
    withProviderAnswer(VALID_MODEL_RESPONSE);
    // The router's own addressing member, honoured and OWNERSHIP-CHECKED exactly as an
    // import's is: a foreign profileId is refused before anything is written, which is a
    // better answer than silently writing into the caller's own profile instead.
    const foreign = await submitAnswers({ ...answerBody(), profileId: FOREIGN_PROFILE.id });
    expect(foreign.status).toBe(403);
    expect(store.rows).toHaveLength(0);

    const own = await submitAnswers({ ...answerBody(), profileId: PROFILE.id });
    expect(own.status).toBe(201);
    expect(own.body.profileId).toBe(PROFILE.id);
    for (const row of store.rows) expect(row.profileId).toBe(PROFILE.id);

    // And with no id at all, the caller's own profile is resolved and used.
    store.rows.length = 0;
    const implicit = await submitAnswers(answerBody());
    expect(implicit.status).toBe(201);
    expect(implicit.body.profileId).toBe(PROFILE.id);
  });
});

// ---------------------------------------------------------------------------
// T1054 - career entity CRUD + claim attachment
// ---------------------------------------------------------------------------

/** A foreign tenant's row of the named kind, written straight into the fixture table. */
function seedForeignEntity(kind: keyof typeof store.entityTables, row: Record<string, unknown>): string {
  const id = `foreign-${kind}-1`;
  store.entityTables[kind].push({ id, ...row });
  return id;
}

/** Create one entity through the real HTTP surface. */
function createEntity(kind: string, body: Record<string, unknown>) {
  return request(app).post(`/career/entities/${kind}`).send(body);
}

/** A hand-entered claim, through the real surface. Born unconfirmed, as always. */
function createClaim(kind: string, statement: string) {
  return request(app).post('/career/claims').send({ kind, statement });
}

describe('the pairing table: which claim kind may name which entity (T1054)', () => {
  it('every one of the schema six entity kinds owns exactly one claim FK column', () => {
    expect(Object.values(ENTITY_KIND_CLAIM_FIELD).sort()).toEqual([
      'achievementId',
      'certificationId',
      'educationId',
      'experienceId',
      'projectId',
      'skillId',
    ]);
    // ...and the map is TOTAL over the kind vocabulary, because a kind with no column would be
    // CRUD the projector could never place anything against.
    for (const kind of CAREER_ENTITY_KINDS) {
      expect(typeof ENTITY_KIND_CLAIM_FIELD[kind]).toBe('string');
    }
  });

  it('every one of the twelve ClaimKind values can be attached to SOMETHING', () => {
    // The coverage guard. A new claim kind added to the enum without a row here would be a
    // statement the user could never place in their own resume, which is the bug this table
    // was written to prevent.
    for (const kind of Object.values(ClaimKind)) {
      expect(entityKindsForClaimKind(kind).length, `nothing accepts a ${kind} claim`).toBeGreaterThan(0);
    }
    expect(Object.values(ClaimKind)).toHaveLength(12);
  });

  it('refuses the nonsensical pairings and accepts the defensible ones', () => {
    // The named example from the task: an education claim on a Project.
    expect(isCompatiblePairing('project', ClaimKind.education)).toBe(false);
    expect(isCompatiblePairing('education', ClaimKind.project)).toBe(false);
    // A certification claim is only ever about a certification.
    expect(isCompatiblePairing('experience', ClaimKind.certification)).toBe(false);
    // ...and the pairs that are meant to be allowed.
    expect(isCompatiblePairing('experience', ClaimKind.role)).toBe(true);
    expect(isCompatiblePairing('experience', ClaimKind.achievement)).toBe(true);
    expect(isCompatiblePairing('education', ClaimKind.education)).toBe(true);
    expect(isCompatiblePairing('project', ClaimKind.project)).toBe(true);
    expect(isCompatiblePairing('skill', ClaimKind.skill)).toBe(true);
    expect(isCompatiblePairing('skill', ClaimKind.language)).toBe(true);
    expect(isCompatiblePairing('certification', ClaimKind.certification)).toBe(true);
    // An achievement may sit under a job, under a project, or on its own row.
    expect(entityKindsForClaimKind(ClaimKind.achievement)).toEqual([
      'experience',
      'project',
      'achievement',
    ]);
  });

  it('normalises a skill name the way claims normalise a statement', () => {
    expect(normalizeSkillName('  Postgres  ')).toBe('postgres');
    expect(normalizeSkillName('PostgreSQL')).toBe('postgresql');
  });
});

describe('career entity CRUD - user-authored and profile-scoped (T1054)', () => {
  it('creates one row of EVERY kind and lists them back in the projector order', async () => {
    const created: Record<string, string> = {};
    const bodies: Record<string, Record<string, unknown>> = {
      experience: { title: 'Compiler architect', company: 'Naval Ordnance Laboratory', startDate: '1843', current: true, sortOrder: 2 },
      education: { degree: 'BSc Mathematics', institution: 'University of London', graduationYear: '1842', sortOrder: 1 },
      project: { name: 'LedgerKit', role: 'Maintainer', tech: ['TypeScript', 'Postgres'], sortOrder: 3 },
      skill: { name: 'TypeScript', category: 'language', level: 'expert', sortOrder: 4 },
      certification: { name: 'Analytical Engine Notes', issuer: 'Somerville College', issuedOn: '1843-07-01' },
      achievement: { statement: 'Wrote the first published algorithm', sortOrder: 5 },
    };

    for (const kind of CAREER_ENTITY_KINDS) {
      const response = await createEntity(kind, bodies[kind]);
      expect(response.status, `${kind}: ${JSON.stringify(response.body)}`).toBe(201);
      expect(response.body.kind).toBe(kind);
      expect(response.body.entity.profileId).toBe(PROFILE.id);
      created[kind] = response.body.entity.id;
    }

    // `sortOrder` is HONOURED on write, and the list comes back in it.
    const listed = await request(app).get('/career/entities/experience');
    expect(listed.status).toBe(200);
    expect(listed.body.entities.map((row: { sortOrder: number }) => row.sortOrder)).toEqual([2]);
    const ordered = await request(app).get('/career/entities/project');
    expect(ordered.body.entities[0].name).toBe('LedgerKit');
    // The JSON column round-trips as the array the caller sent.
    expect(ordered.body.entities[0].tech).toEqual(['TypeScript', 'Postgres']);
    // A certification has no order column, so the list is by name - which is what the
    // projector does with it.
    const certs = await request(app).get('/career/entities/certification');
    expect(certs.body.entities[0].name).toBe('Analytical Engine Notes');
    expect(certs.body.entities[0]).not.toHaveProperty('sortOrder');
    expect(created.achievement).toBeTruthy();
  });

  it('REFUSES a sortOrder for certification rather than dropping it silently', async () => {
    // `Certification` has no such column in the schema. A request that supplies one is
    // refused, because "accepted, then ignored" is how a user loses an edit.
    const response = await createEntity('certification', { name: 'x', sortOrder: 1 });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('career_entity_invalid_input');
    expect(response.body.error).toMatch(/sortOrder is not a field of a certification/);
    expect(prismaMocks.certification.create).not.toHaveBeenCalled();
  });

  it('F5: an achievement\u2019s `experienceId` is RESOLVED against this profile, not refused', async () => {
    // F5. `entityWriteData` used to throw on `experienceId` for an achievement ("resolved by
    // the server ... not written as text") BEFORE `resolveAchievementExperienceId` ran, so the
    // resolver could only ever see `undefined`, the column was unwritable through the API at
    // all, and the message contradicted the code. The member is now accepted and the resolver
    // owns it - which is also the only thing that keeps the tenant check, because the column
    // is a bare `String?` with no relation.
    const role = await createEntity('experience', {
      title: 'Compiler architect',
      company: 'Naval Ordnance Laboratory',
      startDate: '1843',
      current: true,
    });
    expect(role.status).toBe(201);
    const experienceId = role.body.entity.id as string;

    const created = await createEntity('achievement', {
      statement: 'Wrote the first published algorithm',
      experienceId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.entity.experienceId).toBe(experienceId);
    expect(prismaMocks.achievement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ experienceId }) }),
    );

    // A PATCH moves it, and `null` clears it - `undefined` leaves it alone.
    const moved = await request(app)
      .patch(`/career/entities/achievement/${created.body.entity.id}`)
      .send({ experienceId: null });
    expect(moved.status).toBe(200);
    expect(moved.body.entity.experienceId).toBeNull();

    // An experience that is not THIS profile's is a 404, not a dangling pointer and not a
    // silent write: the same answer an absent id gets.
    const foreign = seedForeignEntity('experience', {
      profileId: 'someone-else',
      company: 'Their Co',
      title: 'Their role',
    });
    const crossTenant = await createEntity('achievement', {
      statement: 'Belongs to someone else',
      experienceId: foreign,
    });
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.code).toBe('career_entity_not_found');

    // And the member is still refused for every OTHER kind, because only an achievement hangs
    // off an experience - the fix is narrow rather than a new hole.
    const wrongKind = await createEntity('project', { name: 'LedgerKit', experienceId });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error).toMatch(/experienceId is not a field of a project/);
  });

  it('derives Skill.normalized, so two spellings of one skill collide with a 409', async () => {
    const first = await createEntity('skill', { name: 'Postgres' });
    expect(first.status).toBe(201);
    expect(first.body.entity.normalized).toBe('postgres');

    // The real database raises P2002 on `@@unique([profileId, normalized])`; the fake
    // raises the same driver code so the mapping is what is under test.
    prismaMocks.skill.create.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });
    const second = await createEntity('skill', { name: '  postgres ' });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('career_entity_conflict');
    expect(second.body.error).toMatch(/already on this profile/);
  });

  it('PATCHes only the members the request names, and never an id or a profile', async () => {
    const created = await createEntity('experience', {
      title: 'Engineer',
      company: 'Acme',
      location: 'London',
    });
    const id = created.body.entity.id;

    const patched = await request(app)
      .patch(`/career/entities/experience/${id}`)
      .send({ title: 'Senior Engineer', sortOrder: 7 });
    expect(patched.status).toBe(200);
    expect(patched.body.entity.title).toBe('Senior Engineer');
    expect(patched.body.entity.sortOrder).toBe(7);
    // Untouched members keep their values: this is a PATCH, not a replace.
    expect(patched.body.entity.company).toBe('Acme');
    expect(patched.body.entity.location).toBe('London');
    expect(patched.body.entity.profileId).toBe(PROFILE.id);
    expect(patched.body.entity.id).toBe(id);

    // A required member cannot be cleared: the projector would render "Unknown employer".
    const cleared = await request(app).patch(`/career/entities/experience/${id}`).send({ company: null });
    expect(cleared.status).toBe(400);
    expect(cleared.body.error).toMatch(/company is required/);

    // An unknown member is a 400 rather than a silent no-op.
    const typo = await request(app).patch(`/career/entities/experience/${id}`).send({ companyy: 'Acme' });
    expect(typo.status).toBe(400);
    expect(typo.body.error).toMatch(/companyy is not a field of a experience/);
  });

  it('answers a 404 - never a 403 or a 200 - for a foreign id, and for an unknown kind', async () => {
    const foreignId = seedForeignEntity('experience', { profileId: FOREIGN_PROFILE.id, title: 'X', company: 'Y' });

    const read = await request(app).get(`/career/entities/experience/${foreignId}`);
    const patched = await request(app).patch(`/career/entities/experience/${foreignId}`).send({ title: 'mine now' });
    const removed = await request(app).delete(`/career/entities/experience/${foreignId}`);
    for (const response of [read, patched, removed]) {
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('career_entity_not_found');
      // No existence oracle: the message names the id and nothing else, and it is the SAME
      // message an id that never existed would carry.
      expect(response.body.error).toBe(`career entity not found: experience/${foreignId}`);
    }
    // And nothing was written - not even a `SetNull` on the foreign tenant's claims.
    expect(prismaMocks.experience.update).not.toHaveBeenCalled();
    expect(prismaMocks.experience.delete).not.toHaveBeenCalled();
    expect(store.entityTables.experience).toHaveLength(1);

    // An absent id is the same 404, which is what makes the two indistinguishable.
    const absent = await request(app).get('/career/entities/experience/never-existed');
    expect(absent.status).toBe(404);
    expect(absent.body.error).toBe('career entity not found: experience/never-existed');

    // An unknown KIND is a 404 too - the six real kinds cannot be enumerated by probing.
    const badKind = await request(app).get('/career/entities/salary');
    expect(badKind.status).toBe(404);
    expect(badKind.body.error).toBe('Career entity kind not found');
  });

  it('deleting an entity DETACHES its claims (the schema SetNull) and reports how many', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme' })).body.entity;
    const claim = (await createClaim('achievement', 'Cut the CI build time by 40%')).body.claim;
    await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });
    expect(store.rows.find((row) => row.id === claim.id)?.experienceId).toBe(experience.id);

    const removed = await request(app).delete(`/career/entities/experience/${experience.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ id: experience.id, kind: 'experience', detachedClaims: 1 });
    // The CLAIM survives - a profile statement the user made is not deleted because its
    // container went away.
    const survivor = store.rows.find((row) => row.id === claim.id);
    expect(survivor).toBeDefined();
    expect(survivor?.experienceId).toBeNull();
    // ...and no audit row: a container is not a claim decision.
    expect(store.verifications).toHaveLength(0);
  });

  it('an empty profile is an EMPTY list, not a 404', async () => {
    mockUserId.value = 'user-3';
    prismaMocks.careerProfile.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.userId === 'user-3') return null;
      if (where?.id === PROFILE.id) return PROFILE;
      return null;
    });
    const response = await request(app).get('/career/entities/experience');
    expect(response.status).toBe(200);
    expect(response.body.entities).toEqual([]);
  });

  it('creating an entity MAY create the profile, so a profile can be built from scratch', async () => {
    mockUserId.value = 'user-4';
    prismaMocks.careerProfile.findUnique.mockResolvedValue(null as never);
    prismaMocks.careerProfile.create.mockResolvedValue({ id: 'profile-new', userId: 'user-4' } as never);
    const response = await createEntity('experience', { title: 'Engineer', company: 'Acme' });
    expect(response.status).toBe(201);
    expect(response.body.entity.profileId).toBe('profile-new');
    expect(prismaMocks.careerProfile.create).toHaveBeenCalledTimes(1);
  });
});

describe('claim attachment - bookkeeping, NOT a decision (T1054)', () => {
  it('attaches: exactly one FK set, the other five cleared, and NO ClaimVerification row', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme' })).body.entity;
    const project = (await createEntity('project', { name: 'LedgerKit' })).body.entity;
    const claim = (await createClaim('achievement', 'Owned the ledger reconciliation service')).body.claim;
    const claimId = claim.id;

    const attached = await request(app).post(`/career/claims/${claimId}/attach`).send({ kind: 'experience', entityId: experience.id });
    expect(attached.status).toBe(200);
    expect(attached.body.changed).toBe(true);
    expect(attached.body.field).toBe('experienceId');
    expect(attached.body.claim.experienceId).toBe(experience.id);

    // Move it to the project: still exactly ONE FK set.
    const moved = await request(app).post(`/career/claims/${claimId}/attach`).send({ kind: 'project', entityId: project.id });
    expect(moved.status).toBe(200);
    const row = store.rows.find((entry) => entry.id === claimId);
    expect(row?.projectId).toBe(project.id);
    expect(row?.experienceId).toBeNull();
    for (const field of ['educationId', 'skillId', 'certificationId', 'achievementId']) {
      expect(row?.[field], field).toBeNull();
    }

    // THE INVARIANT: attachment is not a decision, so it wrote NO audit row.
    expect(prismaMocks.claimVerification.create).not.toHaveBeenCalled();
    expect(store.verifications).toHaveLength(0);
  });

  it('attaching never changes status - the claim row is byte-identical but for the FK', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme' })).body.entity;
    const claim = (await createClaim('achievement', 'Migrated the reporting stack to Postgres')).body.claim;
    const before = { ...store.rows.find((row) => row.id === claim.id) };

    await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });

    const after = store.rows.find((row) => row.id === claim.id);
    expect(after?.status).toBe(before.status);
    expect(after?.confirmedAt).toBeNull();
    // Everything except the FK and the row's own `updatedAt` is untouched.
    const { experienceId: _attached, updatedAt: _touched, ...rest } = after as Record<string, unknown>;
    const { experienceId: _wasNull, updatedAt: _wasUntouched, ...beforeRest } = before as Record<string, unknown>;
    expect(rest).toEqual(beforeRest);
  });

  it('REFUSES a rejected claim, and the refusal writes nothing at all', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme' })).body.entity;
    const claim = (await createClaim('achievement', 'That was a team project, not mine')).body.claim;
    const rejected = await request(app).post(`/career/claims/${claim.id}/reject`).send({ reason: 'not mine' });
    expect(rejected.status).toBe(200);
    const verificationsBefore = store.verifications.length;
    prismaMocks.careerClaim.update.mockClear();

    const attached = await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });
    expect(attached.status).toBe(409);
    expect(attached.body.code).toBe('career_entity_claim_refused');
    expect(attached.body.error).toMatch(/was rejected/);
    expect(attached.body.error).toMatch(/reopen it first/);
    // NOTHING was written: no FK, no audit row, and the status is untouched - attaching
    // cannot be the way a rejection is quietly undone.
    expect(prismaMocks.careerClaim.update).not.toHaveBeenCalled();
    expect(store.verifications).toHaveLength(verificationsBefore);
    expect(store.rows.find((row) => row.id === claim.id)?.experienceId).toBeNull();
    expect(store.rows.find((row) => row.id === claim.id)?.status).toBe(ClaimStatus.rejected);

    // And the other direction of the same rule: detaching a rejected claim is allowed,
    // because there is nothing left to protect.
    const detached = await request(app).post(`/career/claims/${claim.id}/detach`).send({ kind: 'experience' });
    expect(detached.status).toBe(200);
    expect(detached.body.changed).toBe(false);
  });

  it('REFUSES a nonsensical pairing and names the kinds that WOULD be legal', async () => {
    const project = (await createEntity('project', { name: 'LedgerKit' })).body.entity;
    const claim = (await createClaim('education', 'BSc Computer Science at University of London')).body.claim;

    const response = await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'project', entityId: project.id });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('career_entity_claim_refused');
    expect(response.body.error).toMatch(/a claim of kind education cannot be attached to a project/);
    // Actionable: the message lists what a project does accept.
    expect(response.body.error).toMatch(/a project accepts claims of kind project\|achievement\|metric\|technology\|domain\|responsibility/);
    expect(prismaMocks.careerClaim.update).not.toHaveBeenCalled();

    // The matching pairing works, so the refusal is the pairing and not the endpoint.
    const education = (await createEntity('education', { degree: 'BSc', institution: 'University of London' })).body.entity;
    const ok = await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'education', entityId: education.id });
    expect(ok.status).toBe(200);
    expect(ok.body.claim.educationId).toBe(education.id);
  });

  it('a FOREIGN entity id is a 404 with no oracle, and does not attach', async () => {
    const foreignId = seedForeignEntity('experience', { profileId: FOREIGN_PROFILE.id, title: 'X', company: 'Y' });
    const claim = (await createClaim('achievement', 'Cut the CI build time by 40%')).body.claim;

    const response = await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: foreignId });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('career_entity_not_found');
    // The SAME body an absent id gets: a probe cannot learn that the row exists.
    const absent = await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: 'not-a-row' });
    expect(absent.status).toBe(404);
    expect(absent.body.code).toBe('career_entity_not_found');
    expect(prismaMocks.careerClaim.update).not.toHaveBeenCalled();
    expect(store.rows.find((row) => row.id === claim.id)?.experienceId).toBeNull();
  });

  it('re-attaching the SAME pair is a no-op: no write, and it says so', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme' })).body.entity;
    const claim = (await createClaim('achievement', 'Owned the ledger reconciliation service')).body.claim;
    await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });
    prismaMocks.careerClaim.update.mockClear();

    const again = await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(prismaMocks.careerClaim.update).not.toHaveBeenCalled();
  });

  it('detach is IDEMPOTENT, in both the narrow and the wide form', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme' })).body.entity;
    const claim = (await createClaim('achievement', 'Owned the ledger reconciliation service')).body.claim;
    await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });

    const first = await request(app).post(`/career/claims/${claim.id}/detach`).send({ kind: 'experience' });
    expect(first.status).toBe(200);
    expect(first.body.changed).toBe(true);
    expect(first.body.fields).toEqual(['experienceId']);
    expect(store.rows.find((row) => row.id === claim.id)?.experienceId).toBeNull();
    prismaMocks.careerClaim.update.mockClear();

    // The second detach writes NOTHING and is not an error.
    const second = await request(app).post(`/career/claims/${claim.id}/detach`).send({ kind: 'experience' });
    expect(second.status).toBe(200);
    expect(second.body.changed).toBe(false);
    expect(prismaMocks.careerClaim.update).not.toHaveBeenCalled();

    // The WIDE form (no kind) clears whatever the claim names - and is idempotent too.
    await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });
    const wide = await request(app).post(`/career/claims/${claim.id}/detach`).send({});
    expect(wide.body.changed).toBe(true);
    prismaMocks.careerClaim.update.mockClear();
    const wideAgain = await request(app).post(`/career/claims/${claim.id}/detach`).send({});
    expect(wideAgain.body.changed).toBe(false);
    expect(prismaMocks.careerClaim.update).not.toHaveBeenCalled();
  });

  it('detach never touches a status or an audit row either', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme' })).body.entity;
    const claim = (await createClaim('achievement', 'Owned the ledger reconciliation service')).body.claim;
    await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });
    const before = { ...store.rows.find((row) => row.id === claim.id) };

    await request(app).post(`/career/claims/${claim.id}/detach`).send({ kind: 'experience' });

    const after = store.rows.find((row) => row.id === claim.id);
    expect(after?.status).toBe(before.status);
    expect(after?.statement).toBe(before.statement);
    expect(after?.fingerprint).toBe(before.fingerprint);
    expect(store.verifications).toHaveLength(0);
  });

  it('403s another tenant CLAIM, and refuses a body that is not strictly shaped', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme' })).body.entity;
    store.rows.push({
      id: 'clm-foreign',
      profileId: FOREIGN_PROFILE.id,
      kind: ClaimKind.achievement,
      statement: 'Their claim',
      fingerprint: 'f'.repeat(64),
      status: ClaimStatus.inferred,
      provenance: ClaimProvenance.user_entered,
      experienceId: null,
      educationId: null,
      projectId: null,
      skillId: null,
      certificationId: null,
      achievementId: null,
    });

    const foreign = await request(app).post('/career/claims/clm-foreign/attach').send({ kind: 'experience', entityId: experience.id });
    expect(foreign.status).toBe(403);

    const own = (await createClaim('achievement', 'Owned the ledger reconciliation service')).body.claim;
    // A body that tries to NAME the column is a 400 - the service picks the column from
    // `kind`, so no body can reach a column it did not name as a kind.
    const smuggle = await request(app).post(`/career/claims/${own.id}/attach`).send({ kind: 'experience', entityId: experience.id, status: 'user_confirmed' });
    expect(smuggle.status).toBe(400);
    const badKind = await request(app).post(`/career/claims/${own.id}/attach`).send({ kind: 'salary', entityId: experience.id });
    expect(badKind.status).toBe(400);
    expect(prismaMocks.careerClaim.update).not.toHaveBeenCalled();
  });
});

describe('the projector finally has something to place (T1054 acceptance)', () => {
  /** The whole V2 read path, over the same mocked store the HTTP surface wrote. */
  async function projectProfile() {
    const input = await loadProjectionInput(PROFILE.id, prismaMocks as never);
    return projectResumeJson(input);
  }

  it('a profile built from scratch projects a POPULATED document with the attached claims placed', async () => {
    const experience = (await createEntity('experience', { title: 'Compiler architect', company: 'Naval Ordnance Laboratory', startDate: '1843', current: true, sortOrder: 0 })).body.entity;
    await createEntity('experience', { title: 'Engineer', company: 'Globex', sortOrder: 1 });
    await createEntity('education', { degree: 'BSc Mathematics', institution: 'University of London', graduationYear: '1842' });
    await createEntity('project', { name: 'LedgerKit', role: 'Maintainer', tech: ['TypeScript'], sortOrder: 0 });
    await createEntity('skill', { name: 'TypeScript', category: 'language', sortOrder: 0 });
    await createEntity('certification', { name: 'Analytical Engine Notes' });
    await createEntity('achievement', { statement: 'Wrote the first published algorithm', sortOrder: 0 });

    // Three claims, attached to the two kinds whose text the projector actually places.
    const role = (await createClaim('role', 'Compiler architect at Naval Ordnance Laboratory')).body.claim;
    const bullet = (await createClaim('achievement', 'Cut the CI build time by 40%')).body.claim;
    const eduClaim = (await createClaim('education', 'BSc Computer Science at University of London')).body.claim;
    const skillClaim = (await createClaim('skill', 'TypeScript')).body.claim;
    const loose = (await createClaim('achievement', 'A statement nothing has been filed under')).body.claim;

    await request(app).post(`/career/claims/${role.id}/attach`).send({ kind: 'experience', entityId: experience.id });
    await request(app).post(`/career/claims/${bullet.id}/attach`).send({ kind: 'experience', entityId: experience.id });
    const education = (await request(app).get('/career/entities/education')).body.entities[0];
    await request(app).post(`/career/claims/${eduClaim.id}/attach`).send({ kind: 'education', entityId: education.id });
    const skill = (await request(app).get('/career/entities/skill')).body.entities[0];
    await request(app).post(`/career/claims/${skillClaim.id}/attach`).send({ kind: 'skill', entityId: skill.id });

    const { document, clearance } = await projectProfile();

    // >0 entries of every kind the acceptance names.
    expect(document.work?.length).toBeGreaterThan(0);
    expect(document.education?.length).toBeGreaterThan(0);
    expect(document.projects?.length).toBeGreaterThan(0);
    expect(document.skills?.length).toBeGreaterThan(0);
    expect(document.certificates?.length).toBeGreaterThan(0);

    // THE FOREIGN KEY IS THE WHOLE MECHANISM: a claim attached by `experienceId` appears as
    // a `work[].highlights[]` bullet, and the block names it at the path its text occupies.
    expect(document.work?.[0]).toMatchObject({
      name: 'Naval Ordnance Laboratory',
      position: 'Compiler architect',
      startDate: '1843',
    });
    expect(document.work?.[0].highlights).toEqual([
      'Compiler architect at Naval Ordnance Laboratory',
      'Cut the CI build time by 40%',
    ]);
    const placedRole = clearance.claims.find((entry) => entry.claimId === role.id);
    expect(placedRole).toMatchObject({ usage: 'verbatim', jsonPath: 'work[0].highlights[0]' });
    const placedBullet = clearance.claims.find((entry) => entry.claimId === bullet.id);
    expect(placedBullet).toMatchObject({ usage: 'verbatim', jsonPath: 'work[0].highlights[1]' });
    // A CURRENT role has no end date, which is JSON Resume's own convention.
    expect(document.work?.[0]).not.toHaveProperty('endDate');

    // The kinds whose rows already carry the text are RECORDED against their row and never
    // restated: usage omitted, no path, so the block still accounts for them (the projector
    // emits no renderedText for an omitted claim, so there is nothing for a path to name).
    expect(clearance.claims.find((entry) => entry.claimId === eduClaim.id)).toMatchObject({
      usage: 'omitted',
      jsonPath: null,
      renderedText: null,
    });
    expect(clearance.claims.find((entry) => entry.claimId === skillClaim.id)).toMatchObject({
      usage: 'omitted',
      jsonPath: null,
    });
    // The DOCUMENT names the entry instead - the education row is a real section.
    expect(document.education?.[0]).toMatchObject({
      institution: 'University of London',
      studyType: 'BSc Mathematics',
      endDate: '1842',
    });
    // And an unattached claim is still accounted for, with no path at all.
    expect(clearance.claims.find((entry) => entry.claimId === loose.id)).toMatchObject({
      usage: 'omitted',
      jsonPath: null,
    });
    expect(clearance.claimCount).toBe(5);
    // Every status is the claim row's own; attaching promoted nothing.
    for (const entry of clearance.claims) {
      expect(entry.status).toBe(ClaimStatus.inferred);
    }
  });

  it('the same profile projects NOTHING before any entity exists, which is the gap this closes', async () => {
    const claim = (await createClaim('achievement', 'Cut the CI build time by 40%')).body.claim;
    const { document, clearance } = await projectProfile();
    expect(document.work).toBeUndefined();
    expect(document.education).toBeUndefined();
    expect(document.skills).toBeUndefined();
    expect(clearance.claims.find((entry) => entry.claimId === claim.id)).toMatchObject({
      usage: 'omitted',
      jsonPath: null,
    });
  });

  it('the projection is DETERMINISTIC: the same profile twice is the same bytes', async () => {
    const experience = (await createEntity('experience', { title: 'Engineer', company: 'Acme', sortOrder: 0 })).body.entity;
    await createEntity('experience', { title: 'Analyst', company: 'Globex', sortOrder: 1 });
    const claim = (await createClaim('role', 'Engineer at Acme')).body.claim;
    await request(app).post(`/career/claims/${claim.id}/attach`).send({ kind: 'experience', entityId: experience.id });

    const first = await projectProfile();
    const second = await projectProfile();
    expect(second.canonical).toBe(first.canonical);
  });
});