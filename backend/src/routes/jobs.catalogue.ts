// GET /jobs/catalogue - faceted browse over every stored listing.
//
// Separate from the run-based `GET /jobs/search` and the DeepSearch flow; this
// route reads the derived `searchDocument` JSONB and never discovers or writes.
// Errors carry a machine-readable `code` alongside the usual `error` message.

import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError } from '../shared/errors.js';
import { ValidationError } from '../shared/validation.js';
import {
  CATALOGUE_INVALID_QUERY_CODE,
  CatalogueError,
  catalogueQuery,
  type CatalogueStore,
} from '../search/query.js';
import { createPrismaCatalogueStore } from '../search/store.js';

function queryString(raw: unknown): string | undefined {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && entry.trim().length > 0) return entry.trim();
    }
  }
  return undefined;
}

/** Accepts repeated (`?workMode=a&workMode=b`) and comma-joined values. */
function queryStringArray(raw: unknown): string[] | undefined {
  const values: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (trimmed.length > 0) values.push(trimmed);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
    }
  };
  collect(raw);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

function readQuery(req: Request): Record<string, unknown> {
  return {
    q: queryString(req.query.q),
    location: queryString(req.query.location),
    workMode: queryStringArray(req.query.workMode),
    seniority: queryStringArray(req.query.seniority),
    specialization: queryStringArray(req.query.specialization),
    skills: queryStringArray(req.query.skills),
    salaryMin: queryString(req.query.salaryMin),
    postedWithin: queryString(req.query.postedWithin),
    source: queryStringArray(req.query.source),
    company: queryString(req.query.company),
    sort: queryString(req.query.sort),
    page: queryString(req.query.page),
    limit: queryString(req.query.limit),
  };
}

/**
 * Build the router against an injected store. Production passes the Prisma
 * store; tests pass the in-memory store, so the route contract is exercised
 * without a database.
 */
export function createCatalogueRouter(store: CatalogueStore): Router {
  const router = Router();

  router.get('/catalogue', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await catalogueQuery(store, readQuery(req));
      res.json(result);
    } catch (error) {
      if (error instanceof CatalogueError) {
        res.status(error.statusCode).json({ error: error.message, code: error.code });
        return;
      }
      if (error instanceof ValidationError) {
        res.status(400).json({ error: error.message, code: CATALOGUE_INVALID_QUERY_CODE });
        return;
      }
      handleApiError(error, res);
    }
  });

  return router;
}

/** The default router, wired to the app's Prisma client. */
export default function catalogueRouter(): Router {
  return createCatalogueRouter(createPrismaCatalogueStore(prisma));
}
