/**
 * Tests for billingPricing.service.js — the authoritative plan-price resolver.
 *
 * billing (roadmap 3.1): prices are prepaid terms (`month` / `year`). These
 * tests cover the RAZORPAY_PLAN_MAPPING_JSON schema (per-interval entries and
 * the legacy flat `one-time` entry, read as a monthly term), rejection of
 * malformed entries, currency handling, catalogue-first resolution and the
 * public configuration view. No live provider configuration is used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePrice,
  resolvePlanPrice,
  listPlanPrices,
  isPurchasable,
  listPricedPlans,
  formatMinor,
  termMonthsFor,
  SUPPORTED_CURRENCIES,
  SUPPORTED_INTERVALS,
  LEGACY_INTERVAL,
  MAX_AMOUNT_MINOR,
  __setTestMapping,
  __clearTestMapping,
} from '../src/services/billingPricing.service.js';

test.beforeEach(() => {
  __clearTestMapping();
});

test.afterEach(() => {
  __clearTestMapping();
});

test('SUPPORTED_CURRENCIES is exactly INR (no multi-currency by default)', () => {
  assert.deepEqual([...SUPPORTED_CURRENCIES], ['INR']);
});

test('prepaid intervals are month and year; the legacy one-time entry is a monthly term', () => {
  assert.deepEqual([...SUPPORTED_INTERVALS], ['month', 'year']);
  assert.equal(LEGACY_INTERVAL, 'one-time');
  assert.equal(termMonthsFor('month'), 1);
  assert.equal(termMonthsFor('year'), 12);
  assert.equal(termMonthsFor('week'), null);
});

test('MAX_AMOUNT_MINOR is a positive integer (paise)', () => {
  assert.ok(Number.isInteger(MAX_AMOUNT_MINOR));
  assert.ok(MAX_AMOUNT_MINOR > 0);
});

test('resolvePrice: per-interval mapping returns canonical term prices', () => {
  __setTestMapping({
    pro: { month: { amountMinor: 99900, currency: 'INR' }, year: { amountMinor: 999000, currency: 'inr' } },
  });
  assert.deepEqual(resolvePrice('pro', 'month'), {
    planCode: 'pro', amountMinor: 99900, currency: 'INR', interval: 'month', termMonths: 1,
  });
  assert.deepEqual(resolvePrice('pro', 'year'), {
    planCode: 'pro', amountMinor: 999000, currency: 'INR', interval: 'year', termMonths: 12,
  });
});

test('resolvePrice: legacy flat one-time entry resolves as a monthly term only', () => {
  __setTestMapping({ pro: { amountMinor: 99900, currency: 'INR', interval: 'one-time' } });
  assert.equal(resolvePrice('pro').interval, 'month');
  assert.equal(resolvePrice('pro', 'month').amountMinor, 99900);
  assert.throws(() => resolvePrice('pro', 'year'), (err) => err.statusCode === 422);
});

test('resolvePrice: rejects unknown plan code (no silent zero pricing)', () => {
  __setTestMapping({ pro: { month: { amountMinor: 99900, currency: 'INR' } } });
  assert.throws(() => resolvePrice('unknown-plan'), (err) => err.statusCode === 422 && /no configured/.test(err.message));
});

test('resolvePrice: rejects empty planCode and unknown intervals', () => {
  assert.throws(() => resolvePrice(''), (err) => err.statusCode === 400);
  assert.throws(() => resolvePrice(null), (err) => err.statusCode === 400);
  __setTestMapping({ pro: { month: { amountMinor: 99900, currency: 'INR' } } });
  assert.throws(() => resolvePrice('pro', 'weekly'), (err) => err.statusCode === 400);
});

test('resolvePrice: rejects non-integer, negative, zero and oversized amounts', () => {
  for (const amountMinor of [99.5, -1, 0, MAX_AMOUNT_MINOR + 1, '99900']) {
    __setTestMapping({ pro: { month: { amountMinor, currency: 'INR' } } });
    assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422, `amount ${amountMinor}`);
  }
});

test('resolvePrice: rejects unsupported currency (not silently coerced)', () => {
  __setTestMapping({ pro: { month: { amountMinor: 99900, currency: 'USD' } } });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422 && /currency/.test(err.message));
});

test('resolvePrice: rejects an unsupported legacy interval', () => {
  __setTestMapping({ pro: { amountMinor: 99900, currency: 'INR', interval: 'weekly' } });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422 && /interval/.test(err.message));
});

test('resolvePrice: handles non-object entry gracefully', () => {
  __setTestMapping({ pro: 'oops' });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422);
});

test('resolvePlanPrice: catalogue prices win over configuration; free is never priced', () => {
  __setTestMapping({ pro: { month: { amountMinor: 99900, currency: 'INR' } } });
  const plan = { code: 'pro', data: { prices: [{ interval: 'month', amountMinor: 123400, currency: 'INR' }] } };
  assert.equal(resolvePlanPrice(plan, 'month').amountMinor, 123400);
  assert.equal(resolvePlanPrice(plan, 'month').source, 'catalog');
  assert.equal(resolvePlanPrice({ code: 'pro', data: {} }, 'month').source, 'config');
  assert.throws(() => resolvePlanPrice({ code: 'free', data: {} }), (err) => err.statusCode === 400);
  assert.deepEqual(listPlanPrices({ code: 'free', data: {} }), []);
  assert.equal(listPlanPrices(plan).length, 1);
});

test('isPurchasable: false for "free", falsy and broken codes; true for valid ones', () => {
  __setTestMapping({
    free: { month: { amountMinor: 100, currency: 'INR' } },
    pro: { month: { amountMinor: 99900, currency: 'INR' } },
    broken: { month: { amountMinor: -5, currency: 'INR' } },
  });
  assert.equal(isPurchasable('free'), false);
  assert.equal(isPurchasable(''), false);
  assert.equal(isPurchasable(null), false);
  assert.equal(isPurchasable('pro'), true);
  assert.equal(isPurchasable('pro', 'year'), false);
  assert.equal(isPurchasable('broken'), false);
  assert.equal(isPurchasable('absent'), false);
});

test('listPricedPlans: returns only valid entries per plan', () => {
  __setTestMapping({
    pro: { month: { amountMinor: 99900, currency: 'INR' }, year: { amountMinor: 999000, currency: 'INR' } },
    starter: { amountMinor: 49900, currency: 'INR', interval: 'one-time' },
    badCurrency: { month: { amountMinor: 1000, currency: 'EUR' } },
    badAmount: { month: { amountMinor: -1, currency: 'INR' } },
    notAnObject: 'oops',
  });
  const priced = listPricedPlans();
  assert.deepEqual(Object.keys(priced).sort(), ['pro', 'starter']);
  assert.equal(priced.pro.length, 2);
  assert.deepEqual(priced.starter, [{ interval: 'month', amountMinor: 49900, currency: 'INR' }]);
});

test('listPricedPlans: empty mapping returns empty object (not error)', () => {
  __setTestMapping({});
  assert.deepEqual(listPricedPlans(), {});
});

test('formatMinor: converts paise to major-unit string', () => {
  assert.equal(formatMinor(99900, 'INR'), '999.00 INR');
  assert.equal(formatMinor(49900, 'INR'), '499.00 INR');
  assert.equal(formatMinor(1, 'INR'), '0.01 INR');
});

test('resolvePrice: example schema from .env.example comment is valid', () => {
  // These are PLACEHOLDER amounts and must NOT be treated as production prices.
  __setTestMapping({
    pro: { month: { amountMinor: 99900, currency: 'INR' }, year: { amountMinor: 999000, currency: 'INR' } },
  });
  assert.equal(resolvePrice('pro', 'month').amountMinor, 99900);
  assert.equal(resolvePrice('pro', 'year').amountMinor, 999000);
});
