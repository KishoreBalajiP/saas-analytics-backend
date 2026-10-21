/**
 * Analytics Export Service (roadmap 1.5).
 *
 * PURPOSE
 *   Async export of an ad-hoc analytics query to a file (CSV, JSON or XLSX)
 *   holding the WHOLE result, end to end:
 *
 *     POST /analytics/export        scheduleExport  -> 202 { exportId, status: 'pending' }
 *     analytics queue, type 'export' processExport  -> artefact in storage, status 'ready'
 *     GET  /analytics/exports/:id   getStatus       -> status, rows, truncated, file name
 *     GET  /analytics/exports/:id/download          -> short-lived signed URL
 *
 *   The export record is an `AnalyticsQuery` with `kind: 'export'` (it also
 *   shows in the query history). The artefact is written by the same
 *   streaming writer as report runs (`artifact.service.writeQueryArtifact`).
 *
 * ACCESS
 *   Every call is tenant-scoped, and an export is visible only to the user
 *   who requested it (another user of the same workspace gets 404). The
 *   routes require `analytics.export`.
 *
 * QUERY
 *   The body is the engine's strict query contract (400 INVALID_QUERY with
 *   field errors), except `pagination`, which is refused because an export
 *   always contains the whole result. `connectorIds` must be datasets of
 *   the workspace. Relative date presets are stored as presets and resolved
 *   when the export runs.
 */

// rls: background runs query as their owner.
import dataAccess from './dataAccess.service.js';
import ApiError from '../utils/ApiError.js';
import { exportExpiredError } from '../utils/exportExpiry.js';
import logger from '../utils/logger.js';
import clock from '../utils/clock.js';
import env from '../config/env.js';
import * as engine from './analytics.engine.js';
import * as artifactService from './artifact.service.js';
import * as storageService from './storage.service.js';
import * as auditLogService from './auditLog.service.js';
import * as analyticsRepository from '../repositories/analytics.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import { enqueueAnalytics } from './queue.service.js';

export const EXPORT_ERROR_CODES = Object.freeze({
  EXPORT_NOT_READY: 'EXPORT_NOT_READY',
});

/**
 * Queue job id of an export: deterministic (a duplicate enqueue of the same
 * export is collapsed by BullMQ) and free of `:`, which BullMQ refuses in
 * custom job ids ("Custom Id cannot contain :").
 */
export function exportJobId(exportId) {
  return `export-${exportId}`;
}

async function audit(entry) {
  try {
    await auditLogService.emit(entry);
  } catch {
    /* best-effort */
  }
}

/** Failure text stored on the export: typed errors verbatim, others generic. */
function failureMessage(err) {
  if (!(err instanceof ApiError)) {
    logger.warn({ err: { message: err?.message, code: err?.code } }, 'analytics export failed');
    return err?.name === 'StorageError'
      ? 'The export file could not be stored; please retry'
      : 'The export could not be generated; please retry';
  }
  const details = Array.isArray(err.errors)
    ? err.errors.filter((e) => e && e.field).map((e) => `${e.field} ${e.message}`)
    : [];
  return (details.length ? `${err.message}: ${details.join('; ')}` : err.message).slice(0, 2000);
}

/** Validate an export request: format + the strict query contract. */
export async function validateExportRequest({ tenantId, body }) {
  const { format = 'csv', ...rest } = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!artifactService.ARTIFACT_FORMAT_NAMES.includes(format)) {
    throw ApiError.badRequest('Invalid export format', [
      { field: 'format', message: `must be one of ${artifactService.ARTIFACT_FORMAT_NAMES.join(', ')}` },
    ]);
  }
  const query = engine.validateQuery(rest);
  if (query.pagination !== undefined) {
    throw new ApiError(400, 'Invalid analytics query', {
      code: engine.QUERY_ERROR_CODES.INVALID_QUERY,
      errors: [{ field: 'pagination', message: 'is not accepted: an export always contains the whole result' }],
    });
  }
  const requested = query.connectorIds ?? [];
  if (requested.length) {
    const owned = new Set((await connectorRepository.dataVersions(tenantId, requested)).map((d) => d.id));
    const errors = requested
      .map((id, i) => (owned.has(String(id)) ? null : { field: `connectorIds[${i}]`, message: 'is not a dataset of this workspace' }))
      .filter(Boolean);
    if (errors.length) {
      throw new ApiError(400, 'Invalid analytics query', { code: engine.QUERY_ERROR_CODES.INVALID_QUERY, errors });
    }
  }
  return { format, query };
}

/**
 * Record a pending export and enqueue it (type `export` on the analytics
 * queue). When nothing could be queued the record is marked failed and the
 * typed queue error (503) is rethrown.
 */
export async function scheduleExport({ tenantId, actorId, format, query }) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const record = await analyticsRepository.createQuery({
    tenantId,
    createdBy: actorId ?? null,
    params: query,
    status: 'pending',
    connectorIds: query.connectorIds || [],
    resultMeta: {},
    kind: 'export',
    artifact: { format },
  });
  const exportId = String(record._id);
  try {
    await enqueueAnalytics({ jobId: exportJobId(exportId), tenantId, type: 'export', params: { exportId } });
  } catch (err) {
    await analyticsRepository.updateResult(tenantId, exportId, {
      status: 'failed', error: 'The export could not be queued; please retry shortly',
    }).catch(() => {});
    throw err;
  }
  await audit({
    tenantId, actorId, action: 'analytics.export.requested', module: 'analytics',
    resource: { type: 'analytics_export', id: exportId }, after: { format },
  });
  return { exportId, jobId: exportId, accepted: true, queued: true, status: 'pending', format };
}

/**
 * Worker handler: claim the pending export, stream the whole result into
 * storage, and record the outcome. Never throws into the queue; a job for
 * an export that is not pending (already run, or unknown) does nothing.
 */
export async function processExport({ tenantId, exportId } = {}) {
  const t0 = Date.now();
  const startedAt = clock.now();
  // A run older than twice the cursor budget lost its worker; let a
  // redelivered job take it over.
  const staleBefore = new Date(startedAt.getTime() - 2 * env.artifacts.queryTimeoutMs);
  const claimed = await analyticsRepository.claimExport(tenantId, exportId, { now: startedAt, staleBefore });
  if (!claimed) return { status: 'skipped' };
  const format = claimed.artifact?.format ?? 'csv';
  try {
    // The stored query is held to the contract it was saved under.
    const query = engine.validateQuery(claimed.params ?? {});
    const key = `exports/${tenantId}/${exportId}.${artifactService.ARTIFACT_FORMATS[format].ext}`;
    // rls: the requester's data access (the job runs outside the request).
    const out = await dataAccess.runAsDataActor(dataAccess.userDataActor(claimed.createdBy ?? null, tenantId), () => artifactService.writeQueryArtifact({
      query: { ...query, tenantId },
      format,
      key,
      sheetName: 'Export',
    }));
    const finishedAt = clock.now();
    await analyticsRepository.updateResult(tenantId, exportId, {
      status: 'ready',
      error: null,
      resultMeta: { rowCount: out.rowCount, columns: out.columns.slice(0, 500), cached: false, cacheKey: null, ttlSec: 0, executedAt: finishedAt },
      artifact: {
        format,
        resultKey: key,
        fileName: artifactService.artifactFileName('analytics-export', format, startedAt),
        contentType: out.contentType,
        size: out.size,
        rowCount: out.rowCount,
        truncated: out.truncated,
        rowLimit: out.rowLimit,
        startedAt,
        finishedAt,
        durationMs: Date.now() - t0,
      },
    });
    await audit({
      tenantId, actorId: claimed.createdBy, action: 'analytics.export.generated', module: 'analytics',
      resource: { type: 'analytics_export', id: String(exportId) },
      after: { format, rowCount: out.rowCount, truncated: out.truncated },
    });
    return { status: 'ready', rowCount: out.rowCount, truncated: out.truncated };
  } catch (err) {
    await analyticsRepository.updateResult(tenantId, exportId, {
      status: 'failed',
      error: failureMessage(err),
      'artifact.finishedAt': clock.now(),
      'artifact.durationMs': Date.now() - t0,
    }).catch(() => {});
    await audit({
      tenantId, actorId: claimed.createdBy, action: 'analytics.export.failed', module: 'analytics',
      resource: { type: 'analytics_export', id: String(exportId) }, result: 'failure',
      errorCode: typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code) ? err.code : 'EXPORT_FAILED',
    });
    return { status: 'failed' };
  }
}

/**
 * Mark a queued export failed without running it (e.g. workspace not
 * active). Only a pending export is failed: a redelivered job must never
 * turn an export that already finished (ready) into a failure.
 */
export async function skipExport({ tenantId, exportId, reason }) {
  const doc = await analyticsRepository.findExport(tenantId, exportId).catch(() => null);
  if (!doc || doc.status !== 'pending') return;
  await analyticsRepository.updateResult(tenantId, exportId, { status: 'failed', error: reason }).catch(() => {});
}

/** Public view of an export record. */
function view(doc) {
  const a = doc.artifact ?? {};
  return {
    exportId: String(doc._id),
    status: doc.status,
    format: a.format ?? 'csv',
    rowCount: a.rowCount ?? null,
    truncated: Boolean(a.truncated),
    rowLimit: a.rowLimit ?? null,
    fileName: doc.status === 'ready' ? a.fileName ?? null : null,
    size: a.size ?? null,
    error: doc.status === 'failed' ? doc.error ?? null : null,
    createdAt: doc.createdAt ?? null,
    startedAt: a.startedAt ?? null,
    finishedAt: a.finishedAt ?? null,
  };
}

async function ownExport({ tenantId, actorId, exportId }) {
  const doc = await analyticsRepository.findExport(tenantId, exportId, { createdBy: actorId ?? null });
  if (!doc) throw ApiError.notFound('Export not found');
  return doc;
}

/** Status of one of the caller's exports (poll until `ready` or `failed`). */
export async function getStatus({ tenantId, actorId, exportId }) {
  return view(await ownExport({ tenantId, actorId, exportId }));
}

/**
 * Short-lived signed download URL for one of the caller's ready exports.
 * 409 EXPORT_NOT_READY while it is pending or running (or when it failed).
 */
export async function getDownload({ tenantId, actorId, exportId }) {
  const doc = await ownExport({ tenantId, actorId, exportId });
  const a = doc.artifact ?? {};
  // retention: the cleanup job removed this export's file (RETENTION_EXPORT_DAYS).
  if (doc.status === 'ready' && !a.resultKey && a.expiredAt) throw exportExpiredError(a.expiredAt, 'export');
  if (doc.status !== 'ready' || !a.resultKey) {
    throw new ApiError(409, doc.status === 'failed'
      ? 'This export failed; request a new export.'
      : 'This export is not ready yet; poll its status and download it when it is ready.', { code: EXPORT_ERROR_CODES.EXPORT_NOT_READY });
  }
  const { url, expiresAt } = await storageService.signedDownloadUrl(a.resultKey, {
    ttlSec: env.artifacts.downloadUrlTtlSec,
    fileName: a.fileName,
    contentType: a.contentType,
  });
  await audit({
    tenantId, actorId, action: 'analytics.export.downloaded', module: 'analytics',
    resource: { type: 'analytics_export', id: String(doc._id) }, after: { format: a.format },
  });
  return {
    url,
    expiresAt,
    exportId: String(doc._id),
    fileName: a.fileName,
    contentType: a.contentType,
    format: a.format,
    rowCount: a.rowCount,
    truncated: Boolean(a.truncated),
    rowLimit: a.rowLimit ?? null,
    size: a.size ?? null,
  };
}

export default {
  exportJobId,
  validateExportRequest,
  scheduleExport,
  processExport,
  skipExport,
  getStatus,
  getDownload,
  EXPORT_ERROR_CODES,
};
