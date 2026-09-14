// AI provider registry + per-provider LLM model settings API.
import { apiClient } from './client';

export type ProviderGroup = 'recommended' | 'local' | 'other';

// Mirrors backend GET /api/providers (preset registry, no secrets).
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  keyPrefix: string | null;
  authStyle: 'bearer' | 'query' | 'header' | 'none';
  protocol: 'openai' | 'anthropic';
  defaultModel: string;
  presetModels: string[];
  fetchModels: boolean;
  group: ProviderGroup;
}

// Back-compat alias: provider ids are now the 13 registry ids plus
// `custom:<slug>` — a plain string.
export type LlmModelProvider = string;

// Legacy core-provider list (kept for back-compat; prefer useProviders()).
export const LLM_MODEL_PROVIDERS: LlmModelProvider[] = ['groq', 'openai', 'openrouter', 'gemini'];

// Mirrors the backend GET/PUT /api/settings/models response.
export interface ModelSettings {
  models: Record<string, string>;
  overrides: Record<string, string>;
  defaults: Record<string, string>;
}

export const settingsApi = {
  getModels: () => apiClient.get<ModelSettings>('/settings/models'),
  updateModels: (models: Record<string, string>) =>
    apiClient.put<ModelSettings>('/settings/models', { models }),
  getProviders: () => apiClient.get<ProviderPreset[]>('/providers'),
  getProviderModels: (id: string, apiKey?: string) =>
    apiClient.post<{ models: string[] }>(
      `/providers/${encodeURIComponent(id)}/models`,
      apiKey ? { apiKey } : {}
    ),
};
