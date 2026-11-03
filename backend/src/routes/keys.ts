// BYOK API Key Management Routes
// Users bring their own LLM (groq/openai/openrouter/gemini) and search (tavily) keys.
// Keys are encrypted at rest (lib/crypto.ts). Per security.md: never return raw keys.

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { handleApiError, NotFoundError, ForbiddenError, BadRequestError } from '../shared/errors.js';
import { validateInput, createApiKeySchema } from '../shared/validation.js';
import { encryptSecret, maskKey } from '../lib/crypto.js';
import { getCustomBaseUrl, isCustomProviderId } from '../ai/providerRegistry.js';
import { leaseNextKey, markKeySuccess, markKeyFailure, isRateLimitError } from '../ai/keyManager.js';

const router = Router();

// ==================== LIST KEYS (masked) ====================
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const keys = await prisma.aIProviderKey.findMany({
      where: { userId: req.user!.id },
      orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
    });

    res.json(
      keys.map((k) => ({
        id: k.id,
        provider: k.provider,
        label: k.label,
        maskedKey: maskKey(k.apiKey),
        isActive: k.isActive,
        lastUsedAt: k.lastUsedAt,
        lastValidatedAt: k.lastValidatedAt,
        failureCount: k.failureCount,
      }))
    );
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== CREATE KEY (validates before storing) ====================
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const { provider, apiKey, label } = validateInput(createApiKeySchema, req.body);

    // Custom providers (`custom:<slug>`) and azure-openai carry their endpoint
    // in AIProviderKey.label as JSON {"baseUrl":"…"} (see
    // CUSTOM_BASE_URL_LABEL_DOC in ai/providerRegistry.ts). Require it here so
    // a custom key is never stored without a resolvable endpoint.
    if ((isCustomProviderId(provider) || provider === 'azure-openai') && !getCustomBaseUrl(label)) {
      throw new BadRequestError(
        'Custom provider label must carry the endpoint as JSON {"baseUrl":"https://…"} (max 50 chars)'
      );
    }

    // D8: Adzuna needs "appId:appKey" (split on the FIRST colon at fetch
    // time). A colon-less paste used to pass creation as "validated" and
    // only fail later via source health. Fail fast here with guidance - the
    // message carries no key material. This check MUST stay outside the probe
    // try/catch below, which converts any error into validated=false.
    if (provider === 'adzuna') {
      const sep = apiKey.indexOf(':');
      const idPart = sep >= 0 ? apiKey.slice(0, sep).trim() : '';
      const keyPart = sep >= 0 ? apiKey.slice(sep + 1).trim() : '';
      if (!idPart || !keyPart) {
        throw new BadRequestError(
          'Adzuna keys must be stored as "appId:appKey" (app ID, a colon, then the app key from your Adzuna developer dashboard).'
        );
      }
    }

    // Validate the key with a lightweight provider ping
    const probe = await leaseNextKey(provider, req.user!.id).catch(() => null);
    let validated = false;
    try {
      const testKey = { id: 'test', apiKey, provider, source: 'database' as const, userId: req.user!.id };
      if (provider === 'tavily') {
        const resp = await fetch('https://api.tavily.com/search?api_key=' + encodeURIComponent(apiKey) + '&query=test&max_results=1', {
          method: 'GET',
        });
        validated = resp.ok;
      } else if (provider === 'exa') {
        const resp = await fetch('https://api.exa.ai/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ query: 'test', numResults: 1 }),
        });
        validated = resp.ok;
      } else if (provider === 'adzuna') {
        // Format already enforced above (fail-fast); a well-formed value is
        // stored as validated - live credential errors surface via source health.
        validated = true;
      } else if (provider === 'rapidapi') {
        // D8: probe JSearch (the primary RapidAPI upstream) so a key that is
        // valid on RapidAPI but not subscribed to JSearch is stored WITHOUT
        // the validated stamp instead of looking "validated" in Settings.
        // Creation still succeeds; health/probes surface the subscription gap.
        // No key material is logged - only the boolean outcome is stored.
        try {
          const resp = await fetch('https://jsearch.p.rapidapi.com/search-v2?query=test&num_pages=1', {
            method: 'GET',
            headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' },
          });
          validated = resp.ok;
        } catch {
          validated = false;
        }
      } else {
        // LLM providers: just ensure non-empty; full validation happens at use time
        validated = apiKey.trim().length >= 8;
      }
      if (probe) {
        await markKeySuccess(probe).catch(() => {});
      }
    } catch (e) {
      if (probe) await markKeyFailure(probe, isRateLimitError(e)).catch(() => {});
      validated = false;
    }

    const created = await prisma.aIProviderKey.create({
      data: {
        userId: req.user!.id,
        provider,
        apiKey: encryptSecret(apiKey),
        label: label || null,
        lastValidatedAt: validated ? new Date() : null,
      },
    });

    res.status(201).json({
      id: created.id,
      provider: created.provider,
      label: created.label,
      maskedKey: maskKey(apiKey),
      isActive: created.isActive,
      lastValidatedAt: created.lastValidatedAt,
    });
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== DELETE KEY ====================
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const key = await prisma.aIProviderKey.findUnique({ where: { id } });
    if (!key) throw new NotFoundError('API Key');
    if (key.userId && key.userId !== req.user!.id && !req.user!.isAdmin) {
      throw new ForbiddenError('You can only delete your own keys');
    }

    await prisma.aIProviderKey.delete({ where: { id } });
    res.status(204).send();
  } catch (error) {
    handleApiError(error, res);
  }
});

// ==================== ADMIN: list all keys (system management) ====================
router.get('/admin/all', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const keys = await prisma.aIProviderKey.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(
      keys.map((k) => ({
        id: k.id,
        userId: k.userId,
        provider: k.provider,
        label: k.label,
        maskedKey: maskKey(k.apiKey),
        isActive: k.isActive,
        lastUsedAt: k.lastUsedAt,
        lastValidatedAt: k.lastValidatedAt,
      }))
    );
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
