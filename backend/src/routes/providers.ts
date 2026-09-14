// AI provider registry + server-side model-list proxy routes.
// - GET /api/providers: preset registry WITHOUT secrets (safe for the client).
// - POST /api/providers/:id/models { apiKey? }: resolves the key from the body
//   or the user's stored key (decrypted server-side, never returned), proxies
//   the provider's list-models endpoint, and returns normalized { models }.
//   Provider failures become 502s with no key material.
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError, NotFoundError, BadRequestError } from '../shared/errors.js';
import { validateInput } from '../shared/validation.js';
import { decryptSecret } from '../lib/crypto.js';
import {
  PROVIDER_PRESETS,
  buildCustomProvider,
  getCustomBaseUrl,
  getProviderPreset,
  isCustomProviderId,
  isValidCustomProviderId,
  normalizeModelList,
  type ProviderAuthStyle,
  type ProviderPreset,
} from '../ai/providerRegistry.js';

const router = Router();

const MODELS_PROXY_TIMEOUT_MS = 15000;

// ==================== GET /api/providers ====================
router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    res.json(
      PROVIDER_PRESETS.map((p) => ({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        keyPrefix: p.keyPrefix ?? null,
        authStyle: p.authStyle,
        protocol: p.protocol,
        defaultModel: p.defaultModel,
        presetModels: p.presetModels,
        fetchModels: p.fetchModels,
        group: p.group,
      }))
    );
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== POST /api/providers/:id/models ====================
const providerModelsBodySchema = z.object({
  apiKey: z.string().min(1).max(500).optional(),
});

function resolvePreset(id: string): ProviderPreset {
  const preset = getProviderPreset(id);
  if (preset) return preset;
  // Custom providers are ad-hoc: the base URL comes from the stored key label
  // (see CUSTOM_BASE_URL_LABEL_DOC in providerRegistry.ts). The stored row is
  // looked up below; without one there is nothing to fetch from.
  if (isCustomProviderId(id)) {
    if (!isValidCustomProviderId(id)) {
      throw new BadRequestError('Invalid custom provider id (expected custom:<slug>, [a-z0-9-], max 40)');
    }
    return buildCustomProvider(id.slice('custom:'.length), '');
  }
  throw new NotFoundError('Provider');
}

function authHeaders(auth: ProviderAuthStyle, apiKey: string, protocol: string): Record<string, string> {
  if (auth === 'bearer') return { Authorization: `Bearer ${apiKey}` };
  if (auth === 'header' && protocol === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  }
  if (auth === 'header') return { 'api-key': apiKey };
  return {};
}

router.post('/:id/models', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { apiKey: bodyKey } = validateInput(providerModelsBodySchema, req.body);
    let preset = resolvePreset(id);

    // Resolve the key: explicit body key wins, else the user's stored key
    // (decrypted server-side, never returned). Keyless local providers
    // (ollama/lmstudio) work without any key.
    let apiKey = bodyKey?.trim() || '';
    let storedLabel: string | null = null;
    if (!apiKey) {
      const stored = await prisma.aIProviderKey.findFirst({
        where: { userId: req.user!.id, provider: id, isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      if (stored) {
        apiKey = decryptSecret(stored.apiKey);
        storedLabel = stored.label;
      }
    } else if (isCustomProviderId(id)) {
      const stored = await prisma.aIProviderKey.findFirst({
        where: { userId: req.user!.id, provider: id, isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      storedLabel = stored?.label ?? null;
    }

    // Custom providers (and azure-openai) need a base URL from the stored label.
    if (isCustomProviderId(id)) {
      const baseUrl = getCustomBaseUrl(storedLabel);
      if (!baseUrl) {
        throw new BadRequestError(
          'Custom provider has no stored base URL. Save the provider key first (endpoint is stored with the key).'
        );
      }
      preset = buildCustomProvider(id.slice('custom:'.length), baseUrl);
    }

    const endpoint = preset.modelsEndpoint;
    if (!preset.fetchModels || !endpoint) {
      // No reliable list endpoint (z.ai, Azure): answer with the presets.
      res.json({ models: preset.presetModels });
      return;
    }
    if (!apiKey && preset.modelsEndpoint?.auth !== 'none') {
      throw new BadRequestError(`No API key for provider ${id}. Save a key first or pass apiKey.`);
    }

    let url = endpoint.url;
    if (endpoint.auth === 'query' && apiKey) {
      url += (url.includes('?') ? '&' : '?') + `key=${encodeURIComponent(apiKey)}`;
    }
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url, {
        headers: { Accept: 'application/json', ...authHeaders(endpoint.auth, apiKey, preset.protocol) },
        signal: AbortSignal.timeout(MODELS_PROXY_TIMEOUT_MS),
      });
    } catch (error) {
      res.status(502).json({ error: `${id}: model list fetch failed (${(error as Error).message})` });
      return;
    }
    if (!upstream.ok) {
      res.status(502).json({ error: `${id}: provider returned ${upstream.status} for model list` });
      return;
    }
    const payload: unknown = await upstream.json().catch(() => null);
    res.json({ models: normalizeModelList(endpoint.normalizer, payload) });
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
