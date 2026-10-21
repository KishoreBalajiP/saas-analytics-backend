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
 *   - findExport      - one export of a tenant (optionally of one requester).
 *   - claimExport     - atomic pending -> running transition for the worker.
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
export async function createQuery({ tenantId, createdBy, params, resultMeta, status = 'ready', connectorIds = [], kind = 'query', artifact = null, attribution = null }) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const doc = await AnalyticsQuery.create({
    tenantId,
    createdBy: createdBy ?? null,
    params: params || {},
    status,
    resultMeta: resultMeta || {},
    connectorIds: (connectorIds || []).map(toId).filter(Boolean),
    kind,
    artifact,
    // ai-catalogue: P7 attribution.
    attribution,
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
export async function listQueries({ tenantId, page = 1, limit = 20, status, kind } = {}) {
  const filter = { tenantId };
  if (status) filter.status = status;
  // ai-catalogue: attribution-only runs (kind `run`) are listed only when asked for.
  filter.kind = kind ?? { $ne: 'run' };
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

/**
 * Find one export of a tenant (kind `export`), optionally only when it was
 * requested by `createdBy`. Null when absent.
 */
export async function findExport(tenantId, id, { createdBy } = {}) {
  const _id = toId(id);
  if (!_id || !tenantId) return null;
  const filter = { _id, tenantId, kind: 'export' };
  if (createdBy !== undefined) filter.createdBy = createdBy;
  return AnalyticsQuery.findOne(filter).lean();
}

/**
 * Atomically move a pending export to `running` (exactly one worker wins,
 * so a redelivered job never writes the artefact twice). An export left
 * `running` since before `staleBefore` (its worker died) can be claimed
 * again by a redelivered job. Null otherwise.
 */
export async function claimExport(tenantId, id, { now = new Date(), staleBefore = null } = {}) {
  const _id = toId(id);
  if (!_id || !tenantId) return null;
  const claimable = staleBefore
    ? { $or: [{ status: 'pending' }, { status: 'running', 'artifact.startedAt': { $lte: staleBefore } }] }
    : { status: 'pending' };
  return AnalyticsQuery.findOneAndUpdate(
    { _id, tenantId, kind: 'export', ...claimable },
    { $set: { status: 'running', 'artifact.startedAt': now } },
    { new: true, lean: true },
  );
}

export default { createQuery, getQuery, listQueries, updateResult, findExport, claimExport };
