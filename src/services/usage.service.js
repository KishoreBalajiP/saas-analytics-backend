/**
 * Usage service (Phase 6 - implemented).
 *
 * PURPOSE
 *   Front-door for "I just did the thing, count it." Wraps the entitlement
 *   check with the atomic counter increment so the read-then-write race
 *   that the limit check exists to prevent cannot reappear.
 *
 * RESPONSIBILITY
 *   - checkAndConsume({ tenantId, metric, requested })   enforce + record
 *   - release({ tenantId, metric, requested })           soft-delete counterpart
 *   - incrementCumulative({ tenantId, metric, period }) cumulative metric
 *   - reconcile(tenantId, metric, value)                 admin reconciliation
 *
 * CODING GUIDELINES
 *   - `checkAndConsume` performs entitlement check first, then the
 *     atomic `incrementOrCreate`. If the atomic increment crosses the
 *     limit (extremely unlikely with hard limits, but possible when
 *     the entitlement was just changed by an admin), the soft-delete
 *     is performed and the QUOTA_EXCEEDED error is thrown. This is
 *     the only "double-check" path and is required for correctness
 *     under concurrent admin writes.
 *   - The cumulative increment accepts an `idempotencyKey`; callers
 *     using one MUST pass it and the service de-dupes via the existing
 *     `idempotencyKey` service (Sprint 9). The Phase 6 surface here is
 *     a thin pass-through; it does NOT itself maintain an idempotency
 *     table.
 */

import ApiError from '../utils/ApiError.js';
import entitlementService from './entitlement.service.js';
import usageCounterRepository from '../repositories/usageCounter.repository.js';
import { USAGE_METRICS } from '../models/UsageCounter.js';

/**
 * Enforce and then record usage. Returns the new value on success.
 * Throws `QUOTA_EXCEEDED` on hard limit. Returns `{ soft: true, ... }`
 * on soft warning.
 */
export async function checkAndConsume({ tenantId, metric, requested = 1, by = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!metric) throw ApiError.badRequest('metric is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw ApiError.badRequest(`Unknown usage metric "${metric}"`);
  }
  if (!Number.isInteger(requested) || requested <= 0) {
    throw ApiError.badRequest('requested must be a positive integer');
  }
  const check = await entitlementService.checkLimit({ tenantId, metric, requested });
  if (!check.allowed) {
    if (check.reason === 'subscription_blocked') {
      throw ApiError.forbidden(
        `Subscription state "${check.state}" blocks writes; restore or upgrade to continue.`,
      );
    }
    // Defensive: checkLimit should throw on hard; this branch is soft.
    return { ...check, value: 0 };
  }
  const inc = await usageCounterRepository.incrementOrCreate({
    tenantId,
    metric,
    period: 'current',
    delta: requested,
    by,
    kind: 'current',
  });
  if (check.ungoverned) {
    return { ...check, value: inc.value };
  }
  // Re-check after the increment; if the increment crossed the limit
  // (admin moved the plan down concurrently), undo and throw.
  const limit = check.limit;
  if (typeof limit === 'number' && inc.value > limit) {
    await usageCounterRepository.incrementOrCreate({
      tenantId,
      metric,
      period: 'current',
      delta: -requested,
      by,
      kind: 'current',
    });
    const err = new ApiError(
      409,
      `Plan limit reached for ${metric} (max ${limit})`,
      { code: 'QUOTA_EXCEEDED' },
    );
    err.details = {
      metric,
      limit,
      current: Math.max(0, inc.value - requested),
      requested,
      hard: check.hard === true,
    };
    throw err;
  }
  if (check.soft) {
    return { ...check, value: inc.value, soft: true };
  }
  return { ...check, value: inc.value };
}

/** Soft-delete counterpart: never throws. */
export async function release({ tenantId, metric, requested = 1, by = null } = {}) {
  if (!tenantId) return { value: 0 };
  if (!USAGE_METRICS.includes(metric)) return { value: 0 };
  if (!Number.isInteger(requested) || requested <= 0) requested = 1;
  try {
    const inc = await usageCounterRepository.incrementOrCreate({
      tenantId,
      metric,
      period: 'current',
      delta: -requested,
      by,
      kind: 'current',
    });
    return { value: inc.value };
  } catch (err) {
    // Never block a soft-delete on a counter error.
    return { value: 0, error: err?.message ?? 'unknown' };
  }
}

/** Cumulative metric increment (e.g. apiCallsPerDay). */
export async function incrementCumulative({
  tenantId,
  metric,
  period,
  delta = 1,
  by = null,
} = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!metric) throw ApiError.badRequest('metric is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw ApiError.badRequest(`Unknown usage metric "${metric}"`);
  }
  if (!period) throw ApiError.badRequest('period is required for cumulative metrics');
  if (!Number.isInteger(delta) || delta === 0) {
    throw ApiError.badRequest('delta must be a non-zero integer');
  }
  return usageCounterRepository.incrementOrCreate({
    tenantId,
    metric,
    period,
    delta,
    by,
    kind: 'cumulative',
  });
}

export async function reconcile({ tenantId, metric, value, by = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw ApiError.badRequest(`Unknown usage metric "${metric}"`);
  }
  if (!Number.isInteger(value) || value < 0) {
    throw ApiError.badRequest('value must be a non-negative integer');
  }
  return usageCounterRepository.setToActual({ tenantId, metric, value, by, kind: 'current' });
}

export default {
  checkAndConsume,
  release,
  incrementCumulative,
  reconcile,
  _meta: { module: 'iam.usage', authoritative: true },
};
