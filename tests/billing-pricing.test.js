/**
 * Tests for billingPricing.service.js — the authoritative plan-price resolver.
 *
 * These tests cover the RAZORPAY_PLAN_MAPPING_JSON schema, rejection of
 * malformed/invalid entries, currency handling, and the public catalogue view.
 * They do NOT depend on any live provider configuration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePrice,
  isPurchasable,
  listPricedPlans,
  formatMinor,
  SUPPORTED_CURRENCIES,
  SUPPORTED_INTERVAL,
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

test('SUPPORTED_INTERVAL is "one-time" (no recurring billing in this build)', () => {
  assert.equal(SUPPORTED_INTERVAL, 'one-time');
});

test('MAX_AMOUNT_MINOR is a positive integer (paise)', () => {
  assert.ok(Number.isInteger(MAX_AMOUNT_MINOR));
  assert.ok(MAX_AMOUNT_MINOR > 0);
});

test('resolvePrice: valid mapping returns canonical price object', () => {
  __setTestMapping({
    pro: { amountMinor: 99900, currency: 'INR', interval: 'one-time' },
  });
  const price = resolvePrice('pro');
  assert.deepEqual(price, {
    planCode: 'pro',
    amountMinor: 99900,
    currency: 'INR',
    interval: 'one-time',
  });
});

test('resolvePrice: rejects unknown plan code (no silent zero pricing)', () => {
  __setTestMapping({
    pro: { amountMinor: 99900, currency: 'INR', interval: 'one-time' },
  });
  assert.throws(
    () => resolvePrice('unknown-plan'),
    (err) => err.statusCode === 422 && /no configured pricing/.test(err.message),
  );
});

test('resolvePrice: rejects empty planCode', () => {
  __setTestMapping({});
  assert.throws(
    () => resolvePrice(''),
    (err) => err.statusCode === 400,
  );
  assert.throws(() => resolvePrice(null), (err) => err.statusCode === 400);
});

test('resolvePrice: rejects non-integer amountMinor (no float rounding errors)', () => {
  __setTestMapping({
    pro: { amountMinor: 999.5, currency: 'INR', interval: 'one-time' },
  });
  assert.throws(
    () => resolvePrice('pro'),
    (err) => err.statusCode === 422 && /amountMinor/.test(err.message),
  );
});

test('resolvePrice: rejects negative or zero amountMinor', () => {
  __setTestMapping({
    pro: { amountMinor: 0, currency: 'INR', interval: 'one-time' },
  });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422);
  __setTestMapping({
    pro: { amountMinor: -100, currency: 'INR', interval: 'one-time' },
  });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422);
});

test('resolvePrice: rejects amountMinor above sanity ceiling', () => {
  __setTestMapping({
    pro: { amountMinor: MAX_AMOUNT_MINOR + 1, currency: 'INR', interval: 'one-time' },
  });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422);
});

test('resolvePrice: rejects unsupported currency (not silently coerced)', () => {
  __setTestMapping({
    pro: { amountMinor: 99900, currency: 'USD', interval: 'one-time' },
  });
  assert.throws(
    () => resolvePrice('pro'),
    (err) => err.statusCode === 422 && /unsupported currency/.test(err.message),
  );
});

test('resolvePrice: normalises lowercase currency to uppercase', () => {
  __setTestMapping({
    pro: { amountMinor: 99900, currency: 'inr', interval: 'one-time' },
  });
  const price = resolvePrice('pro');
  assert.equal(price.currency, 'INR');
});

test('resolvePrice: rejects non-"one-time" interval (recurring not supported)', () => {
  __setTestMapping({
    pro: { amountMinor: 99900, currency: 'INR', interval: 'monthly' },
  });
  assert.throws(
    () => resolvePrice('pro'),
    (err) => err.statusCode === 422 && /one-time/.test(err.message),
  );
});

test('resolvePrice: rejects missing required fields', () => {
  __setTestMapping({ pro: { currency: 'INR', interval: 'one-time' } });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422);
  __setTestMapping({ pro: { amountMinor: 99900, interval: 'one-time' } });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422);
  __setTestMapping({ pro: { amountMinor: 99900, currency: 'INR' } });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422);
});

test('resolvePrice: handles non-object entry gracefully', () => {
  __setTestMapping({ pro: 'not an object' });
  assert.throws(() => resolvePrice('pro'), (err) => err.statusCode === 422);
});

test('isPurchasable: returns false for "free" and falsy codes', () => {
  __setTestMapping({
    pro: { amountMinor: 99900, currency: 'INR', interval: 'one-time' },
  });
  assert.equal(isPurchasable('free'), false);
  assert.equal(isPurchasable(''), false);
  assert.equal(isPurchasable(null), false);
});

test('isPurchasable: returns true only for fully valid mappings', () => {
  __setTestMapping({
    pro: { amountMinor: 99900, currency: 'INR', interval: 'one-time' },
    broken: { amountMinor: -1, currency: 'INR', interval: 'one-time' },
  });
  assert.equal(isPurchasable('pro'), true);
  assert.equal(isPurchasable('broken'), false);
  assert.equal(isPurchasable('absent'), false);
});

test('listPricedPlans: returns only valid entries (frontend uses this)', () => {
  __setTestMapping({
    pro: { amountMinor: 99900, currency: 'INR', interval: 'one-time' },
    starter: { amountMinor: 49900, currency: 'INR', interval: 'one-time' },
    badCurrency: { amountMinor: 1000, currency: 'EUR', interval: 'one-time' },
    badAmount: { amountMinor: -1, currency: 'INR', interval: 'one-time' },
    badInterval: { amountMinor: 1000, currency: 'INR', interval: 'monthly' },
    notAnObject: 'oops',
  });
  const priced = listPricedPlans();
  assert.deepEqual(Object.keys(priced).sort(), ['pro', 'starter']);
  assert.equal(priced.pro.amountMinor, 99900);
  assert.equal(priced.starter.amountMinor, 49900);
  assert.equal(priced.pro.currency, 'INR');
  assert.equal(priced.starter.interval, 'one-time');
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
  // The example in .env.example is:
  // {"starter":{"amountMinor":49900,"currency":"INR","interval":"one-time"},"pro":{"amountMinor":99900,"currency":"INR","interval":"one-time"}}
  // These are PLACEHOLDER amounts and must NOT be treated as production prices.
  __setTestMapping({
    starter: { amountMinor: 49900, currency: 'INR', interval: 'one-time' },
    pro: { amountMinor: 99900, currency: 'INR', interval: 'one-time' },
  });
  const starter = resolvePrice('starter');
  const pro = resolvePrice('pro');
  assert.equal(starter.amountMinor, 49900);
  assert.equal(pro.amountMinor, 99900);
  // These are placeholder amounts; real commercial prices must be set by
  // the business owner before live activation.
});