// App Settings routes - per-provider LLM model selection.
// Auth: requireAuth (single-owner self-hosted app; model selection is global).
// Model IDs are not secrets: logging them is fine. Never log API keys.
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError } from '../shared/errors.js';
import { validateInput, updateModelSettingsSchema } from '../shared/validation.js';
import {
  getAllProviderModelSettings,
  setProviderModel,
  clearProviderModel,
  type LlmModelProvider,
} from '../ai/providerModels.js';

const router = Router();

// ==================== GET MODELS ====================
router.get('/models', requireAuth, async (_req: Request, res: Response) => {
  try {
    const settings = await getAllProviderModelSettings();
    res.json(settings);
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== UPDATE MODELS ====================
router.put('/models', requireAuth, async (req: Request, res: Response) => {
  try {
    const { models } = validateInput(updateModelSettingsSchema, req.body);
    for (const [provider, value] of Object.entries(models)) {
      const model = (value ?? '').trim();
      if (!model) await clearProviderModel(provider as LlmModelProvider);
      else await setProviderModel(provider as LlmModelProvider, model);
    }
    const settings = await getAllProviderModelSettings();
    res.json(settings);
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
