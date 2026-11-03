import { Router, type Request, type Response } from 'express';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { handleApiError } from '../shared/errors.js';
import { getCatalogueInsights } from '../search/insights.js';

export function createInsightsRouter(client: any = prisma): Router {
  const router = Router();

  router.get('/catalogue', requireAuth, async (_req: Request, res: Response) => {
    try {
      const result = await getCatalogueInsights(client);
      res.json(result);
    } catch (error) {
      handleApiError(error, res);
    }
  });

  return router;
}

export default function insightsRouter(): Router {
  return createInsightsRouter(prisma);
}