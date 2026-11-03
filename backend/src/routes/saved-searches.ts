// Saved Search routes (per-user).
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { ensureSearchDocument } from '../search/refresh.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import {
  validateInput,
  serializeLocationPref,
  normalizeLocationPref,
  intentCarriesCriteria,
  intentModePersistenceRefinement,
  FullModeNotPersistableError,
  NO_SEARCH_CRITERIA_MESSAGE,
} from '../shared/validation.js';
import { runSource, boardToConfig } from '../jobSources/index.js';
import { recordSourceSuccess, recordSourceFailure } from '../jobSources/sourceHealth.js';
import { dedupeJobs, withDeterministicExternalId } from '../jobSources/jobIdentity.js';
import type { SourceRef } from '../discovery/dedupe.js';
import {
  provenanceCreateData,
  provenanceUpdateData,
  shapeListingResponse,
  type PersistableJob,
} from '../discovery/persistence.js';
// Wave 12 (T843): the intent is canonical, the legacy string columns are kept
// and populated (spec SCOPE items 2-4). Derivation lives in T840's pure
// module - this route only decides WHEN to derive, never HOW.
import { searchIntentSchema, type SearchIntent } from '../discovery/searchIntent.js';
import { DEEP_RUN_TTL_MS } from '../discovery/budgets.js';
import {
  deriveIntentForRow,
  intentToLegacy,
  legacyToIntent,
} from '../discovery/intentPersistence.js';
// Wave 12 (T843, STEP 4): replay goes through the wave-7 orchestrator with a
// freshly minted runId (ADR-024). The snapshot is pollable through the
// existing GET /jobs/runs/:runId endpoint; no background runner (ADR-013).
import {
  runSearch,
  type ExecutableUnit,
  type UserBoardRef,
} from '../discovery/orchestrator.js';
import {
  beginRun,
  markRunning,
  markOk,
  markFailed,
  markNeedsKey,
  markCancelled,
  finishRun,
  setRunEvaluation,
  setRunMode,
  isLikelyMissingKeyError,
} from '../jobSources/discoveryRuns.js';

// Wave 12 (T843, T842): `intent` is ADDITIVE on create. A criteria-bearing
// intent makes `query` optional (it is derived from the intent); a legacy
// payload without an intent keeps the ORIGINAL required+min `query` rule with
// its ORIGINAL messages (the refinement below reproduces them - the base
// keeps type+max verbatim so those failures are unchanged).
const createSchema = z.object({
  name: z.string().min(1, 'Name required').max(100),
  query: z.string().max(200).optional(),
  // ADR-008 wire type: string | string[]. Arrays persist as JSON.stringify
  // via serializeLocationPref; plain strings pass through verbatim.
  location: z.union([z.string().max(100), z.array(z.string().max(80)).max(10)]).optional().nullable(),
  company: z.string().max(100).optional(),
  boards: z.array(z.string()).max(10).optional(),
  minMatchScore: z.number().int().min(0).max(100).nullable().optional(),
  remoteOnly: z.boolean().optional(),
  sortBy: z.string().max(50).optional(),
  // Wave 7's schema is the ONLY intent validator - no second schema (T842).
  intent: searchIntentSchema.optional(),
}).superRefine((data, ctx) => {
  intentModePersistenceRefinement(data, ctx);
  // A criteria-bearing intent carries the search: `query` may be absent.
  if (intentCarriesCriteria(data.intent)) return;
  if (data.intent === undefined) {
    // Legacy path: restore the original required+min rule exactly.
    if (data.query === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.invalid_type,
        expected: 'string',
        received: 'undefined',
        path: ['query'],
        message: 'Required',
      });
      return;
    }
    // A non-string query is already reported by the base - don't pile on.
    if (typeof data.query !== 'string') return;
    if (data.query.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_small,
        minimum: 1,
        type: 'string',
        inclusive: true,
        path: ['query'],
        message: 'String must contain at least 1 character(s)',
      });
    }
    return;
  }
  // Present but not criteria-bearing: an invalid intent is already reported
  // by the base object, so only a VALID-but-empty intent without a usable
  // query is rejected here (T842's shared no-criteria message).
  if (searchIntentSchema.safeParse(data.intent).success) {
    if (typeof data.query === 'string' && data.query.trim().length > 0) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['query'],
      message: NO_SEARCH_CRITERIA_MESSAGE,
    });
  }
});

// PATCH accepts the same client-editable fields plus ranking/display prefs.
// Server-controlled fields (lastRunAt, matchCount) are intentionally absent
// so clients can never set them. No criteria rule on update by design (T842):
// a rename-only PATCH validates without sending an intent, and the route
// (not the schema) owns the no-rewrite behaviour (STEP 2).
const updateSchema = z.object({
  name: z.string().min(1, 'Name required').max(100).optional(),
  query: z.string().min(1).max(200).optional(),
  location: z.union([z.string().max(100), z.array(z.string().max(80)).max(10)]).nullable().optional(),
  company: z.string().max(100).nullable().optional(),
  boards: z.array(z.string()).max(10).nullable().optional(),
  minMatchScore: z.number().int().min(0).max(100).nullable().optional(),
  remoteOnly: z.boolean().optional(),
  sortBy: z.string().max(50).optional(),
  intent: searchIntentSchema.optional(),
}).superRefine((data, ctx) => {
  intentModePersistenceRefinement(data, ctx);
});

function safeRegistry(fn: () => void): void {
  try {
    fn();
  } catch {
    // Registry bugs must never fail the request.
  }
}

function registryErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 500);
}

function handleSavedSearchError(error: unknown, res: Response): void {
  if (error instanceof FullModeNotPersistableError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  handleApiError(error, res);
}

/**
 * Replay intent for a stored row (T843 STEP 3/4). A row with a valid stored
 * intent replays it; a pre-migration `intent: null` row derives one on the
 * fly and is NEVER written back here (persistence happens only on update).
 *
 * Adversarial-but-legal legacy queries (e.g. a single >100-char token, which
 * `deriveIntent` rejects although the legacy column accepts it - see
 * `intentForLegacySearch` in routes/jobs.ts) fall back to a structureless
 * intent that keeps the VERBATIM query plus the row's own scoping
 * (locations/companies/remoteOnly). The saved-sources board filter below
 * still applies, so the fallback can never widen the scope - a loud 500
 * stays reserved for a fallback that itself cannot validate (rethrow), never
 * for a silent whole-registry search (ADR-026/027).
 */
function replayIntentForRow(row: {
  query?: string | null;
  location?: string | null;
  company?: string | null;
  sources?: unknown;
  remoteOnly?: boolean;
  intent?: unknown;
}): SearchIntent {
  try {
    return deriveIntentForRow(row);
  } catch (originalError) {
    const raw = typeof row.query === 'string' ? row.query.slice(0, 200) : '';
    try {
      return searchIntentSchema.parse({
        ...(raw.trim().length > 0 ? { query: raw.trim() } : {}),
        locations: normalizeLocationPref(row.location ?? null),
        ...(typeof row.company === 'string' && row.company.trim().length > 0
          ? { companies: [row.company.trim()] }
          : {}),
        remoteOnly: row.remoteOnly === true,
      });
    } catch {
      throw originalError;
    }
  }
}

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const searches = await prisma.savedSearch.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
    // Read-path derivation (STEP 3): a pre-migration null-intent row derives
    // on the fly via T840 and is NOT written back. A row whose stored intent
    // is valid is returned normalised; a row that cannot derive keeps the
    // pre-wave `intent: null` shape rather than failing the whole list.
    res.json(
      searches.map((s) => {
        try {
          return { ...s, intent: replayIntentForRow(s) };
        } catch {
          return s;
        }
      }),
    );
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, query, location, company, boards, minMatchScore, remoteOnly, sortBy, intent } =
      validateInput(createSchema, req.body);
    // STEP 1 - WITH an intent: store it, derive the legacy columns from it
    // via T840 so old readers keep working. Explicit ranking modifiers still
    // win (the intent cannot carry minMatchScore/sortBy - T840 loss 5).
    // WITHOUT an intent (legacy caller): keep the caller's legacy values
    // VERBATIM (no lossy re-derivation of `query` from a just-derived
    // intent) and store a derived intent alongside - every row has an intent
    // after this wave. A valid-but-empty intent is treated as absent: with a
    // usable query the legacy path below applies; without one the schema
    // above already rejected the payload.
    if (intent !== undefined && intentCarriesCriteria(intent)) {
      // Re-parse to the canonical output type (defaults filled in).
      const stored = searchIntentSchema.parse(intent);
      const derived = intentToLegacy(stored);
      const search = await prisma.savedSearch.create({
        data: {
          userId: req.user!.id, name,
          query: derived.query ?? '',
          location: derived.location ?? null,
          company: derived.company ?? null,
          sources: ((derived.sources ?? null) as any),
          ...(minMatchScore !== undefined ? { minMatchScore } : { minMatchScore: derived.minMatchScore ?? null }),
          remoteOnly: derived.remoteOnly ?? false,
          ...(sortBy !== undefined ? { sortBy } : { sortBy: derived.sortBy ?? 'relevance' }),
          intent: stored as any,
        },
      });
      res.status(201).json(search);
      return;
    }
    const storedLocation = serializeLocationPref(location);
    const storedSources = (boards || null) as any;
    const storedCompany = company || null;
    const storedRemoteOnly = remoteOnly ?? false;
    const search = await prisma.savedSearch.create({
      data: {
        userId: req.user!.id, name, query: query ?? '',
        location: storedLocation,
        company: storedCompany, sources: storedSources,
        ...(minMatchScore !== undefined ? { minMatchScore } : {}),
        ...(remoteOnly !== undefined ? { remoteOnly } : {}),
        ...(sortBy !== undefined ? { sortBy } : {}),
        intent: legacyToIntent({
          query: query ?? '',
          location: storedLocation,
          company: storedCompany,
          sources: storedSources,
          remoteOnly: storedRemoteOnly,
        }) as any,
      },
    });
    res.status(201).json(search);
  } catch (error) {
    handleSavedSearchError(error, res);
  }
});

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(updateSchema, req.body);
    const s = await prisma.savedSearch.findUnique({ where: { id: req.params.id } });
    if (!s) throw new NotFoundError('Saved Search');
    if (s.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    // STEP 2 - explicit "does this payload carry filter changes" check. Only
    // a criteria-bearing intent or an intent-carried legacy field
    // (query/location/company/boards/remoteOnly) re-derives. A payload
    // changing only `name` - or only the intent-uncarried modifiers
    // minMatchScore/sortBy (T840 loss 5: deriving would CLOBBER a rich stored
    // intent's mode/exclusions) - leaves `intent` and the derived columns
    // untouched. A valid-but-empty supplied intent is treated as absent.
    if (body.intent !== undefined && intentCarriesCriteria(body.intent)) {
      // Re-parse to the canonical output type (defaults filled in).
      const stored = searchIntentSchema.parse(body.intent);
      const derived = intentToLegacy(stored);
      const updated = await prisma.savedSearch.update({
        where: { id: s.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          query: derived.query ?? '',
          location: derived.location ?? null,
          company: derived.company ?? null,
          sources: ((derived.sources ?? null) as any),
          // T840 note: the intent carries no minMatchScore/sortBy - merge
          // them from the existing row unless the payload overrides them.
          minMatchScore: body.minMatchScore !== undefined ? body.minMatchScore : s.minMatchScore,
          remoteOnly: derived.remoteOnly ?? false,
          sortBy: body.sortBy !== undefined ? body.sortBy : s.sortBy,
          intent: stored as any,
        },
      });
      res.json(updated);
      return;
    }
    const hasFilterChange =
      body.query !== undefined ||
      body.location !== undefined ||
      body.company !== undefined ||
      body.boards !== undefined ||
      body.remoteOnly !== undefined;
    const updated = await prisma.savedSearch.update({
      where: { id: s.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.query !== undefined ? { query: body.query } : {}),
        ...(body.location !== undefined ? { location: serializeLocationPref(body.location) } : {}),
        ...(body.company !== undefined ? { company: body.company || null } : {}),
        ...(body.boards !== undefined ? { sources: (body.boards || null) as any } : {}),
        ...(body.minMatchScore !== undefined ? { minMatchScore: body.minMatchScore } : {}),
        ...(body.remoteOnly !== undefined ? { remoteOnly: body.remoteOnly } : {}),
        ...(body.sortBy !== undefined ? { sortBy: body.sortBy } : {}),
        // A legacy filter edit re-derives the intent from the MERGED legacy
        // values (the edited string is now canonical). Modifiers-only edits
        // skip this: the stored intent survives untouched.
        ...(hasFilterChange
          ? {
              intent: legacyToIntent({
                query: body.query ?? s.query,
                location: body.location !== undefined ? serializeLocationPref(body.location) : s.location,
                company: body.company !== undefined ? (body.company || null) : s.company,
                sources: body.boards !== undefined ? (body.boards || null) : (s.sources as unknown),
                remoteOnly: body.remoteOnly ?? s.remoteOnly,
              }) as any,
            }
          : {}),
      },
    });
    res.json(updated);
  } catch (error) {
    handleSavedSearchError(error, res);
  }
});

router.post('/:id/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const s = await prisma.savedSearch.findUnique({ where: { id: req.params.id } });
    if (!s) throw new NotFoundError('Saved Search');
    if (s.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });

    // STEP 4 - the SAME pipeline as a live search: the stored intent (or an
    // on-the-fly derivation for pre-migration rows - never written back)
    // through the wave-7 orchestrator with a freshly minted runId. No
    // special-casing: a deep-mode intent replays deep with the same budgets
    // and is cancellable via POST /jobs/runs/:runId/cancel, exactly like
    // live search. Company intents consult the registry through the
    // orchestrator's default resolver: names with no match report the wave-7
    // 'no registry match' skip (STEP 5) instead of erroring or widening.
    const intent = replayIntentForRow(s);
    const runId = `ss-${randomUUID()}`;

    // Resolve boards: either the saved search's selected boards or all active user boards.
    // The saved `sources` filter is NEVER widened here (ADR-026/027).
    const boardIds = (s.sources as string[] | null) || undefined;
    const boards = await prisma.jobBoard.findMany({
      where: { userId: req.user!.id, isActive: true, ...(boardIds ? { id: { in: boardIds } } : {}) },
    });
    safeRegistry(() =>
      beginRun(
        runId,
        req.user!.id,
        boards.map((b) => ({ id: b.id, name: b.name, type: b.type })),
        intent.mode === 'deep' ? DEEP_RUN_TTL_MS : undefined,
      ),
    );
    // ADR-033 (T887): record the mode this replay RESOLVED - fast for a
    // legacy null-intent row (derivation defaults to fast), otherwise the
    // stored intent's own mode - so a pollable snapshot reports the same
    // vocabulary as /search, /scan and /jobs/full-scan. This is the SAME
    // additive writer those routes use, so beginRun's signature and the
    // legacy snapshot shape stay unchanged. `intent.mode` is already the
    // schema-validated vocabulary (Full is not persistable here), so no
    // route-level coercion is needed.
    safeRegistry(() => setRunMode(runId, intent.mode));

    const outcome = await runSearch(
      intent,
      { runId, userId: req.user!.id },
      {
        listUserBoards: async (): Promise<UserBoardRef[]> =>
          boards.map((b) => ({
            boardId: b.id,
            name: b.name,
            type: b.type,
            config: { ...boardToConfig(b), userId: req.user!.id },
          })),
        // resolveCompanies intentionally omitted: the default registry-backed
        // resolver applies (STEP 5 semantics come from the orchestrator).
        executeUnit: async (unit: ExecutableUnit) => {
          // The executed query is the orchestrator-planned one (derived from
          // the intent, as for live search) - not the legacy string.
          const config = { ...unit.config, userId: req.user!.id };
          const boardId = unit.unitId.startsWith('board:')
            ? unit.unitId.slice('board:'.length)
            : unit.unitId;
          const startedAt = Date.now();
          safeRegistry(() => markRunning(runId, boardId));
          try {
            const jobs = await runSource(config);
            const latencyMs = Date.now() - startedAt;
            safeRegistry(() => markOk(runId, boardId, jobs.length, latencyMs));
            try {
              await recordSourceSuccess(boardId, jobs.length, latencyMs);
            } catch {
              // Health writes must never fail the request (sourceHealth also swallows errors).
            }
            return jobs;
          } catch (error) {
            const latencyMs = Date.now() - startedAt;
            safeRegistry(() => {
              const message = registryErrorMessage(error);
              if (isLikelyMissingKeyError(message)) markNeedsKey(runId, boardId, message);
              else markFailed(runId, boardId, message, latencyMs);
            });
            try {
              await recordSourceFailure(boardId, error, latencyMs);
            } catch {
              // Health writes must never fail the request (sourceHealth also swallows errors).
            }
            return [];
          }
        },
      },
    );

    // Post steps keep the run route's historical contract: dedupe -> limit
    // slice -> upsert with provenance -> shaped listings (no token-OR
    // post-filter added here).
    // Wave 3 (T665): provenance columns ride the same upsert; `firstSeenAt`
    // is stamped from the per-request `now` on create only and never moves.
    const now = new Date();
    const upserted = [];
    for (const job of dedupeJobs(outcome.jobs).slice(0, Number(req.query.limit) || 100)) {
      // Always sanitize (WIN1252-safe upsert) even when an externalId exists.
      const withId = withDeterministicExternalId(job);
      const persistable = withId as PersistableJob;
      const rec = await prisma.jobListing.upsert({
        where: { source_externalId: { source: withId.source, externalId: withId.externalId! } },
        update: { title: withId.title, company: withId.company, location: withId.location, description: withId.description, applyUrl: withId.applyUrl, sourceUrl: withId.sourceUrl, postedAt: withId.postedAt, ...provenanceUpdateData(persistable) },
        create: {
          source: withId.source, externalId: withId.externalId, sourceUrl: withId.sourceUrl, title: withId.title,
          company: withId.company, location: withId.location, description: withId.description, applyUrl: withId.applyUrl, postedAt: withId.postedAt,
          ...provenanceCreateData(persistable, now),
        },
      });
      await ensureSearchDocument(prisma, rec, now);
      upserted.push(persistable.sources && persistable.sources.length > 0 ? { ...rec, sources: persistable.sources } : rec);
    }

    // Wave 11 (T820) cancel retention + wave 9 (T783) evaluation summary: same
    // post-persist snapshot writes as the live-search routes.
    if (outcome.cancelled) safeRegistry(() => markCancelled(runId));
    safeRegistry(() => finishRun(runId, upserted.length));
    if (outcome.evaluation !== undefined) {
      const summary = outcome.evaluation;
      safeRegistry(() => setRunEvaluation(runId, summary));
    }

    // The listing array keeps its exact shape (existing fields intact); the
    // minted runId - pollable via GET /jobs/runs/:runId - and any
    // orchestrator skip reasons (e.g. the STEP-5 'no registry match' empty
    // scope) ride additive response headers.
    res.set('x-run-id', runId);
    if (outcome.skipped.length > 0) {
      res.set('x-run-skipped', JSON.stringify(outcome.skipped).slice(0, 2000));
    }
    res.json(upserted.map((j) => shapeListingResponse(j, { sources: (j as { sources?: SourceRef[] }).sources })));
  } catch (error) {
    handleApiError(error, res);
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const s = await prisma.savedSearch.findUnique({ where: { id: req.params.id } });
    if (!s) throw new NotFoundError('Saved Search');
    if (s.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    await prisma.savedSearch.delete({ where: { id: s.id } });
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
