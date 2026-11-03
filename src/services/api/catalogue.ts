// Catalogue snapshot API: local status, one-shot upload and one-click sync.
//
// The import uploads the published `catalogue.jsonl.gz` and its `manifest.json`
// text in ONE multipart request. The sync asks the backend to download the
// configured daily feed itself. Either way the backend verifies the manifest
// sha256 before touching the database and then upserts through the normal
// discovery path.
import { apiClient } from './client';

/** Mirrors `GET /api/catalogue/status`. */
export interface CatalogueSnapshotStatus {
  total: number;
  active: number;
  importedAt: string | null;
}

/** Mirrors `POST /api/catalogue/import` (exactly four keys). */
export interface CatalogueSnapshotImportResult {
  imported: number;
  reactivated: number;
  skipped: number;
  snapshotGeneratedAt: string;
}

/** Mirrors `POST /api/catalogue/sync`. */
export interface CatalogueSnapshotSyncResult {
  imported: number;
  reactivated: number;
  skipped: number;
  generatedAt: string;
  feedUrl: string;
}

export const catalogueApi = {
  status: () => apiClient.get<CatalogueSnapshotStatus>('/catalogue/status'),
  sync: () => apiClient.post<CatalogueSnapshotSyncResult>('/catalogue/sync'),
  importSnapshot: (snapshot: File, manifest: string) =>
    apiClient.upload<CatalogueSnapshotImportResult>('/catalogue/import', snapshot, 'file', { manifest }),
};
