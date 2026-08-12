/**
 * Widget Repository (Sprint 6 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for dashboard widgets (`models/Widget.js`).
 *   Owns every read/write against the Widget collection.
 *
 * RESPONSIBILITY (database access ONLY - no business logic)
 *   - list, findById, create, update, softDelete, countByDashboard
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Widgets are scoped by BOTH `tenantId` and `dashboardId` so a widget
 *     can never be read or mutated across a dashboard boundary.
 *   - The `query`/`visualization` Mixed fields are whitelisted by the
 *     service layer before execution; the repository stores as-is.
 */

import { Widget } from '../models/Widget.js';

/** Paginated widget list for a dashboard within a tenant. */
export const list = async ({ tenantId, dashboardId, page = 1, limit = 50 } = {}) => {
  const query = { tenantId, dashboardId };
  const result = await Widget.paginate(query, {
    page,
    limit,
    lean: true,
    sort: { 'position.y': 1, 'position.x': 1, createdAt: 1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Find a widget by id within a tenant + dashboard. */
export const findById = (id, { tenantId, dashboardId } = {}) =>
  Widget.findOne({ _id: id, ...(tenantId ? { tenantId } : {}), ...(dashboardId ? { dashboardId } : {}) }).lean();

/** Create a widget. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new Widget(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a widget. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  Widget.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Soft-delete a widget. Returns the plain doc or null. */
export const remove = async (id, by) => {
  const doc = await Widget.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Count active widgets on a dashboard (authoring limit guard). */
export const countByDashboard = async (dashboardId) =>
  Widget.countDocuments({ dashboardId });

/** Soft-delete every widget on a dashboard (used when the dashboard is removed). */
export const softDeleteByDashboard = async (dashboardId, by) => {
  await Widget.updateMany(
    { dashboardId },
    { $set: { deletedAt: new Date(), deletedBy: by ?? null } },
  );
  return true;
};

export default {
  list,
  findById,
  create,
  update,
  remove,
  countByDashboard,
  softDeleteByDashboard,
  _meta: { leanReturns: true, tenancy: 'tenant + dashboard' },
};
