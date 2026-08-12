/**
 * Notification Controller (Sprint 7 - implemented).
 *
 * PURPOSE
 *   HTTP layer for `/api/v1/notifications`. The inbox is always scoped to the
 *   authenticated actor (`req.user.id`); the service layer enforces tenant
 *   scoping. Translates request context into `notification.service` calls and
 *   shapes responses with `ApiResponse`.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import notificationService from '../services/notification.service.js';

const recipientOf = (req) => req.user?.id ?? req.admin?.id ?? null;
const pageOf = (v, f = 1) => Math.max(1, Number(v) || f);
const limitOf = (v, f = 20, m = 100) => Math.min(Math.max(1, Number(v) || f), m);

/** GET /api/v1/notifications - paginated inbox for the current user. */
export const listInbox = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const q = req.validated?.query ?? {};
  const result = await notificationService.listInbox({
    tenantId,
    recipientId: recipientOf(req),
    page: pageOf(q.page),
    limit: limitOf(q.limit),
    unreadOnly: q.unreadOnly === true || q.unreadOnly === 'true',
  });
  return ApiResponse.ok(res, result.docs, 'Notifications', {
    page: result.page, limit: result.limit, total: result.total, pages: result.pages,
  });
});

/** GET /api/v1/notifications/unread-count - badge value. */
export const getUnreadCount = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const { count } = await notificationService.getUnreadCount({ tenantId, recipientId: recipientOf(req) });
  return ApiResponse.ok(res, { count }, 'Unread count');
});

/** POST /api/v1/notifications/:id/read - mark a single notification read. */
export const markRead = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const doc = await notificationService.markRead({
    tenantId, recipientId: recipientOf(req), notificationId: req.validated.params.id, by: recipientOf(req),
  });
  return ApiResponse.ok(res, doc, 'Notification marked read');
});

/** POST /api/v1/notifications/read-all - mark every notification read. */
export const markAllRead = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  await notificationService.markAllRead({ tenantId, recipientId: recipientOf(req), by: recipientOf(req) });
  return ApiResponse.noContent(res);
});

/** DELETE /api/v1/notifications/:id - soft-delete from the inbox. */
export const removeInbox = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  await notificationService.remove({
    tenantId, recipientId: recipientOf(req), notificationId: req.validated.params.id, by: recipientOf(req),
  });
  return ApiResponse.noContent(res);
});

/** GET /api/v1/notifications/preferences - read preferences. */
export const getPreferences = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const prefs = await notificationService.getPreferences({ tenantId, recipientId: recipientOf(req) });
  return ApiResponse.ok(res, prefs, 'Preferences');
});

/** POST /api/v1/notifications/preferences - write preferences. */
export const updatePreferences = asyncHandler(async (req, res) => {
  const tenantId = getTenantId(req);
  const prefs = await notificationService.updatePreferences({
    tenantId, recipientId: recipientOf(req), preferences: req.validated?.body?.preferences,
  });
  return ApiResponse.ok(res, prefs, 'Preferences updated');
});

export default {
  listInbox, getUnreadCount, markRead, markAllRead, removeInbox, getPreferences, updatePreferences,
};
