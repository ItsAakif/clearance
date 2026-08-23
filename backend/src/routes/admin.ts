import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { handleApiError } from '../shared/errors.js';
import { analyzeAllTemplates, clearTemplateCache } from '../templates/analyzer.js';

const router = Router();
const TEMPLATES_DIR = path.join(__dirname, '../../templates');
const PREVIEWS_DIR = path.join(__dirname, '../../previews');

router.use(requireAuth, requireAdmin);

router.get('/status', async (req, res) => {
  res.json({
    email: req.user?.email,
    isAdmin: true,
  });
});

router.get('/templates', async (_req, res) => {
  try {
    clearTemplateCache();
    const templates = fs.existsSync(TEMPLATES_DIR)
      ? analyzeAllTemplates(TEMPLATES_DIR).map((template) => ({
          id: template.id,
          fileName: template.fileName,
          analyzedAt: template.analyzedAt,
          sectionCount: template.sections.length,
          hasPreview: fs.existsSync(path.join(PREVIEWS_DIR, `${template.id}.png`)),
        }))
      : [];

    res.json(templates);
  } catch (error) {
    handleApiError(error, res);
  }
});

export default router;
