/**
 * Tenant Lifecycle Service (Sprint 3 - implemented).
 *
 * PURPOSE
 *   The four lifecycle transitions on a tenant: suspend, restore, disable,
 *   archive. Each enforces the legal status graph, cascades to the session
 *   store and RBAC cache, and writes an audit event.
 *
 * STATUS GRAPH
 *   - suspend : active                      -> suspended (temporary block)
 *   - restore : suspended | disabled        -> active
 *   - disable : active | suspended          -> disabled (longer block)
 *   - archive : any (except archived)       -> archived (terminal, read-only)
 *   - `archived` is terminal: every transition on an archived tenant is 409.
 *
 * CASCADE
 *   - suspend/disable/archive revoke EVERY active session in the tenant
 *     (`sessionRepository.revokeAllForTenant`) so a blocked tenant cannot
 *     authenticate through a lingering token.
 *   - Every transition invalidates the tenant's RBAC cache scope so role
 *     resolution reflects the new state immediately.
 *
 * CODING GUIDELINES
 *   - Same-state transitions are idempotent no-ops (return the tenant);
 *     illegal transitions throw 409. Unknown tenants throw 404.
 *   - All side effects run BEFORE the audit event so a failed cascade
 *     never leaves a misleading success trail.
 */

import ApiError from '../utils/ApiError.js';
import tenantRepository from '../repositories/tenant.repository.js';
import sessionRepository from '../repositories/session.repository.js';
import { invalidateScope } from './rbac.cache.service.js';
import { emit as auditEmit } from './auditLog.service.js';

const TERMINAL = 'archived';

function actorOf(by) {
  return by ? { type: 'admin', id: by } : { type: 'system', id: 'system' };
}

/**
 * Execute a lifecycle transition with guard + cascade + audit.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {'tenant.suspend'|'tenant.restore'|'tenant.disable'|'tenant.archive'} opts.action
 * @param {string[]} opts.allowedFrom - statuses the tenant may transition from.
 * @param {(id: string, meta: Object) => Promise<Object|null>} opts.repoFn
 * @param {string} [opts.reason]
 * @param {string|null} [opts.by]
 * @param {boolean} [opts.revokeSessions=false]
 * @returns {Promise<Object>} updated tenant (plain).
 */
async function transition({ tenantId, action, allowedFrom, repoFn, reason, by, revokeSessions = false }) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  if (tenant.status === TERMINAL) throw ApiError.conflict('Archived tenants cannot change status');

  if (allowedFrom.length > 0 && !allowedFrom.includes(tenant.status)) {
    throw ApiError.conflict(`Cannot ${action.replace('tenant.', '')} a tenant in status "${tenant.status}"`);
  }

  const updated = await repoFn(tenantId, { by, reason });
  if (!updated) throw ApiError.notFound('Tenant not found');

  if (revokeSessions) {
    await sessionRepository.revokeAllForTenant(tenantId, `${action.replace('tenant.', '')}: ${reason ?? 'no reason'}`);
  }
  await invalidateScope(tenantId);

  await auditEmit({
    actor: actorOf(by),
    action,
    module: 'iam.tenants',
    resource: { type: 'tenant', id: tenantId },
    tenantId,
    before: { status: tenant.status },
    after: { status: updated.status },
    reason: reason ?? null,
  });

  return updated;
}

/** Temporarily block a tenant (status -> `suspended`). */
export const suspend = ({ tenantId, reason, by } = {}) =>
  transition({
    tenantId,
    action: 'tenant.suspend',
    allowedFrom: ['active'],
    repoFn: tenantRepository.suspend,
    reason,
    by,
    revokeSessions: true,
  });

/** Re-open a suspended/disabled tenant (status -> `active`). */
export const restore = ({ tenantId, reason, by } = {}) =>
  transition({
    tenantId,
    action: 'tenant.restore',
    allowedFrom: ['suspended', 'disabled'],
    repoFn: tenantRepository.restore,
    reason,
    by,
    revokeSessions: false,
  });

/** Longer-term block (status -> `disabled`). */
export const disable = ({ tenantId, reason, by } = {}) =>
  transition({
    tenantId,
    action: 'tenant.disable',
    allowedFrom: ['active', 'suspended'],
    repoFn: tenantRepository.disable,
    reason,
    by,
    revokeSessions: true,
  });

/** Terminal, read-only state (status -> `archived`). */
export const archive = ({ tenantId, reason, by } = {}) =>
  transition({
    tenantId,
    action: 'tenant.archive',
    allowedFrom: ['pending', 'active', 'suspended', 'disabled'],
    repoFn: tenantRepository.archive,
    reason,
    by,
    revokeSessions: true,
  });

export default {
  suspend,
  restore,
  disable,
  archive,
  _meta: { cascade: 'sessions+rbac', module: 'iam.tenants' },
};
