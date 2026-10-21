/**
 * /api/v1/metrics routes (ai-catalogue, roadmap 4.A1).
 *
 * ENDPOINTS
 *   - GET    /                                  catalogue            metrics.view
 *   - POST   /                                  create draft (v1)    metrics.manage
 *   - POST   /suggest                           profiler drafts      metrics.manage
 *   - GET    /:key                              one version          metrics.view
 *   - PATCH  /:key                              next version (draft) metrics.manage
 *   - POST   /:key/versions/:version/approve    approve a draft      metrics.approve
 *   - DELETE /:key                              archive all versions metrics.manage
 *
 * DEPENDS: billing requireFeature - none (metric definitions are not an
 * AI feature; the AI surfaces that read them are gated on ai_assistant).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import metricValidator from '../validators/metricDefinition.validator.js';
import metricController from '../controllers/metricDefinition.controller.js';

const router = Router();

const guarded = (action, ...mw) => [authenticate, resolveTenant, permission('metrics', action), ...mw];

router.get('/', guarded('view', validate(metricValidator.metricListSchema)), metricController.listMetrics);
router.post('/', guarded('manage', validate(metricValidator.metricCreateSchema)), metricController.createMetric);
router.post('/suggest', guarded('manage', validate(metricValidator.metricSuggestSchema)), metricController.suggestMetrics);
router.get('/:key', guarded('view', validate(metricValidator.metricKeySchema)), metricController.getMetric);
router.patch('/:key', guarded('manage', validate(metricValidator.metricUpdateSchema)), metricController.updateMetric);
router.post('/:key/versions/:version/approve', guarded('approve', validate(metricValidator.metricApproveSchema)), metricController.approveMetric);
router.delete('/:key', guarded('manage', validate(metricValidator.metricKeySchema)), metricController.archiveMetric);

export default router;
