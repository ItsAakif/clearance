// Production wiring for the catalogue snapshot importer.
//
// Kept out of `importSnapshot.ts` so the import logic stays dependency-light
// and unit-testable: this is the ONE module that knows both Prisma and the
// shared discovery upsert path. The route and the offline CLI use it, so both
// surfaces reactivate rows and recompute documents identically.

import prisma from '../lib/prisma.js';
import { upsertDiscoveredJobs } from '../routes/jobs.js';
import type { ImportSnapshotDeps } from './importSnapshot.js';
import { refreshCatalogueFacets } from './store.js';

/** AppSetting key the Settings card reads as "last updated". */
export const CATALOGUE_IMPORTED_AT_KEY = 'catalogue:importedAt';

export function createPrismaSnapshotImportDeps(): ImportSnapshotDeps {
  return {
    upsertJobs: (jobs) => upsertDiscoveredJobs(jobs),
    loadInactiveKeys: async (sources) => {
      if (sources.length === 0) return [];
      return prisma.jobListing.findMany({
        where: { isActive: false, source: { in: sources } },
        select: { source: true, externalId: true },
      });
    },
  };
}

/** ISO timestamp of the last successful import, or null when never imported. */
export async function readCatalogueImportedAt(): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: CATALOGUE_IMPORTED_AT_KEY },
    select: { value: true },
  });
  const value = typeof row?.value === 'string' ? row.value.trim() : '';
  return value.length > 0 ? value : null;
}

export async function recordCatalogueImport(iso: string): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: CATALOGUE_IMPORTED_AT_KEY },
    update: { value: iso },
    create: { key: CATALOGUE_IMPORTED_AT_KEY, value: iso },
  });
  // The import changed the active set: refresh the unfiltered facet cache now
  // instead of making the next browse request pay for it. Failure is harmless
  // (the cache TTL expires and the request recomputes).
  try {
    await refreshCatalogueFacets(prisma);
  } catch {
    // ignore
  }
}
