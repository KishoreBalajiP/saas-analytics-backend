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
 *   - ensureDefaults(by, { overwritePrices })
 *                                     (idempotent seed of the four
 *                                       reference plans: free, starter,
 *                                       pro, enterprise; run at startup)
 *   - resolveByCode(code)             (catalogue row, else the built-in
 *                                       reference definition, else free)
 *
 * BILLING (roadmap 3.1)
 *   - `data.features` carries the feature-entitlement contract keys
 *     (`FEATURE_KEYS`: embedding, api_access, scheduled_delivery,
 *     ai_assistant, sso, audit_streaming, row_level_security). Older rows
 *     may still hold the legacy keys `embed` / `scheduled_reports`; they
 *     are read as aliases (`FEATURE_ALIASES`).
 *   - `data.prices` lists the prepaid terms a plan sells:
 *     `[{ interval: 'month'|'year', amountMinor, currency }]`. The seed
 *     copies them from `RAZORPAY_PLAN_MAPPING_JSON` when a row has none
 *     and never replaces edited prices unless `overwritePrices` is set.
 *   - Codes are matched exactly (finding bil.10).
 *   - The default plan for new workspaces, and for a tenant without a
 *     subscription row, is `free` (finding bil.09).
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
import config from '../config/env.js';

export const PLAN_CATALOGUE = 'plans';

/** billing: the feature-entitlement contract keys (requireFeature). */
export const FEATURE_KEYS = Object.freeze([
  'embedding',
  'api_access',
  'scheduled_delivery',
  'ai_assistant',
  'sso',
  'audit_streaming',
  'row_level_security',
]);

/** billing: legacy catalogue keys still honoured for a contract key. */
export const FEATURE_ALIASES = Object.freeze({
  embedding: Object.freeze(['embed']),
  scheduled_delivery: Object.freeze(['scheduled_reports']),
});

/** billing: prepaid term lengths a plan price can sell, in months. */
export const BILLING_INTERVALS = Object.freeze({ month: 1, year: 12 });

/** billing: the plan every new workspace starts on (finding bil.09). */
export const DEFAULT_PLAN_CODE = 'free';

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
        audit_export: false,
        webhook_connectors: false,
        embedding: false,
        api_access: false,
        scheduled_delivery: false,
        ai_assistant: false,
        sso: false,
        audit_streaming: false,
        row_level_security: false,
      },
      // billing: prepaid prices come from the seed mapping or the admin.
      prices: [],
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
        audit_export: false,
        webhook_connectors: true,
        embedding: false,
        api_access: true,
        scheduled_delivery: true,
        ai_assistant: false,
        sso: false,
        audit_streaming: false,
        row_level_security: false,
      },
      // billing: prepaid prices come from the seed mapping or the admin.
      prices: [],
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
        audit_export: true,
        webhook_connectors: true,
        embedding: true,
        api_access: true,
        scheduled_delivery: true,
        ai_assistant: true,
        sso: false,
        audit_streaming: false,
        row_level_security: true,
      },
      // billing: prepaid prices come from the seed mapping or the admin.
      prices: [],
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
        audit_export: true,
        webhook_connectors: true,
        embedding: true,
        api_access: true,
        scheduled_delivery: true,
        ai_assistant: true,
        sso: true,
        audit_streaming: true,
        row_level_security: true,
      },
      // billing: prepaid prices come from the seed mapping or the admin.
      prices: [],
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

/** The plan used when a tenant has no subscription row, or its plan can be
 *  resolved neither from the catalogue nor from the reference definitions.
 *  billing (finding bil.09): this is the free plan, never a paid tier. */
export const SAFE_FALLBACK_PLAN_CODE = DEFAULT_PLAN_CODE;

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
  if (d.prices !== undefined && d.prices !== null) {
    d.prices = normalizePrices(d.prices, { strict: true });
  }
  return d;
}

/**
 * billing: validate a plan's prepaid prices. One entry per interval,
 * positive integer minor units, a supported currency. `strict` throws on
 * the first bad entry (admin writes); otherwise bad entries are dropped
 * (reading legacy rows / seed config).
 */
export function normalizePrices(prices, { strict = false } = {}) {
  if (!Array.isArray(prices)) {
    if (strict) throw ApiError.validation('Plan prices must be an array');
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const entry of prices) {
    const interval = entry?.interval;
    const amountMinor = entry?.amountMinor;
    const currency = String(entry?.currency ?? '').toUpperCase();
    let problem = null;
    if (!Object.hasOwn(BILLING_INTERVALS, interval)) problem = 'interval must be "month" or "year"';
    else if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > planConstants.MAX_PRICE_MINOR) {
      problem = 'amountMinor must be a positive integer in minor units';
    } else if (!planConstants.SUPPORTED_CURRENCIES.includes(currency)) {
      problem = `currency must be one of ${planConstants.SUPPORTED_CURRENCIES.join(', ')}`;
    } else if (seen.has(interval)) problem = `duplicate price for interval "${interval}"`;
    if (problem) {
      if (strict) throw ApiError.validation(`Plan price is invalid: ${problem}`);
      continue;
    }
    seen.add(interval);
    out.push({ interval, amountMinor, currency });
  }
  return out;
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

/** Exact lookup by plan code (finding bil.10: never a search pattern). */
export async function getByCode(code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  const row = await masterDataService.getByCode(PLAN_CATALOGUE, code);
  return row ? shapePlan(row) : null;
}

/** billing: the built-in reference definition of a default plan code. */
export function referencePlan(code) {
  const def = DEFAULT_PLANS.find((p) => p.code === code);
  if (!def) return null;
  return shapePlan({
    _id: `reference:${def.code}`,
    code: def.code,
    name: def.name,
    description: def.description,
    isSystem: true,
    data: def.data,
  });
}

/**
 * billing: resolve the plan a subscription points at. The catalogue row
 * wins; a default plan missing from an unseeded catalogue resolves to its
 * reference definition; anything else falls back to the free plan.
 *
 * @returns {Promise<{ plan: object, source: 'catalog'|'reference'|'fallback' }>}
 */
export async function resolveByCode(code) {
  const row = code ? await getByCode(code) : null;
  if (row) return { plan: row, source: 'catalog' };
  const ref = code ? referencePlan(code) : null;
  if (ref) return { plan: ref, source: 'reference' };
  return { plan: await resolveFallbackPlan(), source: 'fallback' };
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
  const data = normalizeData(row.data ?? {});
  data.prices = normalizePrices(data.prices ?? []);
  return {
    id: String(row._id),
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    isSystem: row.isSystem === true,
    data,
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

/**
 * billing: prepaid prices for a default plan from the seed mapping
 * (`RAZORPAY_PLAN_MAPPING_JSON`). Accepts the per-interval shape
 * `{ month: { amountMinor, currency }, year: {...} }` and the legacy flat
 * one-time entry `{ amountMinor, currency, interval: 'one-time' }`, which is
 * read as a monthly term (what a one-time order used to buy: 30 days).
 */
export function seedPricesFor(code, mapping = config?.razorpay?.planMapping ?? {}) {
  const entry = mapping?.[code];
  if (!entry || typeof entry !== 'object') return [];
  const raw = [];
  const legacyInterval = entry.interval === undefined || entry.interval === 'one-time' || entry.interval === 'month';
  if (Number.isInteger(entry.amountMinor) && legacyInterval) {
    raw.push({ interval: 'month', amountMinor: entry.amountMinor, currency: entry.currency });
  }
  for (const interval of Object.keys(BILLING_INTERVALS)) {
    const term = entry[interval];
    if (term && typeof term === 'object') {
      raw.push({ interval, amountMinor: term.amountMinor, currency: term.currency });
    }
  }
  // A per-interval entry overrides the legacy flat one for the same interval.
  const byInterval = new Map();
  for (const price of normalizePrices(raw)) byInterval.set(price.interval, price);
  return [...byInterval.values()];
}

/**
 * Idempotent seed of the default plans (run at startup and from the admin
 * endpoint). A missing plan is inserted. An existing row only gains what it
 * lacks: feature keys added since it was seeded, and seed prices when it
 * has none. Edited values, including prices, are never replaced unless
 * `overwritePrices` is set (prices only).
 *
 * @param {string|null} [by]
 * @param {{ overwritePrices?: boolean, mapping?: object }} [opts]
 * @returns {Promise<{ created: object[], updated: string[], total: number }>}
 */
export async function ensureDefaults(by = null, { overwritePrices = false, mapping } = {}) {
  const created = [];
  const updated = [];
  for (const plan of DEFAULT_PLANS) {
    const seedPrices = seedPricesFor(plan.code, mapping);
    const existing = await getByCode(plan.code);
    if (!existing) {
      try {
        const row = await masterDataService.create(
          PLAN_CATALOGUE,
          {
            code: plan.code,
            name: plan.name,
            description: plan.description,
            data: { ...plan.data, prices: seedPrices },
            isSystem: plan.isSystem,
          },
          by,
        );
        created.push(shapePlan(row));
      } catch (err) {
        if (err?.code !== 'CONFLICT' && err?.statusCode !== 409) throw err;
        // A concurrent initializer won the race; treat as success.
      }
      continue;
    }
    const data = { ...existing.data };
    let changed = false;
    const features = { ...(data.features ?? {}) };
    for (const [key, value] of Object.entries(plan.data.features)) {
      if (!Object.hasOwn(features, key)) {
        features[key] = value;
        changed = true;
      }
    }
    data.features = features;
    const currentPrices = normalizePrices(data.prices ?? []);
    if (seedPrices.length > 0 && (currentPrices.length === 0 || overwritePrices)) {
      if (JSON.stringify(currentPrices) !== JSON.stringify(seedPrices)) {
        data.prices = seedPrices;
        changed = true;
      }
    }
    if (changed) {
      await masterDataService.update(PLAN_CATALOGUE, existing.id, { data }, by);
      updated.push(plan.code);
    }
  }
  return { created, updated, total: DEFAULT_PLANS.length };
}

/** The safe fallback plan: the free plan from the catalogue, else its
 *  reference definition (billing: never a paid tier). */
export async function resolveFallbackPlan() {
  const free = await getByCode(SAFE_FALLBACK_PLAN_CODE);
  if (free) return free;
  return shapePlan({
    _id: 'fallback',
    code: SAFE_FALLBACK_PLAN_CODE,
    name: 'Free',
    description: 'Default safe-fallback plan',
    isSystem: true,
    data: DEFAULT_PLANS.find((p) => p.code === SAFE_FALLBACK_PLAN_CODE).data,
  });
}

/** billing: a plan's tier (free = 0); unknown plans rank lowest. */
export function tierOf(plan) {
  const tier = plan?.data?.tier;
  return Number.isInteger(tier) ? tier : 0;
}

/** billing: true for the free plan (perpetual, never sold). */
export function isFreePlan(planOrCode) {
  const code = typeof planOrCode === 'string' ? planOrCode : planOrCode?.code;
  return code === DEFAULT_PLAN_CODE;
}

export const planDataValidatorSchema = planDataSchema;

export default {
  PLAN_CATALOGUE,
  DEFAULT_PLANS,
  SAFE_FALLBACK_PLAN_CODE,
  DEFAULT_PLAN_CODE,
  FEATURE_KEYS,
  FEATURE_ALIASES,
  BILLING_INTERVALS,
  normalizePrices,
  seedPricesFor,
  referencePlan,
  resolveByCode,
  tierOf,
  isFreePlan,
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
