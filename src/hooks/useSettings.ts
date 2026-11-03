// React Query hooks for the AI provider picker + per-provider model settings.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { catalogueApi, settingsApi } from '@/services/api';
import type {
  CatalogueSnapshotImportResult,
  CatalogueSnapshotSyncResult,
  ModelSettings,
  ProviderPreset,
} from '@/services/api';
import { keysQueryKey } from './useJobs';
import { toast } from './use-toast';

export const modelSettingsQueryKey = ['settings', 'models'] as const;
export const providersQueryKey = ['providers'] as const;
export const catalogueStatusQueryKey = ['settings', 'catalogue'] as const;

export function useProviders() {
  return useQuery({ queryKey: providersQueryKey, queryFn: () => settingsApi.getProviders() });
}

/** Live model list for a provider (server-side proxy; presets merged client-side). */
export function useProviderModels(providerId: string | null, apiKey?: string, enabled = false) {
  return useQuery({
    queryKey: ['providers', providerId, 'models', apiKey ? 'custom-key' : 'stored-key'],
    queryFn: () => settingsApi.getProviderModels(providerId!, apiKey),
    enabled: enabled && !!providerId,
    staleTime: 60_000,
    retry: false,
  });
}

export function useModelSettings() {
  return useQuery({ queryKey: modelSettingsQueryKey, queryFn: () => settingsApi.getModels() });
}

export function useUpdateModelSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (models: Record<string, string>) => settingsApi.updateModels(models),
    onSuccess: (data: ModelSettings) => {
      qc.setQueryData(modelSettingsQueryKey, data);
      toast({ title: 'Models saved', description: 'Per-provider model selection updated.' });
    },
    onError: (e: Error) => toast({ title: 'Failed to save models', description: e.message, variant: 'destructive' }),
  });
}

/** Set (or clear with '') a single provider's model. */
export function useSetProviderModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { providerId: string; model: string }) =>
      settingsApi.updateModels({ [vars.providerId]: vars.model }),
    onSuccess: (data: ModelSettings) => {
      qc.setQueryData(modelSettingsQueryKey, data);
      toast({ title: 'Model updated' });
    },
    onError: (e: Error) => toast({ title: 'Failed to update model', description: e.message, variant: 'destructive' }),
  });
}

export function mergePresetAndFetched(preset: ProviderPreset, fetched: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Presets first (Continue's merge rule), then fetched discoveries.
  for (const m of [...preset.presetModels, ...(fetched ?? [])]) {
    const trimmed = m.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/** Invalidate key-dependent queries after a provider key is added/removed. */
export function useInvalidateProviderKeys() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: keysQueryKey });
    qc.invalidateQueries({ queryKey: providersQueryKey });
    qc.invalidateQueries({ queryKey: modelSettingsQueryKey });
  };
}

/** Catalogue total + `catalogue:importedAt` for the Settings snapshot card. */
export function useCatalogueStatus() {
  return useQuery({
    queryKey: catalogueStatusQueryKey,
    queryFn: () => catalogueApi.status(),
    staleTime: 30_000,
  });
}

/**
 * One-click sync of the configured daily feed. The card owns the inline
 * success/quiet-not-published message; the hook only refreshes both the status
 * and the unknown-keyed catalogue pages prefix.
 */
export function useSyncCatalogue() {
  const qc = useQueryClient();
  return useMutation<CatalogueSnapshotSyncResult>({
    mutationFn: () => catalogueApi.sync(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: catalogueStatusQueryKey });
      qc.invalidateQueries({ queryKey: ['jobs', 'catalogue'] });
    },
  });
}

/**
 * Import a snapshot from the Settings card. The invalidation includes
 * the unknown-keyed catalogue pages prefix so browse results refresh too.
 */
export function useImportCatalogueSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { snapshot: File; manifest: string }) =>
      catalogueApi.importSnapshot(vars.snapshot, vars.manifest),
    onSuccess: (data: CatalogueSnapshotImportResult) => {
      qc.invalidateQueries({ queryKey: catalogueStatusQueryKey });
      qc.invalidateQueries({ queryKey: ['jobs', 'catalogue'] });
      toast({
        title: 'Catalogue snapshot imported',
        description:
          `${data.imported} listing(s) imported, ${data.reactivated} reactivated, ` +
          `${data.skipped} skipped.`,
      });
    },
    onError: (e: Error) =>
      toast({ title: 'Snapshot import failed', description: e.message, variant: 'destructive' }),
  });
}
