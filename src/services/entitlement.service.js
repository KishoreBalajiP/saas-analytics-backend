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
 *   - getUsage(tenantId)                     usage vs limits per metric and
 *                                            period, with warning flags
 *   - quotaExceededError(details)            the single typed hard-limit error
 *
 * FAIL-SAFE POLICY
 *   - Missing subscription -> the free plan (billing, finding bil.09:
 *     never a paid tier for free).
 *   - Plan not in catalogue -> its reference definition when it is a
 *     default plan, else the free plan.
 *   - billing (finding bil.04): the effective state is COMPUTED on every
 *     call from the stored state and the period
 *     (`subscriptionService.computeAccess`), so access never outlives a
 *     prepaid term even when the lifecycle job has not run yet:
 *       - `canceled` keeps the plan until `currentPeriodEnd`, then counts
 *         as `expired`;
 *       - an unrenewed paid term keeps the plan during the grace window
 *         (`past_due`), then counts as `restricted`;
 *       - an ended trial resolves the free plan (over-limit resources stay;
 *         only new creation beyond the free limits is refused).
 *   - `expired` / `restricted` resolve the plan's limits but quotas count
 *     as exhausted (hard) and every feature is off. Workspace reads
 *     continue; writes are blocked at the `usageService` boundary.
 *
 * FEATURES (billing)
 *   - `hasFeature({ tenantId, feature })` is the server-side gate behind
 *     `middleware/requireFeature.middleware.js`. Contract keys are
 *     `planService.FEATURE_KEYS`; legacy catalogue keys are aliases.
 *
 * CACHING
 *   - Phase 6 does NOT cache entitlements process-wide. Each call
 *     performs two queries (subscription, overrides). This is the safe
 *     default; per-request caching via AsyncLocalStorage is layered on
 *     by middleware in a follow-up sprint.
 */

import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import { ERROR_CODES } from '../config/constants.js';
import subscriptionRepository from '../repositories/subscription.repository.js';
import entitlementOverrideRepository from '../repositories/entitlementOverride.repository.js';
import planService, { FEATURE_ALIASES } from './plan.service.js';
import { computeAccess, graceDaysFor } from './subscription.service.js';
import clock from '../utils/clock.js';
import { planConstants } from '../validators/plan.validator.js';
import { USAGE_METRICS, periodOf, periodKeyFor, periodEndFor } from '../models/UsageCounter.js';
import usageCounterRepository from '../repositories/usageCounter.repository.js';

const WRITE_BLOCKING_STATES = new Set(['expired', 'restricted']);

/** The one machine-readable code every hard-limit refusal carries. */
export const QUOTA_EXCEEDED = ERROR_CODES.QUOTA_EXCEEDED;

/**
 * Build the typed hard-limit error. Resource counts answer 409 (the
 * workspace must free capacity or upgrade); metered per-period metrics such
 * as API calls answer 429 with the reset time. The details travel to the
 * client in the standard `errors` array (one entry keyed by the metric) and
 * stay on `err.details` for server-side callers.
 *
 * @param {Object} d
 * @param {string} d.metric
 * @param {number} d.limit
 * @param {number} d.current
 * @param {number} [d.requested=1]
 * @param {string} [d.period='current']
 * @param {Date|string|null} [d.resetsAt=null]
 * @param {string|null} [d.planCode=null]
 */
export function quotaExceededError({
  metric,
  limit,
  current,
  requested = 1,
  period = 'current',
  resetsAt = null,
  planCode = null,
} = {}) {
  const metered = periodOf(metric) !== 'current';
  const resets = resetsAt ? new Date(resetsAt).toISOString() : null;
  const message = metered
    ? `Plan limit reached for ${metric} (max ${limit} per ${periodOf(metric)})`
    : `Plan limit reached for ${metric} (max ${limit})`;
  const detail = {
    field: metric,
    message,
    metric,
    limit,
    current,
    requested,
    period,
    resetsAt: resets,
  };
  const err = new ApiError(metered ? 429 : 409, message, { code: QUOTA_EXCEEDED, errors: [detail] });
  err.details = {
    metric,
    limit,
    current,
    requested,
    hard: true,
    period,
    resetsAt: resets,
    planCode,
    upgradeHints: ['upgrade_plan', 'contact_admin'],
  };
  return err;
}

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
export async function resolveEffective(tenantId, { now = clock.now() } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const sub = await subscriptionRepository.findByTenantId(tenantId);
  const stored = await planService.resolveByCode(sub?.planId ?? planService.DEFAULT_PLAN_CODE);
  const access = computeAccess(sub, { now, graceDays: graceDaysFor(stored.plan) });
  // An ended trial / due downgrade resolves another plan than the stored one.
  const resolved = access.planId === stored.plan.code ? stored : await planService.resolveByCode(access.planId);
  const effectivePlan = resolved.plan;
  const source = sub && resolved.source !== 'fallback' ? 'catalog' : 'fallback';

  const overrides = await entitlementOverrideRepository.findActive(tenantId);
  const features = withFeatureAliases(mergeFeatures(effectivePlan.data.features, overrides));
  const limits = mergeLimits(effectivePlan.data.limits, overrides);

  const state = access.state;
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
          billingInterval: sub.billingInterval ?? null,
          scheduledChange: sub.scheduledChange
            ? { planId: sub.scheduledChange.planId, effectiveAt: sub.scheduledChange.effectiveAt ?? null }
            : null,
        }
      : null,
    state,
    // billing: the stored state and the computed access details.
    storedState: sub?.state ?? null,
    access: {
      inGrace: access.inGrace,
      graceEndsAt: access.graceEndsAt ? access.graceEndsAt.toISOString() : null,
      periodEnded: access.periodEnded,
      reason: access.reason,
    },
    features: writeBlocked ? Object.fromEntries(Object.keys(features).map((k) => [k, false])) : features,
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
 * billing: fill each feature-contract key from its legacy alias when the
 * plan row predates the key (an explicit value always wins).
 */
function withFeatureAliases(features) {
  const out = { ...features };
  for (const key of planService.FEATURE_KEYS) {
    if (typeof out[key] === 'boolean') continue;
    const alias = (FEATURE_ALIASES[key] ?? []).find((a) => typeof out[a] === 'boolean');
    out[key] = alias ? out[alias] === true : false;
  }
  return out;
}

/**
 * billing: the feature-entitlement contract. True when the tenant's
 * effective plan (computed from subscription state and period on every
 * call, plus active overrides) includes `feature` and the subscription
 * does not block writes. Missing data denies.
 *
 * @param {{ tenantId: string, feature: string, now?: Date }} params
 * @returns {Promise<boolean>}
 */
export async function hasFeature({ tenantId, feature, now } = {}) {
  if (!tenantId || !feature) return false;
  const ent = await resolveEffective(tenantId, now ? { now } : {});
  if (ent.writeBlocked) return false;
  return ent.features[feature] === true;
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
  // Read the current counter from UsageCounter (one query, lean). Metered
  // metrics read the row of the current period (e.g. today's API calls).
  const period = periodKeyFor(metric);
  const counter = await usageCounterRepository.findOne(tenantId, metric, period);
  const current = counter?.value ?? 0;
  const projected = current + requested;
  if (projected > limit.max) {
    if (limit.hard) {
      throw quotaExceededError({
        metric,
        limit: limit.max,
        current,
        requested,
        period,
        resetsAt: periodEndFor(metric),
        planCode: ent.plan.code,
      });
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

/** Warning threshold as a fraction (e.g. 0.8). */
export function warningThreshold() {
  return env.usage.warningThresholdPercent / 100;
}

/**
 * Describe one metric against its limit. `limit: null` means ungoverned
 * (unlimited). A limit of 0 means "not included in the plan".
 */
export function describeMetric({ metric, current, limit, now = new Date(), threshold = warningThreshold() }) {
  const value = Math.max(0, Number(current) || 0);
  const period = periodOf(metric);
  const resetsAt = periodEndFor(metric, now);
  const base = {
    current: value,
    limit: limit ? limit.max : null,
    hard: limit?.hard === true,
    period,
    periodKey: periodKeyFor(metric, now),
    resetsAt: resetsAt ? resetsAt.toISOString() : null,
  };
  if (!limit) {
    return { ...base, remaining: null, percent: null, included: true, warning: false, atLimit: false, overLimit: false, blocked: false, status: 'unlimited' };
  }
  const max = limit.max;
  const included = max > 0;
  const atLimit = value >= max;
  const overLimit = value > max;
  // Compare shares, not `ceil(threshold * max)`: the product drifts in
  // floating point (0.07 * 100 = 7.000000000000001 would need 8 to warn).
  const warning = included && value / max >= threshold - 1e-9;
  const blocked = limit.hard === true && atLimit;
  const percent = included ? Math.round((value / max) * 100) : (value > 0 ? 100 : 0);
  let status = 'ok';
  if (!included) status = value > 0 ? 'over_limit' : 'not_included';
  else if (overLimit) status = 'over_limit';
  else if (atLimit) status = 'at_limit';
  else if (warning) status = 'warning';
  return {
    ...base,
    remaining: Math.max(0, max - value),
    percent,
    included,
    warning,
    atLimit,
    overLimit,
    blocked,
    status,
  };
}

/**
 * Parse the optional `period` query of the usage endpoints: a UTC day
 * (`YYYY-MM-DD`) selects which day metered metrics are read for. Returns the
 * instant to read at (noon UTC of that day), or `null` for "now".
 */
export function parseUsagePeriod(value) {
  if (value === undefined || value === null || value === '' || value === 'current') return null;
  const day = String(value);
  const at = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T12:00:00.000Z`) : null;
  if (!at || Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day) {
    throw ApiError.badRequest('period must be "current" or a UTC day (YYYY-MM-DD)', [
      { field: 'period', message: 'must be "current" or YYYY-MM-DD' },
    ]);
  }
  return at;
}

/**
 * Current usage against the plan limits, per metric and period.
 * Resource counts read the `current` counter; metered metrics read the
 * counter of the period containing `now` (today, UTC, for API calls).
 */
export async function getUsage(tenantId, { now = new Date() } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const ent = await resolveEffective(tenantId);
  const usage = await usageCounterRepository.getUsageMap(tenantId, 'current');
  const threshold = warningThreshold();
  const result = {};
  const warnings = [];
  for (const metric of USAGE_METRICS) {
    let current = usage[metric] ?? 0;
    if (periodOf(metric) !== 'current') {
      const row = await usageCounterRepository.findOne(tenantId, metric, periodKeyFor(metric, now));
      current = row?.value ?? 0;
    }
    const described = describeMetric({ metric, current, limit: ent.limits[metric] ?? null, now, threshold });
    if (described.warning || described.overLimit) warnings.push(metric);
    result[metric] = described;
  }
  return {
    tenantId: String(tenantId),
    plan: ent.plan,
    state: ent.state,
    writeBlocked: ent.writeBlocked,
    warningThreshold: threshold,
    warnings,
    usage: result,
    resolvedAt: ent.resolvedAt,
  };
}

export default {
  resolveEffective,
  hasFeature,
  can,
  getLimit,
  checkLimit,
  checkLimitSoft,
  getUsage,
  parseUsagePeriod,
  describeMetric,
  warningThreshold,
  quotaExceededError,
  QUOTA_EXCEEDED,
  clampOverrideValue,
  clampOverrideToSafety,
  WRITE_BLOCKING_STATES,
  _meta: { module: 'iam.entitlements', authoritative: true },
};
