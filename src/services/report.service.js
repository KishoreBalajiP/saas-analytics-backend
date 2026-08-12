/**
 * Report Service (Sprint 7 - implemented).
 *
 * PURPOSE
 *   Business logic for scheduled + ad-hoc analytics reports. Reports produce
 *   frozen artefacts (CSV / JSON / Excel) and deliver them via email or
 *   download. Ad-hoc runs are always enqueued onto the analytics queue; the
 *   worker (`processRun`) generates the artefact off the HTTP hot path and
 *   persists run state. Generated binaries live in `src/storage/`.
 *
 * REUSE
 *   - Widget reports reuse `dashboard.service.executeWidget` (which runs the
 *     safe query through the analytics engine with tenant isolation).
 *   - Query reports run the whitelisted query directly through the engine
 *     using the same `QUERY_FIELDS` contract as a widget.
 *
 * RESPONSIBILITY
 *   - list, create, getById, update, remove
 *   - run (enqueue) + processRun (worker) + download
 *   - runDue (scheduler scan for scheduled reports)
 */

import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import reportRepository from '../repositories/report.repository.js';
import dashboardRepository from '../repositories/dashboard.repository.js';
import widgetRepository from '../repositories/widget.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import * as dashboardService from './dashboard.service.js';
import * as engine from './analytics.engine.js';
import * as auditLogService from './auditLog.service.js';
import * as storageService from './storage.service.js';
import * as queueService from './queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import { nextCronDate } from '../utils/cron.js';
import { DATE_RANGE_PRESETS } from '../models/Dashboard.js';
import { QUERY_FIELDS } from '../models/Widget.js';
import {
  REPORT_STATUSES,
  REPORT_FORMATS,
  REPORT_SOURCES,
  RUN_STATUSES,
} from '../models/Report.js';

/* ------------------------------ helpers ---------------------------------- */

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isValidDate(value) {
  return value !== undefined && value !== null && !Number.isNaN(new Date(value).getTime());
}

/** Resolve a date-range preset into `{ from, to }` ISO strings (UTC). */
function resolveDateRange(dateRange, now = new Date()) {
  if (!dateRange || typeof dateRange !== 'object') return null;
  const { preset, from, to } = dateRange;
  if (!preset) return { from: from ?? null, to: to ?? null };
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  switch (preset) {
    case 'today': return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case 'yesterday': {
      const day = new Date(now); day.setDate(day.getDate() - 1);
      return { from: startOfDay(day).toISOString(), to: endOfDay(day).toISOString() };
    }
    case 'last_7_days': {
      const from = new Date(now); from.setDate(from.getDate() - 6);
      return { from: startOfDay(from).toISOString(), to: endOfDay(now).toISOString() };
    }
    case 'last_30_days': {
      const from = new Date(now); from.setDate(from.getDate() - 29);
      return { from: startOfDay(from).toISOString(), to: endOfDay(now).toISOString() };
    }
    case 'this_month': return {
      from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
      to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString(),
    };
    case 'previous_month': return {
      from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(),
      to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).toISOString(),
    };
    case 'custom': return { from: from ?? null, to: to ?? null };
    default: return null;
  }
}

/** Whitelist a report query to the same safe contract as a widget query. */
function sanitizeReportQuery(query) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    throw ApiError.badRequest('report query must be an object');
  }
  const out = {};
  for (const key of QUERY_FIELDS) {
    if (query[key] !== undefined) out[key] = query[key];
  }
  if (query.datasetId !== undefined) out.datasetId = String(query.datasetId);
  if (out.filtersOp !== undefined && !['and', 'or'].includes(out.filtersOp)) {
    throw ApiError.badRequest('query.filtersOp must be "and" or "or"');
  }
  if (out.dateRange !== undefined) out.dateRange = resolveDateRange(out.dateRange);
  return out;
}

/** Sanitize the report-level filter override envelope. */
function sanitizeReportFilters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) return {};
  const out = {};
  if (filters.dateRange !== undefined) out.dateRange = resolveDateRange(filters.dateRange);
  if (Array.isArray(filters.filters)) out.filters = filters.filters;
  if (filters.filtersOp !== undefined) {
    if (!['and', 'or'].includes(filters.filtersOp)) throw ApiError.badRequest('filtersOp must be "and" or "or"');
    out.filtersOp = filters.filtersOp;
  }
  return out;
}

/** Build the persisted schedule sub-document. */
function sanitizeSchedule(schedule, defaultFormat) {
  const out = {
    enabled: Boolean(schedule.enabled),
    cron: typeof schedule.cron === 'string' ? schedule.cron : '0 0 * * *',
    timezone: typeof schedule.timezone === 'string' ? schedule.timezone : 'UTC',
    format: REPORT_FORMATS.includes(schedule.format) ? schedule.format : defaultFormat,
    recipients: Array.isArray(schedule.recipients) ? schedule.recipients : [],
  };
  if (out.enabled && !out.cron.trim()) throw ApiError.badRequest('an enabled schedule requires a cron expression');
  return out;
}

/** Verify the dataset is a connector owned by the tenant. */
async function assertDatasetOwned(tenantId, datasetId) {
  const connector = await connectorRepository.findById(String(datasetId), { tenantId });
  if (!connector) throw ApiError.badRequest('report dataset must be a connector owned by the tenant');
  return connector;
}

/** Resolve the effective engine params + datasetId for a report execution. */
async function resolveExecution({ tenantId, report, overrides = {} }) {
  let datasetId;
  let params;
  if (report.source === 'widget') {
    const dashboard = await dashboardRepository.findById(report.dashboardId, { tenantId });
    if (!dashboard) throw ApiError.notFound('Dashboard not found');
    const widget = await widgetRepository.findById(report.widgetId, { tenantId, dashboardId: report.dashboardId });
    if (!widget) throw ApiError.notFound('Widget not found');
    await assertDatasetOwned(tenantId, widget.datasetId);
    datasetId = String(widget.datasetId);
    const widgetQuery = widget.query && typeof widget.query === 'object' ? widget.query : {};
    const dashboardFilters = dashboard.filters && typeof dashboard.filters === 'object' ? dashboard.filters : {};
    params = {
      filters: overrides.filters ?? widgetQuery.filters ?? dashboardFilters.filters ?? [],
      filtersOp: overrides.filtersOp ?? widgetQuery.filtersOp ?? dashboardFilters.filtersOp ?? 'and',
      dateRange: resolveDateRange(overrides.dateRange ?? widgetQuery.dateRange ?? dashboardFilters.dateRange ?? null),
      metrics: widgetQuery.metrics ?? [],
      groupBy: widgetQuery.groupBy ?? [],
      orderBy: widgetQuery.orderBy ?? [],
      pagination: widgetQuery.pagination ?? {},
    };
  } else {
    const q = (report.query && typeof report.query === 'object') ? report.query : {};
    if (!q.datasetId) throw ApiError.badRequest('report query requires a datasetId');
    await assertDatasetOwned(tenantId, q.datasetId);
    datasetId = String(q.datasetId);
    params = {
      filters: overrides.filters ?? q.filters ?? [],
      filtersOp: overrides.filtersOp ?? q.filtersOp ?? 'and',
      dateRange: resolveDateRange(overrides.dateRange ?? q.dateRange ?? null),
      metrics: q.metrics ?? [],
      groupBy: q.groupBy ?? [],
      orderBy: q.orderBy ?? [],
      pagination: q.pagination ?? {},
    };
  }
  // Lay report-level filters on top of the source filters.
  const reportFilters = (report.filters && report.filters.filters) || [];
  return { datasetId, params: { ...params, filters: [...params.filters, ...reportFilters] } };
}

/** Flatten raw engine rows (which nest data under `data`) to plain objects. */
function flattenRows(rows) {
  return (rows || []).map((row) => {
    if (row && row.data && typeof row.data === 'object' && !Array.isArray(row.data)) {
      const { data, ...rest } = row;
      return { ...rest, ...data };
    }
    return row;
  });
}

function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Serialize flattened rows to the requested format. */
function serialize(format, rows, meta) {
  if (format === 'json') {
    return {
      contentType: 'application/json',
      content: JSON.stringify(
        { columns: meta.columns, rowCount: meta.rowCount, generatedAt: new Date().toISOString(), rows },
        null,
        2,
      ),
    };
  }
  if (format === 'xlsx') {
    const headers = [];
    const seen = new Set();
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
    let html =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"></head><body><table>';
    html += `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
    for (const r of rows) html += `<tr>${headers.map((h) => `<td>${escapeHtml(r[h])}</td>`).join('')}</tr>`;
    html += '</table></body></html>';
    return { contentType: 'application/vnd.ms-excel', content: html };
  }
  // default: csv
  const headers = [];
  const seen = new Set();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => escapeCsv(r[h])).join(','));
  return { contentType: 'text/csv', content: lines.join('\n') };
}

/** Generate the artefact content + row count for a resolved execution. */
async function generateArtifact({ tenantId, datasetId, params, format }) {
  const result = await engine.queryRows({ tenantId, connectorIds: [datasetId], ...params });
  const rows = flattenRows(result.rows);
  const { contentType, content } = serialize(format, rows, result);
  return { content, contentType, rowCount: result.total };
}

/** Best-effort audit trail write. */
async function audit(entry) {
  try {
    await auditLogService.emit(entry);
  } catch {
    /* best-effort */
  }
}

/* ------------------------------- service --------------------------------- */

/** Paginated, tenant-scoped report list. */
export async function list({ tenantId, page = 1, limit = 20, status, search } = {}) {
  const filter = {};
  if (status && REPORT_STATUSES.includes(status)) filter.status = status;
  if (search && typeof search === 'string' && search.trim()) {
    filter.name = { $regex: search.trim(), $options: 'i' };
  }
  return reportRepository.list({ tenantId, filter, page, limit });
}

/** Create a report. */
export async function create({
  tenantId,
  actorId = null,
  name,
  description = '',
  source = 'widget',
  dashboardId,
  widgetId,
  query,
  format = 'csv',
  filters = {},
  schedule = null,
  status = 'draft',
} = {}) {
  if (typeof name !== 'string' || !name.trim()) throw ApiError.badRequest('report name is required');
  if (!REPORT_FORMATS.includes(format)) throw ApiError.badRequest('invalid report format');
  if (!REPORT_SOURCES.includes(source)) throw ApiError.badRequest('invalid report source');

  let resolvedQuery = null;
  if (source === 'widget') {
    if (!dashboardId || !widgetId) throw ApiError.badRequest('widget source requires dashboardId and widgetId');
  } else {
    if (!query || !query.datasetId) throw ApiError.badRequest('query source requires query.datasetId');
    resolvedQuery = sanitizeReportQuery(query);
  }

  const scheduleObj = schedule ? sanitizeSchedule(schedule, format) : { enabled: false, format, cron: '0 0 * * *', timezone: 'UTC', recipients: [] };

  const doc = await reportRepository.create({
    tenantId,
    ownerId: actorId,
    name: name.trim(),
    description: description ?? '',
    status: REPORT_STATUSES.includes(status) ? status : 'draft',
    source,
    dashboardId: source === 'widget' ? String(dashboardId) : null,
    widgetId: source === 'widget' ? String(widgetId) : null,
    query: source === 'query' ? resolvedQuery : null,
    format,
    filters: sanitizeReportFilters(filters),
    schedule: scheduleObj,
    nextRunAt: scheduleObj.enabled ? nextCronDate(scheduleObj.cron) : null,
    createdBy: actorId,
  });

  await audit({
    tenantId, actorId, action: 'report.created', module: 'reports',
    resource: { type: 'report', id: String(doc._id) },
    after: { name: doc.name, source: doc.source },
  });
  return doc;
}

/** Fetch a report by id (includes run history). */
export async function getById({ tenantId, reportId } = {}) {
  const report = await reportRepository.findById(reportId, { tenantId });
  if (!report) throw ApiError.notFound('Report not found');
  return report;
}

/** Update a report (whitelisted fields). */
export async function update({ tenantId, reportId, actorId = null, patch = {} } = {}) {
  const existing = await reportRepository.findById(reportId, { tenantId });
  if (!existing) throw ApiError.notFound('Report not found');

  const updates = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim()) throw ApiError.badRequest('report name must be a non-empty string');
    updates.name = patch.name.trim();
  }
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.status !== undefined) {
    if (!REPORT_STATUSES.includes(patch.status)) throw ApiError.badRequest('invalid report status');
    updates.status = patch.status;
  }
  if (patch.source !== undefined) {
    if (!REPORT_SOURCES.includes(patch.source)) throw ApiError.badRequest('invalid report source');
    updates.source = patch.source;
  }
  if (updates.source === 'widget' || patch.dashboardId || patch.widgetId) {
    updates.dashboardId = String(patch.dashboardId ?? existing.dashboardId);
    updates.widgetId = String(patch.widgetId ?? existing.widgetId);
    if (!updates.dashboardId || !updates.widgetId) {
      throw ApiError.badRequest('widget source requires dashboardId and widgetId');
    }
  }
  if (patch.query !== undefined) {
    if (!patch.query || !patch.query.datasetId) throw ApiError.badRequest('query source requires query.datasetId');
    updates.query = sanitizeReportQuery(patch.query);
  }
  if (patch.format !== undefined) {
    if (!REPORT_FORMATS.includes(patch.format)) throw ApiError.badRequest('invalid report format');
    updates.format = patch.format;
  }
  if (patch.filters !== undefined) updates.filters = sanitizeReportFilters(patch.filters);
  if (patch.schedule !== undefined) {
    const next = sanitizeSchedule({ ...existing.schedule, ...patch.schedule }, updates.format ?? existing.format);
    updates.schedule = next;
    updates.nextRunAt = next.enabled ? nextCronDate(next.cron) : null;
  }

  if (Object.keys(updates).length === 0) return existing;
  updates.updatedBy = actorId;
  const updated = await reportRepository.update(reportId, updates);
  if (!updated) throw ApiError.notFound('Report not found');

  await audit({
    tenantId, actorId, action: 'report.updated', module: 'reports',
    resource: { type: 'report', id: reportId }, after: updates,
  });
  return updated;
}

/** Soft-delete a report. */
export async function remove({ tenantId, reportId, actorId = null } = {}) {
  const existing = await reportRepository.findById(reportId, { tenantId });
  if (!existing) throw ApiError.notFound('Report not found');
  await reportRepository.remove(reportId, actorId);
  await audit({
    tenantId, actorId, action: 'report.deleted', module: 'reports',
    resource: { type: 'report', id: reportId },
  });
  return true;
}

/**
 * Enqueue an ad-hoc (or scheduled) run. Always off the HTTP hot path: the
 * worker (`processRun`) generates the artefact and updates run state.
 */
export async function run({ tenantId, reportId, actorId = null, format, filters, triggeredBy = 'manual' } = {}) {
  const report = await reportRepository.findById(reportId, { tenantId });
  if (!report) throw ApiError.notFound('Report not found');
  const runId = String(new mongoose.Types.ObjectId());
  const runFormat = format || report.format || 'csv';
  await reportRepository.addRun(reportId, {
    _id: runId,
    status: 'pending',
    triggeredBy,
    runBy: actorId,
    format: runFormat,
    filters: filters ?? null,
  });
  await queueService.enqueue(
    QUEUE_NAMES.ANALYTICS_JOBS,
    {
      jobId: `${reportId}:${runId}`,
      tenantId,
      type: 'report',
      params: { reportId, runId, format: runFormat, filters, triggeredBy, runBy: actorId },
    },
    { name: 'report' },
  );
  return { runId, accepted: true, queued: true };
}

/**
 * Worker handler: generate the artefact, store it, and persist run state.
 * Invoked by the analytics queue consumer. Never throws into the queue.
 */
export async function processRun({ tenantId, reportId, runId, format, filters, triggeredBy, runBy } = {}) {
  const t0 = Date.now();
  try {
    const report = await reportRepository.findById(reportId, { tenantId });
    if (!report) {
      await reportRepository.completeRun(reportId, runId, {
        status: 'failed', finishedAt: new Date(), error: 'Report not found',
      });
      return;
    }
    await reportRepository.completeRun(reportId, runId, { status: 'running', startedAt: new Date() });
    const { datasetId, params } = await resolveExecution({ tenantId, report, overrides: { filters } });
    const fmt = format || report.format || 'csv';
    const { content, contentType, rowCount } = await generateArtifact({ tenantId, datasetId, params, format: fmt });
    const ext = fmt === 'json' ? 'json' : fmt === 'csv' ? 'csv' : 'xls';
    const key = `reports/${tenantId}/${reportId}/${runId}.${ext}`;
    await storageService.put(key, content, { contentType });
    await reportRepository.completeRun(reportId, runId, {
      status: 'ready', finishedAt: new Date(), durationMs: Date.now() - t0,
      resultKey: key, rowCount, format: fmt,
    });
    await audit({
      tenantId, actorId: runBy, action: 'report.generated', module: 'reports',
      resource: { type: 'report', id: reportId },
      after: { runId, rowCount, format: fmt },
    });
  } catch (err) {
    await reportRepository.completeRun(reportId, runId, {
      status: 'failed', finishedAt: new Date(), durationMs: Date.now() - t0,
      error: err?.message ?? 'generation failed',
    });
    await audit({
      tenantId, actorId: runBy, action: 'report.generation_failed', module: 'reports',
      resource: { type: 'report', id: reportId }, result: 'failure', errorCode: 'GENERATION_FAILED',
    });
  }
}

/** Return a download descriptor (presigned URL) for the latest/specific run. */
export async function download({ tenantId, reportId, runId } = {}) {
  const report = await reportRepository.findById(reportId, { tenantId });
  if (!report) throw ApiError.notFound('Report not found');
  let run = report.lastRun;
  if (runId) {
    run = (report.runs || []).find((r) => String(r._id) === String(runId)) || null;
  }
  if (!run || !run.resultKey) throw ApiError.notFound('No generated artefact available');
  const url = await storageService.presignedUrl(run.resultKey, { ttlSec: 3600 });
  return {
    url,
    key: run.resultKey,
    format: run.format,
    rowCount: run.rowCount,
    status: run.status,
    generatedAt: run.finishedAt,
  };
}

/** Scheduler scan: enqueue every due scheduled report and re-project next run. */
export async function runDue({ now = new Date() } = {}) {
  const due = await reportRepository.findByDueSchedule({ now });
  let enqueued = 0;
  for (const r of due) {
    try {
      await run({
        tenantId: r.tenantId,
        reportId: String(r._id),
        triggeredBy: 'schedule',
        format: r.schedule?.format || r.format,
      });
      enqueued += 1;
      const next = nextCronDate(r.schedule?.cron || '0 0 * * *', now);
      await reportRepository.update(String(r._id), { nextRunAt: next });
    } catch {
      /* continue with the next due report */
    }
  }
  return { scanned: due.length, enqueued };
}

export default {
  list,
  create,
  getById,
  update,
  remove,
  run,
  processRun,
  download,
  runDue,
  _meta: { module: 'reports' },
};
