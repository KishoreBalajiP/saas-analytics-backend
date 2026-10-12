/**
 * Billing pricing resolver (Phase 6.1 - Razorpay one-time order flow).
 *
 * PURPOSE
 *   The single authority for "how much does plan X cost". The Phase 6
 *   plan catalogue carries NO commercial pricing (no amount/currency/
 *   interval fields were ever added, per the no-invent-prices constraint),
 *   so purchasable amounts live in explicit server-side configuration:
 *   `RAZORPAY_PLAN_MAPPING_JSON`.
 *
 * CONFIG SHAPE (per plan code):
 *   {
 *     "pro":     { "amountMinor": 99900, "currency": "INR", "interval": "one-time" },
 *     "starter": { "amountMinor": 49900, "currency": "INR", "interval": "one-time" }
 *   }
 *
 * RULES
 *   - `amountMinor` must be a positive integer (smallest currency unit,
 *     e.g. paise for INR). No floats, no client-supplied amounts, ever.
 *   - `currency` must be a 3-letter ISO code; only `INR` is supported
 *     today (the only currency Razorpay test-mode merchants in India
 *     settle by default). Anything else is rejected, not coerced.
 *   - `interval` must be `"one-time"`. The plan model has no billing
 *     interval, so this integration implements a ONE-TIME order/payment
 *     flow. It is NOT a recurring subscription: no automatic renewals.
 *     A recurring Razorpay Subscriptions API integration is an explicit
 *     follow-up (documented in the Phase 6.1 report).
 *   - `free` and unmapped plans are NOT purchasable. Missing mapping is
 *     a business-decision gap, surfaced as 422 with a clear message -
 *     never silently priced at zero.
 *   - Disabled/archived plans are rejected by the caller via
 *     `planService.getActiveByCode` before this resolver runs.
 */

import ApiError from '../utils/ApiError.js';
import config from '../config/env.js';

export const SUPPORTED_CURRENCIES = Object.freeze(['INR']);
export const SUPPORTED_INTERVAL = 'one-time';
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

/**
 * Resolve the authoritative price for a plan code.
 * @throws 422 when the plan has no configured pricing (business gap).
 * @throws 422 when the configured pricing is malformed.
 */
export function resolvePrice(planCode) {
  if (!planCode) throw ApiError.badRequest('planCode is required');
  const mapping = getRawMapping();
  const entry = mapping[planCode];
  if (!entry || typeof entry !== 'object') {
    throw ApiError.validation(
      `Plan "${planCode}" has no configured pricing. Set RAZORPAY_PLAN_MAPPING_JSON for this plan before it can be purchased.`,
    );
  }
  const { amountMinor, currency, interval } = entry;
  if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR) {
    throw ApiError.validation(
      `Configured pricing for plan "${planCode}" is invalid: amountMinor must be a positive integer in minor units.`,
    );
  }
  const normalizedCurrency = String(currency ?? '').toUpperCase();
  if (!SUPPORTED_CURRENCIES.includes(normalizedCurrency)) {
    throw ApiError.validation(
      `Configured pricing for plan "${planCode}" uses unsupported currency "${currency}". Supported: ${SUPPORTED_CURRENCIES.join(', ')}.`,
    );
  }
  if (interval !== SUPPORTED_INTERVAL) {
    throw ApiError.validation(
      `Configured pricing for plan "${planCode}" uses unsupported interval "${interval}". This integration supports one-time payments only.`,
    );
  }
  return { planCode, amountMinor, currency: normalizedCurrency, interval: SUPPORTED_INTERVAL };
}

/** True when the plan code can be purchased right now. */
export function isPurchasable(planCode) {
  if (!planCode || planCode === 'free') return false;
  try {
    resolvePrice(planCode);
    return true;
  } catch {
    return false;
  }
}

/** Public catalogue view: plan code -> { amountMinor, currency, interval }
 *  for every VALID mapping entry. Used by the workspace plans endpoint so
 *  the UI prices from the backend, never from hardcoded values. */
export function listPricedPlans() {
  const mapping = getRawMapping();
  const out = {};
  for (const [code, entry] of Object.entries(mapping)) {
    if (!entry || typeof entry !== 'object') continue;
    const { amountMinor, currency, interval } = entry;
    if (!Number.isInteger(amountMinor) || amountMinor <= 0 || amountMinor > MAX_AMOUNT_MINOR) continue;
    if (!SUPPORTED_CURRENCIES.includes(String(currency ?? '').toUpperCase())) continue;
    if (interval !== SUPPORTED_INTERVAL) continue;
    out[code] = { amountMinor, currency: String(currency).toUpperCase(), interval };
  }
  return out;
}

export function formatMinor(amountMinor, currency = 'INR') {
  const major = (amountMinor / 100).toFixed(2);
  return `${major} ${currency}`;
}

export default {
  SUPPORTED_CURRENCIES,
  SUPPORTED_INTERVAL,
  MAX_AMOUNT_MINOR,
  getRawMapping,
  resolvePrice,
  isPurchasable,
  listPricedPlans,
  formatMinor,
  _meta: { module: 'billing.pricing' },
};
