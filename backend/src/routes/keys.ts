// BYOK API Key Management Routes
// Users bring their own LLM (groq/openai/openrouter/gemini) and search (tavily) keys.
// Keys are encrypted at rest (lib/crypto.ts). Per security.md: never return raw keys.

import { Router, Request, Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { handleApiError, NotFoundError, ForbiddenError } from '../shared/errors.js';
import { validateInput, createApiKeySchema } from '../shared/validation.js';
import { encryptSecret, maskKey } from '../lib/crypto.js';
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
