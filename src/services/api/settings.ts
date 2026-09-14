// Per-provider LLM model settings API.
import { apiClient } from './client';

export type LlmModelProvider = 'groq' | 'openai' | 'openrouter' | 'gemini';

export const LLM_MODEL_PROVIDERS: LlmModelProvider[] = ['groq', 'openai', 'openrouter', 'gemini'];

// Mirrors the backend GET/PUT /api/settings/models response.
export interface ModelSettings {
  models: Record<LlmModelProvider, string>;
  overrides: Partial<Record<LlmModelProvider, string>>;
  defaults: Record<LlmModelProvider, string>;
}

export const settingsApi = {
  getModels: () => apiClient.get<ModelSettings>('/settings/models'),
  updateModels: (models: Partial<Record<LlmModelProvider, string>>) =>
    apiClient.put<ModelSettings>('/settings/models', { models }),
};
