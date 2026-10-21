/**
 * Billing pricing resolver (Phase 6.1; billing roadmap 3.1 prepaid terms).
 *
 * PURPOSE
 *   The single authority for "how much does a term of plan X cost".
 *
 * BILLING MODEL (roadmap 3.1, pending business approval)
 *   Prepaid terms bought through one-time provider orders: a plan sells a
 *   monthly and/or an annual term (`interval: 'month' | 'year'`). Nothing
 *   is charged automatically; renewing means buying the next term. The
 *   model lives behind this resolver and `paymentProvider.adapter.js`, so a
 *   recurring model can replace it without touching callers.
 *
 * WHERE PRICES COME FROM (first match wins)
 *   1. The plan catalogue row: `plan.data.prices` (admin-editable, seeded
 *      idempotently by `planService.ensureDefaults`).
 *   2. Server configuration `RAZORPAY_PLAN_MAPPING_JSON`:
 *        {
 *          "pro": { "month": { "amountMinor": 99900, "currency": "INR" },
 *                   "year":  { "amountMinor": 999000, "currency": "INR" } },
 *          "starter": { "amountMinor": 49900, "currency": "INR", "interval": "one-time" }
 *        }
 *      The legacy flat `one-time` entry is read as a monthly term.
 *
 * RULES
 *   - `amountMinor` must be a positive integer (smallest currency unit,
 *     e.g. paise for INR). No floats, no client-supplied amounts, ever.
 *   - Only `INR` is supported; anything else is rejected, not coerced.
 *   - `free` and unpriced plans are NOT purchasable. A missing price is a
 *     business-decision gap, surfaced as 422 - never silently zero.
 *   - Disabled/archived plans are rejected by the caller via
 *     `planService.getActiveByCode` before this resolver runs.
 */

import ApiError from '../utils/ApiError.js';
import config from '../config/env.js';
import planService, { BILLING_INTERVALS, normalizePrices, seedPricesFor } from './plan.service.js';

export const SUPPORTED_CURRENCIES = Object.freeze(['INR']);
/** Prepaid intervals a plan price may sell. */
export const SUPPORTED_INTERVALS = Object.freeze(Object.keys(BILLING_INTERVALS));
/** Legacy interval of the Phase 6.1 mapping, read as a monthly term. */
export const LEGACY_INTERVAL = 'one-time';
export const MAX_AMOUNT_MINOR = 100_000_000_00; // 10 crore paise sanity ceiling

/** Test-only mapping override (never prod config). */
let testMapping = null;

export function __setTestMapping(obj) {
  testMapping = obj && typeof obj === 'object' ? obj : null;
}

export function __clearTestMapping() {
  testMapping = null;
}

export function getRawMapping() {
  if (testMapping) return testMapping;
  const mapping = config?.razorpay?.planMapping;
  return mapping && typeof mapping === 'object' ? mapping : {};
}

/** Months bought by one term of `interval`. */
export function termMonthsFor(interval) {
  return BILLING_INTERVALS[interval] ?? null;
}

function assertInterval(interval) {
  if (!SUPPORTED_INTERVALS.includes(interval)) {
    throw ApiError.badRequest(`interval must be one of ${SUPPORTED_INTERVALS.join(', ')}`, [
      { field: 'interval', message: `must be one of ${SUPPORTED_INTERVALS.join(', ')}` },
    ]);
  }
}

/** Strictly validate one mapping entry (configuration errors are 422). */
function strictMappingPrice(planCode, interval) {
  const mapping = getRawMapping();
  const entry = mapping[planCode];
  if (!entry || typeof entry !== 'object') return null;
  const term = entry[interval] && typeof entry[interval] === 'object'
    ? { ...entry[interval], interval }
    : interval === 'month' && (entry.interval === LEGACY_INTERVAL || entry.interval === 'month' || entry.interval === undefined)
      && entry.amountMinor !== undefined
      ? { amountMinor: entry.amountMinor, currency: entry.currency, interval: 'month' }
      : null;
  if (!term) {
    if (entry.interval !== undefined && entry.interval !== LEGACY_INTERVAL && !SUPPORTED_INTERVALS.includes(entry.interval)) {
      throw ApiError.validation(
        `Configured pricing for plan "${planCode}" uses unsupported interval "${entry.interval}". Supported: ${SUPPORTED_INTERVALS.join(', ')} (or the legacy "${LEGACY_INTERVAL}").`,
      );
    }
    return null;
  }
  if (!Number.isInteger(term.amountMinor) || term.amountMinor <= 0 || term.amountMinor > MAX_AMOUNT_MINOR) {
    throw ApiError.validation(
      `Configured pricing for plan "${planCode}" is invalid: amountMinor must be a positive integer in minor units.`,
    );
  }
  const currency = String(term.currency ?? '').toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    throw ApiError.validation(
      `Configured pricing for plan "${planCode}" uses unsupported currency "${term.currency}". Supported: ${SUPPORTED_CURRENCIES.join(', ')}.`,
    );
  }
  return { amountMinor: term.amountMinor, currency };
}

/**
 * Resolve the configured price of one term from server configuration only
 * (no catalogue read). Kept synchronous for config validation and tests.
 *
 * @param {string} planCode
 * @param {'month'|'year'} [interval='month']
 * @throws 422 when the plan has no configured pricing or it is malformed.
 */
export function resolvePrice(planCode, interval = 'month') {
  if (!planCode) throw ApiError.badRequest('planCode is required');
  assertInterval(interval);
  const price = strictMappingPrice(planCode, interval);
  if (!price) {
    throw ApiError.validation(
      `Plan "${planCode}" has no configured ${interval}ly pricing. Set a price on the plan (or RAZORPAY_PLAN_MAPPING_JSON) before it can be purchased.`,
    );
  }
  return { planCode, ...price, interval, termMonths: termMonthsFor(interval) };
}

/**
 * Resolve the authoritative price of one prepaid term of `plan` (a shaped
 * plan from `planService`): the catalogue price first, then configuration.
 *
 * @param {Object} plan
 * @param {'month'|'year'} [interval='month']
 */
export function resolvePlanPrice(plan, interval = 'month') {
  if (!plan?.code) throw ApiError.badRequest('plan is required');
  assertInterval(interval);
  if (planService.isFreePlan(plan)) {
    throw ApiError.badRequest('Free plan does not require checkout');
  }
  const fromCatalogue = normalizePrices(plan.data?.prices ?? []).find((p) => p.interval === interval);
  if (fromCatalogue) {
    return {
      planCode: plan.code,
      amountMinor: fromCatalogue.amountMinor,
      currency: fromCatalogue.currency,
      interval,
      termMonths: termMonthsFor(interval),
      source: 'catalog',
    };
  }
  return { ...resolvePrice(plan.code, interval), source: 'config' };
}

/** Every valid price of `plan` (catalogue, else configuration). */
export function listPlanPrices(plan) {
  if (!plan?.code || planService.isFreePlan(plan)) return [];
  const fromCatalogue = normalizePrices(plan.data?.prices ?? []);
  if (fromCatalogue.length > 0) return fromCatalogue;
  return seedPricesFor(plan.code, getRawMapping());
}

/** True when the plan code can be purchased right now (config only). */
export function isPurchasable(planCode, interval = 'month') {
  if (!planCode || planCode === 'free') return false;
  try {
    resolvePrice(planCode, interval);
    return true;
  } catch {
    return false;
  }
}

/** Configuration view: plan code -> valid prices. */
export function listPricedPlans() {
  const mapping = getRawMapping();
  const out = {};
  for (const code of Object.keys(mapping)) {
    if (code === 'free') continue;
    const prices = seedPricesFor(code, mapping);
    if (prices.length > 0) out[code] = prices;
  }
  return out;
}

export function formatMinor(amountMinor, currency = 'INR') {
  const major = (amountMinor / 100).toFixed(2);
  return `${major} ${currency}`;
}

export default {
  SUPPORTED_CURRENCIES,
  SUPPORTED_INTERVALS,
  LEGACY_INTERVAL,
  MAX_AMOUNT_MINOR,
  getRawMapping,
  termMonthsFor,
  resolvePrice,
  resolvePlanPrice,
  listPlanPrices,
  isPurchasable,
  listPricedPlans,
  formatMinor,
  _meta: { module: 'billing.pricing' },
};
