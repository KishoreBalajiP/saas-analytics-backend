/**
 * The analytics query contract (roadmap 1.1): one strict validator shared by
 * every consumer. Each rejection rule documented at the top of
 * `services/analytics.engine.js` has a case here; every rejection is a 400
 * INVALID_QUERY carrying field-level errors, and nothing is silently dropped.
 *
 * Pure validation: no database is needed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateQuery,
  normalizeQuery,
  resolveDateRange,
  DATE_PRESETS,
  QUERY_KEYS,
  FILTER_ENVELOPE_KEYS,
  LIMITS,
} from '../../src/services/analytics.engine.js';
import { DATE_RANGE_PRESETS } from '../../src/models/Dashboard.js';

const ID = '0123456789abcdef01234567';

/** Assert `fn` throws a 400 INVALID_QUERY whose errors include `field`. */
function rejects(fn, field, messagePattern) {
  let error;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert.ok(error, `expected a rejection for ${field}`);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, 'INVALID_QUERY');
  const match = error.errors?.find((e) => e.field === field);
  assert.ok(match, `expected an error for "${field}", got ${JSON.stringify(error.errors)}`);
  if (messagePattern) assert.match(match.message, messagePattern);
  return error;
}

const v = (query, opts) => validateQuery(query, opts);

test('accepted shape round-trips, with UI shorthand normalised', () => {
  const out = v({
    connectorIds: [ID],
    filters: [{ field: 'region', op: 'in', value: 'EU' }, { field: 'amount', op: 'gt', value: '10' }, { field: 'x', op: 'exists', value: 'true' }],
    filtersOp: 'or',
    dateRange: { field: 'order_date', preset: 'last_month' },
    metrics: [{ op: 'count' }, { op: 'sum', field: 'amount', alias: 'revenue' }],
    groupBy: ['region', { field: 'order_date', bucket: 'month' }],
    orderBy: [{ field: 'revenue', dir: 'desc' }, 'region'],
    pagination: { page: '2', limit: 25 },
  });
  assert.deepEqual(out.filters[0].value, ['EU'], 'single in-value is wrapped');
  assert.equal(out.filters[1].value, 10, 'numeric strings become numbers for range ops');
  assert.equal(out.filters[2].value, true);
  assert.deepEqual(out.groupBy, [{ field: 'region' }, { field: 'order_date', bucket: 'month' }]);
  assert.deepEqual(out.orderBy, [{ field: 'revenue', direction: 'desc' }, { field: 'region', direction: 'asc' }]);
  assert.deepEqual(out.pagination, { page: 2, limit: 25 });
  assert.deepEqual(out.dateRange, { field: 'order_date', preset: 'last_month' }, 'presets are kept, not frozen');
});

test('rule: the query must be an object', () => {
  rejects(() => v([]), 'query');
  rejects(() => v('x', { prefix: 'query.' }), 'query');
});

test('rule: unknown keys are rejected at every level', () => {
  rejects(() => v({ select: '*' }), 'select', /not a recognised/);
  rejects(() => v({ filters: [{ field: 'a', op: 'eq', value: 1, $where: 'x' }] }), 'filters[0].$where');
  rejects(() => v({ metrics: [{ op: 'count', as: 'n' }] }), 'metrics[0].as');
  rejects(() => v({ groupBy: [{ field: 'a', interval: 'day' }] }), 'groupBy[0].interval');
  rejects(() => v({ orderBy: [{ field: 'a', nulls: 'last' }] }), 'orderBy[0].nulls');
  rejects(() => v({ dateRange: { field: 'd', preset: 'today', tz: 'UTC' } }), 'dateRange.tz');
  rejects(() => v({ pagination: { page: 1, offset: 5 } }), 'pagination.offset');
  // Consumers restrict the top-level keys further and prefix the path.
  rejects(() => v({ connectorIds: [ID] }, { keys: FILTER_ENVELOPE_KEYS, prefix: 'filters.' }), 'filters.connectorIds');
  // Internal execution keys are not part of the public contract.
  rejects(() => v({ timezone: 'UTC' }), 'timezone');
  rejects(() => v({ filterGroups: [] }), 'filterGroups');
  rejects(() => normalizeQuery({ tenantId: 't', hack: 1 }), 'hack');
});

test('rule: bad operators are rejected', () => {
  rejects(() => v({ filters: [{ field: 'a', op: 'contains', value: 'x' }] }), 'filters[0].op', /must be one of/);
  rejects(() => v({ metrics: [{ op: 'median', field: 'a' }] }), 'metrics[0].op');
  rejects(() => v({ filtersOp: 'xor' }), 'filtersOp');
  rejects(() => v({ orderBy: [{ field: 'a', direction: 'up' }] }), 'orderBy[0].direction');
  rejects(() => v({ orderBy: [{ field: 'a', dir: 'sideways' }] }), 'orderBy[0].dir');
  rejects(() => v({ orderBy: [{ field: 'a', direction: 'asc', dir: 'desc' }] }), 'orderBy[0].dir', /conflicts/);
});

test('rule: bad field names are rejected', () => {
  for (const bad of ['$where', 'a.b', '', 'x'.repeat(LIMITS.nameLength + 1), 'tab\tname', 42]) {
    rejects(() => v({ filters: [{ field: bad, op: 'eq', value: 1 }] }), 'filters[0].field');
  }
  rejects(() => v({ metrics: [{ op: 'sum', field: 'a.b' }] }), 'metrics[0].field');
  rejects(() => v({ metrics: [{ op: 'sum' }] }), 'metrics[0].field', /required/);
  rejects(() => v({ metrics: [{ op: 'count', alias: '$x' }] }), 'metrics[0].alias');
  rejects(() => v({ groupBy: ['a.b'] }), 'groupBy[0]');
  rejects(() => v({ groupBy: [{ field: '_id' }] }), 'groupBy[0].field', /reserved/);
  // Output names starting with "__" are engine-internal; "__proto__" would
  // otherwise set the prototype of the result objects instead of a column.
  rejects(() => v({ groupBy: ['__proto__'] }), 'groupBy[0].field', /reserved/);
  rejects(() => v({ groupBy: [{ field: '__sort0' }] }), 'groupBy[0].field', /reserved/);
  rejects(() => v({ metrics: [{ op: 'count', alias: '__proto__' }] }), 'metrics[0].alias', /reserved/);
  // Filter and metric INPUT fields only read `data.<name>`, so they may start with "__".
  assert.doesNotThrow(() => v({ filters: [{ field: '__meta', op: 'eq', value: 1 }], metrics: [{ op: 'sum', field: '__n' }] }));
  rejects(() => v({ orderBy: [{ field: '$natural' }] }), 'orderBy[0].field');
  rejects(() => v({ filters: [{ field: 'ingestedAt', op: 'gt', value: 1 }] }), 'filters[0].field', /dateRange/);
  rejects(() => v({ filters: [{ field: 'tenantId', op: 'eq', value: 'other' }] }), 'filters[0].field');
  rejects(() => v({ dateRange: { field: 'connectorId', preset: 'today' } }), 'dateRange.field', /date column/);
  rejects(() => v({ connectorIds: ['not-an-id'] }), 'connectorIds[0]');
  rejects(() => v({ connectorIds: 'abc' }), 'connectorIds');
});

test('rule: names must be unique and grouped ordering must name an output column', () => {
  rejects(() => v({ metrics: [{ op: 'sum', field: 'a', alias: 'x' }, { op: 'max', field: 'b', alias: 'x' }] }), 'metrics[1].alias', /duplicates/);
  rejects(() => v({ metrics: [{ op: 'count' }, { op: 'count' }] }), 'metrics[1].alias');
  rejects(() => v({ groupBy: ['a', 'a'] }), 'groupBy[1].field');
  rejects(() => v({ groupBy: ['region'], metrics: [{ op: 'count', alias: 'region' }] }), 'metrics[0].alias', /groupBy/);
  rejects(() => v({ groupBy: ['region'], orderBy: [{ field: 'amount' }] }), 'orderBy[0].field', /groupBy field or metric alias/);
  // Without metrics the result carries a `count` column, which would
  // overwrite a group field called "count" in every row.
  rejects(() => v({ groupBy: ['region', 'count'] }), 'groupBy[1].field', /default count column/);
  assert.doesNotThrow(() => v({ groupBy: ['count'], metrics: [{ op: 'count', alias: 'rows' }] }));
  // Raw (ungrouped) queries may sort on any column.
  assert.doesNotThrow(() => v({ orderBy: [{ field: 'amount' }] }));
  assert.doesNotThrow(() => v({ groupBy: ['region'], orderBy: [{ field: 'count', direction: 'desc' }] }));
});

test('rule: bad value types are rejected', () => {
  rejects(() => v({ filters: [{ field: 'a', op: 'eq', value: { $range: [0, 1e7] } }] }), 'filters[0].value');
  rejects(() => v({ filters: [{ field: 'a', op: 'eq', value: [1, 2] }] }), 'filters[0].value');
  rejects(() => v({ filters: [{ field: 'a', op: 'eq' }] }), 'filters[0].value');
  rejects(() => v({ filters: [{ field: 'a', op: 'eq', value: 'x'.repeat(LIMITS.valueLength + 1) }] }), 'filters[0].value');
  rejects(() => v({ filters: [{ field: 'a', op: 'in', value: [1, { $gt: 1 }] }] }), 'filters[0].value');
  rejects(() => v({ filters: [{ field: 'a', op: 'in', value: new Array(LIMITS.inValues + 1).fill(1) }] }), 'filters[0].value');
  for (const bad of ['2024-01-01', '', null, true, { n: 1 }, 'ten']) {
    rejects(() => v({ filters: [{ field: 'a', op: 'gt', value: bad }] }), 'filters[0].value');
  }
  rejects(() => v({ filters: [{ field: 'a', op: 'exists', value: 'yes' }] }), 'filters[0].value', /true or false/);
  rejects(() => v({ filters: [{ field: 'connectorId', op: 'eq', value: 'nope' }] }), 'filters[0].value', /dataset id/);
  rejects(() => v({ filters: [{ field: 'connectorId', op: 'in', value: ['nope'] }] }), 'filters[0].value');
  rejects(() => v({ filters: 'region=EU' }), 'filters');
  rejects(() => v({ filters: ['region'] }), 'filters[0]');
  rejects(() => v({ metrics: {} }), 'metrics');
  rejects(() => v({ groupBy: [42] }), 'groupBy[0]');
  rejects(() => v({ orderBy: [null] }), 'orderBy[0]');
  rejects(() => v({ pagination: { page: 0 } }), 'pagination.page');
  rejects(() => v({ pagination: { page: 1.5 } }), 'pagination.page');
  rejects(() => v({ pagination: { limit: 500 } }), 'pagination.limit');
  rejects(() => v({ pagination: { limit: '10abc' } }), 'pagination.limit');
  rejects(() => v({ pagination: [] }), 'pagination');
  rejects(() => v({ filters: new Array(LIMITS.filters + 1).fill({ field: 'a', op: 'eq', value: 1 }) }), 'filters');
  rejects(() => v({ metrics: new Array(LIMITS.metrics + 1).fill(0).map((_, i) => ({ op: 'count', alias: `c${i}` })) }), 'metrics');
  rejects(() => v({ groupBy: ['a', 'b', 'c', 'd', 'e', 'f'] }), 'groupBy');
  rejects(() => v({ connectorIds: new Array(LIMITS.connectorIds + 1).fill(ID) }), 'connectorIds');
});

test('rule: bad date ranges and presets are rejected', () => {
  rejects(() => v({ dateRange: { preset: 'today' } }), 'dateRange.field', /required/);
  rejects(() => v({ dateRange: { field: 'd', preset: 'last_fortnight' } }), 'dateRange.preset', /must be one of/);
  rejects(() => v({ dateRange: { field: 'd', preset: 'today', from: '2024-01-01' } }), 'dateRange.from', /relative preset/);
  rejects(() => v({ dateRange: { field: 'd', preset: 'last_month', to: '2024-01-01' } }), 'dateRange.to');
  rejects(() => v({ dateRange: { field: 'd', preset: 'custom' } }), 'dateRange', /from and\/or to/);
  rejects(() => v({ dateRange: { field: 'd' } }), 'dateRange', /preset or from\/to/);
  rejects(() => v({ dateRange: { field: 'd', from: 'January 3rd' } }), 'dateRange.from', /ISO-8601/);
  rejects(() => v({ dateRange: { field: 'd', from: '2024-02-30' } }), 'dateRange.from');
  rejects(() => v({ dateRange: { field: 'd', to: '2024-01-01T25:00' } }), 'dateRange.to');
  rejects(() => v({ dateRange: { field: 'd', from: '2024-03-01', to: '2024-02-01' } }), 'dateRange', /on or before/);
  rejects(() => v({ dateRange: 'last_month' }), 'dateRange');
  assert.doesNotThrow(() => v({ dateRange: { field: 'd', from: '2024-01-01' } }));
  assert.doesNotThrow(() => v({ dateRange: { field: 'd', preset: 'custom', from: '2024-01-01T00:00:00+05:30', to: '2024-01-31' } }));
  assert.doesNotThrow(() => v({ dateRange: { field: 'ingestedAt', preset: 'previous_month' } }), 'legacy preset name stays accepted');
});

test('rule: bad buckets are rejected', () => {
  rejects(() => v({ groupBy: [{ field: 'd', bucket: 'hour' }] }), 'groupBy[0].bucket', /must be one of/);
  rejects(() => v({ groupBy: [{ field: 'd', bucket: 7 }] }), 'groupBy[0].bucket');
  rejects(() => v({ groupBy: [{ field: 'sourceRowId', bucket: 'day' }] }), 'groupBy[0].bucket', /date column/);
  for (const bucket of ['day', 'week', 'month', 'quarter', 'year']) {
    assert.doesNotThrow(() => v({ groupBy: [{ field: 'd', bucket }] }));
  }
});

test('every problem is reported at once, not just the first', () => {
  const err = rejects(() => v({ bogus: 1, filters: [{ field: '$x', op: 'nope', value: {} }], pagination: { limit: 0 } }), 'bogus');
  const fields = err.errors.map((e) => e.field).sort();
  assert.deepEqual(fields, ['bogus', 'filters[0].field', 'filters[0].op', 'pagination.limit']);
});

test('engine options: tenantId is required, internal keys are validated', () => {
  assert.throws(() => normalizeQuery({}), (e) => e.statusCode === 400 && e.code === 'INVALID_QUERY');
  rejects(() => normalizeQuery({ tenantId: 't', timezone: 'Mars/Base' }), 'timezone');
  rejects(() => normalizeQuery({ tenantId: 't', now: 'yesterday' }), 'now');
  rejects(() => normalizeQuery({ tenantId: 't', filterGroups: [{ filters: [{ field: 'a', op: 'like', value: 1 }] }] }), 'filterGroups[0].filters[0].op');
  const out = normalizeQuery({ tenantId: 't' });
  assert.deepEqual(out.filters, []);
  assert.equal(out.filtersOp, 'and');
  assert.deepEqual(QUERY_KEYS, ['connectorIds', 'filters', 'filtersOp', 'dateRange', 'metrics', 'groupBy', 'orderBy', 'pagination']);
});

test('date presets resolve in the workspace time zone at the given instant', () => {
  // 2026-03-01 02:00 UTC is still 2026-02-28 in New York and already
  // 2026-03-01 07:30 in Kolkata.
  const now = new Date('2026-03-01T02:00:00Z');
  const r = (preset, timezone) => {
    const w = resolveDateRange({ field: 'd', preset }, { timezone, now });
    return [w.from.toISOString(), w.to.toISOString()];
  };
  assert.deepEqual(r('today', 'UTC'), ['2026-03-01T00:00:00.000Z', '2026-03-01T23:59:59.999Z']);
  assert.deepEqual(r('today', 'America/New_York'), ['2026-02-28T05:00:00.000Z', '2026-03-01T04:59:59.999Z']);
  assert.deepEqual(r('yesterday', 'Asia/Kolkata'), ['2026-02-27T18:30:00.000Z', '2026-02-28T18:29:59.999Z']);
  assert.deepEqual(r('last_7_days', 'UTC'), ['2026-02-23T00:00:00.000Z', '2026-03-01T23:59:59.999Z']);
  assert.deepEqual(r('last_30_days', 'UTC'), ['2026-01-31T00:00:00.000Z', '2026-03-01T23:59:59.999Z']);
  assert.deepEqual(r('this_month', 'America/New_York'), ['2026-02-01T05:00:00.000Z', '2026-03-01T04:59:59.999Z']);
  assert.deepEqual(r('this_month', 'Asia/Kolkata'), ['2026-02-28T18:30:00.000Z', '2026-03-31T18:29:59.999Z']);
  assert.deepEqual(r('last_month', 'Asia/Kolkata'), ['2026-01-31T18:30:00.000Z', '2026-02-28T18:29:59.999Z']);
  assert.deepEqual(r('previous_month', 'Asia/Kolkata'), r('last_month', 'Asia/Kolkata'));
  assert.deepEqual(r('this_quarter', 'UTC'), ['2026-01-01T00:00:00.000Z', '2026-03-31T23:59:59.999Z']);
  assert.deepEqual(r('last_quarter', 'UTC'), ['2025-10-01T00:00:00.000Z', '2025-12-31T23:59:59.999Z']);
  assert.deepEqual(r('this_year', 'UTC'), ['2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z']);
  assert.deepEqual(r('last_year', 'America/New_York'), ['2025-01-01T05:00:00.000Z', '2026-01-01T04:59:59.999Z']);
  // Custom bounds: dates are whole days in the zone; offsets are absolute.
  const custom = resolveDateRange({ field: 'd', from: '2026-01-01', to: '2026-01-31' }, { timezone: 'Asia/Kolkata', now });
  assert.equal(custom.from.toISOString(), '2025-12-31T18:30:00.000Z');
  assert.equal(custom.to.toISOString(), '2026-01-31T18:29:59.999Z');
  const abs = resolveDateRange({ field: 'd', from: '2026-01-01T00:00:00Z' }, { timezone: 'Asia/Kolkata', now });
  assert.equal(abs.from.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(abs.to, null);
  const wall = resolveDateRange({ field: 'd', from: '2026-01-01T09:00' }, { timezone: 'Asia/Kolkata', now });
  assert.equal(wall.from.toISOString(), '2026-01-01T03:30:00.000Z');
});

test('the dashboard model preset list mirrors the engine contract', () => {
  assert.deepEqual([...DATE_RANGE_PRESETS], [...DATE_PRESETS]);
});
