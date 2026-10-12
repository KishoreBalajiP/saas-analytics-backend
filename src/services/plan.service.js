/**
 * Plan service (Phase 6 - implemented).
 *
 * PURPOSE
 *   Wraps `masterDataService` for the `plans` partition so callers see a
 *   typed plan shape (`{ code, name, data, isSystem, ... }`) rather than a
 *   generic MasterData row. The plan catalogue is the single authoritative
 *   source of plan identity, marketing display and enforceable entitlements.
 *
 * RESPONSIBILITY
 *   - list({ page, limit, search })
 *   - getById(id)
 *   - getByCode(code)                 (lookup by stable plan id, used by
 *                                       the subscription/entitlement services)
 *   - create(input, by)
 *   - update(id, patch, by)
 *   - archive(id, by)
 *   - ensureDefaults()                (idempotent seed of the four
 *                                       reference plans: free, starter,
 *                                       pro, enterprise)
 *
 * CODING GUIDELINES
 *   - Plan identifiers (`code`) are immutable once created; renaming is
 *     done through `displayName` in `data`.
 *   - `data.status` is the canonical plan lifecycle value; the master-data
 *     row is the storage but the plan lifecycle is owned here.
 *   - `data.limits` and `data.features` are validated by
 *     `plan.validator.js` before this service touches them. The service
 *     re-validates defensively.
 *   - `isSystem: true` blocks soft-delete at the master-data repository.
 *   - The service never reads from or writes to a request body without the
 *     validator having run.
 */

import ApiError from '../utils/ApiError.js';
import * as masterDataService from './masterData.service.js';
import { planDataSchema, planConstants } from '../validators/plan.validator.js';

export const PLAN_CATALOGUE = 'plans';

/** Reference plan catalogue seeded on first entitlement resolution. */
export const DEFAULT_PLANS = Object.freeze([
  {
    code: 'free',
    name: 'Free',
    description: 'For evaluation and small workspaces',
    isSystem: true,
    data: {
      displayName: 'Free',
      description: 'For evaluation and small workspaces',
      status: 'active',
      tier: 0,
      trialDays: 0,
      graceDays: 0,
      features: {
        dashboards: true,
        reports: true,
        alerts: true,
        scheduled_reports: false,
        audit_export: false,
        sso: false,
        embed: false,
        webhook_connectors: false,
      },
      limits: {
        members: { max: 3, hard: true },
        connectors: { max: 1, hard: true },
        dashboards: { max: 5, hard: true },
        reports: { max: 5, hard: true },
        alerts: { max: 0, hard: true },
        scheduledReports: { max: 0, hard: true },
        storedRows: { max: 10000, hard: true },
        apiCallsPerDay: { max: 1000, hard: true },
      },
    },
  },
  {
    code: 'starter',
    name: 'Starter',
    description: 'For growing teams',
    isSystem: true,
    data: {
      displayName: 'Starter',
      description: 'For growing teams',
      status: 'active',
      tier: 1,
      trialDays: 14,
      graceDays: 3,
      features: {
        dashboards: true,
        reports: true,
        alerts: true,
        scheduled_reports: true,
        audit_export: false,
        sso: false,
        embed: false,
        webhook_connectors: true,
      },
      limits: {
        members: { max: 10, hard: true },
        connectors: { max: 5, hard: true },
        dashboards: { max: 25, hard: true },
        reports: { max: 25, hard: true },
        alerts: { max: 5, hard: true },
        scheduledReports: { max: 5, hard: true },
        storedRows: { max: 100000, hard: true },
        apiCallsPerDay: { max: 10000, hard: true },
      },
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'For production teams',
    isSystem: true,
    data: {
      displayName: 'Pro',
      description: 'For production teams',
      status: 'active',
      tier: 2,
      trialDays: 14,
      graceDays: 7,
      features: {
        dashboards: true,
        reports: true,
        alerts: true,
        scheduled_reports: true,
        audit_export: true,
        sso: false,
        embed: true,
        webhook_connectors: true,
      },
      limits: {
        members: { max: 25, hard: true },
        connectors: { max: 10, hard: true },
        dashboards: { max: 50, hard: false },
        reports: { max: 50, hard: false },
        alerts: { max: 25, hard: true },
        scheduledReports: { max: 10, hard: true },
        storedRows: { max: 1000000, hard: true },
        apiCallsPerDay: { max: 50000, hard: true },
      },
    },
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    description: 'For larger organizations with compliance needs',
    isSystem: true,
    data: {
      displayName: 'Enterprise',
      description: 'For larger organizations with compliance needs',
      status: 'active',
      tier: 3,
      trialDays: 30,
      graceDays: 14,
      features: {
        dashboards: true,
        reports: true,
        alerts: true,
        scheduled_reports: true,
        audit_export: true,
        sso: true,
        embed: true,
        webhook_connectors: true,
      },
      limits: {
        members: { max: 100, hard: false },
        connectors: { max: 50, hard: false },
        dashboards: { max: 250, hard: false },
        reports: { max: 250, hard: false },
        alerts: { max: 100, hard: false },
        scheduledReports: { max: 50, hard: false },
        storedRows: { max: 10000000, hard: false },
        apiCallsPerDay: { max: 500000, hard: false },
      },
    },
  },
]);

/** The plan used as the safe fail-safe default when the catalogue is empty
 *  or a tenant's plan has been removed. It mirrors `starter` so existing
 *  tenants are not silently downgraded to a 0-limit plan. */
export const SAFE_FALLBACK_PLAN_CODE = 'starter';

function normalizeData(data) {
  const d = { ...(data ?? {}) };
  if (!d.status) d.status = 'active';
  if (!d.features || typeof d.features !== 'object') d.features = {};
  if (!d.limits || typeof d.limits !== 'object') d.limits = {};
  return d;
}

function assertValidPlanData(data) {
  if (!data || typeof data !== 'object') {
    throw ApiError.validation('Plan data is required');
  }
  const d = data;
  if (d.status && !planConstants.PLAN_STATUSES.includes(d.status)) {
    throw ApiError.validation(
      `Plan status must be one of ${planConstants.PLAN_STATUSES.join(', ')}`,
    );
  }
  if (d.tier !== undefined) {
    if (!Number.isInteger(d.tier) || d.tier < planConstants.PLAN_TIER_MIN || d.tier > planConstants.PLAN_TIER_MAX) {
      throw ApiError.validation(
        `Plan tier must be an integer between ${planConstants.PLAN_TIER_MIN} and ${planConstants.PLAN_TIER_MAX}`,
      );
    }
  }
  if (d.trialDays !== undefined && d.trialDays !== null) {
    if (!Number.isInteger(d.trialDays) || d.trialDays < 0) {
      throw ApiError.validation('Plan trialDays must be a non-negative integer');
    }
  }
  if (d.graceDays !== undefined && d.graceDays !== null) {
    if (!Number.isInteger(d.graceDays) || d.graceDays < 0) {
      throw ApiError.validation('Plan graceDays must be a non-negative integer');
    }
  }
  if (d.limits && typeof d.limits === 'object') {
    for (const [key, limit] of Object.entries(d.limits)) {
      if (!limit || typeof limit !== 'object') {
        throw ApiError.validation(`Plan limit "${key}" must be an object`);
      }
      if (!Number.isInteger(limit.max) || limit.max < 0) {
        throw ApiError.validation(`Plan limit "${key}.max" must be a non-negative integer`);
      }
      if (typeof limit.hard !== 'boolean') {
        throw ApiError.validation(`Plan limit "${key}.hard" must be a boolean`);
      }
    }
  }
  if (d.features && typeof d.features === 'object') {
    for (const [key, value] of Object.entries(d.features)) {
      if (typeof value !== 'boolean') {
        throw ApiError.validation(`Plan feature "${key}" must be a boolean`);
      }
    }
  }
  return d;
}

/** True when this MasterData row looks like a plan catalogue row. */
export function isPlanRow(row) {
  return row && row.catalogue === PLAN_CATALOGUE;
}

export async function list({ page = 1, limit = 50, search = null, includeDisabled = true } = {}) {
  const result = await masterDataService.list(PLAN_CATALOGUE, { page, limit, search });
  if (includeDisabled) return result;
  return {
    ...result,
    docs: result.docs.filter((d) => (d.data?.status ?? 'active') !== 'disabled'),
  };
}

export async function getById(id) {
  const row = await masterDataService.getById(PLAN_CATALOGUE, id);
  return shapePlan(row);
}

export async function getByCode(code) {
  if (!code) return null;
  const result = await masterDataService.list(PLAN_CATALOGUE, { page: 1, limit: 1, search: code });
  if (result.docs.length === 0) return null;
  return shapePlan(result.docs[0]);
}

export async function getActiveByCode(code) {
  const plan = await getByCode(code);
  if (!plan) return null;
  if (plan.data.status === 'disabled' || plan.data.status === 'archived') {
    return null;
  }
  return plan;
}

function shapePlan(row) {
  return {
    id: String(row._id),
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    isSystem: row.isSystem === true,
    data: normalizeData(row.data ?? {}),
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

export async function create({ code, name, description, data, isSystem = true }, by) {
  if (!code || !name) {
    throw ApiError.badRequest('Plan code and name are required');
  }
  const safeData = assertValidPlanData(normalizeData(data));
  const created = await masterDataService.create(
    PLAN_CATALOGUE,
    { code, name, description, data: safeData, isSystem },
    by,
  );
  return shapePlan(created);
}

export async function update(id, patch, by) {
  const set = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.data !== undefined) {
    set.data = assertValidPlanData(normalizeData(patch.data));
  }
  if (patch.isSystem !== undefined) set.isSystem = patch.isSystem === true;
  if (Object.keys(set).length === 0) {
    throw ApiError.badRequest('Nothing to update');
  }
  const updated = await masterDataService.update(PLAN_CATALOGUE, id, set, by);
  return shapePlan(updated);
}

export async function archive(id, by) {
  const existing = await masterDataService.getById(PLAN_CATALOGUE, id);
  if (!existing) throw ApiError.notFound('Plan not found');
  const data = { ...(existing.data ?? {}), status: 'archived' };
  const updated = await masterDataService.update(PLAN_CATALOGUE, id, { data }, by);
  return shapePlan(updated);
}

export async function disable(id, by) {
  const existing = await masterDataService.getById(PLAN_CATALOGUE, id);
  if (!existing) throw ApiError.notFound('Plan not found');
  const data = { ...(existing.data ?? {}), status: 'disabled' };
  const updated = await masterDataService.update(PLAN_CATALOGUE, id, { data }, by);
  return shapePlan(updated);
}

export async function enable(id, by) {
  const existing = await masterDataService.getById(PLAN_CATALOGUE, id);
  if (!existing) throw ApiError.notFound('Plan not found');
  const data = { ...(existing.data ?? {}), status: 'active' };
  const updated = await masterDataService.update(PLAN_CATALOGUE, id, { data }, by);
  return shapePlan(updated);
}

/** Idempotent seed. Inserts any missing default plan; never overwrites. */
export async function ensureDefaults(by = null) {
  const created = [];
  for (const plan of DEFAULT_PLANS) {
    const existing = await getByCode(plan.code);
    if (existing) continue;
    try {
      const row = await masterDataService.create(
        PLAN_CATALOGUE,
        {
          code: plan.code,
          name: plan.name,
          description: plan.description,
          data: plan.data,
          isSystem: plan.isSystem,
        },
        by,
      );
      created.push(shapePlan(row));
    } catch (err) {
      if (err?.code !== 'CONFLICT' && err?.statusCode !== 409) throw err;
      // A concurrent initializer won the race; treat as success.
    }
  }
  return { created, total: DEFAULT_PLANS.length };
}

/** The shape of a safe fallback plan when none can be resolved. */
export async function resolveFallbackPlan() {
  const starter = await getByCode(SAFE_FALLBACK_PLAN_CODE);
  if (starter) return starter;
  const free = await getByCode('free');
  if (free) return free;
  return shapePlan({
    _id: 'fallback',
    code: SAFE_FALLBACK_PLAN_CODE,
    name: 'Starter',
    description: 'Default safe-fallback plan',
    isSystem: true,
    data: DEFAULT_PLANS.find((p) => p.code === SAFE_FALLBACK_PLAN_CODE).data,
  });
}

export const planDataValidatorSchema = planDataSchema;

export default {
  PLAN_CATALOGUE,
  DEFAULT_PLANS,
  SAFE_FALLBACK_PLAN_CODE,
  isPlanRow,
  list,
  getById,
  getByCode,
  getActiveByCode,
  create,
  update,
  archive,
  disable,
  enable,
  ensureDefaults,
  resolveFallbackPlan,
  _meta: { module: 'iam.plans' },
};
