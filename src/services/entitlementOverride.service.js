/**
 * Entitlement override service (Phase 6 - implemented).
 *
 * PURPOSE
 *   The only service that creates, lists, and revokes entitlement
 *   overrides. Enforces the safety-net clamp (`OVERRIDE_SAFETY_FACTOR`)
 *   on every write so an override can never accidentally grant
 *   unlimited access. All writes are audit-logged.
 *
 * RESPONSIBILITY
 *   - create({ tenantId, metric, kind, value, reason, expiresAt, by })
 *   - list({ tenantId, page, limit, includeRevoked })
 *   - listAll({ page, limit, includeRevoked })
 *   - revoke(id, { by, reason })
 *
 * CODING GUIDELINES
 *   - `reason` is REQUIRED for both create and revoke.
 *   - Feature overrides: `value` MUST be a boolean; metric MUST be a
 *     known feature key.
 *   - Limit overrides: `value` MUST be `{ max: integer >= 0, hard: boolean }`;
 *     metric MUST be a known limit key; `max` is clamped to the safety
 *     ceiling (`highest plan max * OVERRIDE_SAFETY_FACTOR`).
 *   - Idempotent on `(tenantId, metric, kind)`: a re-create returns
 *     the existing row.
 */

import ApiError from '../utils/ApiError.js';
import entitlementOverrideRepository from '../repositories/entitlementOverride.repository.js';
import entitlementService from './entitlement.service.js';
import { planConstants } from '../validators/plan.validator.js';
import { USAGE_METRICS } from '../models/UsageCounter.js';
import { emit as auditEmit } from './auditLog.service.js';
import planService from './plan.service.js';

const KNOWN_FEATURES = Object.freeze([
  'dashboards',
  'reports',
  'alerts',
  'scheduled_reports',
  'audit_export',
  'sso',
  'embed',
  'webhook_connectors',
]);

function actorOf(by) {
  return by ? { type: 'admin', id: by } : { type: 'system', id: 'system' };
}

function shapeOverride(row) {
  if (!row) return null;
  return {
    id: String(row._id),
    tenantId: row.tenantId,
    metric: row.metric ?? null,
    kind: row.kind,
    valueKind: row.valueKind,
    value: row.value,
    reason: row.reason,
    expiresAt: row.expiresAt ?? null,
    grantedBy: row.grantedBy,
    revokedAt: row.revokedAt ?? null,
    revokedBy: row.revokedBy ?? null,
    revokeReason: row.revokeReason ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function create({ tenantId, metric = null, kind, value, reason, expiresAt = null, by }) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!kind) throw ApiError.badRequest('kind is required');
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required for an override');
  }
  if (!by) throw ApiError.badRequest('by (admin id) is required for an override');

  let valueKind = 'boolean';
  let safeValue = value;

  if (kind === 'feature') {
    if (typeof value !== 'boolean') {
      throw ApiError.validation('Feature override value must be a boolean');
    }
    if (!metric || !KNOWN_FEATURES.includes(metric)) {
      throw ApiError.validation(`Feature override metric must be one of ${KNOWN_FEATURES.join(', ')}`);
    }
    valueKind = 'boolean';
    safeValue = value;
  } else if (kind === 'limit') {
    if (!value || typeof value !== 'object') {
      throw ApiError.validation('Limit override value must be an object { max, hard }');
    }
    if (!metric || !USAGE_METRICS.includes(metric)) {
      throw ApiError.validation(`Limit override metric must be one of ${USAGE_METRICS.join(', ')}`);
    }
    if (!Number.isInteger(value.max) || value.max < 0) {
      throw ApiError.validation('Limit override max must be a non-negative integer');
    }
    if (typeof value.hard !== 'boolean') {
      throw ApiError.validation('Limit override hard must be a boolean');
    }
    const clamped = await entitlementService.clampOverrideToSafety(metric, {
      max: value.max,
      hard: value.hard,
    });
    if (clamped.max < value.max) {
      // Safety net engaged: log the clamp to the audit trail so the
      // admin sees it in the trail.
      await auditEmit({
        actor: actorOf(by),
        action: 'entitlement.override.clamped',
        module: 'iam.entitlements',
        resource: { type: 'tenant', id: tenantId },
        tenantId,
        metadata: {
          metric,
          requestedMax: value.max,
          appliedMax: clamped.max,
          safetyFactor: planConstants.OVERRIDE_SAFETY_FACTOR,
          reason: 'override_clamped_to_safety_factor',
        },
      });
    }
    valueKind = 'object';
    safeValue = { max: clamped.max, hard: clamped.hard };
  } else {
    throw ApiError.validation('kind must be "feature" or "limit"');
  }

  const row = await entitlementOverrideRepository.create(
    {
      tenantId,
      metric: metric ?? null,
      kind,
      valueKind,
      value: safeValue,
      reason: String(reason).trim(),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      grantedBy: by,
    },
    by,
  );
  await auditEmit({
    actor: actorOf(by),
    action: 'entitlement.override.created',
    module: 'iam.entitlements',
    resource: { type: 'tenant', id: tenantId },
    tenantId,
    metadata: {
      overrideId: String(row._id),
      metric: row.metric ?? null,
      kind: row.kind,
      value: row.value,
      reason: row.reason,
      expiresAt: row.expiresAt ?? null,
    },
  });
  return shapeOverride(row);
}

export async function list({ tenantId, page = 1, limit = 20, includeRevoked = false } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const result = await entitlementOverrideRepository.listByTenant(tenantId, {
    page,
    limit,
    includeRevoked,
  });
  return { ...result, docs: result.docs.map(shapeOverride) };
}

export async function listAll({ page = 1, limit = 20, includeRevoked = true } = {}) {
  const result = await entitlementOverrideRepository.listAll({
    page,
    limit,
    includeRevoked,
  });
  return { ...result, docs: result.docs.map(shapeOverride) };
}

export async function revoke(id, { by, reason }) {
  if (!id) throw ApiError.badRequest('id is required');
  if (!reason || !String(reason).trim()) {
    throw ApiError.badRequest('A reason is required to revoke an override');
  }
  if (!by) throw ApiError.badRequest('by (admin id) is required to revoke an override');
  const updated = await entitlementOverrideRepository.revoke(id, by, String(reason).trim());
  if (!updated) throw ApiError.notFound('Override not found');
  await auditEmit({
    actor: actorOf(by),
    action: 'entitlement.override.revoked',
    module: 'iam.entitlements',
    resource: { type: 'tenant', id: updated.tenantId },
    tenantId: updated.tenantId,
    metadata: {
      overrideId: String(updated._id),
      reason,
    },
  });
  return shapeOverride(updated);
}

export default {
  create,
  list,
  listAll,
  revoke,
  _meta: { module: 'iam.entitlements' },
};
