/**
 * Notification Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/notifications`. Tenant-facing inbox
 *   plus admin broadcasting.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listInbox, getUnreadCount, markRead, markAllRead, removeInbox
 *   - adminBroadcast, listPreferences
 *
 * CODING GUIDELINES
 *   - Inbox endpoints filter by `req.actor.id`.
 *   - WebSocket emit happens at the service layer (`onEmit(user.<id>, evt)`).
 *   - Tenant Admins see only their tenant's broadcasting UI.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listInbox = notImplemented('GET /notifications');
export const getUnreadCount = notImplemented('GET /notifications/unread-count');
export const markRead = notImplemented('POST /notifications/:id/read');
export const markAllRead = notImplemented('POST /notifications/read-all');
export const removeInbox = notImplemented('DELETE /notifications/:id');
export const adminBroadcast = notImplemented('POST /notifications/admin/broadcast');
export const listPreferences = notImplemented('GET /notifications/admin/preferences/:userId');

export default {
  listInbox, getUnreadCount, markRead, markAllRead, removeInbox,
  adminBroadcast, listPreferences,
};
