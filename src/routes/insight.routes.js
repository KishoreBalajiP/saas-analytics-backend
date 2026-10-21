/**
 * /api/v1/insights routes (ai-insights, roadmap 4.A3).
 *   GET  /                 feed (?dashboardId, ?metric, ?status)   analytics.view
 *   POST /generate         compute + store insights                analytics.view
 *   POST /:id/dismiss      dismiss from the feed                   analytics.view
 *   POST /:id/feedback     rate an insight                          analytics.view
 * DEPENDS: billing requireFeature(ai_assistant) only for narration (wired at integration).
 */
import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import c from '../controllers/insight.controller.js';
// billing: generating insights needs a plan with ai_assistant.
import { requireFeature } from '../middleware/requireFeature.middleware.js';

const router = Router();
const g = (...mw) => [authenticate, resolveTenant, permission('analytics', 'view'), ...mw];
const id = { id: 'objectId|required' };

router.get('/', g(validate({ query: { dashboardId: 'objectId', metric: 'string', status: { type: 'string', oneOf: ['open', 'dismissed'] }, page: { type: 'integer', min: 1 }, limit: { type: 'integer', min: 1, max: 100 } } })), c.list);
router.post('/generate', g(requireFeature('ai_assistant'), validate({ body: { connectorId: 'objectId|required', metric: 'object|required', dateField: 'string|required', dimension: 'string', bucket: 'string', dashboardId: 'objectId' } })), c.generate);
router.post('/:id/dismiss', g(validate({ params: id })), c.dismiss);
router.post('/:id/feedback', g(validate({ params: id, body: { rating: 'string|required' } })), c.feedback);

export default router;
