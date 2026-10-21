/**
 * Report Service (Sprint 7 - implemented).
 *
 * PURPOSE
 *   Business logic for scheduled + ad-hoc analytics reports. Reports produce
 *   frozen artefacts (CSV / JSON / real XLSX) and deliver them via email or
 *   download. Ad-hoc runs are always enqueued onto the analytics queue; the
 *   worker (`processRun`) generates the artefact off the HTTP hot path and
 *   persists run state. Generated binaries live in `src/storage/`.
 *
 * ARTEFACTS
 *   Every artefact holds the WHOLE result: rows stream from one engine
 *   cursor into storage (`artifact.service.writeQueryArtifact`). The only
 *   limit is the configurable safety cap ARTIFACT_MAX_ROWS; a run that hits
 *   it records `truncated: true` and `rowLimit`. `rowCount` is always the
 *   number of rows in the file. Downloads are short-lived signed URLs.
 *
 * REUSE
 *   - Widget reports read the widget's effective query the same way widget
 *     execution does (`dashboard.service.mergeWidgetQuery`).
 *   - Query reports store a query validated by the engine's strict contract
 *     (`QUERY_FIELDS` + `datasetId`); relative date presets are stored as
 *     presets and resolved at run time in the workspace time zone.
 *
 * FILTER PRECEDENCE AT RUN TIME
 *   source query (widget / stored query)
 *     < report-level `filters` envelope { dateRange, filters, filtersOp }
 *     < run overrides (same envelope shape, POST /reports/:id/run).
 *   A dateRange from a higher level replaces the window; filters from the
 *   report or run level are AND-ed on top of the source (they narrow it).
 *   A run-level `filtersOp` without filters re-combines the report-level
 *   filters for that run.
 *
 * SCHEDULES
 *   `schedule.timezone` is an optional IANA override; when it is empty the
 *   cron runs in the workspace time zone (`localization.timezone`).
 *
 * RESPONSIBILITY
 *   - list, create, getById, update, remove
 *   - run (enqueue) + processRun (worker) + download
 *   - runDue (scheduler scan for scheduled reports)
 */

// rls: background runs query as their owner.
import dataAccess from './dataAccess.service.js';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import entitlementService from './entitlement.service.js';
import usageService from './usage.service.js';
import reportRepository from '../repositories/report.repository.js';
import dashboardRepository from '../repositories/dashboard.repository.js';
import widgetRepository from '../repositories/widget.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import * as dashboardService from './dashboard.service.js';
import * as engine from './analytics.engine.js';
import * as auditLogService from './auditLog.service.js';
import * as storageService from './storage.service.js';
import * as artifactService from './artifact.service.js';
// ai-catalogue: P7 attribution of report runs.
import { recordRun } from './queryAttribution.service.js';
import { exportExpiredError } from '../utils/exportExpiry.js';
import * as queueService from './queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import { nextCronDate, assertValidCron } from '../utils/cron.js';
import { isValidTimeZone, normalizeTimeZone } from '../utils/timezone.js';
import clock from '../utils/clock.js';
// delivery: roadmap 3.4 - scheduled runs deliver through the delivery pipeline.
import * as deliveryService from './delivery/index.js';
import { User } from '../models/User.js';
import env from '../config/env.js';
import { getTimezone as getWorkspaceTimezone } from './tenantSettings.service.js';
import { newClaimOwner, claimLeaseMs, safeNextRun, createTenantStatusCache } from '../jobs/claims.js';
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

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const DEFAULT_REPORT_CRON = '0 0 * * *';

/** `datasetId` of a query-source report: a dataset id string. */
function validateDatasetId(value, at, fail) {
  const id = String(value);
  if (!OBJECT_ID_RE.test(id)) fail(at, 'must be a dataset id');
  return id;
}

/**
 * Validate a report query against the engine contract (same fields as a
 * widget query, plus `datasetId`). Presets are stored verbatim so a
 * scheduled report always covers the window relative to when it runs.
 */
function sanitizeReportQuery(query) {
  return engine.validateQuery(query, {
    keys: QUERY_FIELDS,
    prefix: 'query.',
    extra: { datasetId: validateDatasetId },
  });
}

/** Validate the report-level filter envelope `{ dateRange?, filters?, filtersOp? }`. */
function sanitizeReportFilters(filters) {
  if (filters === undefined || filters === null) return {};
  return dashboardService.sanitizeFilterEnvelope(filters, 'filters.');
}

/** A schedule's own time zone, or null to follow the workspace time zone. */
function scheduleTimezone(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!isValidTimeZone(value)) {
    throw ApiError.badRequest('Invalid schedule time zone', [
      { field: 'schedule.timezone', message: 'must be an IANA time zone name, or empty to use the workspace time zone' },
    ]);
  }
  return normalizeTimeZone(value);
}

/**
 * The zone a report's cron runs in: its own override, else the workspace's
 * (read through `resolveWorkspaceZone`, which a scheduler scan memoises).
 */
async function effectiveScheduleTimezone(tenantId, schedule, resolveWorkspaceZone = getWorkspaceTimezone) {
  return schedule?.timezone ? normalizeTimeZone(schedule.timezone) : resolveWorkspaceZone(tenantId);
}

/** Next run of an enabled schedule, projected in its effective time zone. */
async function projectNextRun(tenantId, schedule, from = clock.now(), resolveWorkspaceZone = getWorkspaceTimezone) {
  if (!schedule?.enabled) return null;
  const tz = await effectiveScheduleTimezone(tenantId, schedule, resolveWorkspaceZone);
  return nextCronDate(schedule.cron || DEFAULT_REPORT_CRON, from, tz);
}

/** Build the persisted schedule sub-document. */
function sanitizeSchedule(schedule, defaultFormat) {
  const out = {
    enabled: Boolean(schedule.enabled),
    cron: typeof schedule.cron === 'string' ? schedule.cron : DEFAULT_REPORT_CRON,
    timezone: scheduleTimezone(schedule.timezone),
    format: REPORT_FORMATS.includes(schedule.format) ? schedule.format : defaultFormat,
    recipients: Array.isArray(schedule.recipients) ? schedule.recipients : [],
    // delivery: destination ids (webhook / Slack / Teams), checked in validateScheduleDelivery.
    destinationIds: Array.isArray(schedule.destinationIds) ? schedule.destinationIds.map(String) : [],
  };
  if (out.enabled && !out.cron.trim()) throw ApiError.badRequest('an enabled schedule requires a cron expression');
  if (out.enabled) assertValidCron(out.cron, (m) => ApiError.badRequest(m), out.timezone ?? 'UTC');
  return out;
}

// delivery: roadmap 3.4
const RECIPIENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate schedule recipients and destinations: `user` recipients must be
 * active members of the tenant, `external` recipients valid emails, at most
 * DELIVERY_MAX_RECIPIENTS, destinations owned by the tenant.
 * (Plan gating of external recipients: DEPENDS billing requireFeature(scheduled_delivery).)
 */
async function validateScheduleDelivery(tenantId, schedule) {
  const recipients = schedule.recipients || [];
  if (recipients.length > env.delivery.maxRecipients) {
    throw ApiError.badRequest('Too many recipients', [{ field: 'schedule.recipients', message: `at most ${env.delivery.maxRecipients}` }]);
  }
  const out = [];
  for (const r of recipients) {
    const type = r?.type === 'external' ? 'external' : 'user';
    const value = String(r?.value ?? '').trim();
    if (type === 'external') {
      if (!RECIPIENT_EMAIL_RE.test(value)) throw ApiError.badRequest('Invalid recipient', [{ field: 'schedule.recipients', message: 'external recipients must be email addresses' }]);
      out.push({ type, value: value.toLowerCase() });
    } else {
      const member = OBJECT_ID_RE.test(value) ? await User.exists({ _id: value, tenantId: String(tenantId), status: 'active' }) : null;
      if (!member) throw ApiError.badRequest('Invalid recipient', [{ field: 'schedule.recipients', message: 'user recipients must be active members of this workspace' }]);
      out.push({ type, value });
    }
  }
  schedule.recipients = out;
  schedule.destinationIds = await deliveryService.assertDestinationsOwned(tenantId, schedule.destinationIds || [], 'schedule.destinationIds');
  return schedule;
}

/** Deliver a ready scheduled run to every recipient and destination. Best-effort. */
async function deliverRun({ tenantId, report, runId, run }) {
  const schedule = report.schedule || {};
  const recipients = schedule.recipients || [];
  const destinationIds = schedule.destinationIds || [];
  if (!recipients.length && !destinationIds.length) return;
  const attach = run.size != null && run.size <= env.delivery.attachMaxBytes;
  let downloadUrl = '';
  if (!attach) {
    const { url } = await storageService.signedDownloadUrl(run.resultKey, {
      ttlSec: env.artifacts.downloadUrlTtlSec, fileName: run.fileName, contentType: run.contentType,
    });
    downloadUrl = `${env.delivery.publicApiUrl}${url}`;
  }
  const base = { sourceId: String(report._id), reportRunId: String(runId) };
  const text = `Report "${report.name}" is ready (${run.rowCount ?? 0} rows).`;
  const send = async (destination, payload, key) => {
    try {
      await deliveryService.deliver({ tenantId, kind: 'report', destination, payload: { ...base, ...payload }, idempotencyKey: `report:${runId}:${key}` });
    } catch (err) {
      logger.warn({ err: { message: err?.message }, reportId: String(report._id) }, 'report delivery failed');
    }
  };
  for (const r of recipients) {
    let email = r.value;
    if (r.type === 'user') {
      const user = await User.findOne({ _id: r.value, tenantId: String(tenantId), status: 'active' }).select('email').lean();
      if (!user) continue;
      email = user.email;
    }
    await send({ type: 'email', to: email, external: r.type === 'external' }, {
      template: 'report.delivered',
      variables: { reportName: report.name, rowCount: run.rowCount ?? 0, downloadUrl: downloadUrl || 'attached', unsubscribeUrl: '' },
      attachments: attach ? [{ filename: run.fileName, storageKey: run.resultKey, contentType: run.contentType }] : [],
    }, `email:${String(email).toLowerCase()}`);
  }
  for (const id of destinationIds) {
    await send({ type: 'webhook', destinationId: id }, { title: `Report: ${report.name}`, text, data: { reportId: String(report._id), runId: String(runId), rowCount: run.rowCount } }, `dest:${id}`);
  }
}

/** Verify the dataset is a connector owned by the tenant. */
async function assertDatasetOwned(tenantId, datasetId) {
  const connector = await connectorRepository.findById(String(datasetId), { tenantId });
  if (!connector) throw ApiError.badRequest('report dataset must be a connector owned by the tenant');
  return connector;
}

/**
 * Resolve the effective (unresolved) engine params + datasetId for a report
 * execution. `overrides` is the run-level filter envelope (already
 * validated); see FILTER PRECEDENCE in the header.
 */
async function resolveExecution({ tenantId, report, overrides = null }) {
  let datasetId;
  let params;
  if (report.source === 'widget') {
    const dashboard = await dashboardRepository.findById(report.dashboardId, { tenantId });
    if (!dashboard) throw ApiError.notFound('Dashboard not found');
    const widget = await widgetRepository.findById(report.widgetId, { tenantId, dashboardId: report.dashboardId });
    if (!widget) throw ApiError.notFound('Widget not found');
    await assertDatasetOwned(tenantId, widget.datasetId);
    datasetId = String(widget.datasetId);
    params = dashboardService.mergeWidgetQuery({ widget, dashboard });
  } else {
    const q = (report.query && typeof report.query === 'object') ? report.query : {};
    if (!q.datasetId) throw ApiError.badRequest('report query requires a datasetId');
    await assertDatasetOwned(tenantId, q.datasetId);
    datasetId = String(q.datasetId);
    const { datasetId: _ignored, ...query } = q;
    // The stored query is held to the contract it was saved under: a key
    // outside it (e.g. an engine option such as `tenantId`) is rejected.
    engine.validateQuery(query, { keys: QUERY_FIELDS });
    params = query;
  }
  const reportLevel = report.filters && typeof report.filters === 'object' && !Array.isArray(report.filters) ? report.filters : {};
  const run = overrides || {};
  const runHasFilters = Array.isArray(run.filters) && run.filters.length > 0;
  const envelope = {
    dateRange: run.dateRange ?? reportLevel.dateRange,
    filters: runHasFilters ? run.filters : reportLevel.filters,
    // A run-level filtersOp alone re-combines the report-level filters for
    // this run (an override is applied, never silently dropped).
    filtersOp: runHasFilters ? run.filtersOp : run.filtersOp ?? reportLevel.filtersOp,
  };
  return { datasetId, params: dashboardService.applyFilterEnvelope(params, envelope) };
}

/**
 * Run-record text for a failure. A query rejected by the contract (e.g. a
 * definition saved before it) names every offending part, so the owner can
 * see what to fix instead of a bare "Invalid analytics query".
 */
function failureMessage(err) {
  // Only our own typed errors are shown verbatim: driver and storage
  // messages can carry server paths or hosts (they are logged instead).
  if (!(err instanceof ApiError)) {
    logger.warn({ err: { message: err?.message, code: err?.code } }, 'report generation failed');
    return err?.name === 'StorageError'
      ? 'The report file could not be stored; please retry'
      : 'The report could not be generated; please retry';
  }
  const base = err?.message ?? 'generation failed';
  const details = Array.isArray(err?.errors)
    ? err.errors.filter((e) => e && e.field).map((e) => `${e.field} ${e.message}`)
    : [];
  return (details.length ? `${base}: ${details.join('; ')}` : base).slice(0, 2000);
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

  // Validate everything BEFORE consuming quota, so a rejected definition
  // never uses up a report slot.
  let resolvedQuery = null;
  if (source === 'widget') {
    if (!dashboardId || !widgetId) throw ApiError.badRequest('widget source requires dashboardId and widgetId');
  } else {
    if (!query || !query.datasetId) throw ApiError.badRequest('query source requires query.datasetId');
    resolvedQuery = sanitizeReportQuery(query);
  }

  const scheduleObj = schedule ? sanitizeSchedule(schedule, format) : { enabled: false, format, cron: DEFAULT_REPORT_CRON, timezone: null, recipients: [] };
  await validateScheduleDelivery(tenantId, scheduleObj);
  const reportFilters = sanitizeReportFilters(filters);

  const nextRunAt = await projectNextRun(tenantId, scheduleObj);

  // Report-count quota (plus the scheduled-report quota when the schedule is
  // on): consumed atomically after validation, given back if the create fails.
  const quotaMetrics = scheduleObj.enabled ? ['reports', 'scheduledReports'] : ['reports'];
  const doc = await usageService.withQuota({ tenantId, metric: quotaMetrics, by: actorId }, () => reportRepository.create({
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
    filters: reportFilters,
    schedule: scheduleObj,
    nextRunAt,
    createdBy: actorId,
  }));

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
    await validateScheduleDelivery(tenantId, next);
    updates.schedule = next;
    updates.nextRunAt = await projectNextRun(tenantId, next);
  }

  if (Object.keys(updates).length === 0) return existing;
  updates.updatedBy = actorId;
  // Turning a schedule on takes a scheduled-report slot; turning it off gives it back.
  const wasScheduled = existing.schedule?.enabled === true;
  const isScheduled = updates.schedule ? updates.schedule.enabled === true : wasScheduled;
  const applyUpdate = async () => {
    const row = await reportRepository.update(reportId, updates);
    if (!row) throw ApiError.notFound('Report not found');
    return row;
  };
  const updated = !wasScheduled && isScheduled
    ? await usageService.withQuota({ tenantId, metric: 'scheduledReports', by: actorId }, applyUpdate)
    : await applyUpdate();
  if (wasScheduled && !isScheduled) await usageService.release({ tenantId, metric: 'scheduledReports', requested: 1, by: actorId });

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
  if (!(await reportRepository.remove(reportId, actorId))) throw ApiError.notFound('Report not found');
  await usageService.release({ tenantId, metric: 'reports', requested: 1, by: actorId });
  if (existing.schedule?.enabled === true) await usageService.release({ tenantId, metric: 'scheduledReports', requested: 1, by: actorId });
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
  // Run overrides are a filter envelope, validated before anything is
  // queued: an override is applied or rejected, never silently ignored.
  const overrides = filters === undefined || filters === null ? null : sanitizeReportFilters(filters);
  if (format !== undefined && format !== null && !REPORT_FORMATS.includes(format)) {
    throw ApiError.badRequest('Invalid report format', [{ field: 'format', message: `must be one of ${REPORT_FORMATS.join(', ')}` }]);
  }
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
    filters: overrides,
  });
  try {
    await queueService.enqueue(
      QUEUE_NAMES.ANALYTICS_JOBS,
      {
        jobId: `${reportId}:${runId}`,
        tenantId,
        type: 'report',
        params: { reportId, runId, format: runFormat, filters: overrides, triggeredBy, runBy: actorId },
      },
      { name: 'report' },
    );
  } catch (err) {
    // Nothing was queued (typed 503 from the queue): never leave the run
    // pending forever; the caller still receives the queue error.
    await reportRepository.completeRun(reportId, runId, {
      status: 'failed', finishedAt: new Date(), error: 'The report could not be queued; please retry shortly',
    }).catch(() => {});
    throw err;
  }
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
    // The run record is the source of truth for its overrides (validated
    // when the run was requested); the job copy is a fallback.
    const runRecord = (report.runs || []).find((r) => String(r._id) === String(runId));
    const overrides = runRecord?.filters ?? filters ?? null;
    const { datasetId, params } = await resolveExecution({ tenantId, report, overrides });
    const fmt = [runRecord?.format, format, report.format].find((f) => REPORT_FORMATS.includes(f)) || 'csv';
    const startedAt = clock.now();
    const key = `reports/${tenantId}/${reportId}/${runId}.${artifactService.ARTIFACT_FORMATS[fmt].ext}`;
    // The whole result, streamed to storage (execution keys go last so
    // nothing in the stored query can replace them).
    // rls: the requester's data access, else the owner's (scheduled runs).
    const dataActor = dataAccess.userDataActor(runBy ?? report.ownerId ?? report.createdBy ?? null, tenantId);
    const out = await dataAccess.runAsDataActor(dataActor, () => artifactService.writeQueryArtifact({
      query: { ...params, tenantId, connectorIds: [datasetId] },
      format: fmt,
      key,
      sheetName: report.name,
    }));
    await reportRepository.completeRun(reportId, runId, {
      status: 'ready', finishedAt: new Date(), durationMs: Date.now() - t0,
      resultKey: key, rowCount: out.rowCount, truncated: out.truncated, rowLimit: out.rowLimit,
      fileName: artifactService.artifactFileName(report.name, fmt, startedAt),
      contentType: out.contentType, size: out.size, format: fmt,
    });
    // ai-catalogue: attribution of the computed run (row counts only).
    await recordRun({
      tenantId,
      source: 'report',
      sourceId: String(reportId),
      actorId: runBy ?? null,
      query: { ...params, connectorIds: [datasetId], now: startedAt },
      window: out.window ?? null,
      result: { rowCount: out.rowCount, columns: out.columns, total: null },
      durationMs: Date.now() - t0,
    });
    // delivery: roadmap 3.4 - scheduled runs go to their recipients/destinations.
    if ((runRecord?.triggeredBy ?? triggeredBy) === 'schedule') {
      await deliverRun({
        tenantId, report, runId,
        run: { resultKey: key, rowCount: out.rowCount, size: out.size, contentType: out.contentType, fileName: artifactService.artifactFileName(report.name, fmt, startedAt) },
      }).catch((err) => logger.warn({ err: { message: err?.message } }, 'report delivery failed'));
    }
    await audit({
      tenantId, actorId: runBy, action: 'report.generated', module: 'reports',
      resource: { type: 'report', id: reportId },
      after: { runId, rowCount: out.rowCount, truncated: out.truncated, format: fmt },
    });
  } catch (err) {
    await reportRepository.completeRun(reportId, runId, {
      status: 'failed', finishedAt: new Date(), durationMs: Date.now() - t0,
      error: failureMessage(err),
    });
    await audit({
      tenantId, actorId: runBy, action: 'report.generation_failed', module: 'reports',
      resource: { type: 'report', id: reportId }, result: 'failure',
      errorCode: err?.code === 'INVALID_QUERY' ? 'INVALID_QUERY' : 'GENERATION_FAILED',
    });
  }
}

/**
 * Download descriptor for a run's artefact: a short-lived signed URL
 * (`ARTIFACT_DOWNLOAD_URL_TTL_SECONDS`) plus what the file holds. Without
 * `runId` the most recent ready run is used. The caller has already been
 * authorised (tenant + `reports.export`); the URL is the credential until it
 * expires.
 */
export async function download({ tenantId, reportId, runId, actorId = null } = {}) {
  const report = await reportRepository.findById(reportId, { tenantId });
  if (!report) throw ApiError.notFound('Report not found');
  const runs = report.runs || [];
  // Without runId: the newest ready run, including one whose artefact the
  // retention job already removed (so the caller gets 410, not an older file).
  const run = runId
    ? runs.find((r) => String(r._id) === String(runId)) || null
    : [...runs].reverse().find((r) => r.status === 'ready' && (r.resultKey || r.expiredAt)) || null;
  // retention: the cleanup job deleted this artefact (RETENTION_REPORT_ARTIFACT_DAYS).
  if (run && !run.resultKey && run.expiredAt) throw exportExpiredError(run.expiredAt, 'report artefact');
  if (!run || run.status !== 'ready' || !run.resultKey) throw ApiError.notFound('No generated artefact available');
  const ext = String(run.resultKey).split('.').pop();
  const fileName = run.fileName || artifactService.artifactFileName(report.name, ext, run.finishedAt ? new Date(run.finishedAt) : clock.now());
  const contentType = run.contentType || artifactService.contentTypeForKey(run.resultKey);
  const { url, expiresAt } = await storageService.signedDownloadUrl(run.resultKey, {
    ttlSec: env.artifacts.downloadUrlTtlSec, fileName, contentType,
  });
  await audit({
    tenantId, actorId, action: 'report.downloaded', module: 'reports',
    resource: { type: 'report', id: String(reportId) }, after: { runId: String(run._id), format: run.format },
  });
  return {
    url,
    expiresAt,
    runId: String(run._id),
    fileName,
    contentType,
    format: run.format,
    rowCount: run.rowCount,
    truncated: Boolean(run.truncated),
    rowLimit: run.rowLimit ?? null,
    size: run.size ?? null,
    status: run.status,
    generatedAt: run.finishedAt,
  };
}

/**
 * Next run of a due report, projected BEFORE it is claimed or enqueued, in
 * the schedule's effective time zone. A stored cron that no longer parses
 * falls back to the daily default, and a projection that cannot be computed
 * at all (e.g. the workspace time zone cannot be read) falls back to UTC, so
 * the report is never left due on every tick.
 */
async function nextDueRun(r, now, resolveWorkspaceZone = getWorkspaceTimezone) {
  try {
    return await projectNextRun(r.tenantId, { ...r.schedule, enabled: true }, now, resolveWorkspaceZone);
  } catch {
    try {
      return await projectNextRun(r.tenantId, { ...r.schedule, enabled: true, cron: DEFAULT_REPORT_CRON }, now, resolveWorkspaceZone);
    } catch {
      return safeNextRun(r.schedule?.cron || DEFAULT_REPORT_CRON, now, DEFAULT_REPORT_CRON);
    }
  }
}

/**
 * Scheduler scan: claim every due scheduled report and enqueue one run each.
 *
 * Each candidate is claimed with one atomic update that advances `nextRunAt`
 * (projected in the schedule's effective time zone) and takes a short lease,
 * so concurrent scans (two instances, or a slow tick overlapping the next)
 * enqueue each due report exactly once per tick. The next run is computed
 * and stored BEFORE the run is enqueued, so a failure can never leave the
 * report due again. Reports of tenants that are not active are claimed
 * (their schedule moves on) but not run.
 */
export async function runDue({ now = clock.now(), limit = 50, owner = newClaimOwner() } = {}) {
  const due = await reportRepository.findByDueSchedule({ now, limit });
  const isActive = createTenantStatusCache();
  const leaseMs = claimLeaseMs();
  let claimed = 0;
  let enqueued = 0;
  let skippedInactive = 0;
  let skippedNotEntitled = 0;
  let failed = 0;
  // billing: one feature lookup per tenant per scan.
  const entitled = new Map();
  const isEntitled = (tenantId) => {
    const key = String(tenantId);
    if (!entitled.has(key)) {
      entitled.set(key, entitlementService.hasFeature({ tenantId: key, feature: 'scheduled_delivery' }).catch(() => false));
    }
    return entitled.get(key);
  };
  // One workspace time zone lookup per tenant per scan.
  const zones = new Map();
  const workspaceZone = (tenantId) => {
    const key = String(tenantId);
    if (!zones.has(key)) zones.set(key, getWorkspaceTimezone(tenantId));
    return zones.get(key);
  };
  for (const r of due) {
    const next = await nextDueRun(r, now, workspaceZone);
    const claim = await reportRepository.claimDueSchedule({
      id: r._id, expectedNextRunAt: r.nextRunAt, nextRunAt: next, owner, leaseMs, now,
    }).catch(() => null);
    if (!claim) continue; // another scan claimed it first
    claimed += 1;
    try {
      if (!(await isActive(r.tenantId))) {
        skippedInactive += 1;
        continue;
      }
      // billing: a workspace whose plan lost scheduled delivery keeps its
      // schedules (they resume after an upgrade) but nothing is sent.
      if (!(await isEntitled(r.tenantId))) {
        skippedNotEntitled += 1;
        continue;
      }
      await run({
        tenantId: r.tenantId,
        reportId: String(r._id),
        triggeredBy: 'schedule',
        format: r.schedule?.format || r.format,
      });
      enqueued += 1;
    } catch {
      failed += 1; /* continue with the next due report */
    } finally {
      await reportRepository.releaseScheduleClaim(r._id, owner).catch(() => {});
    }
  }
  return { scanned: due.length, claimed, enqueued, skippedInactive, skippedNotEntitled, failed };
}

/**
 * Re-project `nextRunAt` for a tenant's enabled schedules that follow the
 * workspace time zone (no `schedule.timezone` of their own). Called after
 * the workspace time zone changes.
 */
export async function reprojectSchedules({ tenantId, now = clock.now() } = {}) {
  let updated = 0;
  for (let page = 1; ; page += 1) {
    const result = await reportRepository.list({
      tenantId,
      filter: { 'schedule.enabled': true, 'schedule.timezone': { $in: [null, ''] } },
      page,
      limit: 100,
    });
    for (const r of result.docs) {
      try {
        await reportRepository.update(String(r._id), { nextRunAt: await projectNextRun(tenantId, r.schedule, now) });
        updated += 1;
      } catch {
        /* an unparseable legacy cron keeps its current projection */
      }
    }
    if (page >= (result.pages || 1)) break;
  }
  return { updated };
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
  reprojectSchedules,
  _meta: { module: 'reports' },
};
