/**
 * Report Repository (Sprint 7 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for persisted reports. Owns every read/write
 *   against the Report collection, including run-history appends and the
 *   bounded `runs` array + `lastRun` mirror.
 *
 * CODING GUIDELINES
 *   - Reads return PLAIN objects (`.lean()`).
 *   - Tenant scoping is explicit (`tenantId`) plus the `tenantScope` plugin.
 */

import { Report } from '../models/Report.js';

/** Paginated report list for a tenant. */
export const list = async ({ tenantId, filter = {}, page = 1, limit = 20 } = {}) => {
  const query = { tenantId, ...filter };
  const result = await Report.paginate(query, { page, limit, lean: true, sort: { updatedAt: -1 } });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
};

/** Find a report by id within a tenant. */
export const findById = (id, { tenantId } = {}) =>
  Report.findOne({ _id: id, ...(tenantId ? { tenantId } : {}) }).lean();

/** Create a report. Returns the saved plain document. */
export const create = async (data) => {
  const doc = new Report(data);
  await doc.save();
  return doc.toObject();
};

/** Apply a patch to a report. Returns the updated lean doc or null. */
export const update = (id, patch) =>
  Report.findByIdAndUpdate(id, { $set: patch }, { new: true, runValidators: true, lean: true });

/** Soft-delete a report. Returns the plain doc or null. */
export const remove = async (id, by) => {
  const doc = await Report.softDeleteById(id, by);
  return doc ? doc.toObject() : null;
};

/** Append a run record (bounded history) and mirror it into `lastRun`. */
export const addRun = async (id, run, { maxHistory = 100 } = {}) => {
  const doc = await Report.findByIdAndUpdate(
    id,
    { $push: { runs: { $each: [run], $slice: -maxHistory } }, $set: { lastRun: run } },
    { new: true, lean: true },
  );
  return doc;
};

/** Complete a run: update its sub-document and mirror into `lastRun`. */
export const completeRun = async (id, runId, patch) => {
  const runUpdate = {};
  const lastSet = {};
  for (const [k, v] of Object.entries(patch)) {
    runUpdate[`runs.$.${k}`] = v;
    lastSet[`lastRun.${k}`] = v;
  }
  await Report.findOneAndUpdate({ _id: id, 'runs._id': runId }, { $set: runUpdate }, { new: false });
  await Report.updateOne({ _id: id }, { $set: lastSet });
  return Report.findById(id).lean();
};

/** Find enabled scheduled reports whose next run is due (platform-wide scan). */
export const findByDueSchedule = async ({ now = new Date(), limit = 50 } = {}) =>
  Report.find({
    'schedule.enabled': true,
    nextRunAt: { $lte: now },
    status: { $in: ['draft', 'active', 'paused'] },
  })
    .limit(limit)
    .lean();

export default {
  list,
  findById,
  create,
  update,
  remove,
  addRun,
  completeRun,
  findByDueSchedule,
  _meta: { leanReturns: true, tenancy: 'tenant' },
};
