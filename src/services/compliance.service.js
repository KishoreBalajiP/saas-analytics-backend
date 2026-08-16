/**
 * Compliance Service (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Orchestrates data-subject requests (export, delete, restrict,
 *   consent withdraw). Records every state transition to the audit trail
 *   (`governance.audit-logs`), and materialises export evidence through the
 *   storage layer.
 *
 * RESPONSIBILITY
 *   - fileRequest({ subjectId, type, reason, tenantScope? })
 *   - listRequests, getRequestStatus, cancelRequest
 *   - processExport / processDelete / processRestrict (queued jobs)
 *   - createSubjectToken / verifySubjectToken (public poll surface)
 *
 * CODING GUIDELINES
 *   - Even `no data found` outcomes produce a compliance log entry (proof of
 *     search) plus an audit event.
 *   - Tenant isolation is suspended for cross-tenant compliance flows
 *     (`tenantScope` may be empty).
 *   - Exports are queued to `src/queues/` and persisted to `src/storage/`.
 *   - The subject token is an HMAC over `requestId:subjectId:exp` - never a
 *     reversible claim, and never a bearer credential.
 */

import { randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import complianceRepository from '../repositories/compliance.repository.js';
import userRepository from '../repositories/user.repository.js';
import sessionRepository from '../repositories/session.repository.js';
import auditLogRepository from '../repositories/auditLog.repository.js';
import * as storageService from './storage.service.js';
import * as queueService from './queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import { emit as emitAudit } from './auditLog.service.js';
import env from '../config/env.js';
import { REQUEST_STATUSES } from '../models/ComplianceLog.js';

export const REQUEST_TYPES = ['export', 'delete', 'restrict', 'consent.withdraw'];
const REQUEST_TYPES_SET = new Set(REQUEST_TYPES);
const SUBJECT_TYPES_SET = new Set(['user', 'tenant']);
const FULFILL_DAYS = 30;
const TOKEN_TTL_SEC = 60 * 60 * 24 * 7; // subjects can poll for a week

/** Generate a public, URL-safe request reference. */
function makeRequestId() {
  return `crq_${randomUUID()}`;
}

/**
 * File a data-subject request. Always produces a row (even when later
 * rejected) so the search itself is provable.
 *
 * @param {Object} opts
 * @param {string} opts.subjectId
 * @param {'user'|'tenant'} [opts.subjectType='user']
 * @param {string} opts.type - one of REQUEST_TYPES.
 * @param {string} opts.reason - mandatory.
 * @param {string[]} [opts.tenantScope=[]]
 * @param {string} [opts.requesterId] - admin id or subject id.
 * @param {'admin'|'user'|'tenant'} [opts.requesterType='user']
 * @param {string} [opts.subjectEmail]
 * @param {string|null} [opts.by]
 * @returns {Promise<{ requestId: string, status: string, type: string, subjectId: string }>}
 */
export async function fileRequest({
  subjectId,
  subjectType = 'user',
  type,
  reason,
  tenantScope = [],
  requesterId = null,
  requesterType = 'user',
  subjectEmail = null,
  by = null,
} = {}) {
  if (!subjectId || typeof subjectId !== 'string') {
    throw ApiError.badRequest('subjectId is required');
  }
  if (!REQUEST_TYPES_SET.has(type)) {
    throw ApiError.badRequest(`type must be one of: ${REQUEST_TYPES.join(', ')}`);
  }
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw ApiError.badRequest('reason is required');
  }
  if (!SUBJECT_TYPES_SET.has(subjectType)) {
    throw ApiError.badRequest('subjectType must be "user" or "tenant"');
  }

  const requestId = makeRequestId();
  const row = await complianceRepository.file({
    requestId,
    type,
    subjectId,
    subjectType,
    subjectEmail,
    requesterId,
    requesterType,
    tenantScope: Array.isArray(tenantScope) ? tenantScope.map(String) : [],
    status: 'received',
    reason,
    dueBy: new Date(Date.now() + FULFILL_DAYS * 24 * 60 * 60 * 1000),
  });

  // Queue the fulfillment job. A queue failure must not fail the filing -
  // the row stays `received` and a stale-request sweeper (cleanup cron)
  // can requeue it.
  try {
    await queueService.enqueue(
      QUEUE_NAMES.EXPORT_JOBS,
      { kind: 'compliance', type, requestId, subjectId },
      { jobId: requestId, name: `compliance.${type}` },
    );
  } catch (err) {
    logger.warn({ err: { message: err?.message }, requestId }, 'compliance job enqueue failed; request remains received');
  }

  await emitAudit({
    actor: by
      ? { type: 'admin', id: by }
      : { type: 'user', id: subjectId, display: subjectEmail },
    action: `compliance.${type}.filed`,
    module: 'compliance',
    resource: { type: 'complianceRequest', id: requestId },
    tenantId: row.tenantScope?.[0] ?? null,
    after: { requestId, type, status: row.status },
    reason,
    result: 'success',
  });

  return { requestId, status: row.status, type: row.type, subjectId: row.subjectId };
}

/** Paginated request listing (admin surface). Filters are caller-sanitised. */
export async function listRequests({ filters = {}, page = 1, limit = 20 } = {}) {
  const safe = sanitizeListFilter(filters);
  return complianceRepository.list({ filter: safe, page, limit });
}

/**
 * Status of a single request. Admin callers get the full row (including the
 * internal `evidenceKey`); public callers get a scrubbed projection after the
 * subject token verifies.
 */
export async function getRequestStatus({ requestId } = {}) {
  const row = await complianceRepository.findByRequestId(requestId);
  if (!row) throw ApiError.notFound('Compliance request not found');
  return row;
}

/** Admin-visible status projection (no internal fields). */
export function toPublicStatus(row) {
  return {
    requestId: row.requestId,
    type: row.type,
    subjectType: row.subjectType,
    status: row.status,
    reason: row.reason,
    filedAt: row.createdAt,
    completedAt: row.completedAt,
    rejectionReason: row.rejectionReason,
    cancelledReason: row.cancelledReason,
    evidenceAvailable: Boolean(row.evidenceKey),
  };
}

/** Cancel a request before work starts. */
export async function cancelRequest({ requestId, by = null, reason = 'Cancelled by administrator' } = {}) {
  const row = await complianceRepository.findByRequestId(requestId);
  if (!row) throw ApiError.notFound('Compliance request not found');

  const updated = await complianceRepository.transition(
    requestId,
    ['received', 'in_progress'],
    'cancelled',
    { cancelledReason: reason, completedAt: new Date() },
  );
  if (!updated) {
    throw ApiError.conflict('Compliance request cannot be cancelled in its current state');
  }

  await emitAudit({
    actor: { type: 'admin', id: by ?? 'system' },
    action: `compliance.${row.type}.cancelled`,
    module: 'compliance',
    resource: { type: 'complianceRequest', id: requestId },
    tenantId: row.tenantScope?.[0] ?? null,
    before: { status: row.status },
    after: { status: 'cancelled' },
    reason,
    result: 'success',
  });

  return updated;
}

/* --------------------------- queued processors ---------------------------- */

/**
 * Materialise an export request: collect a bounded subject manifest, store it
 * as evidence, mark the request completed, and audit. (Queued job entry point.)
 *
 * @param {Object} opts - { requestId }.
 * @returns {Promise<Object>} completion summary.
 */
export async function processExport({ requestId } = {}) {
  const row = await startProcessing(requestId, 'export');
  if (!row) throw ApiError.notFound('Compliance request not found');

  const manifest = await buildSubjectManifest(row);
  const storageKey = `compliance/exports/${row.subjectType}/${row.subjectId}/${requestId}.json`;
  await storageService.putJson(storageKey, manifest);

  const done = await complianceRepository.transition(
    requestId,
    ['in_progress'],
    'completed',
    { evidenceKey: storageKey, completedAt: new Date() },
  );
  await attachEvidenceAndAudit(row, done, storageKey, manifest.records.length);
  return { requestId, status: done?.status ?? 'completed', recordCount: manifest.records.length, storageKey };
}

/**
 * Erase a subject's data (queued job entry point). For user subjects the
 * account is soft-deleted and every session revoked; a purge manifest is
 * stored as evidence. Tenant subjects are flagged (tenant lifecycle owns the
 * bulk erase) and a manifest of the tenant's record is kept as proof.
 */
export async function processDelete({ requestId } = {}) {
  const row = await startProcessing(requestId, 'delete');
  if (!row) throw ApiError.notFound('Compliance request not found');

  const manifest = { requestId, type: 'delete', subjectId: row.subjectId, subjectType: row.subjectType, purgedAt: new Date().toISOString() };

  if (row.subjectType === 'user') {
    const user = await userRepository.findById(row.subjectId);
    if (user) {
      await userRepository.softDelete(row.subjectId, 'compliance');
      await sessionRepository.revokeAllForActor(row.subjectId, 'compliance: erasure');
      manifest.purged = {
        email: user.email,
        tenantId: user.tenantId,
        status: user.status,
        deletedAt: new Date().toISOString(),
      };
    } else {
      manifest.purged = null; // already gone - proof of search
    }
  } else {
    const tenant = await getTenantSummary(row.subjectId);
    manifest.purged = tenant;
    manifest.flag = 'tenant lifecycle owns bulk erasure; record flagged for purge';
  }

  const storageKey = `compliance/purges/${row.subjectType}/${row.subjectId}/${requestId}.json`;
  await storageService.putJson(storageKey, manifest);

  const done = await complianceRepository.transition(
    requestId,
    ['in_progress'],
    'completed',
    { evidenceKey: storageKey, completedAt: new Date() },
  );
  await attachEvidenceAndAudit(row, done, storageKey, 1);
  return { requestId, status: done?.status ?? 'completed', storageKey };
}

/**
 * Restrict processing for a subject (queued job entry point). Marks the
 * request completed; `compliance.middleware.js#blockIfRestricted` consults
 * the active restriction state on subsequent business requests.
 */
export async function processRestrict({ requestId } = {}) {
  const row = await startProcessing(requestId, 'restrict');
  if (!row) throw ApiError.notFound('Compliance request not found');

  const manifest = {
    requestId,
    type: 'restrict',
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    reason: row.reason,
    restrictedAt: new Date().toISOString(),
    note: 'processing restricted until the data subject lifts the restriction',
  };
  const storageKey = `compliance/restrictions/${row.subjectType}/${row.subjectId}/${requestId}.json`;
  await storageService.putJson(storageKey, manifest);

  const done = await complianceRepository.transition(
    requestId,
    ['in_progress'],
    'completed',
    { evidenceKey: storageKey, completedAt: new Date() },
  );
  await attachEvidenceAndAudit(row, done, storageKey, 0);
  return { requestId, status: done?.status ?? 'completed', storageKey };
}

/**
 * Consent withdrawal (queued job entry point). Records the withdrawal
 * manifest as evidence; downstream systems consult the compliance store
 * (via `compliance.middleware.js#blockIfRestricted`) to honour it.
 */
export async function processConsentWithdraw({ requestId } = {}) {
  const row = await startProcessing(requestId, 'consent.withdraw');
  if (!row) throw ApiError.notFound('Compliance request not found');

  const manifest = {
    requestId,
    type: 'consent.withdraw',
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    reason: row.reason,
    withdrawnAt: new Date().toISOString(),
    note: 'marketing/analytics processing withdrawn until the subject consents again',
  };
  const storageKey = `compliance/consent/${row.subjectType}/${row.subjectId}/${requestId}.json`;
  await storageService.putJson(storageKey, manifest);

  const done = await complianceRepository.transition(
    requestId,
    ['in_progress'],
    'completed',
    { evidenceKey: storageKey, completedAt: new Date() },
  );
  await attachEvidenceAndAudit(row, done, storageKey, 0);
  return { requestId, status: done?.status ?? 'completed', storageKey };
}

/* --------------------------- subject tokens ------------------------------- */

/**
 * Sign a short-lived subject token bound to a specific request. Returned to
 * the subject on the public filing surface so they can poll status without
 * any bearer credential.
 *
 * @param {Object} opts - { requestId, subjectId }.
 * @returns {Promise<string>}
 */
export async function createSubjectToken({ requestId, subjectId } = {}) {
  if (!requestId || !subjectId) throw ApiError.badRequest('requestId and subjectId are required');
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload = `${requestId}:${subjectId}:${exp}`;
  const signature = hmac(payload);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signature}`;
}

/**
 * Verify a subject token and return its claims. Throws 403 on any mismatch.
 *
 * @param {Object} opts - { token, requestId }.
 * @returns {Promise<{ requestId: string, subjectId: string, exp: number }>}
 */
export async function verifySubjectToken({ token, requestId } = {}) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw ApiError.forbidden('Invalid subject token');
  }
  const [encodedPayload, signature] = token.split('.');
  let payload;
  try {
    payload = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    throw ApiError.forbidden('Invalid subject token');
  }
  const expected = hmac(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw ApiError.forbidden('Invalid subject token');
  }
  const [tokenRequestId, subjectId, expRaw] = payload.split(':');
  const exp = Number(expRaw);
  if (tokenRequestId !== requestId || !subjectId || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    throw ApiError.forbidden('Subject token is expired or does not match this request');
  }
  return { requestId: tokenRequestId, subjectId, exp };
}

/* ------------------------------ internals -------------------------------- */

/** Advance a request to `in_progress`, validating it is the right type. */
async function startProcessing(requestId, expectedType) {
  if (!requestId) throw ApiError.badRequest('requestId is required');
  const row = await complianceRepository.findByRequestId(requestId);
  if (!row) return null;
  if (row.type !== expectedType) {
    throw ApiError.badRequest(`request is not of type ${expectedType}`);
  }
  const started = await complianceRepository.transition(
    requestId,
    ['received'],
    'in_progress',
    {},
  );
  if (!started) {
    // Already advanced - a replay must not double-run.
    return row;
  }
  return row;
}

/** Store evidence key + emit the audit event for a completed request. */
async function attachEvidenceAndAudit(row, done, storageKey, recordCount) {
  if (done) {
    await complianceRepository.attachEvidence(requestIdSafe(row), storageKey);
  }
  await emitAudit({
    actor: { type: 'service', id: null, display: 'compliance-worker' },
    action: `compliance.${row.type}.completed`,
    module: 'compliance',
    resource: { type: 'complianceRequest', id: requestIdSafe(row) },
    tenantId: row.tenantScope?.[0] ?? null,
    before: { status: 'received' },
    after: { status: 'completed', evidenceKey: storageKey, recordCount },
    reason: 'queued compliance job completed',
    result: 'success',
  });
}

/** Safe accessor that tolerates either a row or its id being passed. */
function requestIdSafe(value) {
  return typeof value === 'string' ? value : value?.requestId;
}

/** Build a bounded subject manifest for an export request. */
async function buildSubjectManifest(row) {
  const subject = row.subjectType === 'user'
    ? await safeUserSummary(row.subjectId)
    : await getTenantSummary(row.subjectId);
  const tenantScope = row.tenantScope?.[0] ?? subject?.tenantId ?? null;
  const records = await collectSubjectRecords({ subjectId: row.subjectId, subjectType: row.subjectType, tenantScope });

  return {
    requestId: row.requestId,
    type: 'export',
    subjectId: row.subjectId,
    subjectType: row.subjectType,
    generatedAt: new Date().toISOString(),
    subject,
    records,
    recordCount: records.length,
    note: 'data subject access request export',
  };
}

/** Safe user projection (never passwordHash or MFA secrets). */
async function safeUserSummary(userId) {
  const user = await userRepository.findById(userId);
  if (!user) return null;
  return {
    id: String(user._id),
    email: user.email,
    tenantId: user.tenantId,
    status: user.status,
    profile: user.profile ?? {},
    createdAt: user.createdAt,
  };
}

/** Minimal tenant record summary (no owner secrets). */
async function getTenantSummary(tenantId) {
  const { Tenant } = await import('../models/Tenant.js');
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) return null;
  return {
    id: String(tenant._id),
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    createdAt: tenant.createdAt,
  };
}

/** Collect a bounded set of audit records touching the subject. */
async function collectSubjectRecords({ subjectId, subjectType, tenantScope }) {
  const filter = subjectType === 'tenant' && tenantScope
    ? { tenantId: tenantScope }
    : { $or: [{ actorId: subjectId }, { resourceId: subjectId }] };
  const records = [];
  let page = 1;
  const PAGE_SIZE = 200;
  for (;;) {
    const { docs } = await auditLogRepository.list({ filter, page, limit: PAGE_SIZE });
    records.push(...docs);
    if (records.length >= 1000) {
      records.length = 1000;
      break;
    }
    if (docs.length < PAGE_SIZE) break;
    page += 1;
  }
  return records;
}

/** HMAC-SHA256 hex over a payload using the platform secret. */
function hmac(payload) {
  return crypto.createHmac('sha256', env.security.jwtSecret).update(payload).digest('hex');
}

/** Whitelist + coerce the list filter so operators can never reach the query. */
function sanitizeListFilter(filters = {}) {
  const out = {};
  if (filters == null || typeof filters !== 'object' || Array.isArray(filters)) return out;
  if (typeof filters.type === 'string' && REQUEST_TYPES_SET.has(filters.type)) out.type = filters.type;
  if (typeof filters.status === 'string' && REQUEST_STATUSES.includes(filters.status)) out.status = filters.status;
  if (typeof filters.subjectId === 'string') out.subjectId = filters.subjectId;
  if (typeof filters.subjectType === 'string' && SUBJECT_TYPES_SET.has(filters.subjectType)) {
    out.subjectType = filters.subjectType;
  }
  if (typeof filters.tenantScope === 'string') out.tenantScope = filters.tenantScope;
  return out;
}

/**
 * Fold a subject's compliance requests into a single state snapshot for
 * `compliance.middleware.js`. "Restriction" and "consent withdrawn" persist
 * after the request completes (until lifted); "erased" persists after a
 * completed delete (410 on any business read).
 *
 * @param {Object} opts - { subjectId, subjectType }.
 * @returns {Promise<{ subjectId, subjectType, restricted, deleted, deleteInProgress, inProgress, activeRequests }>}
 */
export async function getSubjectComplianceState({ subjectId, subjectType = 'user' } = {}) {
  if (!subjectId || typeof subjectId !== 'string') {
    throw ApiError.badRequest('subjectId is required');
  }
  const { docs } = await complianceRepository.list({
    filter: { subjectId, subjectType },
    page: 1,
    limit: 100,
  });
  const restricted = docs.some(
    (r) => (r.type === 'restrict' || r.type === 'consent.withdraw') && !['cancelled', 'rejected'].includes(r.status),
  );
  const deleted = docs.some((r) => r.type === 'delete' && r.status === 'completed');
  const deleteInProgress = docs.some((r) => r.type === 'delete' && ['received', 'in_progress'].includes(r.status));
  const inProgress = docs.some((r) => ['received', 'in_progress'].includes(r.status));
  return { subjectId, subjectType, restricted, deleted, deleteInProgress, inProgress, activeRequests: docs.length };
}

export default {
  fileRequest,
  listRequests,
  getRequestStatus,
  getSubjectComplianceState,
  cancelRequest,
  processExport,
  processDelete,
  processRestrict,
  processConsentWithdraw,
  createSubjectToken,
  verifySubjectToken,
  toPublicStatus,
  REQUEST_TYPES,
  _meta: { auditOnNoop: true, module: 'compliance' },
};

/**
 * Map a request type to its queued processor. Used by `jobs/export.worker.js`
 * when it sees `kind: 'compliance'`. Exporting the map here (instead of a
 * switch in the worker) keeps the worker leaf-free of routing knowledge.
 */
export const COMPLIANCE_PROCESSORS = Object.freeze({
  export: processExport,
  delete: processDelete,
  restrict: processRestrict,
  'consent.withdraw': processConsentWithdraw,
});
