/**
 * /api/v1/admin/dashboard routes - Platform Admin overview (Phase 5).
 *
 * Provides real operational data: tenant counts by status, recent tenant
 * registrations, recent platform-admin actions, and aggregate health.
 * All values are sourced from authoritative server-side stores.
 */
import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import platformDashboardValidator from '../validators/platformDashboard.validator.js';
import platformDashboardController from '../controllers/platformDashboard.controller.js';

const router = Router();

router.get(
  '/summary',
  adminAuth,
  permission('iam.tenants', 'view'),
  validate(platformDashboardValidator.summarySchema),
  platformDashboardController.getSummary,
);

export default router;
