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
import { NOTIFICATION_CHANNELS } from '../models/NotificationPreference.js';
import { User } from '../models/User.js';

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

/** Write notification preferences (typed keys: in_app, email; booleans). */
export async function updatePreferences({ tenantId, recipientId, preferences } = {}) {
  if (!recipientId) throw ApiError.badRequest('recipientId is required');
  const input = preferences && typeof preferences === 'object' && !Array.isArray(preferences) ? preferences : null;
  if (!input) throw new ApiError(400, 'preferences must be an object', { code: 'VALIDATION_ERROR', errors: [{ field: 'preferences', message: 'must be an object' }] });
  const errors = [];
  for (const [key, value] of Object.entries(input)) {
    if (!NOTIFICATION_CHANNELS.includes(key)) errors.push({ field: `preferences.${key}`, message: `unknown channel (expected ${NOTIFICATION_CHANNELS.join(', ')})` });
    else if (typeof value !== 'boolean') errors.push({ field: `preferences.${key}`, message: 'must be true or false' });
  }
  if (errors.length) throw new ApiError(400, 'Invalid notification preferences', { code: 'VALIDATION_ERROR', errors });
  return notificationRepository.setPreferences({ tenantId, recipientId, preferences: input });
}

/**
 * onboarding: honour preferences when delivering. Returns the user ids that
 * accept `channel`.
 */
export async function recipientsAccepting({ tenantId, userIds = [], channel } = {}) {
  const prefs = await notificationRepository.getPreferencesForUsers({ tenantId, userIds });
  return [...prefs.entries()].filter(([, p]) => p[channel] !== false).map(([id]) => id);
}

/**
 * onboarding: drop email addresses that belong to tenant users who turned
 * email notifications off. Addresses outside the tenant are kept.
 */
export async function emailsAccepting({ tenantId, emails = [] } = {}) {
  if (!emails.length) return [];
  const users = await User.find({ tenantId, email: { $in: emails.map((e) => String(e).toLowerCase()) } }).select('email').lean();
  if (!users.length) return emails;
  const prefs = await notificationRepository.getPreferencesForUsers({ tenantId, userIds: users.map((u) => String(u._id)) });
  const muted = new Set(users.filter((u) => prefs.get(String(u._id))?.email === false).map((u) => u.email));
  return emails.filter((e) => !muted.has(String(e).toLowerCase()));
}

export default {
  listInbox,
  getUnreadCount,
  markRead,
  markAllRead,
  remove,
  getPreferences,
  updatePreferences,
  recipientsAccepting,
  emailsAccepting,
  _meta: { module: 'notifications' },
};
