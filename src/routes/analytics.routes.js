/**
 * /api/v1/analytics routes (Sprint 5 - implemented).
 *
 * WHY IT EXISTS
 *   Tenant-scoped analytics read surface over ingested connector rows, plus
 *   query history and async exports. Backed by `services/analytics.service.js`
 *   which delegates aggregation to `analytics.engine.js`.
 *
 * ENDPOINTS
 *   - GET  /                run a (cached) query     permission analytics.view
 *   - GET  /queries         list past runs           permission analytics.view
 *   - GET  /queries/:id     fetch a run              permission analytics.view
 *   - POST /export          schedule async export    permission analytics.export
 *
 * MIDDLEWARE ORDER
 *   authenticate -> resolveTenant -> permission('analytics', <action>) -> handler
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import analyticsValidator from '../validators/analytics.validator.js';
import analyticsController from '../controllers/analytics.controller.js';

const router = Router();

router.get(
  '/',
  authenticate,
  resolveTenant,
  permission('analytics', 'view'),
  analyticsController.queryRows,
);
router.get(
  '/queries',
  authenticate,
  resolveTenant,
  permission('analytics', 'view'),
  validate(analyticsValidator.queryListSchema),
  analyticsController.listQueries,
);
router.get(
  '/queries/:id',
  authenticate,
  resolveTenant,
  permission('analytics', 'view'),
  analyticsController.getQuery,
);
router.post(
  '/export',
  authenticate,
  resolveTenant,
  permission('analytics', 'export'),
  validate(analyticsValidator.exportSchema),
  analyticsController.exportAsync,
);

export default router;
