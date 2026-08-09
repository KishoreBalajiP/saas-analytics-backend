/**
 * Analytics Service (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Public business API for `/api/v1/analytics`. Owns the *coherency* policy
 *   the engine and repository do not: cache keying, memoisation, result
 *   metadata, and history persistence.
 *
 * RESPONSIBILITY
 *   - query(options)        - run (cached) queryRows + persist a run record.
 *   - getQuery(tenantId,id) - fetch a historical run.
 *   - listQueries(...)      - paginated run history.
 *   - scheduleExport(opts)  - hand off an async export to the queue.
 *
 * CODING GUIDELINES
 *   - A cache hit does NOT create a history record (only real computation does).
 *   - Persisting the run record is best-effort: a cache miss that computed a
 *     valid result must never fail because the metadata write failed.
 *   - The service never touches repositories directly except for history; the
 *     engine reads ConnectorRow.
 */

import ApiError from '../utils/ApiError.js';
import * as engine from './analytics.engine.js';
import * as analyticsCache from './analytics.cache.js';
import * as repository from '../repositories/analytics.repository.js';
import * as scheduler from './analytics.scheduler.js';

/**
 * Run (or serve a cached) analytics query for a tenant.
 */
export async function query(options) {
  const {
    tenantId,
    connectorIds,
    filters,
    filtersOp,
    dateRange,
    metrics,
    groupBy,
    orderBy,
    pagination,
    ttlSec,
  } = options || {};

  if (!tenantId) throw ApiError.badRequest('tenantId is required');

  const params = { connectorIds, filters, filtersOp, dateRange, metrics, groupBy, orderBy, pagination };
  const cacheKey = analyticsCache.buildCacheKey({ tenantId, ...params });

  const { result, cached } = await analyticsCache.cachedQuery(cacheKey, () =>
    engine.queryRows({ tenantId, ...params }),
  );

  if (!cached) {
    const meta = await repository
      .createQuery({
        tenantId,
        createdBy: null,
        params,
        status: 'ready',
        connectorIds: connectorIds || [],
        resultMeta: {
          rowCount: result.rows.length,
          columns: result.columns,
          cached: false,
          cacheKey,
          ttlSec: ttlSec ?? analyticsCache.DEFAULT_TTL_SEC,
          executedAt: result.executedAt,
        },
      })
      .catch(() => null); // best-effort history persistence
    return {
      rows: result.rows,
      total: result.total,
      page: result.page,
      pages: result.pages,
      limit: result.limit,
      columns: result.columns,
      executedAt: result.executedAt,
      groupMode: result.groupMode,
      cached: false,
      cacheKey,
      queryId: meta ? String(meta._id) : null,
    };
  }

  return {
    rows: result.rows,
    total: result.total,
    page: result.page,
    pages: result.pages,
    limit: result.limit,
    columns: result.columns,
    executedAt: result.executedAt,
    groupMode: result.groupMode,
    cached: true,
    cacheKey,
    queryId: null,
  };
}

/** Fetch a single historical run. */
export async function getQuery({ tenantId, id }) {
  return repository.getQuery(tenantId, id);
}

/** Paginated run history for a tenant. */
export async function listQueries({ tenantId, page, limit, status }) {
  return repository.listQueries({ tenantId, page, limit, status });
}

/** Schedule an async export (enqueue + record a `pending` run). */
export async function scheduleExport(opts) {
  return scheduler.scheduleExport(opts);
}

export default { query, getQuery, listQueries, scheduleExport };
