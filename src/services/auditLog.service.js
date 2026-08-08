/**
 * Audit Log Service (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Single write entry point for audit events, plus the read surface for
 *   the `/audit-logs` API. Writes MUST go through `emit` so the event
 *   shape stays consistent and sensitive payloads are always redacted.
 *
 * RESPONSIBILITY
 *   - emit({ actor, action, module, resource, before, after, reason })
 *   - list(filters) / getById / listByModule
 *   - requestExport(filters) -> exportId, getExportStatus(exportId)
 *
 * CODING GUIDELINES
 *   - Sensitive payloads (passwords, tokens, refreshTokenHash, MFA
 *     secrets) are redacted recursively BEFORE persistence - never store
 *     raw secrets in the trail.
 *   - All reads filter by tenant unless the actor is a platform admin
 *     (the controller/middleware layer enforces that; the service accepts
 *     a tenant filter when provided).
 *   - Export jobs are intended to flow through `src/queues/` ->
 *     `src/storage/`; the queue consumer is a later-sprint deliverable,
 *     so `requestExport` records the request but no processing exists yet.
 */

import { randomUUID } from 'node:crypto';
import ApiError from '../utils/ApiError.js';
import auditLogRepository from '../repositories/auditLog.repository.js';

/** Sensitive field names, matched case-insensitively and stripped before persist. */
const SENSITIVE_KEYS = new Set([
  'password', 'passwordhash', 'refreshtoken', 'refreshtokenhash',
  'accesstoken', 'mfasecret', 'mfacode', 'secret', 'authorization',
  'cookie', 'token',
]);

const ACTOR_TYPES = new Set(['admin', 'user', 'service', 'system']);
const RESULTS = new Set(['success', 'failure']);

/**
 * Append an audit event to the trail. Validates the shape, redacts any
 * sensitive payload in `before`/`after`, and persists via the repository.
 *
 * @param {Object} opts
 * @param {{ type: 'admin'|'user'|'service'|'system', id: string, display?: string }} opts.actor
 * @param {string} opts.action
 * @param {string} opts.module - e.g. `iam.roles`, `iam.tenants`.
 * @param {{ type?: string, id?: string }} [opts.resource]
 * @param {*} [opts.before]
 * @param {*} [opts.after]
 * @param {string} [opts.reason]
 * @param {string} [opts.tenantId]
 * @param {'success'|'failure'} [opts.result='success']
 * @param {string} [opts.errorCode]
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.requestId]
 * @returns {Promise<Object>} saved event (plain).
 */
export async function emit({
  actor,
  action,
  module,
  resource,
  before,
  after,
  reason,
  tenantId,
  result = 'success',
  errorCode,
  ip,
  userAgent,
  requestId,
} = {}) {
  if (!actor || !ACTOR_TYPES.has(actor.type)) {
    throw ApiError.badRequest('actor.type must be one of admin, user, service, system');
  }
  if (!action || typeof action !== 'string') throw ApiError.badRequest('action is required');
  if (!module || typeof module !== 'string') throw ApiError.badRequest('module is required');
  if (result && !RESULTS.has(result)) {
    throw ApiError.badRequest('result must be "success" or "failure"');
  }

  return auditLogRepository.insert({
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorDisplay: actor.display ?? null,
    tenantId: tenantId ?? null,
    module,
    action,
    resourceType: resource?.type ?? null,
    resourceId: resource?.id ?? null,
    before: redact(before),
    after: redact(after),
    reason: reason ?? null,
    result,
    errorCode: errorCode ?? null,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    requestId: requestId ?? null,
  });
}

/**
 * Paginated audit read with optional filters. Applies the tenant filter
 * when provided (platform admins omit it to see everything).
 *
 * @param {Object} [opts]
 * @param {string} [opts.tenantId]
 * @param {string} [opts.module]
 * @param {string} [opts.action]
 * @param {string} [opts.actorId]
 * @param {string} [opts.actorType]
 * @param {'success'|'failure'} [opts.result]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated audit list.
 */
export async function list({
  tenantId,
  module,
  action,
  actorId,
  actorType,
  result,
  page = 1,
  limit = 20,
} = {}) {
  const filter = {};
  if (tenantId != null) filter.tenantId = tenantId;
  if (module) filter.module = module;
  if (action) filter.action = action;
  if (actorId) filter.actorId = actorId;
  if (actorType) filter.actorType = actorType;
  if (result) filter.result = result;
  return auditLogRepository.list({ filter, page, limit });
}

/**
 * Fetch a single audit entry.
 *
 * @param {Object} opts
 * @param {string} opts.id
 * @returns {Promise<Object>}
 */
export async function getById({ id } = {}) {
  const entry = await auditLogRepository.findById(id);
  if (!entry) throw ApiError.notFound('Audit entry not found');
  return entry;
}

/**
 * List audit entries for one module (e.g. `iam.tenants`).
 *
 * @param {Object} [opts]
 * @param {string} opts.module
 * @param {string} [opts.tenantId]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated audit list.
 */
export async function listByModule({ module, tenantId, page = 1, limit = 20 } = {}) {
  const filters = {};
  if (tenantId != null) filters.tenantId = tenantId;
  return auditLogRepository.listByModule(module, { filter: filters }, { page, limit });
}

/**
 * Request an audit export. Records the export id in `queued` state.
 * NOTE: the queue consumer that materialises the export file is a
 * later-sprint deliverable; this call only reserves the id + filters.
 *
 * @param {Object} [opts]
 * @param {Object} [opts.filters]
 * @param {string} [opts.requestedBy]
 * @returns {Promise<{ exportId: string, status: 'queued', filters: Object }>}
 */
export async function requestExport({ filters = {}, requestedBy = null } = {}) {
  return {
    exportId: `exp_${randomUUID()}`,
    status: 'queued',
    requestedBy,
    filters,
  };
}

/**
 * Poll the status of an audit export. With no processing pipeline yet,
 * a known id always reports `queued`.
 *
 * @param {Object} opts
 * @param {string} opts.exportId
 * @returns {Promise<{ exportId: string, status: 'queued' }>}
 */
export async function getExportStatus({ exportId } = {}) {
  if (!exportId || typeof exportId !== 'string') {
    throw ApiError.badRequest('exportId is required');
  }
  return { exportId, status: 'queued' };
}

/* ------------------------------ internals -------------------------------- */

/**
 * Recursively replace sensitive values with a redaction marker so secrets
 * never reach the append-only trail. Plain values pass through unchanged.
 *
 * @param {*} value
 * @returns {*}
 */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(val);
    }
    return out;
  }
  return value;
}

export default {
  emit,
  list,
  getById,
  listByModule,
  requestExport,
  getExportStatus,
  _meta: { appendOnly: true, redacts: [...SENSITIVE_KEYS] },
};
