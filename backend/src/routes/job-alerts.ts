// Job Alert routes - per-user alert management

import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { ensureSearchDocument } from '../search/refresh.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError } from '../shared/errors.js';
import { ensureOwnership } from '../shared/auth.js';
import {
  validateInput,
  createJobAlertSchema,
  updateJobAlertSchema,
  serializeLocationPref,
  normalizeLocationPref,
  intentCarriesCriteria,
  FullModeNotPersistableError,
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
// Wave 12 (T844): the intent is canonical, the legacy string columns are kept
// and populated (spec SCOPE items 2-4). Derivation lives in T840's pure
// module - this route only decides WHEN to derive, never HOW. No second copy:
// the two tables share `intentPersistence` so they cannot drift.
import { searchIntentSchema, type SearchIntent } from '../discovery/searchIntent.js';
import { DEEP_RUN_TTL_MS } from '../discovery/budgets.js';
import {
  deriveIntentForRow,
  intentToLegacy,
  legacyToIntent,
} from '../discovery/intentPersistence.js';
// Wave 12 (T844, STEP 2): replay goes through the wave-7 orchestrator with a
// freshly minted runId (ADR-024). The snapshot is pollable through the
// existing GET /jobs/runs/:runId endpoint; no background runner (ADR-013).
// The replay feeds the orchestrator an intent and lets the provider
// abstraction decide tiers - this route MUST NOT branch on a source's
// provider kind (spec scope item 6; any per-kind check here is a defect).
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

const router = Router();

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

function handleJobAlertError(error: unknown, res: Response): void {
  if (error instanceof FullModeNotPersistableError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  handleApiError(error, res);
}

/**
 * Replay intent for a stored row (T844 STEP 2). A row with a valid stored
 * intent replays it; a pre-migration `intent: null` row derives one on the
 * fly and is NEVER written back here (persistence happens only on update).
 *
 * Adversarial-but-legal legacy queries (e.g. a single >100-char token, which
 * `deriveIntent` rejects although the legacy column accepts it) fall back to
 * a structureless intent that keeps the VERBATIM query plus the row's own
 * scoping (locations/remoteOnly). The board filter below still applies, so
 * the fallback can never widen the scope - a loud 500 stays reserved for a
 * fallback that itself cannot validate (rethrow), never for a silent
 * whole-registry search (ADR-026/027).
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
        remoteOnly: row.remoteOnly === true,
      });
    } catch {
      throw originalError;
    }
  }
}

router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const alerts = await prisma.jobAlert.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
    });
    // Read-path derivation: a pre-migration null-intent row derives on the
    // fly via T840 and is NOT written back. A row whose stored intent is
    // valid is returned normalised; a row that cannot derive keeps the
    // pre-wave `intent: null` shape rather than failing the whole list.
    // Response shapes gain fields and lose none (AC 7).
    res.json(
      alerts.map((a) => {
        try {
          return { ...a, intent: replayIntentForRow(a) };
        } catch {
          return a;
        }
      }),
    );
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(createJobAlertSchema, req.body);

    if (body.savedSearchId) {
      const search = await prisma.savedSearch.findUnique({ where: { id: body.savedSearchId } });
      if (!search) throw new NotFoundError('Saved Search');
      if (search.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    }

    // STEP 1 - WITH a criteria-bearing intent: store it, derive the legacy
    // columns from it via T840 so old readers keep working. Explicit
    // modifiers still win (the intent carries no minMatchScore - T840
    // loss 5). WITHOUT an intent (legacy caller): keep the caller's legacy
    // values VERBATIM (no lossy re-derivation of `query` from a
    // just-derived intent) and store a derived intent alongside - every row
    // has an intent after this wave. A valid-but-empty intent is treated as
    // absent: with a usable query the legacy path below applies; without
    // one the schema above already rejected the payload.
    if (body.intent !== undefined && intentCarriesCriteria(body.intent)) {
      // Re-parse to the canonical output type (defaults filled in).
      const stored = searchIntentSchema.parse(body.intent);
      const derived = intentToLegacy(stored);
      const alert = await prisma.jobAlert.create({
        data: {
          userId: req.user!.id,
          name: body.name,
          query: derived.query ?? '',
          location: derived.location ?? null,
          sources: (derived.sources ?? null) as any,
          savedSearchId: body.savedSearchId ?? null,
          minMatchScore: body.minMatchScore ?? derived.minMatchScore ?? null,
          remoteOnly: body.remoteOnly ?? derived.remoteOnly ?? false,
          isActive: body.isActive ?? true,
          notifyInApp: body.notifyInApp ?? true,
          notifyEmail: body.notifyEmail ?? false,
          intent: stored as any,
        },
      });

      res.status(201).json(alert);
      return;
    }

    const storedLocation = serializeLocationPref(body.location);
    const storedSources = (body.sources ?? null) as any;
    const storedRemoteOnly = body.remoteOnly ?? false;
    const alert = await prisma.jobAlert.create({
      data: {
        userId: req.user!.id,
        name: body.name,
        query: body.query ?? '',
        location: storedLocation,
        sources: storedSources,
        savedSearchId: body.savedSearchId ?? null,
        minMatchScore: body.minMatchScore ?? null,
        remoteOnly: storedRemoteOnly,
        isActive: body.isActive ?? true,
        notifyInApp: body.notifyInApp ?? true,
        notifyEmail: body.notifyEmail ?? false,
        intent: legacyToIntent({
          query: body.query ?? '',
          location: storedLocation,
          sources: storedSources,
          remoteOnly: storedRemoteOnly,
        }) as any,
      },
    });

    res.status(201).json(alert);
  } catch (error) {
    handleJobAlertError(error, res);
  }
});

router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const body = validateInput(updateJobAlertSchema, req.body);
    const alert = await prisma.jobAlert.findUnique({ where: { id: req.params.id } });
    if (!alert) throw new NotFoundError('Job Alert');
    await ensureOwnership(req.user!.id, alert.userId, 'Job Alert');

    if (body.savedSearchId !== undefined) {
      if (body.savedSearchId) {
        const search = await prisma.savedSearch.findUnique({ where: { id: body.savedSearchId } });
        if (!search) throw new NotFoundError('Saved Search');
        if (search.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // STEP 1 (update) - explicit "does this payload carry filter changes"
    // check, mirroring T843. Only a criteria-bearing intent or an
    // intent-carried legacy field (query/location/sources/remoteOnly/
    // savedSearchId) re-derives. A payload changing only `name` - or only
    // the intent-uncarried modifiers (minMatchScore/isActive/notifyInApp/
    // notifyEmail) - leaves `intent` and the derived columns untouched, so a
    // rename never rewrites the intent. A valid-but-empty supplied intent is
    // treated as absent.
    if (body.intent !== undefined && intentCarriesCriteria(body.intent)) {
      // Re-parse to the canonical output type (defaults filled in).
      const stored = searchIntentSchema.parse(body.intent);
      const derived = intentToLegacy(stored);
      const updated = await prisma.jobAlert.update({
        where: { id: alert.id },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          query: derived.query ?? '',
          location: derived.location ?? null,
          sources: (derived.sources ?? null) as any,
          ...(body.savedSearchId !== undefined ? { savedSearchId: body.savedSearchId } : {}),
          // T840 note: the intent carries no minMatchScore - merge it from
          // the existing row unless the payload overrides it.
          minMatchScore: body.minMatchScore !== undefined ? body.minMatchScore : alert.minMatchScore,
          remoteOnly: body.remoteOnly ?? derived.remoteOnly ?? false,
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.notifyInApp !== undefined ? { notifyInApp: body.notifyInApp } : {}),
          ...(body.notifyEmail !== undefined ? { notifyEmail: body.notifyEmail } : {}),
          intent: stored as any,
        },
      });

      res.json(updated);
      return;
    }

    const hasFilterChange =
      body.query !== undefined ||
      body.location !== undefined ||
      body.sources !== undefined ||
      body.remoteOnly !== undefined ||
      body.savedSearchId !== undefined;
    const updated = await prisma.jobAlert.update({
      where: { id: alert.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.query !== undefined ? { query: body.query } : {}),
        ...(body.location !== undefined ? { location: serializeLocationPref(body.location) } : {}),
        ...(body.sources !== undefined ? { sources: body.sources as any } : {}),
        ...(body.savedSearchId !== undefined ? { savedSearchId: body.savedSearchId } : {}),
        ...(body.minMatchScore !== undefined ? { minMatchScore: body.minMatchScore } : {}),
        ...(body.remoteOnly !== undefined ? { remoteOnly: body.remoteOnly } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.notifyInApp !== undefined ? { notifyInApp: body.notifyInApp } : {}),
        ...(body.notifyEmail !== undefined ? { notifyEmail: body.notifyEmail } : {}),
        // A legacy filter edit re-derives the intent from the MERGED legacy
        // values (the edited string is now canonical). Modifiers-only edits
        // skip this: the stored intent survives untouched.
        ...(hasFilterChange
          ? {
              intent: legacyToIntent({
                query: body.query ?? alert.query,
                location: body.location !== undefined ? serializeLocationPref(body.location) : alert.location,
                sources: body.sources !== undefined ? (body.sources as unknown) : (alert.sources as unknown),
                remoteOnly: body.remoteOnly ?? alert.remoteOnly,
              }) as any,
            }
          : {}),
      },
    });

    res.json(updated);
  } catch (error) {
    handleJobAlertError(error, res);
  }
});

router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const alert = await prisma.jobAlert.findUnique({ where: { id: req.params.id } });
    if (!alert) throw new NotFoundError('Job Alert');
    await ensureOwnership(req.user!.id, alert.userId, 'Job Alert');
    await prisma.jobAlert.delete({ where: { id: alert.id } });
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

router.post('/:id/run', requireAuth, async (req: Request, res: Response) => {
  try {
    const alert = await prisma.jobAlert.findUnique({ where: { id: req.params.id } });
    if (!alert) throw new NotFoundError('Job Alert');
    await ensureOwnership(req.user!.id, alert.userId, 'Job Alert');

    // STEP 2 - PRESERVED: the `savedSearchId` precedence (a linked search
    // wins, as before). The replay intent comes from the linked saved search
    // (stored, or derived on the fly for pre-migration rows) or, without a
    // link, from the alert's own fields. Pre-migration `intent: null` rows
    // replay via derivation and are NEVER written back here.
    let searchRow: Awaited<ReturnType<typeof prisma.savedSearch.findUnique>> = null;
    if (alert.savedSearchId) {
      searchRow = await prisma.savedSearch.findUnique({ where: { id: alert.savedSearchId } });
      if (!searchRow) throw new NotFoundError('Saved Search');
    }
    const intent = replayIntentForRow(searchRow ?? alert);
    const runId = `alert-${randomUUID()}`;

    // PRESERVED: the board filter is NEVER widened here (ADR-026/027). With
    // a linked search the search's `sources` win; otherwise the alert's own
    // `sources`; otherwise (no sources anywhere) no boards run, as before.
    let boards: Awaited<ReturnType<typeof prisma.jobBoard.findMany>> = [];
    let requestedIds: string[] | undefined;
    if (searchRow) {
      const boardIds = (searchRow.sources as string[] | null) || undefined;
      requestedIds = boardIds;
      boards = await prisma.jobBoard.findMany({
        where: { userId: req.user!.id, isActive: true, ...(boardIds ? { id: { in: boardIds } } : {}) },
      });
    } else if (alert.sources) {
      const sourceIds = alert.sources as string[];
      requestedIds = sourceIds;
      boards = await prisma.jobBoard.findMany({
        where: { userId: req.user!.id, isActive: true, id: { in: sourceIds } },
      });
    }

    // Spec edge case: a legacy alert naming a board id that no longer
    // exists. The id resolves to no row, so it can never run - it is seeded
    // into the snapshot as an `unknown` board and reported failed (per-board
    // failure, never fatal), and the run CONTINUES with the rest.
    const foundIds = new Set(boards.map((b) => b.id));
    const missingIds = (requestedIds ?? []).filter((id) => !foundIds.has(id));

    safeRegistry(() =>
      beginRun(
        runId,
        req.user!.id,
        [
          ...boards.map((b) => ({ id: b.id, name: b.name, type: b.type })),
          ...missingIds.map((id) => ({ id, name: id, type: 'unknown' })),
        ],
        intent.mode === 'deep' ? DEEP_RUN_TTL_MS : undefined,
      ),
    );
    // ADR-033 (T887): the snapshot reports the mode this replay RESOLVED -
    // the linked saved search's stored/derived mode when there is a link, the
    // alert's own otherwise, and fast for a legacy null-intent row. Same
    // additive writer as /search, /scan and /jobs/full-scan, so beginRun's
    // signature and the legacy snapshot shape stay unchanged.
    safeRegistry(() => setRunMode(runId, intent.mode));

    // STEP 3 - PROVIDER-AGNOSTIC: the SAME pipeline as a live search. The
    // executed query is the orchestrator-planned one (derived from the
    // intent, as for live search) - not the legacy string. No branching on a
    // source's kind anywhere on this path: the provider abstraction decides
    // tiers.
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
        // resolver applies, exactly as for live search.
        executeUnit: async (unit: ExecutableUnit) => {
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

    for (const id of missingIds) {
      safeRegistry(() => markFailed(runId, id, `unknown board: ${id} (no longer exists)`, 0));
    }

    // Post steps keep the run route's historical contract: dedupe -> limit
    // slice -> upsert with provenance -> shaped listings.
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
    const matchCount = upserted.length;

    await prisma.jobAlert.update({
      where: { id: alert.id },
      data: { lastRunAt: new Date(), lastMatchCount: matchCount },
    });

    // Wave 11 (T820) cancel retention + wave 9 (T783) evaluation summary: same
    // post-persist snapshot writes as the live-search routes.
    if (outcome.cancelled) safeRegistry(() => markCancelled(runId));
    safeRegistry(() => finishRun(runId, upserted.length));
    if (outcome.evaluation !== undefined) {
      const summary = outcome.evaluation;
      safeRegistry(() => setRunEvaluation(runId, summary));
    }

    // The historical `{ matchCount, results }` shape is preserved exactly;
    // the minted `runId` - pollable via GET /jobs/runs/:runId - and any
    // orchestrator skip reasons ride additively (field + headers, mirroring
    // the saved-search run route). `notifyInApp`/`notifyEmail` behaviour is
    // UNTOUCHED: this route sends nothing new (spec NON-GOALS; the mail
    // module is not modified).
    res.set('x-run-id', runId);
    if (outcome.skipped.length > 0) {
      res.set('x-run-skipped', JSON.stringify(outcome.skipped).slice(0, 2000));
    }
    res.json({
      matchCount,
      results: upserted.slice(0, 50).map((j) => shapeListingResponse(j, { sources: (j as { sources?: SourceRef[] }).sources })),
      runId,
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
