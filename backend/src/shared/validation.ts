// Shared validation schemas using Zod
// All user input must be validated on the backend per security.md

import { z } from 'zod';
import { BadRequestError } from './errors.js';
import { allSourceIds } from '../jobSources/providerRegistry.js';
// Re-exported from the leaf module `./seniority.js` (import-cycle break, see
// that file): every existing `seniorityEnum` import site keeps working.
export { seniorityEnum } from './seniority.js';
import { seniorityEnum } from './seniority.js';
// Wave 12 (T842): `intent` on the saved-search/alert schemas is validated by
// wave 7's `searchIntentSchema` - the ONLY intent validator (no second schema
// here). Emptiness reuses T840's `isEmptyIntent` (no duplicated logic).
// Import-cycle note: `discovery/searchIntent.ts` takes `seniorityEnum` from
// `./seniority.js` (not from this module), so the validation -> discovery
// edge is acyclic; `discovery/intentPersistence.ts` only touches this
// module's location helpers at call time, never at evaluation time.
import { searchIntentSchema, SEARCH_MODES } from '../discovery/searchIntent.js';
import { isEmptyIntent } from '../discovery/intentPersistence.js';
// T1020: the career claim vocabulary is read from the generated Prisma enums, never
// restated as string literal tuples, so this file cannot hold a stale copy of a status
// or a kind (the reason every other enum in this module is a local `z.enum([...])`).
import { ClaimKind, ClaimStatus } from '@prisma/client';

// ==================== AUTH SCHEMAS ====================
export const accessPasswordSchema = z.object({
  password: z.string().min(1, 'Password is required').max(200, 'Password too long'),
}).strict();

export const updateProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long').optional(),
  avatarUrl: z.string().url('Invalid URL').max(500).optional().nullable(),
});

// ==================== RESUME SCHEMAS ====================
export const personalInfoSchema = z.object({
  fullName: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  email: z.string().email('Invalid email format').max(255),
  phone: z.string().max(30, 'Phone number too long').regex(/^[\d\s\-\+\(\)\.]*$/, 'Invalid phone format'),
  location: z.string().max(100, 'Location too long'),
  linkedin: z.string().max(200).optional().nullable(),
  website: z.string().max(200).optional().nullable(),
});

export const experienceItemSchema = z.object({
  id: z.string(),
  title: z.string().max(100, 'Title too long'),
  company: z.string().max(100, 'Company name too long'),
  startDate: z.string().max(20),
  endDate: z.string().max(20),
  description: z.string().max(1000).optional().default(''),
  bullets: z.array(z.string().max(500, 'Bullet point too long')).max(10, 'Too many bullet points'),
});

export const educationItemSchema = z.object({
  id: z.string(),
  degree: z.string().max(100, 'Degree name too long'),
  institution: z.string().max(100, 'Institution name too long'),
  field: z.string().max(100, 'Field of study too long'),
  graduationYear: z.string().max(10),
});

export const resumeSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  personalInfo: personalInfoSchema,
  summary: z.string().max(2000, 'Summary too long'),
  experience: z.array(experienceItemSchema).max(20, 'Too many experience entries'),
  education: z.array(educationItemSchema).max(10, 'Too many education entries'),
  skills: z.array(z.string().max(50, 'Skill name too long')).max(50, 'Too many skills'),
  projects: z.array(z.object({
    id: z.string(),
    name: z.string().max(100),
    description: z.string().max(1000),
    url: z.string().max(200).optional(),
    technologies: z.array(z.string().max(50)).max(10),
  })).max(10).optional(),
  templateId: z.string().max(50).optional(),
  templateSettings: z.object({
    marginX: z.number().min(0.5).max(1.5),
    marginY: z.number().min(0.5).max(1.5),
    fontSize: z.number().min(8).max(16),
    lineSpacing: z.number().min(1).max(2),
    sectionSpacing: z.number().min(0.5).max(3),
  }).optional(),
  sections: z.array(z.object({
    id: z.string(),
    type: z.enum(['personal', 'summary', 'experience', 'education', 'skills', 'projects', 'custom']),
    title: z.string().max(50),
    order: z.number(),
    visible: z.boolean(),
  })).max(10).optional(),
});

export const createResumeSchema = resumeSchema.partial().extend({
  name: z.string().min(1).max(100).optional().default('Untitled Resume'),
});

export const updateResumeSchema = resumeSchema.partial();

export const createVariantSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  targetJob: z.string().max(100).optional(),
});

// ==================== ATS SCHEMAS ====================
export const scanResumeSchema = z.object({
  resumeId: z.string().uuid('Invalid resume ID'),
});

export const publicScanSchema = z.object({
  // For file upload, validated separately
});

// ==================== JOB MATCH SCHEMAS ====================
export const jobMatchSchema = z.object({
  resumeId: z.string().uuid('Invalid resume ID').optional(),
  uploadedFileId: z.string().uuid('Invalid uploaded file ID').optional(),
  jobDescription: z.string()
    .min(50, 'Job description too short')
    .max(10000, 'Job description too long'),
}).refine((data) => data.resumeId || data.uploadedFileId, {
  message: 'Either resumeId or uploadedFileId is required',
});

// ==================== API KEY (BYOK) SCHEMAS ====================
// Custom providers use ids like `custom:my-llm` (slug: [a-z0-9-], max 40).
export const customProviderIdSchema = z
  .string()
  .regex(/^custom:[a-z0-9-]{1,40}$/, 'Invalid custom provider id (expected custom:<slug>, [a-z0-9-], max 40)');

const llmProviderIds = [
  'groq',
  'openai',
  'openrouter',
  'gemini',
  'anthropic',
  'zai',
  'deepseek',
  'mistral',
  'together',
  'fireworks',
  'azure-openai',
  'ollama',
  'lmstudio',
] as const;

export const apiKeyProviderSchema = z.union([
  z.enum([
    ...llmProviderIds,
    'tavily',
    'exa',
    'firecrawl',
    'crawl4ai',
    'rapidapi',
    'adzuna',
    'usajobs',
    'reed',
    'findwork',
    // Retired aggregators (.planning/decisions/ADR-006). Their ids stay valid so previously
    // stored AIProviderKey rows remain listable and deletable; the board path below is what
    // actually stops them running.
    'jooble',
    'careerjet',
  ]),
  customProviderIdSchema,
]);
export const createApiKeySchema = z.object({
  provider: apiKeyProviderSchema,
  apiKey: z.string().min(8, 'API key too short').max(500, 'API key too long'),
  label: z.string().max(50, 'Label too long').optional(),
});

// ==================== AI MODEL SETTINGS SCHEMAS ====================
export const llmModelProviderSchema = z.union([z.enum(llmProviderIds), customProviderIdSchema]);

// Model IDs look like `llama-3.3-70b-versatile`, `openai/gpt-4o`, `gemini-2.0-flash`.
// Allow letters, digits, dot, underscore, colon, slash, hyphen; must start alphanumeric.
export const llmModelIdSchema = z
  .string()
  .max(200, 'Model ID too long')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/, 'Invalid model ID (letters, digits, . _ : / - only)');

// Empty string = "clear override, use fallback chain".
export const llmModelInputSchema = z.union([z.literal(''), llmModelIdSchema]);

export const updateModelSettingsSchema = z
  .object({
    // The 13 registry providers are explicit keys; `custom:<slug>` ids are
    // accepted via catchall so per-custom-provider models persist through the
    // same path. Unknown non-custom keys are still rejected (strict-like).
    models: z
      .object({
        groq: llmModelInputSchema.optional(),
        openai: llmModelInputSchema.optional(),
        openrouter: llmModelInputSchema.optional(),
        gemini: llmModelInputSchema.optional(),
        anthropic: llmModelInputSchema.optional(),
        zai: llmModelInputSchema.optional(),
        deepseek: llmModelInputSchema.optional(),
        mistral: llmModelInputSchema.optional(),
        together: llmModelInputSchema.optional(),
        fireworks: llmModelInputSchema.optional(),
        'azure-openai': llmModelInputSchema.optional(),
        ollama: llmModelInputSchema.optional(),
        lmstudio: llmModelInputSchema.optional(),
      })
      .catchall(llmModelInputSchema)
      .refine((m) => Object.keys(m).length > 0, { message: 'At least one model is required' })
      .superRefine((m, ctx) => {
        const known = new Set([
          'groq', 'openai', 'openrouter', 'gemini', 'anthropic', 'zai', 'deepseek',
          'mistral', 'together', 'fireworks', 'azure-openai', 'ollama', 'lmstudio',
        ]);
        for (const key of Object.keys(m)) {
          if (!known.has(key) && !/^custom:[a-z0-9-]{1,40}$/.test(key)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown provider: ${key}` });
          }
        }
      }),
  })
  .strict();

// ==================== JOB DISCOVERY SCHEMAS ====================
// Canonical job source list: the set of JobListing.source values the app can
// return. Derived from the provider registry (Wave 1, ADR-025) - membership
// AND order both come from allSourceIds() (Wave-0 display order, pinned by
// the tests below). Previously a hand-maintained const kept in step with
// SOURCES in src/pages/Jobs.tsx (frontend) - T310; the frontend copy is
// removed separately (T625).
// Board types (jobBoardCreateSchema below) are a separate contract; do not merge.
const registrySourceIds = allSourceIds();
if (registrySourceIds.length === 0) {
  throw new Error('Provider registry must declare at least one job source id');
}
// z.enum needs a non-empty tuple type; the registry always declares all 14
// providers (pinned by providerRegistry.test.ts), so this is a narrowing
// cast only - the public type stays a tuple, never string[].
export const JOB_SOURCE_VALUES = registrySourceIds as unknown as readonly [string, ...string[]];
export const jobSourceEnum = z.enum(JOB_SOURCE_VALUES);

export const jobSearchSchema = z.object({
  q: z.string().min(2, 'Query too short').max(200, 'Query too long'),
  sources: z.array(jobSourceEnum).max(JOB_SOURCE_VALUES.length).optional(),
  limit: z.number().int().min(1).max(100).optional().default(30),
  postedWithin: z.enum(['day', 'week', 'month']).optional(),
  runId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  // ADR-021 decision 6 / C8: location arrives repeated / comma-joined / as a
  // JSON-array literal, so the route parses it first (parseLocationParam) and
  // this schema validates the already-parsed array. A blank location parses to
  // [] and is passed as undefined (no filtering).
  location: z.array(z.string().max(80, 'Location too long')).max(10, 'Too many locations').optional(),
  company: z.string().max(100, 'Company name too long').optional(),
});

export const jobLocationsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
});

export const evaluateJobSchema = z.object({
  resumeId: z.string().uuid('Invalid resume ID'),
  // Optional: when the caller supplies no description the route falls back to
  // the stored listing text (guarded by the no_description 400). A supplied
  // value must still meet the 50-char minimum.
  jobDescription: z.string().min(50, 'Job description too short').max(20000, 'Job description too long').optional(),
});

// ==================== JD MARKDOWN NORMALIZATION SCHEMAS ====================
// ADR-020 decisions 4-8: on-demand opt-in single/batch endpoints, batch cap 20.
export const normalizeJobSchema = z.object({
  id: z.string().uuid('Invalid job ID'),
});

export const normalizeBatchSchema = z.object({
  ids: z
    .array(z.string().uuid('Invalid job ID'))
    .min(1, 'At least one job ID is required')
    .max(20, 'At most 20 job IDs per batch'),
}).transform((data) => ({ ids: [...new Set(data.ids)] }));

export const tailorResumeSchema = z.object({
  jobEvaluationId: z.string().uuid().optional(),
  jobDescription: z.string().min(50, 'Job description too short').max(20000).optional(),
  resumeId: z.string().uuid('Invalid resume ID'),
  templateId: z.string().min(1, 'Template is required').max(50),
  jobListingId: z.string().uuid().optional(),
}).refine(
  (data) => data.jobEvaluationId || data.jobDescription,
  { message: 'Provide either jobEvaluationId or jobDescription' },
);

export const createApplicationSchema = z.object({
  jobListingId: z.string().uuid('Invalid job listing ID'),
  tailoredResumeId: z.string().uuid().optional(),
  status: z.enum(['saved', 'tailored', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted']).default('saved'),
  notes: z.string().max(2000).optional(),
});

export const updateApplicationSchema = z.object({
  status: z.enum(['saved', 'tailored', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted']).optional(),
  notes: z.string().max(2000).optional(),
  appliedAt: z.string().datetime().optional(),
  followUpAt: z.string().datetime().nullable().optional(),
  ghostedAt: z.string().datetime().nullable().optional(),
  withdrawnAt: z.string().datetime().nullable().optional(),
});

// ==================== APPLICATION EVENT SCHEMAS ====================
export const applicationEventTypeSchema = z.enum([
  'status_change', 'note_added', 'follow_up', 'interview_scheduled', 'offer_received', 'rejected', 'withdrawn',
]);

export const createApplicationEventSchema = z.object({
  type: applicationEventTypeSchema,
  fromStatus: z.string().max(50).optional(),
  toStatus: z.string().max(50).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

export const updateApplicationEventSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
});

// ==================== CAREER PROFILE SCHEMAS ====================
// `seniorityEnum` is defined in `./seniority.js` and re-exported from this
// module's header; it is used here (and by `discovery/searchIntent.ts`).

export const careerProfileSchema = z.object({
  targetRoles: z.array(z.string().max(100, 'Target role too long')).max(10, 'Too many target roles').nullish(),
  seniority: seniorityEnum.nullish(),
  minSalary: z.number().int().min(0).max(10000000).nullish(),
  maxSalary: z.number().int().min(0).max(10000000).nullish(),
  currency: z.string().max(10).nullish(),
  locationPref: z.union([z.string().max(100, 'Location too long'), z.array(z.string().max(80, 'Location too long')).max(10, 'Too many locations')]).nullish(),
  remoteOnly: z.boolean().nullish(),
  topSkills: z.array(z.string().max(50, 'Skill too long')).max(50, 'Too many skills').nullish(),
  industries: z.array(z.string().max(50)).max(30).nullish(),
  redFlags: z.array(z.string().max(50)).max(30).nullish(),
  proofPoints: z.array(z.string().max(500)).max(30).nullish(),
  summary: z.string().max(2000, 'Summary too long').nullish(),
  parsedFromResumeId: z.string().max(100).nullish(),
}).strip();

export function computeProfileComplete(data: Partial<z.infer<typeof careerProfileSchema>>): boolean {
  return (
    Array.isArray(data.targetRoles) &&
    data.targetRoles.length > 0 &&
    !!data.seniority &&
    Array.isArray(data.topSkills) &&
    data.topSkills.length > 0
  );
}

export const parseProfileSchema = z.object({
  resumeId: z.string().uuid('Invalid resume ID'),
});

export const parseProfileFromUploadedFileSchema = z.object({
  fileId: z.string().uuid('Invalid file ID'),
});

// Location-preference normalizers (ADR-019). `locationPref` stays a `String?`
// column: arrays are persisted as `JSON.stringify(array)`, plain strings pass
// through verbatim, and reads decode with the ADR-008 rule (a value that
// starts with '[' and ends with ']' is treated as a JSON array). Both helpers
// are pure and never throw.
function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function normalizeLocationPref(raw: unknown): string[] {
  try {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) {
      const cleaned = raw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      return dedupeCaseInsensitive(cleaned);
    }
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // Not valid JSON: use the raw string literally.
          return [trimmed];
        }
        // Valid JSON but not an array: no list entries to return.
        if (!Array.isArray(parsed)) return [];
        const cleaned = parsed
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        return dedupeCaseInsensitive(cleaned);
      }
      return [trimmed];
    }
    return [];
  } catch {
    return [];
  }
}

export function serializeLocationPref(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const normalized = normalizeLocationPref(value);
    if (normalized.length === 0) return null;
    return JSON.stringify(normalized);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

// The resume path stringifies bounded structured fields while uploaded text is
// arbitrary, so this path needs a cap before the text reaches the LLM.
export const MAX_PROFILE_PARSE_CHARS = 40_000;

// ==================== JOB BOARD SCHEMAS ====================
export const jobBoardCreateSchema = z.object({
  type: z.enum(['greenhouse', 'ashby', 'lever', 'workday', 'rss']),
  name: z.string().min(1, 'Name required').max(100),
  boardId: z.string().max(200).optional(),
  feedUrl: z.string().url().optional().or(z.literal('')),
  isActive: z.boolean().optional(),
});

export const jobBoardUpdateSchema = jobBoardCreateSchema.partial();

// ADR-008 wire type: `string | string[]`. Arrays persist as JSON.stringify in
// the existing String? columns (serializeLocationPref); plain strings pass
// through verbatim so legacy rows keep working.
export const locationArrayOrStringSchema = z.union([
  z.string().max(100),
  z.array(z.string().max(80)).max(10),
]);

// ==================== SAVED SEARCH SCHEMAS ====================
// Wave 12 (T842) - optional intent + the no-criteria rule. Wave-12 spec SCOPE
// item 3, CONSTRAINTS, ACCEPTANCE CRITERION 8 and the empty-intent edge case
// (decisions ADR-027/ADR-028).
//
// `intent` is ADDITIVE: a payload without `intent` validates exactly as
// before (same fields, same messages). `intent` itself is validated by wave
// 7's `searchIntentSchema` - the ONLY intent validator, so its array caps
// (and the wave-7 failure messages) apply here without restatement: a
// too-large intent fails at `searchIntentSchema`.
//
// Criteria rule (explicit, ACCEPTANCE CRITERION 8): a payload must carry
// criteria from EITHER source - a usable `query` OR a criteria-bearing
// intent. On the CREATE schemas `query` is therefore conditionally optional:
// with a criteria-bearing intent it may be absent or empty; with NEITHER, the
// payload is rejected. The single shared predicate is
// `intentCarriesCriteria` (T840's `isEmptyIntent`, reused - no duplicated
// logic), so the rule cannot drift between the two tables.
//
// Legacy fidelity: with NO intent key present the refinement re-enforces the
// ORIGINAL required+min query rule with the ORIGINAL messages (the base
// object keeps the original type+max rule verbatim). Refinements also run
// when other fields fail, and they append after base issues, so legacy
// payloads - valid, single-violation, or multi-violation - reject with the
// same issues as the pre-wave-12 schema; the single documented nuance is
// issue ORDER when a query required/min failure co-occurs with a later-field
// failure (refinement issues append last). Status codes are unaffected (still
// 400). A union or preprocess alternative would change EVERY failure
// message, so this is the highest-fidelity shape available.
//
// With an intent that is present but expresses nothing and no usable query,
// rejection carries the explicit documented `NO_SEARCH_CRITERIA_MESSAGE`
// (a 400 via `validateInput`, hence via the routes using these schemas).
//
// PARTIAL updates carry no criteria rule: a PATCH that edits only `name` (or
// any unrelated field) validates without sending an intent, and the stored
// row's criteria (not the patch body) decide runnability - T843/T844 own that
// merge. Updates still validate a supplied intent with `searchIntentSchema`,
// and still enforce the original min rule on a SUPPLIED query.
export const NO_SEARCH_CRITERIA_MESSAGE =
  'Provide a query or an intent that carries search criteria';

/** The ONE criteria predicate shared by both create schemas (T842). True only
 * for a present intent that T840's `isEmptyIntent` does NOT consider empty:
 * only real criteria count (query text, roles, skills, seniority, exclusions,
 * locations, companies, remoteOnly) - modifiers (`mode`, `limit`,
 * `postedWithin`, `evaluate`, `sourceGroups`, scores, notification flags)
 * never do. Invalid intents read as `false` (they carry nothing verifiable);
 * the base object already reports them, so this never throws. */
export function intentCarriesCriteria(intent: unknown): boolean {
  return readIntent(intent) === 'criteria';
}

/**
 * The Full-scan route is client-driven and batched, while saved-search/alert
 * replay is a single request with no cursor loop.  A Full intent therefore must
 * never be written to either table (ADR-033 decisions 1 and 4).  Keep the
 * persistable set derived from the canonical SearchIntent vocabulary so this
 * guard cannot grow a second, drifting mode list.
 */
export const FULL_MODE_NOT_PERSISTABLE_CODE = 'full_mode_not_persistable' as const;
export const FULL_MODE_NOT_PERSISTABLE_MESSAGE =
  'Full mode cannot be saved to a saved search or alert. Choose Standard or Deep instead.';

const PERSISTABLE_INTENT_MODES: ReadonlySet<string> = new Set(
  SEARCH_MODES.filter((mode) => mode !== 'full'),
);

/**
 * Shared Zod refinement for every create/update schema that accepts an intent.
 * It deliberately validates the intent with the canonical schema first, so
 * malformed intents keep their existing wave-7 diagnostics; a valid Full
 * intent receives the stable, coded persistence error instead.  The issue
 * params are consumed by `validateInput` to preserve the HTTP error code.
 */
export function intentModePersistenceRefinement(
  data: { intent?: unknown },
  ctx: z.RefinementCtx,
): void {
  const parsed = searchIntentSchema.safeParse(data.intent);
  if (!parsed.success || PERSISTABLE_INTENT_MODES.has(parsed.data.mode)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['intent', 'mode'],
    message: FULL_MODE_NOT_PERSISTABLE_MESSAGE,
    params: { code: FULL_MODE_NOT_PERSISTABLE_CODE },
  });
}

/** Four-state reading of the wire `intent`: absent (no key), criteria-bearing,
 * present-but-empty, or failing `searchIntentSchema`. One place, so the rule
 * cannot drift between the two tables. Never throws (`safeParse` only -
 * `isEmptyIntent` runs solely on schema-valid data). */
function readIntent(intent: unknown): 'absent' | 'criteria' | 'empty' | 'invalid' {
  if (intent === undefined) return 'absent';
  const parsed = searchIntentSchema.safeParse(intent);
  if (!parsed.success) return 'invalid';
  return isEmptyIntent(parsed.data) ? 'empty' : 'criteria';
}

/** A `query` carrying real search text (blank strings express no criteria). */
function hasUsableQuery(query: unknown): boolean {
  return typeof query === 'string' && query.trim().length > 0;
}

/**
 * Re-enforce an ORIGINAL required+min query rule with its ORIGINAL messages
 * (legacy path: no intent key present at all). Only required+min live here:
 * the base object owns type+max, and refinements run on dirty bases too, so
 * re-checking those would duplicate the base issues. The `typeof` guard for
 * the same reason: a non-string query is already reported by the base.
 */
function addLegacyQueryIssues(
  ctx: z.RefinementCtx,
  query: unknown,
  originalMinRule: z.ZodString,
): void {
  if (query === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.invalid_type,
      expected: 'string',
      received: 'undefined',
      path: ['query'],
      message: 'Required',
    });
    return;
  }
  if (typeof query !== 'string') return;
  const result = originalMinRule.safeParse(query);
  if (!result.success) {
    for (const issue of result.error.issues) {
      ctx.addIssue({ ...issue, path: ['query'] });
    }
  }
}

/**
 * CREATE-schema criteria refinement for one table's ORIGINAL min query rule.
 * A criteria-bearing intent accepts (query optional); no intent key means
 * pure legacy behaviour; a present-but-empty intent accepts iff the query is
 * usable, else rejects with the documented no-criteria error. An invalid
 * intent is left to the base object (already reported - don't pile on).
 */
function criteriaRefinement(originalMinRule: z.ZodString) {
  return (
    data: { query?: unknown; intent?: unknown },
    ctx: z.RefinementCtx,
  ): void => {
    const reading = readIntent(data.intent);
    if (reading === 'criteria') return;
    if (reading === 'absent') {
      addLegacyQueryIssues(ctx, data.query, originalMinRule);
      return;
    }
    if (reading === 'invalid') return;
    if (hasUsableQuery(data.query)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['query'],
      message: NO_SEARCH_CRITERIA_MESSAGE,
    });
  };
}

/**
 * UPDATE-schema query refinement for one table's ORIGINAL min query rule:
 * `query` stays optional and is never required, but a SUPPLIED string must
 * satisfy the original min rule (preserves the pre-wave-12 min-1 rejection).
 * Type+max stay owned by the base (dirty-base duplicate guard, as above).
 * No criteria rule here by design (see the section comment).
 */
function updateQueryRefinement(originalMinRule: z.ZodString) {
  return (
    data: { query?: unknown },
    ctx: z.RefinementCtx,
  ): void => {
    if (data.query === undefined) return;
    if (typeof data.query !== 'string') return;
    const result = originalMinRule.safeParse(data.query);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ ...issue, path: ['query'] });
      }
    }
  };
}

// ORIGINAL per-table query minima, factored so the refinements reproduce their
// messages exactly (type+max stay inline in the base objects). Do NOT change
// these without changing the wire contract: every legacy message below is
// asserted in `validation.test.ts`.
const savedSearchQueryMinRule = z.string().min(1);
const jobAlertQueryMinRule = z.string().min(1, 'Query is required');

const savedSearchBaseSchema = z.object({
  name: z.string().min(1, 'Name required').max(100),
  // Relaxed from the original required rule: the CREATE refinement restores
  // required+min on the legacy path; the UPDATE refinement restores min on a
  // supplied value. Type+max stay here so those failures keep their exact
  // base-object messages on every path (the cap is never relaxed).
  query: z.string().max(200).optional(),
  location: locationArrayOrStringSchema.optional(),
  company: z.string().max(100).optional(),
  boards: z.array(z.string()).max(10).optional(),
  // Wave 7's schema is the ONLY intent validator - no second schema, no
  // restated caps (STEP 3).
  intent: searchIntentSchema.optional(),
});

export const savedSearchCreateSchema =
  savedSearchBaseSchema.superRefine((data, ctx) => {
    intentModePersistenceRefinement(data, ctx);
    criteriaRefinement(savedSearchQueryMinRule)(data, ctx);
  });

export const savedSearchUpdateSchema =
  savedSearchBaseSchema.partial().superRefine((data, ctx) => {
    intentModePersistenceRefinement(data, ctx);
    updateQueryRefinement(savedSearchQueryMinRule)(data, ctx);
  });

// Score a resume against a job description using the 3-factor ATS scorer.
export const scoreJobSchema = z.object({
  resumeId: z.string().min(1),
  jobDescription: z.string().min(1),
});

// ==================== JOB ALERT SCHEMAS ====================
// Same wave-12 additive-intent treatment as the saved-search schemas above:
// `intent` optional everywhere, criteria rule on create only, original query
// rule (`min(1, 'Query is required')`, `max(500, 'Query too long')`)
// reproduced exactly on the legacy path. NOTE the asymmetry the task calls
// out: this schema's wire shape is the route contract (`job-alerts.ts` uses
// it directly), so fidelity here is load-bearing for the 400s below.
const jobAlertBaseSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
  // Relaxed as above: CREATE restores required+min without an intent,
  // UPDATE restores min on a supplied value; type+max stay in the base.
  query: z.string().max(500, 'Query too long').optional(),
  location: locationArrayOrStringSchema.optional().nullable(),
  sources: z.array(z.string()).max(20).optional().nullable(),
  savedSearchId: z.string().optional().nullable(),
  minMatchScore: z.number().int().min(0).max(100).optional().nullable(),
  remoteOnly: z.boolean().optional(),
  isActive: z.boolean().optional(),
  notifyInApp: z.boolean().optional(),
  notifyEmail: z.boolean().optional(),
  // Wave 7's schema is the ONLY intent validator - no second schema, no
  // restated caps (STEP 3).
  intent: searchIntentSchema.optional(),
});

export const createJobAlertSchema =
  jobAlertBaseSchema.superRefine((data, ctx) => {
    intentModePersistenceRefinement(data, ctx);
    criteriaRefinement(jobAlertQueryMinRule)(data, ctx);
  });

export const updateJobAlertSchema =
  jobAlertBaseSchema.partial().superRefine((data, ctx) => {
    intentModePersistenceRefinement(data, ctx);
    updateQueryRefinement(jobAlertQueryMinRule)(data, ctx);
  });

// ==================== QUESTION ANSWER SCHEMAS ====================
export const createQuestionAnswerSchema = z.object({
  question: z.string().min(1, 'Question is required').max(2000, 'Question too long'),
  answer: z.string().min(1, 'Answer is required').max(5000, 'Answer too long'),
  category: z.string().max(100).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  tags: z.array(z.string().max(50)).max(20).optional().nullable(),
});

export const updateQuestionAnswerSchema = createQuestionAnswerSchema.partial();

// ==================== RESUME REVISION SCHEMAS (T1030) ====================
// The canonical resume document itself is validated by resume/json/validate.ts against
// the JSON Resume + x-clearance draft-07 schema, NOT by zod: the document's shape is
// an interchange contract with a whole ecosystem (ADR-035), and a second, divergent
// zod copy of it is exactly the kind of thing that silently stops matching. So these
// schemas cover the REQUEST ENVELOPE only, and `document` is passed through as an
// opaque value for the draft-07 validator to judge.

export const createResumeRevisionSchema = z
  .object({
    /** Opaque here; validated by validateResumeJson in resume/json/validate.ts. */
    document: z.unknown(),
    reason: z.string().max(500, 'Reason too long').optional().nullable(),
    /** engine/version pins recorded with the snapshot so a later render is reproducible. */
    enginePins: z.record(z.unknown()).optional(),
    usages: z
      .array(
        z.object({
          claimId: z.string().min(1, 'claimId is required').max(100),
          usage: z.enum(['verbatim', 'tailored', 'omitted']),
          renderedText: z.string().max(5000, 'renderedText too long').optional().nullable(),
        }),
      )
      .max(500, 'Too many claim usages')
      .optional(),
    changes: z
      .array(
        z.object({
          op: z.enum([
            'rewrite_bullet',
            'reword_summary',
            'reorder',
            'include',
            'exclude',
            'add_skill',
            'remove_skill',
            'retitle',
            'customize_style',
          ]),
          jsonPath: z.string().min(1, 'jsonPath is required').max(200),
          before: z.unknown().optional(),
          after: z.unknown().optional(),
          reason: z.string().max(500).optional().nullable(),
          targetRequirementIds: z.array(z.string().max(100)).max(100).optional(),
          sourceClaimIds: z.array(z.string().max(100)).max(100).optional(),
          accepted: z.boolean().optional(),
        }),
      )
      .max(200, 'Too many changes')
      .optional(),
  })
  .strict();

export const listResumeRevisionsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

// ==================== JSON RESUME IMPORT SCHEMA (T1030) ====================

export const importJsonResumeSchema = z
  .object({
    profileId: z.string().min(1, 'profileId is required').max(100),
    /** A plain JSON Resume document. Validated by validateResumeJson, not by zod. */
    document: z.unknown(),
    title: z.string().max(200, 'Title too long').optional(),
  })
  .strict();

// ==================== CAREER IMPORT / VERIFICATION SCHEMAS (T1020) ====================
//
// The REQUEST ENVELOPE only - the same split as the revision schemas above. The
// `status` / `kind` vocabularies are read from the generated Prisma enums rather than
// restated as string literal tuples, so a status added to the schema later cannot leave
// a stale, silently-accepting copy of the vocabulary here.
//
// Deliberately ABSENT from every create schema below: a `status`. A caller cannot send
// one, so there is no request that could ask for a confirming status to be written - and
// ADR-036 item 3 makes that status reachable only through `career/verification.ts`, in the
// same transaction as its `ClaimVerification` audit row. `confirm: true` is the only way
// a body can cause a confirmation, and it is a USER gesture that still goes through the
// verification service.

export const careerClaimKindSchema = z.nativeEnum(ClaimKind);
export const careerClaimStatusSchema = z.nativeEnum(ClaimStatus);

export const importCareerResumeSchema = z
  .object({
    /**
     * Optional. When absent, the caller's own CareerProfile is resolved and created on
     * demand (the same shape `PUT /profile` already uses); when present it is loaded and
     * `ensureOwnership`-checked, so another tenant's profileId is a 403 rather than a
     * silent write into their rows.
     */
    profileId: z.string().min(1, 'profileId is required').max(100).optional(),
    /** Import an already-uploaded raw file's stored extracted text instead of a new upload. */
    uploadedFileId: z.string().min(1, 'uploadedFileId is required').max(100).optional(),
    title: z.string().max(200, 'Title too long').optional(),
  })
  .strict();

export const listCareerClaimsSchema = z.object({
  status: careerClaimStatusSchema.optional(),
  kind: careerClaimKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

export const listCareerSourcesSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

export const createCareerClaimSchema = z
  .object({
    /** Present = an EDIT of an existing claim; absent = a new hand-entered claim. */
    id: z.string().min(1, 'id is required').max(100).optional(),
    profileId: z.string().min(1, 'profileId is required').max(100).optional(),
    /** Required for a create; ignored on an edit (a different kind is a different claim). */
    kind: careerClaimKindSchema.optional(),
    statement: z.string().min(1, 'statement is required').max(4000, 'statement too long'),
    note: z.string().max(500, 'note too long').optional().nullable(),
    /**
     * The user asking for the edit to also confirm it, or for a brand-new claim to be
     * confirmed on creation. Both still write a `ClaimVerification` row through
     * `career/verification.ts`; there is no way to skip the audit row.
     */
    confirm: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.id !== undefined || data.kind !== undefined, {
    message: 'kind is required when creating a claim (no id given)',
  });

/** Body of `/claims/:id/confirm` and `/claims/:id/reopen`. */
export const careerClaimDecisionSchema = z
  .object({
    note: z.string().max(500, 'note too long').optional().nullable(),
    /** `edit_confirm`: re-word and confirm in one gesture. */
    statement: z.string().min(1, 'statement is required').max(4000, 'statement too long').optional(),
  })
  .strict();

/** Body of `/claims/:id/reject`. */
export const careerClaimRejectSchema = z
  .object({
    note: z.string().max(500, 'note too long').optional().nullable(),
    reason: z.string().max(500, 'reason too long').optional().nullable(),
  })
  .strict();

// ==================== UTILITY FUNCTIONS ====================
export function validateInput<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fullModeIssue = result.error.issues.find(
      (issue) =>
        issue.code === z.ZodIssueCode.custom &&
        issue.params?.code === FULL_MODE_NOT_PERSISTABLE_CODE,
    );
    if (fullModeIssue) throw new FullModeNotPersistableError();
    const errors = result.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new ValidationError(`Validation failed: ${errors}`);
  }
  return result.data;
}

// Custom error for validation
export class ValidationError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Coded 400 raised by `validateInput` for a persistable-intent refinement. */
export class FullModeNotPersistableError extends ValidationError {
  readonly code = FULL_MODE_NOT_PERSISTABLE_CODE;

  constructor() {
    super(FULL_MODE_NOT_PERSISTABLE_MESSAGE);
    this.name = 'FullModeNotPersistableError';
  }
}

// Type exports
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ResumeInput = z.infer<typeof resumeSchema>;
export type CreateResumeInput = z.infer<typeof createResumeSchema>;
export type UpdateResumeInput = z.infer<typeof updateResumeSchema>;
export type CreateVariantInput = z.infer<typeof createVariantSchema>;
export type JobMatchInput = z.infer<typeof jobMatchSchema>;
