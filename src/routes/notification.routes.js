/**
 * /api/v1/notifications routes (Sprint 7 - implemented).
 *
 * ENDPOINTS (all tenant + actor scoped; inbox is always the calling user)
 *   - GET    /                      inbox list          notifications.view
 *   - GET    /unread-count          badge               notifications.view
 *   - GET    /preferences           preferences         notifications.view
 *   - POST   /preferences           update preferences  notifications.update
 *   - POST   /read-all              mark all read       notifications.update
 *   - POST   /:id/read              mark read           notifications.update
 *   - DELETE /:id                   soft-delete         notifications.delete
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import notificationValidator from '../validators/notification.validator.js';
import notificationController from '../controllers/notification.controller.js';

const router = Router();

const guarded = (action, ...mw) => [authenticate, resolveTenant, permission('notifications', action), ...mw];

router.get('/', guarded('view', validate(notificationValidator.listSchema)), notificationController.listInbox);
router.get('/unread-count', guarded('view'), notificationController.getUnreadCount);
router.get('/preferences', guarded('view'), notificationController.getPreferences);
router.post('/preferences', guarded('update', validate(notificationValidator.preferencesSchema)), notificationController.updatePreferences);
router.post('/read-all', guarded('update'), notificationController.markAllRead);
router.post('/:id/read', guarded('update', validate(notificationValidator.idSchema)), notificationController.markRead);
router.delete('/:id', guarded('delete', validate(notificationValidator.idSchema)), notificationController.removeInbox);

export default router;
