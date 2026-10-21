/**
 * /api/v1/delivery routes (delivery, roadmap 3.4).
 *
 * ENDPOINTS
 *   - GET    /destinations              list destinations     reports.view
 *   - POST   /destinations              create destination    reports.update
 *   - DELETE /destinations/:id          remove destination    reports.update
 *   - GET    /deliveries                delivery history      reports.view
 *   - POST   /deliveries/:id/retry      manual retry          reports.export
 *   - POST   /unsubscribe               external opt-out      public (signed token)
 *
 * DEPENDS: billing requireFeature(scheduled_delivery) on the destination routes.
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import deliveryController from '../controllers/delivery.controller.js';
// billing: delivery destinations need a plan with scheduled_delivery.
import { requireFeature } from '../middleware/requireFeature.middleware.js';

const router = Router();

const guarded = (action, ...mw) => [authenticate, resolveTenant, permission('reports', action), ...mw];
const idParam = { params: { id: 'objectId|required' } };

router.get('/destinations', guarded('view'), deliveryController.listDestinations);
router.post('/destinations', guarded('update', requireFeature('scheduled_delivery'), validate({ body: { type: 'string|required', name: 'string|required', url: 'string|required' } })), deliveryController.createDestination);
router.delete('/destinations/:id', guarded('update', validate(idParam)), deliveryController.removeDestination);
router.get('/deliveries', guarded('view'), deliveryController.listDeliveries);
router.post('/deliveries/:id/retry', guarded('export', validate(idParam)), deliveryController.retryDelivery);
router.post(
  '/unsubscribe', // ci:routes-exempt: public opt-out, HMAC-signed token only
  validate({ body: { token: 'string|required' } }), deliveryController.unsubscribe);

export default router;
