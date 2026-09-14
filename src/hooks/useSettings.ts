// React Query hooks for the AI provider picker + per-provider model settings.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@/services/api';
import type { ModelSettings, ProviderPreset } from '@/services/api';
import { keysQueryKey } from './useJobs';
import { toast } from './use-toast';

export const modelSettingsQueryKey = ['settings', 'models'] as const;
export const providersQueryKey = ['providers'] as const;

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
