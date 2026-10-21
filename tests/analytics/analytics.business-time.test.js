/**
 * Business time (roadmap 1.2) and query semantics (roadmap 1.1) in the
 * analytics engine, against a real (in-memory) MongoDB:
 *   - `dateRange.field` filters on a date column in the row data, parsed
 *     safely; `ingestedAt` only when asked for.
 *   - Presets resolve in the WORKSPACE time zone at an injected "now".
 *   - groupBy buckets (day/week/month/quarter/year) in that zone.
 *   - numeric coercion never aborts a query; range filters compare numbers.
 */

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { useMongo, resetMongo } from '../helpers/index.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { queryRows } from '../../src/services/analytics.engine.js';
import * as tenantSettings from '../../src/services/tenantSettings.service.js';
import * as cacheService from '../../src/services/cache.service.js';
import clock from '../../src/utils/clock.js';

useMongo();
const { ObjectId } = mongoose.Types;
const TENANT = new ObjectId().toString();
const OTHER = new ObjectId().toString();
const connectorId = new ObjectId();
// 2026-03-01 02:00 UTC is still Saturday 2026-02-28 in New York, so
// "last month" there is JANUARY 2026, while in UTC it is February 2026.
const NOW = new Date('2026-03-01T02:00:00Z');

/** One row per calendar day from 2023-03-01 to 2026-02-28 (three years). */
function threeYearsOfDays() {
  const rows = [];
  for (let t = Date.UTC(2023, 2, 1); t <= Date.UTC(2026, 1, 28); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    rows.push({ sourceRowId: `d-${day}`, data: { order_date: day, amount: '1', region: 'EU' } });
  }
  return rows;
}

const EXTRA = [
  // 03:00 UTC on Feb 1 is 22:00 on Jan 31 in New York -> January there.
  { sourceRowId: 'edge-late', data: { order_date: '2026-02-01T03:00:00Z', amount: 100, region: 'US' } },
  // 04:30 UTC on Jan 1 is 23:30 on Dec 31 in New York -> NOT January there.
  { sourceRowId: 'edge-early', data: { order_date: '2026-01-01T04:30:00Z', amount: 1000, region: 'US' } },
  { sourceRowId: 'bson-date', data: { order_date: new Date('2026-01-15T12:00:00Z'), amount: 10, region: 'US' } },
  { sourceRowId: 'epoch-ms', data: { order_date: Date.UTC(2026, 0, 20, 12), amount: 10, region: 'US' } },
  { sourceRowId: 'garbage', data: { order_date: 'n/a', amount: 5, region: 'US' } },
  { sourceRowId: 'missing', data: { amount: 5, region: 'US' } },
];

beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll();
  clock.set(NOW);
  // Every row was (re)ingested "now": ingestion time says nothing about
  // when the business event happened.
  const ingestedAt = new Date('2026-02-28T12:00:00Z');
  await ConnectorRow.insertMany([...threeYearsOfDays(), ...EXTRA].map((r) => ({
    tenantId: TENANT, connectorId, ingestedAt, ...r,
  })));
  await ConnectorRow.insertMany([{ tenantId: OTHER, connectorId, sourceRowId: 'o-1', ingestedAt, data: { order_date: '2026-01-10', amount: 1 } }]);
});

afterEach(() => clock.reset());

const total = (filters) => queryRows({ tenantId: TENANT, ...filters }).then((r) => r.total);

test('last_month on a three-year dataset follows the workspace time zone (fixed clock)', async () => {
  await tenantSettings.setTimezone({ tenantId: TENANT, timezone: 'America/New_York' });
  const result = await queryRows({
    tenantId: TENANT,
    dateRange: { field: 'order_date', preset: 'last_month' },
    metrics: [{ op: 'count' }, { op: 'sum', field: 'amount', alias: 'amount' }],
    groupBy: [{ field: 'region' }],
  });
  assert.equal(result.timezone, 'America/New_York');
  assert.equal(result.window.from, '2026-01-01T05:00:00.000Z');
  assert.equal(result.window.to, '2026-02-01T04:59:59.999Z');
  const byRegion = Object.fromEntries(result.rows.map((r) => [r.region, r]));
  // 31 daily January rows + the BSON date + epoch row + the late-evening Feb 1 UTC row.
  assert.equal(byRegion.EU.count, 31);
  assert.equal(byRegion.US.count, 3, 'edge-late, bson-date and epoch-ms are January in New York; edge-early is December');
  assert.equal(byRegion.US.amount, 120);
});

test('the same preset in a UTC workspace answers February, and ingestion time is only used when asked', async () => {
  assert.equal(await total({ dateRange: { field: 'order_date', preset: 'last_month' } }), 28 + 1, 'Feb 1-28 UTC + edge-late');
  // Every row was ingested on 2026-02-28: an ingestion-time window sees all of them.
  assert.equal(await total({ dateRange: { field: 'ingestedAt', preset: 'last_month' } }), 1096 + EXTRA.length);
  assert.equal(await total({ dateRange: { field: 'ingestedAt', preset: 'this_month' } }), 0);
});

test('workspace time zone is per tenant', async () => {
  await tenantSettings.setTimezone({ tenantId: TENANT, timezone: 'Asia/Kolkata' });
  const mine = await queryRows({ tenantId: TENANT, dateRange: { field: 'order_date', preset: 'today' } });
  const other = await queryRows({ tenantId: OTHER, dateRange: { field: 'order_date', preset: 'today' } });
  assert.equal(mine.timezone, 'Asia/Kolkata');
  assert.equal(other.timezone, 'UTC', "another tenant's setting never leaks");
  assert.equal(other.total, 0);
});

test('relative presets move with the clock instead of being frozen', async () => {
  const first = await total({ dateRange: { field: 'order_date', preset: 'yesterday' } });
  clock.set(new Date('2025-06-15T12:00:00Z'));
  const second = await queryRows({ tenantId: TENANT, dateRange: { field: 'order_date', preset: 'yesterday' } });
  assert.equal(first, 1);
  assert.equal(second.total, 1);
  assert.equal(second.window.from, '2025-06-14T00:00:00.000Z');
});

test('custom ranges: dates are whole days in the zone; unparseable dates are outside every window', async () => {
  await tenantSettings.setTimezone({ tenantId: TENANT, timezone: 'America/New_York' });
  // Whole of 2025 in New York: 365 daily rows + edge-early (23:30 on Dec 31 there).
  assert.equal(await total({ dateRange: { field: 'order_date', from: '2025-01-01', to: '2025-12-31' } }), 366);
  // Open-ended.
  assert.equal(await total({ dateRange: { field: 'order_date', preset: 'custom', from: '2026-02-01' } }), 28);
  // garbage and missing values never match a window.
  const all = await total({ dateRange: { field: 'order_date', from: '1970-01-01' } });
  assert.equal(all, 1096 + EXTRA.length - 2);
});

test('groupBy buckets dates in the workspace time zone', async () => {
  await tenantSettings.setTimezone({ tenantId: TENANT, timezone: 'America/New_York' });
  const monthly = await queryRows({
    tenantId: TENANT,
    dateRange: { field: 'order_date', preset: 'this_year' },
    groupBy: [{ field: 'order_date', bucket: 'month' }],
    metrics: [{ op: 'count', alias: 'orders' }],
    orderBy: [{ field: 'order_date', direction: 'asc' }],
  });
  assert.deepEqual(monthly.rows, [
    { order_date: '2026-01-01', orders: 34 },
    { order_date: '2026-02-01', orders: 28 },
  ]);
  assert.deepEqual(monthly.columns, ['order_date', 'orders']);

  const quarterly = await queryRows({
    tenantId: TENANT,
    dateRange: { field: 'order_date', from: '2025-01-01', to: '2025-12-31' },
    groupBy: [{ field: 'order_date', bucket: 'quarter' }],
  });
  assert.deepEqual(quarterly.rows.map((r) => [r.order_date, r.count]), [
    ['2025-01-01', 90], ['2025-04-01', 91], ['2025-07-01', 92], ['2025-10-01', 93],
  ], 'Q4 includes edge-early, which is Dec 31 in New York');

  const yearly = await queryRows({ tenantId: TENANT, groupBy: [{ field: 'order_date', bucket: 'year' }], pagination: { limit: 10 } });
  const years = Object.fromEntries(yearly.rows.map((r) => [r.order_date, r.count]));
  assert.equal(years['2024-01-01'], 366);
  assert.equal(years[null] ?? years.null, 2, 'unparseable dates group under null');

  const weekly = await queryRows({
    tenantId: TENANT,
    dateRange: { field: 'order_date', from: '2026-02-02', to: '2026-02-15' },
    groupBy: [{ field: 'order_date', bucket: 'week' }],
  });
  assert.deepEqual(weekly.rows.map((r) => [r.order_date, r.count]), [['2026-02-02', 7], ['2026-02-09', 7]], 'ISO weeks start on Monday');

  const daily = await queryRows({
    tenantId: TENANT,
    dateRange: { field: 'order_date', from: '2026-01-31', to: '2026-01-31' },
    groupBy: [{ field: 'order_date', bucket: 'day' }],
  });
  assert.deepEqual(daily.rows.map((r) => [r.order_date, r.count]), [['2026-01-31', 2]], 'the 22:00 New York row lands on Jan 31');
});

test('numeric metrics skip blank and non-numeric values; range filters compare numbers', async () => {
  const cid = new ObjectId();
  await ConnectorRow.insertMany([
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'n1', data: { v: '10' } },
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'n2', data: { v: '' } },
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'n3', data: { v: 'x' } },
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'n4', data: { v: '50' } },
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'n5', data: { v: '150' } },
  ]);
  const sum = await queryRows({ tenantId: TENANT, connectorIds: [String(cid)], groupBy: [{ field: 'k' }], metrics: [{ op: 'sum', field: 'v', alias: 's' }, { op: 'max', field: 'v', alias: 'm' }] });
  assert.equal(sum.rows[0].s, 210);
  assert.equal(sum.rows[0].m, 150);
  // '50' > 100 is false numerically (lexically '50' > '100').
  const gt = await queryRows({ tenantId: TENANT, connectorIds: [String(cid)], filters: [{ field: 'v', op: 'gt', value: 100 }] });
  assert.equal(gt.total, 1);
});

test('raw sorting on a data column is stable and leaks no internal keys', async () => {
  const r = await queryRows({
    tenantId: TENANT,
    dateRange: { field: 'order_date', from: '2026-02-01', to: '2026-02-03' },
    orderBy: [{ field: 'order_date', direction: 'desc' }],
  });
  assert.deepEqual(r.rows.map((row) => row.data.order_date), ['2026-02-03', '2026-02-02', '2026-02-01T03:00:00Z', '2026-02-01']);
  assert.ok(r.rows.every((row) => Object.keys(row).every((k) => !k.startsWith('__'))));
});

test('filters on dataset ids and nested AND groups narrow the result', async () => {
  const r = await queryRows({
    tenantId: TENANT,
    filters: [{ field: 'region', op: 'eq', value: 'US' }, { field: 'region', op: 'eq', value: 'EU' }],
    filtersOp: 'or',
    filterGroups: [{ filters: [{ field: 'amount', op: 'gte', value: 10 }] }],
  });
  assert.equal(r.total, 4, 'US rows with amount >= 10 (EU rows are "1")');
  const byConnector = await queryRows({ tenantId: TENANT, filters: [{ field: 'connectorId', op: 'eq', value: String(connectorId) }] });
  assert.equal(byConnector.total, 1096 + EXTRA.length);
});

test('dates outside years 1-9999 are unreadable instead of failing every bucketed query', async () => {
  // Epoch milliseconds from a JSON/MongoDB source can land far outside the
  // range MongoDB's date-part operators accept (year 33658, year -1199, and
  // year 10000 in UTC); one such row used to fail the whole aggregation.
  const cid = new ObjectId();
  await ConnectorRow.insertMany([
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'far-future', data: { at: 1e15 } },
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'far-past', data: { at: -1e14 } },
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'year-10000', data: { at: '9999-12-31T23:00:00-05:00' } },
    { tenantId: TENANT, connectorId: cid, sourceRowId: 'ok', data: { at: '2026-01-15' } },
  ]);
  await tenantSettings.setTimezone({ tenantId: TENANT, timezone: 'Asia/Kolkata' });
  for (const bucket of ['day', 'week', 'month', 'quarter', 'year']) {
    const r = await queryRows({ tenantId: TENANT, connectorIds: [String(cid)], groupBy: [{ field: 'at', bucket }], orderBy: ['at'] });
    assert.deepEqual(r.rows.map((row) => row.count), [3, 1], bucket);
    assert.equal(r.rows[0].at, null, `${bucket}: out-of-range dates group under null`);
  }
  assert.equal(await total({ connectorIds: [String(cid)], dateRange: { field: 'at', from: '2000-01-01' } }), 1);
});
