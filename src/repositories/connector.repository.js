/**
 * Connector Repository (Sprint 4 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for persisted connectors (`models/Connector.js`).
 *   Owns every read/write against the Connector collection.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - list, findById, findByTenant, findByWebhookToken, create, update,
 *     softDelete, countByType, bumpError.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - `config` is stored as the encrypted envelope string; encryption/decryption
 *     is the service's job, this layer never touches secrets.
 *   - Tenant scoping is explicit (`tenantId: { $eq }`) plus the `tenantScope`
 *     plugin as a second line of defence.
 */

import { Connector } from '../models/Connector.js';

/** Paginated connector list for a tenant. */
export const list = async ({ tenantId, filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { tenantId, ...filter };
  const result = await Connector.paginate(query, {
    page,
    limit,
    lean: true,
    sort: { createdAt: -1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Find a connector by id within a tenant. */
export const findById = (id, { tenantId } = {}) =>
  Connector.findOne({ _id: id, ...(tenantId ? { tenantId } : {}) }).lean();

/** Find a connector by its public webhook token. */
export const findByWebhookToken = (token) => Connector.findOne({ webhookToken: token }).lean();

/** Create a connector. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new Connector(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a connector. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  Connector.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Record an ingestion failure on a connector (error counter + lastError). */
export const bumpError = async (id, message) =>
  Connector.findByIdAndUpdate(
    id,
    {
      $set: { lastError: message, updatedAt: new Date() },
      $inc: { errorCount: 1 },
    },
    { new: true, lean: true },
  );

/** Soft-delete a connector. Returns the plain doc or null. */
export const remove = async (id, by) => {
  const doc = await Connector.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Count connectors by type within a tenant. */
export const countByType = async (tenantId) => {
  const docs = await Connector.aggregate([
    { $match: { tenantId } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(docs.map((d) => [d._id, d.count]));
};

export default {
  list,
  findById,
  findByWebhookToken,
  create,
  update,
  bumpError,
  remove,
  countByType,
  _meta: { leanReturns: true, tenancy: 'tenant', encryptedFields: ['config'] },
};
