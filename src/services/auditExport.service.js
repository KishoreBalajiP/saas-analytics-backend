/**
 * Audit Export Service (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Materialises audit-trail exports asynchronously through the export
 *   queue: `requestExport` reserves an id + sanitised filters and enqueues
 *   the work; `processExport` (the queue consumer) reads the tenant-scoped
 *   trail, serialises it to JSON or CSV, stores the artifact, and records
 *   the outcome. Clients poll `getExportStatus` until `completed` and then
 *   download the artifact via a short-lived URL.
 *
 * DESIGN CONSTRAINTS
 *   - Filters are sanitised ONCE at request time (`sanitizeAuditFilters`)
 *     so the consumer never re-trusts request-shaped input.
 *   - The export is bounded by `MAX_EXPORT_ROWS`; callers who need more
 *     should page with narrower filters.
 *   - A completed export writes a normal audit event (module `audit_logs`,
 *     action `export`) so the export itself is on the trail.
 */

import { randomUUID } from 'node:crypto';
import ApiError from '../utils/ApiError.js';
import auditLogRepository from '../repositories/auditLog.repository.js';
import auditExportRepository from '../repositories/auditExport.repository.js';
import * as storageService from './storage.service.js';
import * as queueService from './queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import { sanitizeAuditFilters, buildAuditFilter } from '../utils/auditFilters.js';
import { emit as emitAudit } from './auditLog.service.js';

/** Hard cap on exported rows per request. */
export const MAX_EXPORT_ROWS = 10000;
/** How long the stored artifact stays downloadable. */
export const EXPORT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

const FORMATS = new Set(['json', 'csv']);
const CSV_HEADER = [
  'id', 'occurredAt', 'actorType', 'actorId', 'actorDisplay', 'tenantId',
  'module', 'action', 'resourceType', 'resourceId', 'result', 'errorCode',
  'ip', 'requestId', 'reason',
];

/**
 * Reserve an export request and enqueue the materialisation job. `kind`
 * selects which collection the consumer reads (`audit` = audit trail,
 * `access-log` = HTTP access trace).
 *
 * @param {Object} opts
 * @param {'audit'|'access-log'} [opts.kind='audit'] - source collection.
 * @param {string|null} [opts.tenantId] - null for a platform-wide export.
 * @param {string|null} [opts.requestedBy] - actor id (admin) that asked.
 * @param {Object} [opts.filters={}] - raw filter input (sanitised here).
 * @param {'json'|'csv'} [opts.format='json']
 * @returns {Promise<{ exportId: string, status: 'queued', format: string, filters: Object }>}
 */
export async function requestExport({ kind = 'audit', tenantId = null, requestedBy = null, filters = {}, format = 'json' } = {}) {
  if (!FORMATS.has(format)) {
    throw ApiError.badRequest('format must be "json" or "csv"');
  }
  if (!['audit', 'access-log'].includes(kind)) {
    throw ApiError.badRequest('kind must be "audit" or "access-log"');
  }

  const sanitised = sanitizeAuditFilters(filters);
  const exportId = `exp_${randomUUID()}`;

  await auditExportRepository.create({
    exportId,
    kind,
    tenantId: tenantId ?? null,
    requestedBy: requestedBy ?? null,
    format,
    filters: sanitised,
    status: 'queued',
  });

  await queueService.enqueue(
    QUEUE_NAMES.EXPORT_JOBS,
    { exportId, tenantId: tenantId ?? null, kind },
    { jobId: exportId, name: kind === 'access-log' ? 'access-log-export' : 'audit-export' },
  );

  return { exportId, status: 'queued', format, filters: sanitised };
}

/**
 * Poll the status of an export. Tenant-scoped callers (support admins) can
 * only see exports they own; platform admins pass `tenantId = null`.
 *
 * @param {Object} opts
 * @param {string} opts.exportId
 * @param {string|null} [opts.tenantId] - scope enforcement (null = platform).
 * @returns {Promise<Object>} status (with `downloadUrl` when completed).
 */
export async function getExportStatus({ exportId, tenantId = null } = {}) {
  if (!exportId || typeof exportId !== 'string') {
    throw ApiError.badRequest('exportId is required');
  }
  const row = await auditExportRepository.findByExportId(exportId, { tenantId });
  if (!row) throw ApiError.notFound('Audit export not found');

  const status = {
    exportId: row.exportId,
    kind: row.kind ?? 'audit',
    status: row.status,
    format: row.format,
    filters: row.filters ?? {},
    requestedBy: row.requestedBy ?? null,
    recordCount: row.recordCount ?? 0,
    completedAt: row.completedAt ?? null,
    expiresAt: row.expiresAt ?? null,
    error: row.error ?? null,
  };

  if (row.status === 'completed' && row.storageKey) {
    const downloadUrl = await storageService.presignedUrl(row.storageKey, {
      ttlSec: Math.floor(EXPORT_ARTIFACT_TTL_MS / 1000),
    });
    status.downloadUrl = downloadUrl;
    status.fileName = row.fileName ?? null;
  }

  return status;
}

/**
 * Materialise the export (queue consumer entry point).
 *
 * @param {Object} opts
 * @param {string} opts.exportId
 * @returns {Promise<Object>} completion summary.
 */
export async function processExport({ exportId } = {}) {
  if (!exportId) throw ApiError.badRequest('exportId is required');
  const row = await auditExportRepository.findByExportId(exportId);
  if (!row) throw ApiError.notFound('Audit export not found');

  const transitioned = await auditExportRepository.markProcessing(exportId);
  if (!transitioned) {
    // Already terminal (completed/failed) or already being processed - a
    // replay must not double-run the job.
    return { exportId, status: row.status };
  }

  try {
    const filter = buildAuditFilter({ ...(row.filters ?? {}), tenantId: row.tenantId ?? undefined });
    const rows = await collectRows(filter);
    const format = row.format === 'csv' ? 'csv' : 'json';
    const ext = format === 'csv' ? 'csv' : 'json';
    const storageKey = `audit/exports/${row.tenantId ?? 'platform'}/${exportId}.${ext}`;
    const fileName = `audit-export-${exportId}.${ext}`;

    if (format === 'csv') {
      await storageService.put(storageKey, toCsv(rows), { contentType: 'text/csv' });
    } else {
      await storageService.putJson(storageKey, {
        exportId,
        format: 'json',
        generatedAt: new Date().toISOString(),
        filters: row.filters ?? {},
        count: rows.length,
        rows,
      });
    }

    const completed = await auditExportRepository.markCompleted(exportId, {
      storageKey,
      fileName,
      recordCount: rows.length,
      expiresAt: new Date(Date.now() + EXPORT_ARTIFACT_TTL_MS),
    });

    await emitAudit({
      actor: { type: 'service', id: null, display: 'audit-export' },
      action: 'export',
      module: 'audit_logs',
      resource: { type: 'auditExport', id: exportId },
      tenantId: row.tenantId ?? null,
      after: { exportId, format, recordCount: rows.length },
      result: 'success',
      reason: 'audit export completed',
    });

    return { exportId, status: completed.status, recordCount: rows.length, fileName, storageKey };
  } catch (err) {
    await auditExportRepository.markFailed(exportId, err?.message ?? 'Export failed');
    throw err;
  }
}

/* ------------------------------ internals -------------------------------- */

/**
 * Page through the audit trail until the cap is reached. Uses the
 * repository's lean pagination so exports never hydrate full documents.
 *
 * @param {Object} filter - safe Mongo filter (see `buildAuditFilter`).
 * @returns {Promise<Array<Object>>} collected plain rows (bounded).
 */
async function collectRows(filter) {
  const rows = [];
  let page = 1;
  const PAGE_SIZE = 500;

  for (;;) {
    const { docs } = await auditLogRepository.list({ filter, page, limit: PAGE_SIZE });
    rows.push(...docs);
    if (rows.length >= MAX_EXPORT_ROWS) {
      rows.length = MAX_EXPORT_ROWS;
      break;
    }
    if (docs.length < PAGE_SIZE) break;
    page += 1;
  }
  return rows;
}

/** Serialise rows to CSV with a stable header and RFC-4180 quoting. */
function toCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const row of rows) {
    lines.push(CSV_HEADER.map((field) => escapeCsv(row[field] ?? '')).join(','));
  }
  return lines.join('\n');
}

function escapeCsv(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default {
  requestExport,
  getExportStatus,
  processExport,
  MAX_EXPORT_ROWS,
  EXPORT_ARTIFACT_TTL_MS,
};
