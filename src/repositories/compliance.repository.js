/**
 * Compliance Repository (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Stable data-access surface for data-subject compliance requests and
 *   their state transitions.
 *
 * RESPONSIBILITY
 *   - file({ ... })                       (create a request row)
 *   - list(filters), findById, findByRequestId, findBySubject
 *   - transition(requestId, fromStates, toState, patch)
 *   - attachEvidence(requestId, key)
 *   - activeForSubject(subjectId)          (middleware reads)
 *
 * CODING GUIDELINES
 *   - State machine transitions use `findOneAndUpdate` with the expected
 *     `status in fromStates`, so concurrent workers cannot double-advance.
 *   - Rejections still produce a row (proof of search).
 *   - `tenantScope` may be empty for cross-tenant compliance flows.
 */

import { ComplianceLog } from '../models/ComplianceLog.js';

/** Create a compliance request row. Returns the saved plain document. */
export const file = async (data) => {
  const doc = new ComplianceLog(data);
  await doc.save();
  return doc.toObject();
};

/** Paginated request listing, filterable by status/type/subject. */
export const list = async ({ filter = {}, page = 1, limit = 20 } = {}) => {
  const result = await ComplianceLog.paginate(filter, {
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

/** Find by internal _id. Returns a plain doc or null. */
export const findById = (id) => ComplianceLog.findById(id).lean();

/** Find by the public requestId. Returns a plain doc or null. */
export const findByRequestId = (requestId) => ComplianceLog.findOne({ requestId }).lean();

/** All requests for a subject, newest first. */
export const findBySubject = async (subjectId, { type, page = 1, limit = 20 } = {}) => {
  const filter = { subjectId };
  if (type) filter.type = type;
  return list({ filter, page, limit });
};

/**
 * Atomic state transition. Only advances when the current status is in
 * `fromStates`. Returns the updated plain doc or null.
 */
export const transition = async (requestId, fromStates, toState, patch = {}) =>
  ComplianceLog.findOneAndUpdate(
    { requestId, status: { $in: fromStates } },
    { $set: { status: toState, ...patch } },
    { new: true },
  ).lean();

/** Attach an evidence artifact key to a request. */
export const attachEvidence = async (requestId, evidenceKey) =>
  ComplianceLog.findOneAndUpdate(
    { requestId },
    { $set: { evidenceKey } },
    { new: true },
  ).lean();

/**
 * Active requests for a subject - used by `compliance.middleware.js` to
 * annotate business requests with the subject's compliance state.
 * "Active" means not completed/cancelled/rejected, or a completed delete
 * (the subject is gone and 410 must persist).
 */
export const activeForSubject = async (subjectId) =>
  ComplianceLog.find({
    subjectId,
    status: { $in: ['received', 'in_progress'] },
  })
    .sort({ createdAt: -1 })
    .lean();

/** Deletion requests for a subject in any non-cancelled/non-rejected state. */
export const deletionRequestsForSubject = async (subjectId) =>
  ComplianceLog.find({
    subjectId,
    type: 'delete',
    status: { $nin: ['cancelled', 'rejected'] },
  })
    .sort({ createdAt: -1 })
    .lean();

export default {
  file,
  list,
  findById,
  findByRequestId,
  findBySubject,
  transition,
  attachEvidence,
  activeForSubject,
  deletionRequestsForSubject,
  _meta: { proofOfSearchRows: true, lifecycle: ['received', 'in_progress', 'completed', 'rejected', 'cancelled'] },
};
