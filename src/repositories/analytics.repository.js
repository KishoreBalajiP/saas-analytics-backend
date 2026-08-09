/**
 * Analytics Repository (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Data-access surface for persisted analytics query records
 *   (`models/AnalyticsQuery.js`). Thin: it never runs a query - the engine does
 *   that - it only persists the *metadata* of a run so the history endpoints
 *   (`GET /queries`, `GET /queries/:id`) work.
 *
 * RESPONSIBILITY
 *   - createQuery     - record that a query was run (status 'ready'/'pending').
 *   - getQuery        - fetch a single run (tenant-scoped, 404 when absent).
 *   - listQueries     - paginated history for a tenant.
 *   - updateResult    - flip status/meta after a job (e.g. export) completes.
 *
 * CODING GUIDELINES
 *   - Reads return lean objects.
 *   - TenantId is ALWAYS part of the filter (aggregate bypasses tenantScope).
 */

import mongoose from 'mongoose';
import { AnalyticsQuery } from '../models/AnalyticsQuery.js';
import ApiError from '../utils/ApiError.js';

const { ObjectId } = mongoose.Types;

/** Cast a route id to an ObjectId, or null. */
function toId(id) {
  if (!id || !/^[0-9a-fA-F]{24}$/.test(String(id))) return null;
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

/**
 * Persist a query run.
 */
export async function createQuery({ tenantId, createdBy, params, resultMeta, status = 'ready', connectorIds = [] }) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const doc = await AnalyticsQuery.create({
    tenantId,
    createdBy: createdBy ?? null,
    params: params || {},
    status,
    resultMeta: resultMeta || {},
    connectorIds: (connectorIds || []).map(toId).filter(Boolean),
  });
  return doc.toObject();
}

/** Fetch a single query run for a tenant. */
export async function getQuery(tenantId, id) {
  const _id = toId(id);
  if (!_id) throw ApiError.badRequest('Invalid query id');
  const doc = await AnalyticsQuery.findOne({ _id, tenantId }).lean();
  if (!doc) throw ApiError.notFound('Analytics query not found');
  return doc;
}

/** Paginated query history for a tenant. */
export async function listQueries({ tenantId, page = 1, limit = 20, status } = {}) {
  const filter = { tenantId };
  if (status) filter.status = status;
  const result = await AnalyticsQuery.paginate(filter, {
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
}

/** Flip a query record to a terminal state (or update metadata). */
export async function updateResult(tenantId, id, patch) {
  const _id = toId(id);
  if (!_id) throw ApiError.badRequest('Invalid query id');
  const doc = await AnalyticsQuery.findOneAndUpdate({ _id, tenantId }, { $set: patch }, {
    new: true,
    runValidators: true,
    lean: true,
  });
  if (!doc) throw ApiError.notFound('Analytics query not found');
  return doc;
}

export default { createQuery, getQuery, listQueries, updateResult };
