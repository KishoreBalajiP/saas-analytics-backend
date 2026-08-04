/**
 * /api/v1/notifications routes - User inbox + administrative broadcasting.
 *
 * WHY IT EXISTS
 *   A unified surface for in-app/email/push/webhook notifications. User
 *   inbox endpoints serve the Tenant Portal / Mobile App; admin
 *   broadcasting is platform-scoped. Backed by `platform/notifications/`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - GET    /                      - inbox for the current user
 *   - GET    /unread-count          - cheap badge value
 *   - POST   /:id/read              - mark read
 *   - POST   /read-all              - mark all read
 *   - DELETE /:id                   - delete (soft) from inbox
 *   - POST   /admin/broadcast       - admin cross-tenant broadcast (Phase 4+)
 *   - GET    /admin/preferences/:userId  - notification preferences
 *
 * HOW TO EXTEND
 *   - User endpoints filter by `actorId = req.actor.id`.
 *   - WebSocket emits `notification:new` on `user:<actorId>` room on each
 *     in-app notification (see `src/websocket/rooms.js`).
 */

import { Router } from 'express';
import asyncHandler from '../utils/asyncHandler.js';

const router = Router();

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    res.status(501).json({
      success: false,
      statusCode: 501,
      message: `${op} is not implemented yet (Phase 1.2 architecture placeholder)`,
      hint: 'See src/modules/platform/notifications/README.md',
    });
  });

router.get('/', notImplemented('GET /notifications'));
router.get('/unread-count', notImplemented('GET /notifications/unread-count'));
router.post('/:id/read', notImplemented('POST /notifications/:id/read'));
router.post('/read-all', notImplemented('POST /notifications/read-all'));
router.delete('/:id', notImplemented('DELETE /notifications/:id'));
router.post('/admin/broadcast', notImplemented('POST /notifications/admin/broadcast'));
router.get('/admin/preferences/:userId', notImplemented('GET /notifications/admin/preferences/:userId'));

export default router;
