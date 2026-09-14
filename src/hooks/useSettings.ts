// React Query hooks for per-provider LLM model settings.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '@/services/api';
import type { LlmModelProvider, ModelSettings } from '@/services/api';
import { toast } from './use-toast';

export const modelSettingsQueryKey = ['settings', 'models'] as const;

export function useModelSettings() {
  return useQuery({ queryKey: modelSettingsQueryKey, queryFn: () => settingsApi.getModels() });
}

export function useUpdateModelSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (models: Partial<Record<LlmModelProvider, string>>) => settingsApi.updateModels(models),
    onSuccess: (data: ModelSettings) => {
      qc.setQueryData(modelSettingsQueryKey, data);
      toast({ title: 'Models saved', description: 'Per-provider model selection updated.' });
    },
    onError: (e: Error) => toast({ title: 'Failed to save models', description: e.message, variant: 'destructive' }),
  });
}
