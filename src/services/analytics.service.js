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
 *   - scheduleExport(opts)  - validate + hand off an async export to the queue.
 *   - getExport / downloadExport - status and signed download of an export.
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
import connectorRepository from '../repositories/connector.repository.js';
import * as scheduler from './analytics.scheduler.js';
import * as analyticsExport from './analyticsExport.service.js';
// ai-catalogue: P7 attribution of every computed run.
import { buildAttribution } from './queryAttribution.service.js';

function shape(result, { cached, cacheKey, queryId }) {
  return {
    rows: result.rows,
    total: result.total,
    page: result.page,
    pages: result.pages,
    limit: result.limit,
    columns: result.columns,
    executedAt: result.executedAt,
    groupMode: result.groupMode,
    timezone: result.timezone,
    window: result.window,
    cached,
    cacheKey,
    queryId,
    // ai-catalogue: present only for a compared query.
    ...(result.compare ? { compare: result.compare } : {}),
  };
}

/**
 * Run (or serve a cached) analytics query for a tenant.
 *
 * The query is validated against the engine's strict contract first (400
 * INVALID_QUERY on any unknown or invalid part), then prepared: relative
 * presets resolve to an absolute window in the workspace time zone. The
 * cache key is built from the prepared query plus the dataset versions of
 * the connectors it reads, so results refresh as soon as a sync lands.
 */
export async function query(options) {
  const { tenantId, actorId = null, actorType = null, source = 'analytics', ttlSec, ...rest } = options || {};
  if (!tenantId) throw ApiError.badRequest('tenantId is required');

  // ai-catalogue: the analytics endpoint also accepts `compare` (period over period).
  const params = engine.validateQuery(rest, { extra: { compare: engine.validateCompare } });
  const { options: prepared, window } = await engine.prepareQuery({ ...params, tenantId });
  const dataVersions = await connectorRepository.dataVersions(tenantId, prepared.connectorIds);
  const cacheKey = analyticsCache.buildCacheKey({ ...prepared, dataVersions });

  const startedAt = Date.now();
  const { result, cached } = await analyticsCache.cachedQuery(
    cacheKey,
    () => engine.queryRows(prepared),
    ttlSec ?? analyticsCache.DEFAULT_TTL_SEC,
  );

  // The cache holds the result of the absolute window; report the preset
  // that was actually asked for.
  const answer = engine.withRequestedPreset(result, params.dateRange);
  if (cached) return shape(answer, { cached: true, cacheKey, queryId: null });

  const meta = await repository
    .createQuery({
      tenantId,
      createdBy: actorId,
      // The query as asked (presets kept), so a re-run from history moves
      // with the clock instead of replaying a frozen window.
      params,
      status: 'ready',
      connectorIds: params.connectorIds || [],
      resultMeta: {
        rowCount: result.rows.length,
        columns: result.columns,
        cached: false,
        cacheKey,
        ttlSec: ttlSec ?? analyticsCache.DEFAULT_TTL_SEC,
        executedAt: result.executedAt,
      },
      // ai-catalogue: who ran it, which dataset versions, which window and engine parameters.
      attribution: buildAttribution({
        source,
        actorType,
        actorId,
        prepared,
        window: result.window ?? window,
        dataVersions,
        result,
        durationMs: Date.now() - startedAt,
      }),
    })
    .catch(() => null); // best-effort history persistence
  return shape(answer, { cached: false, cacheKey, queryId: meta ? String(meta._id) : null });
}

/** Fetch a single historical run. */
export async function getQuery({ tenantId, id }) {
  return repository.getQuery(tenantId, id);
}

/** Paginated run history for a tenant. */
export async function listQueries({ tenantId, page, limit, status, kind }) {
  return repository.listQueries({ tenantId, page, limit, status, kind });
}

/**
 * Schedule an async export of the WHOLE result of a query: validate the
 * request (format + strict query contract + workspace datasets), record a
 * `pending` export and enqueue it. See analyticsExport.service.js.
 */
export async function scheduleExport({ tenantId, actorId = null, body } = {}) {
  const { format, query } = await analyticsExport.validateExportRequest({ tenantId, body });
  return scheduler.scheduleExport({ tenantId, actorId, format, query });
}

/** Status of one of the caller's exports. */
export async function getExport({ tenantId, actorId, exportId }) {
  return analyticsExport.getStatus({ tenantId, actorId, exportId });
}

/** Short-lived signed download URL of one of the caller's ready exports. */
export async function downloadExport({ tenantId, actorId, exportId }) {
  return analyticsExport.getDownload({ tenantId, actorId, exportId });
}

export default { query, getQuery, listQueries, scheduleExport, getExport, downloadExport };
