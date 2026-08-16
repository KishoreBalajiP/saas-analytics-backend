/**
 * Notification Repository (Sprint 7 - implemented).
 *
 * PURPOSE
 *   Data-access surface for the in-app notification inbox and dispatched
 *   email records. Database access ONLY.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Inbox queries are scoped by `tenantId` + `recipientId` (or email).
 */

import { Notification } from '../models/Notification.js';

/** Create a notification document. */
export const create = async (data) => {
  const doc = new Notification(data);
  await doc.save();
  return doc.toObject();
};

/** Bulk-insert notification documents (support broadcast fan-out). */
export const createMany = async (docs) => {
  if (!Array.isArray(docs) || docs.length === 0) return 0;
  const inserted = await Notification.insertMany(docs, { ordered: false });
  return inserted.length;
};

/** Paginated inbox for a recipient (optionally unread-only). */
export const listInbox = async ({ tenantId, recipientId, unreadOnly = false, page = 1, limit = 20 } = {}) => {
  const filter = { tenantId, recipientId };
  if (unreadOnly) filter.read = false;
  const result = await Notification.paginate(filter, { page, limit, lean: true, sort: { createdAt: -1 } });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Count unread notifications for a recipient. */
export const countUnread = async ({ tenantId, recipientId } = {}) =>
  Notification.countDocuments({ tenantId, recipientId, read: false, deletedAt: null });

/** Find a single notification (scoped by tenant + recipient). */
export const findById = (id, { tenantId, recipientId } = {}) => {
  const filter = { _id: id, tenantId };
  if (recipientId) filter.recipientId = recipientId;
  return Notification.findOne(filter).lean();
};

/** Mark a notification read (idempotent). Returns the updated doc or null. */
export const markRead = async (id, { tenantId, recipientId, by } = {}) => {
  const doc = await Notification.findOneAndUpdate(
    { _id: id, tenantId, recipientId, read: false },
    { $set: { read: true, readAt: new Date(), updatedBy: by } },
    { new: true, lean: true },
  );
  return doc;
};

/** Mark every notification in a recipient's inbox read. */
export const markAllRead = async ({ tenantId, recipientId, by } = {}) => {
  await Notification.updateMany(
    { tenantId, recipientId, read: false },
    { $set: { read: true, readAt: new Date(), updatedBy: by } },
  );
  return true;
};

/** Soft-delete a notification from the inbox. */
export const remove = async (id, { tenantId, recipientId, by } = {}) => {
  const filter = { _id: id, tenantId };
  if (recipientId) filter.recipientId = recipientId;
  const doc = await Notification.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Read notification preferences (defaults; persisted prefs land later). */
export const getPreferences = async ({ tenantId, recipientId } = {}) => ({
  tenantId,
  recipientId,
  channels: { in_app: true, email: true },
});

/** Write notification preferences (defaults echoed back for now). */
export const setPreferences = async ({ tenantId, recipientId, preferences } = {}) => ({
  tenantId,
  recipientId,
  channels: { in_app: true, email: true },
  ...(preferences ? { saved: true } : {}),
});

export default {
  create,
  createMany,
  listInbox,
  countUnread,
  findById,
  markRead,
  markAllRead,
  remove,
  getPreferences,
  setPreferences,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
