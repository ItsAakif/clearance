// Route Aggregator - Mount all API routes
import { Router } from 'express';

import authRoutes from './auth.js';
import resumeRoutes from './resume.js';
import atsRoutes from './ats.js';
import jobMatchRoutes from './job-match.js';
import templateRoutes from './templates.js';
import aiRoutes from './ai.js';
import exportRoutes from './export.js';
import adminRoutes from './admin.js';
import keysRoutes from './keys.js';
import jobsRoutes from './jobs.js';
import tailorRoutes from './tailor.js';
import applicationsRoutes from './applications.js';
import profileRoutes from './profile.js';
import boardsRoutes from './boards.js';
import searchesRoutes from './saved-searches.js';
import uploadedFilesRoutes from './uploaded-files.js';
import jobAlertsRoutes from './job-alerts.js';
import questionAnswersRoutes from './question-answers.js';

const router = Router();

router.use('/auth', authRoutes);
router.use('/resumes', resumeRoutes);
router.use('/ats', atsRoutes);
router.use('/job-match', jobMatchRoutes);
router.use('/templates', templateRoutes);
router.use('/ai', aiRoutes);
router.use('/export', exportRoutes);
router.use('/admin', adminRoutes);
router.use('/keys', keysRoutes);
router.use('/jobs', jobsRoutes);
router.use('/tailor', tailorRoutes);
router.use('/applications', applicationsRoutes);
router.use('/profile', profileRoutes);
router.use('/boards', boardsRoutes);
router.use('/searches', searchesRoutes);
router.use('/uploaded-files', uploadedFilesRoutes);
router.use('/job-alerts', jobAlertsRoutes);
router.use('/question-answers', questionAnswersRoutes);

export default router;
