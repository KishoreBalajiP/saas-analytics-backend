/**
 * Query attribution (ai-catalogue, audit doc 08 prerequisite P7).
 *
 * PURPOSE
 *   Every query the engine computes for a person or a schedule records who
 *   ran it, from which surface, the datasets it read with their data
 *   versions, the resolved window and the engine parameters (absolute
 *   window, metric references pinned to versions). A number shown anywhere
 *   (analytics, widget, report, alert, AI answer) can then be traced back to
 *   exactly the data and definitions that produced it.
 *
 * RESPONSIBILITY
 *   - buildAttribution({ ... })  the attribution document (pure)
 *   - recordRun({ ... })         persist an attribution-only run record
 *                                (AnalyticsQuery kind `run`); best-effort
 *
 * CODING GUIDELINES
 *   - Recording never fails the caller: a computed result is returned even
 *     when the history write fails.
 *   - Only parameters and counts are stored, never result rows.
 *   - Cache hits are not recorded (no computation happened); the record of
 *     the run that filled the cache is the attribution.
 */

import * as engine from './analytics.engine.js';
import * as repository from '../repositories/analytics.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import logger from '../utils/logger.js';
import { sanitizeError } from '../utils/sanitizeError.js';

/** Engine parameters worth keeping (everything but the tenant). */
function engineParams(prepared) {
  const { tenantId: _t, ...rest } = prepared ?? {};
  return {
    connectorIds: rest.connectorIds ?? [],
    filters: rest.filters ?? [],
    filtersOp: rest.filtersOp ?? 'and',
    filterGroups: rest.filterGroups ?? [],
    dateRange: rest.dateRange ?? null,
    metrics: rest.metrics ?? [],
    groupBy: rest.groupBy ?? [],
    orderBy: rest.orderBy ?? [],
    pagination: rest.pagination ?? {},
    timezone: rest.timezone ?? null,
    compare: rest.compare ?? null,
  };
}

/** `{ key, version }` of every pinned metric reference in a prepared query. */
export function metricRefsOf(prepared) {
  const out = [];
  for (const m of prepared?.metrics ?? []) {
    const match = typeof m?.ref === 'string' ? engine.METRIC_REF_RE.exec(m.ref) : null;
    if (match && match[2]) out.push({ key: match[1], version: Number(match[2]) });
  }
  return out;
}

/**
 * The attribution document of one computed run.
 *
 * @param {Object} opts
 * @param {string} opts.source - analytics | widget | report | alert | external | ai
 * @param {string|null} [opts.sourceId] - widget/report/alert id
 * @param {string|null} [opts.actorType] - user | api_key | embed | system
 * @param {string|null} [opts.actorId]
 * @param {Object} opts.prepared - `engine.prepareQuery(...).options`
 * @param {Object|null} [opts.window] - resolved window (`prepareQuery().window` or a result window)
 * @param {Array<{ id: string, version: number }>} opts.dataVersions
 * @param {Object} [opts.result] - engine result (row counts only are kept)
 * @param {number|null} [opts.durationMs]
 */
export function buildAttribution({
  source, sourceId = null, actorType = null, actorId = null,
  prepared, window = null, dataVersions = [], result = null, durationMs = null,
}) {
  const win = window ?? result?.window ?? null;
  return {
    source,
    sourceId: sourceId ? String(sourceId) : null,
    actorType: actorType ?? (actorId ? 'user' : 'system'),
    actorId: actorId ? String(actorId) : null,
    datasets: (dataVersions ?? []).map((d) => ({ connectorId: String(d.id), dataVersion: Number(d.version) || 0 })),
    window: win
      ? {
        field: win.field ?? null,
        preset: win.preset ?? null,
        from: win.from ? new Date(win.from) : null,
        to: win.to ? new Date(win.to) : null,
      }
      : null,
    timezone: prepared?.timezone ?? result?.timezone ?? null,
    metricRefs: metricRefsOf(prepared),
    engine: engineParams(prepared),
    rowCount: Array.isArray(result?.rows) ? result.rows.length : (Number.isFinite(result?.rowCount) ? result.rowCount : null),
    total: Number.isFinite(result?.total) ? result.total : null,
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : null,
  };
}

/**
 * Record an attribution-only run (AnalyticsQuery kind `run`). Callers pass
 * either the prepared options (preferred) or the raw engine options, which
 * are prepared here. Never throws.
 *
 * @returns {Promise<string|null>} the run record id, or null when not recorded.
 */
export async function recordRun({
  tenantId, source, sourceId = null, actorType = null, actorId = null,
  prepared = null, query = null, window = null, dataVersions = null, result = null, durationMs = null,
} = {}) {
  try {
    if (!tenantId || !source) return null;
    let options = prepared;
    let win = window;
    if (!options && query) {
      const ready = await engine.prepareQuery({ ...query, tenantId });
      options = ready.options;
      win = win ?? ready.window;
    }
    if (!options) return null;
    const versions = dataVersions ?? await connectorRepository.dataVersions(tenantId, options.connectorIds ?? []);
    const attribution = buildAttribution({
      source, sourceId, actorType, actorId, prepared: options, window: win, dataVersions: versions, result, durationMs,
    });
    const doc = await repository.createQuery({
      tenantId,
      createdBy: actorId ? String(actorId) : null,
      params: attribution.engine,
      status: 'ready',
      kind: 'run',
      connectorIds: options.connectorIds ?? [],
      resultMeta: {
        rowCount: attribution.rowCount ?? 0,
        columns: Array.isArray(result?.columns) ? result.columns : [],
        cached: false,
        executedAt: result?.executedAt ?? new Date(),
      },
      attribution,
    });
    return String(doc._id);
  } catch (err) {
    logger.warn({ err: sanitizeError(err), source }, 'query attribution: could not record run');
    return null;
  }
}

export default { buildAttribution, recordRun, metricRefsOf };
