/**
 * Notification Service (Sprint 7 - implemented).
 *
 * PURPOSE
 *   Serves the in-app notification inbox: listing, unread counts, mark-as-read
 *   (single + all), soft-delete, and preference read/write. Alert delivery
 *   writes the underlying documents via `notification.repository.js`; this
 *   service is the read/management surface used by the HTTP controller.
 */

import ApiError from '../utils/ApiError.js';
import notificationRepository from '../repositories/notification.repository.js';

/** Paginated inbox for a recipient. */
export async function listInbox({ tenantId, recipientId, page = 1, limit = 20, unreadOnly = false } = {}) {
  if (!recipientId) throw ApiError.badRequest('recipientId is required');
  return notificationRepository.listInbox({ tenantId, recipientId, page, limit, unreadOnly });
}

/** Unread notification count for a recipient. */
export async function getUnreadCount({ tenantId, recipientId } = {}) {
  if (!recipientId) throw ApiError.badRequest('recipientId is required');
  const count = await notificationRepository.countUnread({ tenantId, recipientId });
  return { count };
}

/** Mark a single notification read. */
export async function markRead({ tenantId, recipientId, notificationId, by = null } = {}) {
  const doc = await notificationRepository.markRead(notificationId, { tenantId, recipientId, by });
  if (!doc) throw ApiError.notFound('Notification not found');
  return doc;
}

/** Mark every notification in the inbox read. */
export async function markAllRead({ tenantId, recipientId, by = null } = {}) {
  await notificationRepository.markAllRead({ tenantId, recipientId, by });
  return true;
}

/** Soft-delete a notification from the inbox. */
export async function remove({ tenantId, recipientId, notificationId, by = null } = {}) {
  const existing = await notificationRepository.findById(notificationId, { tenantId, recipientId });
  if (!existing) throw ApiError.notFound('Notification not found');
  await notificationRepository.remove(notificationId, { tenantId, recipientId, by });
  return true;
}

/** Read notification preferences. */
export async function getPreferences({ tenantId, recipientId } = {}) {
  return notificationRepository.getPreferences({ tenantId, recipientId });
}

/** Write notification preferences. */
export async function updatePreferences({ tenantId, recipientId, preferences } = {}) {
  return notificationRepository.setPreferences({ tenantId, recipientId, preferences });
}

export default {
  listInbox,
  getUnreadCount,
  markRead,
  markAllRead,
  remove,
  getPreferences,
  updatePreferences,
  _meta: { module: 'notifications' },
};
