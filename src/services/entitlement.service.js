/**
 * Entitlement service (Phase 6 - implemented).
 *
 * PURPOSE
 *   The single authoritative resolver of "what is this tenant allowed to
 *   do?" It reads the canonical subscription, resolves the canonical plan
 *   (with a safe fallback), and merges the active entitlement overrides
 *   on top. The frontend MAY display entitlements, but the backend is
 *   always authoritative: this service is the only place that decides
 *   whether a feature is enabled or a limit is exhausted.
 *
 * RESPONSIBILITY
 *   - resolveEffective(tenantId)              full snapshot
 *   - can(tenantId, featureKey)               boolean feature gate
 *   - getLimit(tenantId, metric)              effective { max, hard } or null
 *   - checkLimit(tenantId, metric, requested?)
 *                                            throws QUOTA_EXCEEDED on hard
 *
 * FAIL-SAFE POLICY
 *   - Missing or malformed subscription -> safe-fallback plan (the
 *     entitlement service applies the platform default plan from
 *     `planService.SAFE_FALLBACK_PLAN_CODE`).
 *   - Plan not in catalogue -> safe-fallback plan.
 *   - A subscription in `expired` or `restricted` state still resolves
 *     the plan's features but quotas count as exhausted (hard). The
 *     workspace reads continue; writes are blocked at the
 *     `usageService.checkAndConsume` boundary.
 *   - A subscription in `canceled` keeps full entitlements UNTIL
 *     `currentPeriodEnd`, then becomes `expired` on the next read by
 *     the reconciliation path.
 *   - A subscription in `past_due` keeps full entitlements during the
 *     grace window.
 *
 * CACHING
 *   - Phase 6 does NOT cache entitlements process-wide. Each call
 *     performs two queries (subscription, overrides). This is the safe
 *     default; per-request caching via AsyncLocalStorage is layered on
 *     by middleware in a follow-up sprint.
 */

import ApiError from '../utils/ApiError.js';
import subscriptionRepository from '../repositories/subscription.repository.js';
import entitlementOverrideRepository from '../repositories/entitlementOverride.repository.js';
import planService from './plan.service.js';
import { planConstants } from '../validators/plan.validator.js';
import { USAGE_METRICS } from '../models/UsageCounter.js';
import usageCounterRepository from '../repositories/usageCounter.repository.js';

const WRITE_BLOCKING_STATES = new Set(['expired', 'restricted']);

/** Build a defaulted empty limit from a partial. */
function withDefaults(limit) {
  if (!limit) return null;
  const max = Number.isInteger(limit.max) && limit.max >= 0 ? limit.max : 0;
  const hard = limit.hard === true;
  return { max, hard };
}

/** Merge base limits with override limits. Override wins for the same metric. */
function mergeLimits(baseLimits, overrides) {
  const limits = {};
  for (const [metric, limit] of Object.entries(baseLimits ?? {})) {
    limits[metric] = withDefaults(limit);
  }
  for (const ov of overrides ?? []) {
    if (ov.kind !== 'limit') continue;
    if (!ov.metric) continue;
    if (!USAGE_METRICS.includes(ov.metric)) continue;
    const value = ov.value;
    if (!value || typeof value !== 'object') continue;
    const max = Number.isInteger(value.max) && value.max >= 0 ? value.max : 0;
    const hard = value.hard === true;
    limits[ov.metric] = { max, hard };
  }
  return limits;
}

/** Merge base features with override features. */
function mergeFeatures(baseFeatures, overrides) {
  const features = { ...(baseFeatures ?? {}) };
  for (const ov of overrides ?? []) {
    if (ov.kind !== 'feature') continue;
    if (!ov.metric) continue;
    if (typeof ov.value !== 'boolean') continue;
    features[ov.metric] = ov.value;
  }
  return features;
}

/**
 * Resolve the effective entitlement for a tenant.
 *
 * @param {string} tenantId
 * @returns {Promise<{
 *   tenantId: string,
 *   plan: object,
 *   subscription: object|null,
 *   state: string,
 *   features: Record<string, boolean>,
 *   limits: Record<string, { max: number, hard: boolean }>,
 *   overrides: Array<object>,
 *   writeBlocked: boolean,
 *   resolvedAt: string,
 *   source: 'catalog' | 'fallback'
 * }>}
 */
export async function resolveEffective(tenantId) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const sub = await subscriptionRepository.findByTenantId(tenantId);
  const plan = await planService.getByCode(sub?.planId ?? null);
  const effectivePlan = plan ?? (await planService.resolveFallbackPlan());
  const source = plan ? 'catalog' : 'fallback';

  const overrides = await entitlementOverrideRepository.findActive(tenantId);
  const features = mergeFeatures(effectivePlan.data.features, overrides);
  const limits = mergeLimits(effectivePlan.data.limits, overrides);

  const state = sub?.state ?? 'active';
  const writeBlocked = WRITE_BLOCKING_STATES.has(state);

  // When writes are blocked, the resolved limits are the same shape but
  // the caller MUST treat the tenant as "quota exhausted" regardless of
  // the numeric value. We expose this as a separate flag.
  return {
    tenantId: String(tenantId),
    plan: {
      id: effectivePlan.id,
      code: effectivePlan.code,
      name: effectivePlan.name,
      displayName: effectivePlan.data?.displayName ?? effectivePlan.name,
      tier: effectivePlan.data?.tier ?? 0,
      status: effectivePlan.data?.status ?? 'active',
    },
    subscription: sub
      ? {
          id: String(sub._id),
          state: sub.state,
          planId: sub.planId,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          trialEndsAt: sub.trialEndsAt ?? null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd === true,
          canceledAt: sub.canceledAt ?? null,
          graceEndsAt: sub.graceEndsAt ?? null,
        }
      : null,
    state,
    features,
    limits,
    overrides: overrides.map((o) => ({
      id: String(o._id),
      metric: o.metric ?? null,
      kind: o.kind,
      value: o.value,
      reason: o.reason,
      expiresAt: o.expiresAt ?? null,
      grantedBy: o.grantedBy,
    })),
    writeBlocked,
    source,
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * Feature gate. Returns true when the feature is enabled for the tenant.
 * Missing data returns false (deny by default), never true.
 */
export async function can(tenantId, featureKey) {
  if (!featureKey) return false;
  const ent = await resolveEffective(tenantId);
  if (ent.writeBlocked) return false;
  return ent.features[featureKey] === true;
}

/**
 * Resolve the effective limit for a metric. Returns `{ max, hard }` or
 * `null` if the metric is not governed.
 */
export async function getLimit(tenantId, metric) {
  if (!metric) return null;
  const ent = await resolveEffective(tenantId);
  return ent.limits[metric] ?? null;
}

/**
 * Clamp an override request to the safety-net maximum.
 */
export function clampOverrideValue(metric, requested) {
  if (!metric) return requested;
  if (!requested || typeof requested !== 'object') return null;
  const max = Number.isInteger(requested.max) && requested.max >= 0 ? requested.max : 0;
  const hard = requested.hard === true;
  // Safety net: the highest plan's hard limit times the safety factor.
  // We compute it lazily because the plan service is async; callers
  // that want a strict cap use the async version below.
  return { max, hard };
}

export async function clampOverrideToSafety(metric, requested) {
  if (!metric || !requested || typeof requested !== 'object') return null;
  const safety = planConstants.OVERRIDE_SAFETY_FACTOR;
  // Look up the highest `max` across all known plans for this metric.
  let highest = 0;
  for (const plan of planService.DEFAULT_PLANS) {
    const limit = plan.data?.limits?.[metric];
    if (limit && Number.isInteger(limit.max) && limit.max > highest) {
      highest = limit.max;
    }
  }
  const ceiling = Math.max(1, highest) * safety;
  const max = Math.min(requested.max, ceiling);
  return { max, hard: requested.hard === true };
}

/**
 * Check whether a tenant is allowed to consume a quota. Throws
 * `QUOTA_EXCEEDED` on hard limit; returns `{ allowed: true, soft:
 * true }` on soft warning; returns `{ allowed: false, reason: 'blocked' }`
 * on write-blocked subscription.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.metric
 * @param {number} [opts.requested=1]
 */
export async function checkLimit({ tenantId, metric, requested = 1 } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!metric) throw ApiError.badRequest('metric is required');
  if (!USAGE_METRICS.includes(metric)) {
    throw ApiError.badRequest(`Unknown usage metric "${metric}"`);
  }
  if (!Number.isFinite(requested) || requested < 0) {
    throw ApiError.badRequest('requested must be a non-negative number');
  }
  const ent = await resolveEffective(tenantId);
  if (ent.writeBlocked) {
    return { allowed: false, reason: 'subscription_blocked', state: ent.state };
  }
  const limit = ent.limits[metric];
  if (!limit) {
    // Ungoverned metric: allow without bookkeeping. The caller is
    // expected to have called `consume` for the metrics that need
    // accounting.
    return { allowed: true, soft: false, ungoverned: true };
  }
  // Read the current counter from UsageCounter (one query, lean).
  const counter = await usageCounterRepository.findOne(tenantId, metric, 'current');
  const current = counter?.value ?? 0;
  const projected = current + requested;
  if (projected > limit.max) {
    if (limit.hard) {
      const err = new ApiError(
        409,
        `Plan limit reached for ${metric} (max ${limit.max})`,
        { code: 'QUOTA_EXCEEDED' },
      );
      err.details = {
        metric,
        limit: limit.max,
        current,
        requested,
        hard: true,
        planCode: ent.plan.code,
        upgradeHints: ['upgrade_plan', 'contact_admin'],
      };
      throw err;
    }
    return {
      allowed: true,
      soft: true,
      metric,
      limit: limit.max,
      current,
      requested,
      hard: false,
      planCode: ent.plan.code,
    };
  }
  return { allowed: true, soft: false, metric, limit: limit.max, current, requested };
}

/** A non-throwing variant for UI hints. */
export async function checkLimitSoft({ tenantId, metric, requested = 1 } = {}) {
  try {
    return await checkLimit({ tenantId, metric, requested });
  } catch (err) {
    if (err?.code === 'QUOTA_EXCEEDED') {
      return {
        allowed: false,
        reason: 'quota_exceeded',
        metric: err.details?.metric ?? metric,
        limit: err.details?.limit ?? null,
        current: err.details?.current ?? null,
        hard: err.details?.hard === true,
      };
    }
    throw err;
  }
}

/** Read the current usage map for a tenant. */
export async function getUsage(tenantId) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const ent = await resolveEffective(tenantId);
  const usage = await usageCounterRepository.getUsageMap(tenantId, 'current');
  const result = {};
  for (const metric of USAGE_METRICS) {
    const limit = ent.limits[metric] ?? null;
    result[metric] = {
      current: usage[metric] ?? 0,
      limit: limit?.max ?? null,
      hard: limit?.hard === true,
    };
  }
  return {
    tenantId: String(tenantId),
    plan: ent.plan,
    state: ent.state,
    writeBlocked: ent.writeBlocked,
    usage: result,
    resolvedAt: ent.resolvedAt,
  };
}

export default {
  resolveEffective,
  can,
  getLimit,
  checkLimit,
  checkLimitSoft,
  getUsage,
  clampOverrideValue,
  clampOverrideToSafety,
  WRITE_BLOCKING_STATES,
  _meta: { module: 'iam.entitlements', authoritative: true },
};
