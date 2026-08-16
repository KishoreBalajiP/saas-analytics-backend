/**
 * Access Log Service (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Captures every authenticated HTTP request (high cardinality) with
 *   buffered/batched writes, offers aggregations for ops dashboards, and
 *   drives async exports of the trace through the shared export queue.
 *
 * RESPONSIBILITY
 *   - capture(entry)                    (buffered, batched, redacted)
 *   - list(filters) / getTopPaths / getTopErrors
 *   - requestExport / getExportStatus / processExport
 *   - countImpersonationsToday(adminId) (support budget enforcement)
 *
 * CODING GUIDELINES
 *   - Writes are batched: `capture` buffers and flushes every N events or
 *     T milliseconds. Capture failures never throw into the request path.
 *   - Only allowlisted fields are persisted, so secrets (Authorization,
 *     cookies, bodies) can never reach the collection.
 *   - Every filter value is coerced to a safe scalar; raw input can never
 *     become a Mongo operator.
 *   - Aggregations are server-side via the repository.
 */

import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import accessLogRepository from '../repositories/accessLog.repository.js';
import auditExportRepository from '../repositories/auditExport.repository.js';
import * as storageService from './storage.service.js';
import { emit as emitAudit } from './auditLog.service.js';

/** Flush cadence for the capture buffer. */
export const BATCH_SIZE = 100;
export const FLUSH_INTERVAL_MS = 2000;
/** Hard cap on exported rows per request. */
export const MAX_EXPORT_ROWS = 10000;
/** How long a stored access-log export artifact stays downloadable. */
export const EXPORT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

const CSV_HEADER = [
  'id', 'occurredAt', 'actorType', 'actorId', 'tenantId',
  'method', 'path', 'statusCode', 'latencyMs', 'ip',
  'userAgent', 'requestId', 'event', 'errorCode', 'errorMessage',
];

const STRING_FILTER_KEYS = ['actorId', 'tenantId', 'method', 'path', 'event', 'search'];
const ACTOR_TYPES = new Set(['admin', 'user', 'service', 'system']);

/* ------------------------------ capture ---------------------------------- */

/** In-memory buffer awaiting the next batched flush. */
let buffer = [];
let flushTimer = null;

/**
 * Buffer one access-log capture. Safe to call on the hot path: never throws,
 * never blocks (the flush is fire-and-forget unless the batch is full).
 *
 * @param {Object} entry - allowlisted fields (anything else is dropped).
 */
export function capture(entry) {
  const safe = sanitizeEntry(entry);
  if (!safe) return;
  buffer.push(safe);
  if (buffer.length >= BATCH_SIZE) {
    void flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_INTERVAL_MS);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }
}

/**
 * Flush the buffer to the repository. Returns the number of rows persisted.
 * The buffer is drained regardless of outcome; a failed flush is logged and
 * dropped so telemetry can never wedge the request path.
 *
 * @returns {Promise<number>}
 */
export async function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return 0;
  const batch = buffer;
  buffer = [];
  try {
    const saved = await accessLogRepository.insertMany(batch);
    return saved.length;
  } catch (err) {
    // Best-effort telemetry: do not retry or resurrect the batch.
    logger.error(
      { err: { message: err?.message }, count: batch.length },
      'access-log flush failed; batch dropped',
    );
    return 0;
  }
}

/* ------------------------------- reads ------------------------------------ */

/**
 * Paginated access-log read. `tenantId` is the caller's boundary (null for
 * platform scope); every filter value is coerced to a safe scalar.
 */
export async function list({ tenantId, filters = {}, page = 1, limit = 20 } = {}) {
  const safe = buildFilter(filters);
  if (tenantId !== undefined && tenantId !== null) safe.tenantId = String(tenantId);
  return accessLogRepository.list({ filter: safe, page, limit });
}

/** Top-N paths by request count within an optional time range. */
export async function getTopPaths({ tenantId, filters = {}, limit = 10 } = {}) {
  const filter = {};
  if (tenantId !== undefined && tenantId !== null) filter.tenantId = String(tenantId);
  return accessLogRepository.aggregateTopPaths({
    filter,
    range: toRange(filters),
    limit,
  });
}

/** Top-N error codes by frequency within an optional time range. */
export async function getTopErrors({ tenantId, filters = {}, limit = 10 } = {}) {
  const filter = {};
  if (tenantId !== undefined && tenantId !== null) filter.tenantId = String(tenantId);
  return accessLogRepository.aggregateTopErrors({
    filter,
    range: toRange(filters),
    limit,
  });
}

/**
 * Count impersonation sessions an admin started since the start of the
 * current UTC day. Used by the support service to enforce the daily budget.
 *
 * @param {string} adminId
 * @returns {Promise<number>}
 */
export async function countImpersonationsToday(adminId) {
  if (!adminId) return 0;
  const from = new Date();
  from.setUTCHours(0, 0, 0, 0);
  return accessLogRepository.countByActorWithin({ actorId: adminId, event: 'impersonate', from });
}

/* ------------------------------ exports ----------------------------------- */

/**
 * Request an async access-log export. Delegates to the shared export
 * pipeline with `kind: 'access-log'` so the consumer materialises rows from
 * the access-log collection.
 *
 * @param {Object} opts - { tenantId, requestedBy, filters, format }.
 * @returns {Promise<{ exportId: string, status: 'queued', format: string }>}
 */
export async function requestExport({ tenantId = null, requestedBy = null, filters = {}, format = 'json' } = {}) {
  const { default: auditExport } = await import('./auditExport.service.js');
  return auditExport.requestExport({ kind: 'access-log', tenantId, requestedBy, filters, format });
}

/**
 * Poll the status of an access-log export. Delegates to the shared export
 * pipeline (kind is included in the returned status).
 *
 * @param {Object} opts - { exportId, tenantId }.
 * @returns {Promise<Object>}
 */
export async function getExportStatus({ exportId, tenantId = null } = {}) {
  const { default: auditExport } = await import('./auditExport.service.js');
  return auditExport.getExportStatus({ exportId, tenantId });
}

/**
 * Materialise an access-log export (export queue consumer entry point).
 * Reads the scoped trace, serialises it to JSON or CSV, stores the artifact,
 * and records the outcome on the shared export row.
 *
 * @param {Object} opts - { exportId }.
 * @returns {Promise<Object>} completion summary.
 */
export async function processExport({ exportId } = {}) {
  if (!exportId) throw ApiError.badRequest('exportId is required');
  const row = await auditExportRepository.findByExportId(exportId);
  if (!row) throw ApiError.notFound('Export not found');

  const transitioned = await auditExportRepository.markProcessing(exportId);
  if (!transitioned) {
    // Already terminal or being processed - a replay must not double-run.
    return { exportId, status: row.status };
  }

  try {
    const filter = buildFilter({ ...(row.filters ?? {}), tenantId: row.tenantId ?? undefined });
    const rows = await collectRows(filter);
    const format = row.format === 'csv' ? 'csv' : 'json';
    const ext = format === 'csv' ? 'csv' : 'json';
    const storageKey = `access-logs/exports/${row.tenantId ?? 'platform'}/${exportId}.${ext}`;
    const fileName = `access-log-export-${exportId}.${ext}`;

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
      actor: { type: 'service', id: null, display: 'access-log-export' },
      action: 'export',
      module: 'access_logs',
      resource: { type: 'accessLogExport', id: exportId },
      tenantId: row.tenantId ?? null,
      after: { exportId, format, recordCount: rows.length },
      result: 'success',
      reason: 'access-log export completed',
    });

    return { exportId, status: completed.status, recordCount: rows.length, fileName, storageKey };
  } catch (err) {
    await auditExportRepository.markFailed(exportId, err?.message ?? 'Export failed');
    throw err;
  }
}

/* ------------------------------ internals -------------------------------- */

/**
 * Keep only allowlisted, scalar-safe fields from a capture. Anything not in
 * the allowlist (headers, bodies, authorization, cookies) is dropped, so a
 * coding mistake can never persist a secret.
 *
 * @param {Object} entry
 * @returns {Object|null} safe capture or null when unusable.
 */
function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const out = {};
  out.actorType = ACTOR_TYPES.has(entry.actorType) ? entry.actorType : 'system';
  out.actorId = scalarString(entry.actorId) ?? null;
  out.tenantId = scalarString(entry.tenantId) ?? null;
  out.method = scalarString(entry.method) ?? 'GET';
  out.path = scalarString(entry.path) ?? '/';
  out.statusCode = Number.isInteger(entry.statusCode) ? entry.statusCode : 200;
  out.latencyMs = Number.isFinite(entry.latencyMs) ? Math.round(entry.latencyMs) : 0;
  out.requestSize = Number.isFinite(entry.requestSize) ? entry.requestSize : 0;
  out.responseSize = Number.isFinite(entry.responseSize) ? entry.responseSize : 0;
  out.ip = scalarString(entry.ip) ?? null;
  out.userAgent = scalarString(entry.userAgent) ?? null;
  out.requestId = scalarString(entry.requestId) ?? null;
  out.event = scalarString(entry.event) ?? 'request';
  if (entry.error && typeof entry.error === 'object') {
    out.error = {
      code: scalarString(entry.error.code) ?? null,
      message: scalarString(entry.error.message) ?? null,
    };
  }
  return out;
}

/**
 * Build a safe Mongo filter from raw query input. Every value is coerced to
 * a scalar; objects/arrays/operators are dropped, so raw input can never
 * become a Mongo operator.
 */
export function buildFilter(filters = {}) {
  const out = {};
  if (filters == null || typeof filters !== 'object' || Array.isArray(filters)) return out;

  for (const key of STRING_FILTER_KEYS) {
    const value = scalarString(filters[key]);
    if (value === null) continue;
    if (key === 'search') {
      out.$or = [
        { path: new RegExp(escapeRegex(value), 'i') },
        { method: new RegExp(escapeRegex(value), 'i') },
        { ip: new RegExp(escapeRegex(value), 'i') },
      ];
    } else if (key === 'event') {
      out.event = value;
    } else {
      out[key] = value;
    }
  }

  const actorType = scalarString(filters.actorType);
  if (actorType && ACTOR_TYPES.has(actorType)) out.actorType = actorType;

  const statusCode = coerceInt(filters.statusCode);
  if (statusCode !== null) out.statusCode = statusCode;

  const range = toRange(filters);
  if (range) out.occurredAt = range;
  return out;
}

/** Coerce raw dateFrom/dateTo input into an `occurredAt` range object. */
function toRange(filters) {
  const from = coerceDate(filters?.dateFrom);
  const to = coerceDate(filters?.dateTo);
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return range;
}

/** Page through the access-log collection until the export cap is reached. */
async function collectRows(filter) {
  const rows = [];
  let page = 1;
  const PAGE_SIZE = 500;
  for (;;) {
    const { docs } = await accessLogRepository.list({ filter, page, limit: PAGE_SIZE });
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

/** String coercion: scalars only, capped to a sane length. */
function scalarString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed.slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Integer coercion for filter fields; returns null on anything non-scalar. */
function coerceInt(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Date coercion for filter fields; returns null on anything non-scalar. */
function coerceDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  capture,
  flush,
  list,
  getTopPaths,
  getTopErrors,
  requestExport,
  getExportStatus,
  processExport,
  countImpersonationsToday,
  BATCH_SIZE,
  FLUSH_INTERVAL_MS,
  MAX_EXPORT_ROWS,
  _meta: { batchedWrites: true },
};
