/**
 * /api/v1/alerts routes (Sprint 7 - implemented).
 *
 * ENDPOINTS
 *   - GET    /                   list rules          alerts.view
 *   - POST   /                   create rule         alerts.create
 *   - GET    /events             all events          alerts.view
 *   - GET    /:id                rule detail         alerts.view
 *   - PATCH  /:id                update rule         alerts.update
 *   - DELETE /:id                soft-delete         alerts.delete
 *   - POST   /:id/evaluate       manual evaluation   alerts.evaluate
 *   - GET    /:id/events         rule events         alerts.view
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import alertValidator from '../validators/alert.validator.js';
import alertController from '../controllers/alert.controller.js';

const router = Router();

const guarded = (action, ...mw) => [authenticate, resolveTenant, permission('alerts', action), ...mw];
const idParam = { params: { id: 'objectId|required' } };

router.get('/', guarded('view', validate(alertValidator.alertListSchema)), alertController.listAlerts);
router.post('/', guarded('create', validate(alertValidator.alertCreateSchema)), alertController.createAlert);
router.get('/events', guarded('view', validate(alertValidator.alertListSchema)), alertController.listAllEvents);
router.get('/:id', guarded('view', validate(idParam)), alertController.getAlert);
router.patch('/:id', guarded('update', validate(alertValidator.alertUpdateSchema)), alertController.updateAlert);
router.delete('/:id', guarded('delete', validate(idParam)), alertController.deleteAlert);
router.post('/:id/evaluate', guarded('evaluate', validate(idParam)), alertController.evaluateAlert);
router.get('/:id/events', guarded('view', validate(alertValidator.alertEventsSchema)), alertController.listAlertEvents);

export default router;
