/**
 * Analytics Engine.
 *
 * PURPOSE
 *   Turns an analytics query into a single MongoDB aggregation over the
 *   ingested `ConnectorRow` collection. Everything runs in the database - no
 *   row materialisation in Node - so even large connectors paginate cheaply.
 *   This module also OWNS THE QUERY CONTRACT: every consumer (the analytics
 *   endpoint and export, dashboard widgets and public embeds, reports,
 *   alerts and the external API) validates through `validateQuery` /
 *   `normalizeQuery` below, and nothing reaches the database without passing
 *   it.
 *
 * TENANCY
 *   `ConnectorRow` carries a tenantScope plugin (auto-filters `find`), but
 *   `aggregate()` bypasses query middleware. The engine therefore ALWAYS
 *   injects `tenantId` into the leading `$match`, and always excludes
 *   soft-deleted rows (`deletedAt: null`).
 *
 * ===========================================================================
 * QUERY CONTRACT (strict: anything not listed is rejected, never ignored)
 * ===========================================================================
 *
 *   {
 *     connectorIds?: string[]            // dataset ids (24-hex), max 50
 *     filters?:      Filter[]            // max 50
 *     filtersOp?:    'and' | 'or'        // how `filters` combine (default 'and')
 *     dateRange?:    DateRange
 *     metrics?:      Metric[]            // max 20
 *     groupBy?:      Array<GroupBy | string>   // max 5; a string is { field }
 *     orderBy?:      Array<Order | string>     // max 5; a string is { field, direction: 'asc' }
 *     pagination?:   { page?: int >= 1, limit?: int 1..200 }   // default 1 / 50
 *   }
 *
 *   Filter    { field, op, value }
 *     op: eq | neq            value: string | number | boolean | null
 *         in | nin            value: array (max 1000) of those scalars (a single scalar is wrapped)
 *         gt | gte | lt | lte value: number or numeric string; compared numerically
 *                             (non-numeric stored values never match)
 *         exists              value: true | false ('true' / 'false' accepted)
 *     Field `connectorId` takes dataset ids as values. `ingestedAt` and
 *     `tenantId` cannot be filtered (use `dateRange` / tenancy is implicit).
 *   Metric    { op, field?, alias? }  or  { ref, alias? }
 *     op: count | sum | avg | min | max | count_distinct; `field` is required
 *     except for count. count_distinct counts distinct non-null values.
 *     ref: 'metric:<key>' (the latest approved version of a tenant metric
 *     definition) or 'metric:<key>@<version>' (that approved version). The
 *     definition supplies the aggregation (or a numerator/denominator
 *     ratio), its dataset and its own filters, which apply to that metric
 *     only. Default alias: the metric key. See resolveMetricRefs below.
 *     With groupBy, metrics are computed per group; without groupBy they
 *     aggregate the whole filtered dataset into ONE row (a KPI). A query with
 *     neither returns raw rows.
 *     Default alias: `<op>_<field>` (`count` for a bare count). Aliases must be
 *     unique and must not repeat a groupBy field. A grouped query without
 *     metrics returns a `count` column, so it may not group on a field
 *     named `count`. Numeric metrics use
 *     `$convert` (onError/onNull: null), so blank or non-numeric values are
 *     skipped instead of failing the query.
 *   GroupBy   { field, bucket? }
 *     bucket: day | week | month | quarter | year. A bucketed field is read as
 *     a business date (see DateRange) and grouped by the start of its bucket
 *     in the workspace time zone, returned as 'YYYY-MM-DD' (weeks start on
 *     Monday). Group fields must be unique.
 *   Order     { field, direction?: 'asc' | 'desc' }   (`dir` is accepted as an alias)
 *     In a grouped or aggregate query, `field` must be a groupBy field or a
 *     metric alias.
 *   DateRange { field, preset?, from?, to? }
 *     field:  REQUIRED. The date column the window applies to: a key of the
 *             row data holding a date (BSON date, ISO-8601 string, or epoch
 *             milliseconds), or `ingestedAt` for ingestion time. Values are
 *             parsed with `$dateFromString` / `$convert` (onError/onNull:
 *             null); rows whose value cannot be read as a date (or lies
 *             outside years 1-9999) are outside every window and bucket
 *             as null. Strings without an offset are read in the
 *             workspace time zone.
 *     preset: one of DATE_PRESETS. Relative presets are resolved at
 *             execution time in the workspace time zone and must not carry
 *             from/to. `custom` (or no preset) needs `from` and/or `to`.
 *     from/to: 'YYYY-MM-DD' (a whole day in the workspace time zone; `to` is
 *             inclusive of that day) or ISO-8601 date-time (with an offset it
 *             is absolute, without one it is wall time in the workspace time
 *             zone). from <= to.
 *
 *   Names (fields, aliases): non-empty, at most 200 characters, no '$', '.'
 *   or control characters. Output names (group fields and metric aliases)
 *   may not be `_id` or start with `__` (reserved for engine internals, and
 *   `__proto__` would corrupt the result object); sort fields may not be
 *   `_id`. String filter values are at most 1000 characters.
 *
 * ERRORS
 *   400 INVALID_QUERY            - any rule above is broken. `errors` lists every
 *                                  problem as { field: 'filters[0].op', message }.
 *                                  Consumers prefix the path with where the query
 *                                  lives (e.g. 'query.', 'filters.').
 *   408 QUERY_TIMEOUT            - the aggregation exceeded ANALYTICS_QUERY_TIMEOUT_MS.
 *   429 QUERY_CONCURRENCY_LIMIT  - the workspace already has the maximum number of
 *                                  queries running and queued (analytics.limiter.js).
 *
 * EXECUTION
 *   queryRows(query & { tenantId, timezone?, now?, filterGroups? })
 *     -> { rows, total, page, pages, limit, columns, executedAt, groupMode,
 *          timezone, window }
 *   `timezone` defaults to the workspace setting `localization.timezone`
 *   (UTC when unset); `now` defaults to the injectable clock. `filterGroups`
 *   (internal, not accepted from clients) adds AND-ed groups of filters so a
 *   caller can narrow a stored query without changing its own filtersOp.
 *   `compare` (ai-catalogue; accepted from clients only where a consumer
 *   opts in with `extra: { compare: validateCompare }`) is
 *   { type: 'previous_period' | 'previous_year' }: the same query also runs
 *   over the comparison window and every metric gains `<alias>_previous`,
 *   `<alias>_change` and `<alias>_change_pct` columns (rows joined on the
 *   group fields). It needs a bounded dateRange and metrics or groupBy, and
 *   cannot be combined with a bucketed groupBy or a row stream.
 *   Every aggregation runs under `maxTimeMS` and the per-tenant concurrency
 *   limiter.
 *   Cached consumers call `prepareQuery` first (relative presets become an
 *   absolute window, the right input for a cache key), run the prepared
 *   options, and put the asked-for preset back on `window` with
 *   `withRequestedPreset`.
 *   rls: `prepareQuery` resolves the actor's data access scope
 *   (`dataAccess.service#resolveAccessScope`: dataset grants + row rules) and
 *   `buildAccessStages` ANDs it right after the tenant match, so no client
 *   filter, groupBy or stored query can widen it. The internal `access` key
 *   is honoured only when it is a scope made by that service (branded);
 *   anything else is ignored and the scope is resolved again.
 *   openRowStream(query & { tenantId, ... }) -> { groupMode, columns,
 *     timezone, window, rows: AsyncGenerator } streams the WHOLE result
 *   through one cursor (no pages; `pagination` is rejected) for report
 *   artefacts and analytics exports.
 */

import mongoose from 'mongoose';
import { ConnectorRow } from '../models/ConnectorRow.js';
import { Connector } from '../models/Connector.js';
import ApiError from '../utils/ApiError.js';
import env from '../config/env.js';
import clock from '../utils/clock.js';
import {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  normalizeTimeZone,
  zonedParts,
  zonedTimeToUtc,
  addCalendarDays,
  addCalendarMonths,
} from '../utils/timezone.js';
import { queryLimiter, QUERY_CONCURRENCY_LIMIT } from './analytics.limiter.js';
// observability: aggregation latency and timeouts (roadmap 2.8).
import { timeAnalyticsQuery } from '../utils/metrics.js';
import { getTimezone as getWorkspaceTimezone } from './tenantSettings.service.js';
// rls: dataset grants and row-level security, resolved from the actor.
import { resolveAccessScope, isAccessScope, assertQueryable } from './dataAccess.service.js';
// security: credential-like dataset columns are never queryable or returned.
import { isSensitiveFieldName, stripSensitiveFields } from '../utils/sensitiveFields.js';

const { ObjectId } = mongoose.Types;

/* ------------------------------- contract --------------------------------- */

export const QUERY_ERROR_CODES = Object.freeze({
  INVALID_QUERY: 'INVALID_QUERY',
  QUERY_TIMEOUT: 'QUERY_TIMEOUT',
  QUERY_CONCURRENCY_LIMIT,
  DATASET_NOT_READY: 'DATASET_NOT_READY',
});

export const FILTER_OPS = Object.freeze(['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'exists']);
// ai-catalogue: count_distinct (P5 derived metrics).
export const METRIC_OPS = Object.freeze(['count', 'sum', 'avg', 'min', 'max', 'count_distinct',
  // vizbuilder: rows with a value of a field.
  'count_non_null']);
export const DATE_BUCKETS = Object.freeze(['day', 'week', 'month', 'quarter', 'year']);
/** `previous_month` is the original name of `last_month` and stays accepted. */
export const DATE_PRESETS = Object.freeze([
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_month',
  'last_month',
  'previous_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'custom',
]);
/** Public query keys (what clients, widgets, reports and alerts may send). */
export const QUERY_KEYS = Object.freeze(['connectorIds', 'filters', 'filtersOp', 'dateRange', 'metrics', 'groupBy', 'orderBy', 'pagination']);
/** Keys of a filter envelope (dashboard defaults, report filters, run/view overrides). */
export const FILTER_ENVELOPE_KEYS = Object.freeze(['dateRange', 'filters', 'filtersOp']);
/** Engine-only execution options, never accepted from a client. */
const INTERNAL_KEYS = Object.freeze(['tenantId', 'timezone', 'now', 'filterGroups',
  // rls: resolved data access scope (branded; see dataAccess.service).
  'access',
  // ai-catalogue: `compare` is internal unless a consumer opts in (see header).
  'compare']);

export const LIMITS = Object.freeze({
  connectorIds: 50,
  filters: 50,
  filterGroups: 5,
  inValues: 1000,
  metrics: 20,
  groupBy: 5,
  orderBy: 5,
  nameLength: 200,
  valueLength: 1000,
  maxPage: 100000,
  maxLimit: 200,
});

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const FILTER_KEYS = new Set(['field', 'op', 'value']);
const METRIC_KEYS = new Set(['field', 'op', 'alias']);
// ai-catalogue: metric references and comparison windows.
const METRIC_REF_KEYS = new Set(['ref', 'alias']);
/** 'metric:<key>' or 'metric:<key>@<version>'. */
export const METRIC_REF_RE = /^metric:([a-z][a-z0-9_]{0,63})(?:@([1-9][0-9]{0,5}))?$/;
export const COMPARE_TYPES = Object.freeze(['previous_period', 'previous_year']);
const COMPARE_KEYS = new Set(['type']);
const GROUP_KEYS = new Set(['field', 'bucket']);
const ORDER_KEYS = new Set(['field', 'direction', 'dir']);
const DATE_RANGE_KEYS = new Set(['field', 'preset', 'from', 'to']);
const PAGINATION_KEYS = new Set(['page', 'limit']);
const RANGE_OPS = new Set(['gt', 'gte', 'lt', 'lte']);
/** Fields that live on the row document itself (vs inside `data`). */
const TOP_LEVEL_FIELDS = new Set(['connectorId', 'ingestedAt', 'sourceRowId', 'tenantId']);
const NOT_FILTERABLE = new Set(['ingestedAt', 'tenantId']);
const NOT_DATES = new Set(['connectorId', 'sourceRowId', 'tenantId']);
const RESERVED_OUTPUT_NAMES = new Set(['_id']);
/** Output names the engine reserves: `_id` and the internal `__` prefix. */
const isReservedOutputName = (name) => RESERVED_OUTPUT_NAMES.has(name) || (typeof name === 'string' && name.startsWith('__'));
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/;

function invalidQuery(errors, message = 'Invalid analytics query') {
  return new ApiError(400, message, { code: QUERY_ERROR_CODES.INVALID_QUERY, errors });
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/**
 * A field or alias name: user data keys (CSV headers, JSON keys) may contain
 * spaces and punctuation, but never `$` (operator / field-path syntax) or
 * `.` (nested-path traversal), and no control characters.
 */
export function isSafeName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= LIMITS.nameLength
    && !/[$.\u0000-\u001f]/.test(value);
}

const SENSITIVE_FIELD_MESSAGE = 'is a protected field (credential-like column) and cannot be queried';

/** True (and records an error) when a field name is on the sensitive denylist. */
function rejectSensitive(field, at, fail) {
  if (isSensitiveFieldName(field)) { fail(at, SENSITIVE_FIELD_MESSAGE); return true; }
  return false;
}

function isScalar(value) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= LIMITS.valueLength;
  return false;
}

/** Report keys of `obj` that are not in `allowed` as errors under `at`. */
function rejectUnknownKeys(obj, allowed, at, fail) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(at ? `${at}.${key}` : key, 'is not a recognised field');
  }
}

/** Parse a calendar date or date-time boundary; null when not valid ISO-8601. */
function parseBoundaryParts(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { instant: value };
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let m = DATE_ONLY_RE.exec(text);
  if (m) {
    const parts = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    return validCalendar(parts) ? { dateOnly: true, ...parts } : null;
  }
  m = DATE_TIME_RE.exec(text);
  if (!m) return null;
  const parts = {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0),
    millisecond: Number((m[7] ?? '0').padEnd(3, '0')),
  };
  if (!validCalendar(parts) || parts.hour > 23 || parts.minute > 59 || parts.second > 59) return null;
  if (m[8]) {
    const instant = new Date(text.replace(' ', 'T'));
    return Number.isNaN(instant.getTime()) ? null : { instant };
  }
  return { wallTime: true, ...parts };
}

function validCalendar({ year, month, day }) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/* ------------------------------ validation -------------------------------- */

function validateConnectorIds(value, at, fail) {
  if (!Array.isArray(value)) { fail(at, 'must be an array of dataset ids'); return []; }
  if (value.length > LIMITS.connectorIds) fail(at, `at most ${LIMITS.connectorIds} datasets`);
  value.forEach((id, i) => { if (typeof id !== 'string' || !OBJECT_ID_RE.test(id)) fail(`${at}[${i}]`, 'must be a dataset id'); });
  return value.map(String);
}

function validateFilters(value, at, fail) {
  if (!Array.isArray(value)) { fail(at, 'must be an array'); return []; }
  if (value.length > LIMITS.filters) fail(at, `at most ${LIMITS.filters} filters`);
  return value.map((f, i) => {
    const here = `${at}[${i}]`;
    if (!isPlainObject(f)) { fail(here, 'must be an object { field, op, value }'); return f; }
    rejectUnknownKeys(f, FILTER_KEYS, here, fail);
    const out = { field: f.field, op: f.op, value: f.value };
    if (!isSafeName(f.field)) fail(`${here}.field`, 'must be a field name without "$" or "."');
    else if (rejectSensitive(f.field, `${here}.field`, fail)) { /* denied */ }
    else if (NOT_FILTERABLE.has(f.field)) fail(`${here}.field`, f.field === 'ingestedAt' ? 'use dateRange to filter on ingestedAt' : 'is not filterable');
    if (!FILTER_OPS.includes(f.op)) { fail(`${here}.op`, `must be one of ${FILTER_OPS.join(', ')}`); return out; }
    if (f.op === 'in' || f.op === 'nin') {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      if (values.length > LIMITS.inValues) fail(`${here}.value`, `at most ${LIMITS.inValues} values`);
      if (!values.every(isScalar)) fail(`${here}.value`, 'values must be strings, numbers, booleans or null');
      else if (f.field === 'connectorId' && !values.every((v) => typeof v === 'string' && OBJECT_ID_RE.test(v))) fail(`${here}.value`, 'values must be dataset ids');
      out.value = values;
    } else if (RANGE_OPS.has(f.op)) {
      const numeric = typeof f.value === 'number' || (typeof f.value === 'string' && f.value.trim() !== '');
      const n = numeric ? Number(f.value) : NaN;
      if (!Number.isFinite(n)) fail(`${here}.value`, 'must be a number (use dateRange to filter dates)');
      else out.value = n;
    } else if (f.op === 'exists') {
      const v = f.value === 'true' ? true : f.value === 'false' ? false : f.value;
      if (typeof v !== 'boolean') fail(`${here}.value`, 'must be true or false');
      out.value = v;
    } else if (!isScalar(f.value)) {
      fail(`${here}.value`, `must be a string (max ${LIMITS.valueLength} characters), number, boolean or null`);
    } else if (f.field === 'connectorId' && !(typeof f.value === 'string' && OBJECT_ID_RE.test(f.value))) {
      fail(`${here}.value`, 'must be a dataset id');
    }
    return out;
  });
}

function validateFiltersOp(value, at, fail) {
  if (!['and', 'or'].includes(value)) fail(at, 'must be "and" or "or"');
  return value;
}

function validateDateRange(value, at, fail) {
  if (!isPlainObject(value)) { fail(at, 'must be an object { field, preset?, from?, to? }'); return value; }
  rejectUnknownKeys(value, DATE_RANGE_KEYS, at, fail);
  const out = {};
  if (value.field === undefined || value.field === null || value.field === '') {
    fail(`${at}.field`, 'is required: name the date column to filter on (use "ingestedAt" for ingestion time)');
  } else if (!isSafeName(value.field)) {
    fail(`${at}.field`, 'must be a field name without "$" or "."');
  } else if (NOT_DATES.has(value.field)) {
    fail(`${at}.field`, 'must be a date column');
  } else {
    out.field = value.field;
  }
  const hasFrom = value.from !== undefined && value.from !== null && value.from !== '';
  const hasTo = value.to !== undefined && value.to !== null && value.to !== '';
  if (value.preset !== undefined && value.preset !== null) {
    if (!DATE_PRESETS.includes(value.preset)) {
      fail(`${at}.preset`, `must be one of ${DATE_PRESETS.join(', ')}`);
      return out;
    }
    out.preset = value.preset;
  }
  const relative = out.preset && out.preset !== 'custom';
  if (relative) {
    if (hasFrom) fail(`${at}.from`, `is not allowed with the relative preset "${out.preset}"`);
    if (hasTo) fail(`${at}.to`, `is not allowed with the relative preset "${out.preset}"`);
    return out;
  }
  if (!hasFrom && !hasTo) {
    fail(at, out.preset === 'custom' ? 'a custom range needs from and/or to' : 'needs a preset or from/to');
    return out;
  }
  const parsed = {};
  for (const key of ['from', 'to']) {
    if (!(key === 'from' ? hasFrom : hasTo)) continue;
    const parts = parseBoundaryParts(value[key]);
    if (!parts) fail(`${at}.${key}`, 'must be an ISO-8601 date (YYYY-MM-DD) or date-time');
    else {
      parsed[key] = parts;
      out[key] = value[key] instanceof Date ? value[key].toISOString() : String(value[key]).trim();
    }
  }
  // Ends of the same kind can be ordered without knowing the time zone;
  // mixed kinds are checked after resolution (prepareQuery).
  const kind = (p) => (p.instant ? 'instant' : p.dateOnly ? 'date' : 'wall');
  if (parsed.from && parsed.to && kind(parsed.from) === kind(parsed.to)) {
    const from = boundaryInstant(parsed.from, DEFAULT_TIMEZONE, false);
    const to = boundaryInstant(parsed.to, DEFAULT_TIMEZONE, true);
    if (from.getTime() > to.getTime()) fail(at, 'from must be on or before to');
  }
  return out;
}

/** Output name of a metric: its alias, else `<op>_<field>` (`count` for a bare count). */
export function metricAlias(metric) {
  if (metric.alias !== undefined && metric.alias !== null && metric.alias !== '') return metric.alias;
  // ai-catalogue: a metric reference is named after its key.
  if (typeof metric.ref === 'string') {
    const m = METRIC_REF_RE.exec(metric.ref);
    return m ? m[1] : metric.ref;
  }
  return metric.field === undefined || metric.field === null || metric.field === '' ? metric.op : `${metric.op}_${metric.field}`;
}

function validateMetrics(value, at, fail) {
  if (!Array.isArray(value)) { fail(at, 'must be an array'); return []; }
  if (value.length > LIMITS.metrics) fail(at, `at most ${LIMITS.metrics} metrics`);
  const seen = new Map();
  return value.map((m, i) => {
    const here = `${at}[${i}]`;
    if (!isPlainObject(m)) { fail(here, 'must be an object { op, field?, alias? }'); return m; }
    // ai-catalogue: { ref: 'metric:<key>[@<version>]', alias? } names a metric definition.
    if (m.ref !== undefined) {
      rejectUnknownKeys(m, METRIC_REF_KEYS, here, fail);
      const ref = { ref: m.ref };
      if (typeof m.ref !== 'string' || !METRIC_REF_RE.test(m.ref)) fail(`${here}.ref`, 'must be "metric:<key>" or "metric:<key>@<version>"');
      if (m.alias !== undefined && m.alias !== null && m.alias !== '') {
        if (!isSafeName(m.alias)) fail(`${here}.alias`, 'must be a name without "$" or "."');
        else ref.alias = m.alias;
      }
      const refAlias = metricAlias(ref);
      if (isReservedOutputName(refAlias)) fail(`${here}.alias`, `"${refAlias}" is reserved (names starting with "__" are used internally)`);
      if (seen.has(refAlias)) fail(`${here}.alias`, `duplicates the name of metrics[${seen.get(refAlias)}] ("${refAlias}")`);
      else seen.set(refAlias, i);
      return ref;
    }
    rejectUnknownKeys(m, METRIC_KEYS, here, fail);
    const out = { op: m.op };
    if (!METRIC_OPS.includes(m.op)) fail(`${here}.op`, `must be one of ${METRIC_OPS.join(', ')}`);
    const hasField = m.field !== undefined && m.field !== null && m.field !== '';
    if (hasField) {
      if (!isSafeName(m.field)) fail(`${here}.field`, 'must be a field name without "$" or "."');
      else if (!rejectSensitive(m.field, `${here}.field`, fail)) out.field = m.field;
    } else if (m.op !== 'count' && METRIC_OPS.includes(m.op)) {
      fail(`${here}.field`, `is required for ${m.op}`);
    }
    if (m.alias !== undefined && m.alias !== null && m.alias !== '') {
      if (!isSafeName(m.alias)) fail(`${here}.alias`, 'must be a name without "$" or "."');
      else out.alias = m.alias;
    }
    const alias = metricAlias(out);
    if (isReservedOutputName(alias)) fail(`${here}.alias`, `"${alias}" is reserved (names starting with "__" are used internally)`);
    if (seen.has(alias)) fail(`${here}.alias`, `duplicates the name of metrics[${seen.get(alias)}] ("${alias}")`);
    else seen.set(alias, i);
    return out;
  });
}

function validateGroupBy(value, at, fail) {
  if (!Array.isArray(value)) { fail(at, 'must be an array'); return []; }
  if (value.length > LIMITS.groupBy) fail(at, `at most ${LIMITS.groupBy} fields`);
  const seen = new Set();
  return value.map((g, i) => {
    const here = `${at}[${i}]`;
    const item = typeof g === 'string' ? { field: g } : g;
    if (!isPlainObject(item)) { fail(here, 'must be a field name or an object { field, bucket? }'); return item; }
    rejectUnknownKeys(item, GROUP_KEYS, here, fail);
    const out = { field: item.field };
    if (!isSafeName(item.field)) fail(typeof g === 'string' ? here : `${here}.field`, 'must be a field name without "$" or "."');
    else if (isReservedOutputName(item.field)) fail(`${here}.field`, `"${item.field}" is reserved (names starting with "__" are used internally)`);
    else if (rejectSensitive(item.field, `${here}.field`, fail)) { /* denied */ }
    else if (seen.has(item.field)) fail(`${here}.field`, 'is already grouped on');
    else seen.add(item.field);
    if (item.bucket !== undefined && item.bucket !== null) {
      if (!DATE_BUCKETS.includes(item.bucket)) fail(`${here}.bucket`, `must be one of ${DATE_BUCKETS.join(', ')}`);
      else if (NOT_DATES.has(item.field)) fail(`${here}.bucket`, 'can only bucket a date column');
      else out.bucket = item.bucket;
    }
    return out;
  });
}

function validateOrderBy(value, at, fail) {
  if (!Array.isArray(value)) { fail(at, 'must be an array'); return []; }
  if (value.length > LIMITS.orderBy) fail(at, `at most ${LIMITS.orderBy} fields`);
  return value.map((o, i) => {
    const here = `${at}[${i}]`;
    const item = typeof o === 'string' ? { field: o } : o;
    if (!isPlainObject(item)) { fail(here, 'must be a field name or an object { field, direction? }'); return item; }
    rejectUnknownKeys(item, ORDER_KEYS, here, fail);
    if (!isSafeName(item.field)) fail(`${here}.field`, 'must be a field name without "$" or "."');
    else if (RESERVED_OUTPUT_NAMES.has(item.field)) fail(`${here}.field`, `"${item.field}" is reserved`);
    else rejectSensitive(item.field, `${here}.field`, fail);
    if (item.direction !== undefined && item.dir !== undefined && item.direction !== item.dir) {
      fail(`${here}.dir`, 'conflicts with direction');
    }
    const direction = item.direction ?? item.dir ?? 'asc';
    if (!['asc', 'desc'].includes(direction)) fail(`${here}.${item.direction !== undefined ? 'direction' : 'dir'}`, 'must be "asc" or "desc"');
    return { field: item.field, direction };
  });
}

function validatePagination(value, at, fail) {
  if (!isPlainObject(value)) { fail(at, 'must be an object { page?, limit? }'); return {}; }
  rejectUnknownKeys(value, PAGINATION_KEYS, at, fail);
  const out = {};
  const intOf = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : NaN);
  if (value.page !== undefined && value.page !== null) {
    const n = intOf(value.page);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxPage) fail(`${at}.page`, `must be a whole number from 1 to ${LIMITS.maxPage}`);
    else out.page = n;
  }
  if (value.limit !== undefined && value.limit !== null) {
    const n = intOf(value.limit);
    if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxLimit) fail(`${at}.limit`, `must be a whole number from 1 to ${LIMITS.maxLimit}`);
    else out.limit = n;
  }
  return out;
}

/**
 * ai-catalogue: `compare` { type: 'previous_period' | 'previous_year' }.
 * Exported so a consumer can accept it from clients through
 * `validateQuery(input, { extra: { compare: validateCompare } })`.
 */
export function validateCompare(value, at, fail) {
  if (!isPlainObject(value)) { fail(at, 'must be an object { type }'); return value; }
  rejectUnknownKeys(value, COMPARE_KEYS, at, fail);
  if (!COMPARE_TYPES.includes(value.type)) fail(`${at}.type`, `must be one of ${COMPARE_TYPES.join(', ')}`);
  return { type: value.type };
}

const VALIDATORS = Object.freeze({
  connectorIds: validateConnectorIds,
  filters: validateFilters,
  filtersOp: validateFiltersOp,
  dateRange: validateDateRange,
  metrics: validateMetrics,
  groupBy: validateGroupBy,
  orderBy: validateOrderBy,
  pagination: validatePagination,
});

/** Cross-field rules that need the whole query (grouped ordering, name clashes). */
function validateCombination(out, prefix, fail) {
  const groupBy = Array.isArray(out.groupBy) ? out.groupBy.filter(isPlainObject) : [];
  const metrics = Array.isArray(out.metrics) ? out.metrics.filter(isPlainObject) : [];
  if (!groupBy.length && !metrics.length) return;
  const groupFields = new Set(groupBy.map((g) => g.field));
  const aliases = metrics.length ? metrics.map(metricAlias) : ['count'];
  metrics.forEach((m, i) => {
    if (groupFields.has(metricAlias(m))) fail(`${prefix}metrics[${i}].alias`, `"${metricAlias(m)}" is also a groupBy field`);
  });
  // Without metrics the engine adds a `count` column, which would overwrite
  // a group field of the same name in every row.
  if (!metrics.length) {
    (Array.isArray(out.groupBy) ? out.groupBy : []).forEach((g, i) => {
      if (isPlainObject(g) && g.field === 'count') {
        fail(`${prefix}groupBy[${i}].field`, '"count" clashes with the default count column: add a metric with another alias');
      }
    });
  }
  const outputs = new Set([...groupFields, ...aliases]);
  (Array.isArray(out.orderBy) ? out.orderBy : []).forEach((o, i) => {
    if (isPlainObject(o) && isSafeName(o.field) && !outputs.has(o.field)) {
      fail(`${prefix}orderBy[${i}].field`, `must be a groupBy field or metric alias in a grouped or aggregate query (${[...outputs].join(', ')})`);
    }
  });
}

/**
 * Validate and normalise a query (or a fragment of one) against the strict
 * contract. Relative presets are KEPT as presets; resolve them at execution.
 *
 * @param {object} input
 * @param {object} [opts]
 * @param {string[]} [opts.keys=QUERY_KEYS] - query keys allowed here.
 * @param {string} [opts.prefix=''] - path prefix for error fields (e.g. 'query.').
 * @param {Object<string, Function>} [opts.extra] - extra keys: (value, at, fail) => normalised.
 * @returns {object} normalised copy containing only the keys that were given.
 * @throws {ApiError} 400 INVALID_QUERY with field-level `errors`.
 */
export function validateQuery(input, { keys = QUERY_KEYS, prefix = '', extra = {} } = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const out = collect(input, { keys, prefix, extra, fail });
  if (errors.length) throw invalidQuery(errors);
  return out;
}

function collect(input, { keys, prefix, extra, fail }) {
  const root = prefix.endsWith('.') ? prefix.slice(0, -1) : prefix;
  if (!isPlainObject(input)) {
    fail(root || 'query', 'must be an object');
    return {};
  }
  const allowed = new Set([...keys, ...Object.keys(extra)]);
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) { fail(`${prefix}${key}`, 'is not a recognised query field'); continue; }
    if (value === undefined || value === null) continue;
    const at = `${prefix}${key}`;
    if (extra[key]) out[key] = extra[key](value, at, fail);
    else out[key] = VALIDATORS[key](value, at, fail);
  }
  validateCombination(out, prefix, fail);
  return out;
}

/**
 * Validate the full engine options: the public query plus the internal
 * execution keys (`tenantId`, `timezone`, `now`, `filterGroups`).
 * Accepts the UI shorthand (`groupBy: ['region']`, `orderBy[].dir`).
 *
 * @returns {object} normalised options with defaults applied.
 * @throws {ApiError} 400 INVALID_QUERY.
 */
export function normalizeQuery(options = {}) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  if (!isPlainObject(options)) throw invalidQuery([{ field: 'query', message: 'must be an object' }]);
  const publicPart = {};
  const internal = {};
  for (const [key, value] of Object.entries(options)) {
    if (INTERNAL_KEYS.includes(key)) internal[key] = value;
    else publicPart[key] = value;
  }
  const out = collect(publicPart, { keys: QUERY_KEYS, prefix: '', extra: {}, fail });

  if (typeof internal.tenantId !== 'string' || !internal.tenantId) {
    throw new ApiError(400, 'tenantId is required', { code: QUERY_ERROR_CODES.INVALID_QUERY });
  }
  if (internal.timezone !== undefined && internal.timezone !== null && !isValidTimeZone(internal.timezone)) {
    fail('timezone', 'must be an IANA time zone name');
  }
  if (internal.now !== undefined && !(internal.now instanceof Date && !Number.isNaN(internal.now.getTime()))) {
    fail('now', 'must be a Date');
  }
  const filterGroups = [];
  if (internal.filterGroups !== undefined && internal.filterGroups !== null) {
    if (!Array.isArray(internal.filterGroups)) fail('filterGroups', 'must be an array');
    else {
      if (internal.filterGroups.length > LIMITS.filterGroups) fail('filterGroups', `at most ${LIMITS.filterGroups} groups`);
      internal.filterGroups.forEach((group, i) => {
        const at = `filterGroups[${i}]`;
        if (!isPlainObject(group)) { fail(at, 'must be an object { filters, filtersOp? }'); return; }
        rejectUnknownKeys(group, new Set(['filters', 'filtersOp']), at, fail);
        filterGroups.push({
          filters: validateFilters(group.filters ?? [], `${at}.filters`, fail),
          filtersOp: group.filtersOp === undefined ? 'and' : validateFiltersOp(group.filtersOp, `${at}.filtersOp`, fail),
        });
      });
    }
  }
  // ai-catalogue: period-over-period comparison (validated, kept only when asked for).
  const compare = internal.compare === undefined || internal.compare === null
    ? null
    : validateCompare(internal.compare, 'compare', fail);
  if (errors.length) throw invalidQuery(errors);

  return {
    ...(compare ? { compare } : {}),
    tenantId: internal.tenantId,
    timezone: internal.timezone ? normalizeTimeZone(internal.timezone) : undefined,
    now: internal.now,
    filterGroups,
    // rls: only a scope made by dataAccess.service survives normalisation.
    access: isAccessScope(internal.access) ? internal.access : undefined,
    connectorIds: out.connectorIds ?? [],
    filters: out.filters ?? [],
    filtersOp: out.filtersOp ?? 'and',
    dateRange: out.dateRange ?? null,
    metrics: out.metrics ?? [],
    groupBy: out.groupBy ?? [],
    orderBy: out.orderBy ?? [],
    pagination: out.pagination ?? {},
  };
}

/* ------------------------------- business time ---------------------------- */

function boundaryInstant(parts, timeZone, isEnd) {
  if (parts.instant) return parts.instant;
  if (parts.dateOnly) {
    if (!isEnd) return zonedTimeToUtc(parts, timeZone);
    const next = addCalendarDays(parts, 1);
    return new Date(zonedTimeToUtc(next, timeZone).getTime() - 1);
  }
  return zonedTimeToUtc(parts, timeZone);
}

/**
 * Resolve a validated dateRange into an inclusive UTC window.
 * Relative presets are computed from `now` in `timeZone`; `to` is the last
 * millisecond of the period.
 *
 * @returns {{ field: string, preset: string|null, from: Date|null, to: Date|null }}
 */
export function resolveDateRange(dateRange, { timezone = DEFAULT_TIMEZONE, now = clock.now() } = {}) {
  const tz = normalizeTimeZone(timezone);
  const { field, preset = null } = dateRange;
  const today = zonedParts(now, tz);
  const day = { year: today.year, month: today.month, day: today.day };
  const start = (date) => zonedTimeToUtc({ year: date.year, month: date.month, day: date.day }, tz);
  const window = (fromDate, toExclusiveDate) => ({
    field,
    preset,
    from: start(fromDate),
    to: new Date(start(toExclusiveDate).getTime() - 1),
  });
  const monthStart = { year: day.year, month: day.month, day: 1 };
  const quarterStart = { year: day.year, month: day.month - ((day.month - 1) % 3), day: 1 };
  const yearStart = { year: day.year, month: 1, day: 1 };
  switch (preset) {
    case 'today': return window(day, addCalendarDays(day, 1));
    case 'yesterday': return window(addCalendarDays(day, -1), day);
    case 'last_7_days': return window(addCalendarDays(day, -6), addCalendarDays(day, 1));
    case 'last_30_days': return window(addCalendarDays(day, -29), addCalendarDays(day, 1));
    case 'this_month': return window(monthStart, addCalendarMonths(monthStart, 1));
    case 'last_month':
    case 'previous_month': return window(addCalendarMonths(monthStart, -1), monthStart);
    case 'this_quarter': return window(quarterStart, addCalendarMonths(quarterStart, 3));
    case 'last_quarter': return window(addCalendarMonths(quarterStart, -3), quarterStart);
    case 'this_year': return window(yearStart, { year: day.year + 1, month: 1, day: 1 });
    case 'last_year': return window({ year: day.year - 1, month: 1, day: 1 }, yearStart);
    default: {
      const fromParts = dateRange.from !== undefined && dateRange.from !== null ? parseBoundaryParts(dateRange.from) : null;
      const toParts = dateRange.to !== undefined && dateRange.to !== null ? parseBoundaryParts(dateRange.to) : null;
      return {
        field,
        preset,
        from: fromParts ? boundaryInstant(fromParts, tz, false) : null,
        to: toParts ? boundaryInstant(toParts, tz, true) : null,
      };
    }
  }
}

/**
 * Validate, then resolve everything that depends on WHEN and WHERE the
 * query runs (workspace time zone, relative presets). The returned
 * `options` are execution-ready: the window is absolute, so they are also
 * the right input for a cache key, and passing them to `queryRows` again
 * yields the same window.
 *
 * @returns {Promise<{ options: object, window: object|null, timezone: string }>}
 */
export async function prepareQuery(rawOptions = {}) {
  const normalized = normalizeQuery(rawOptions);
  // ai-catalogue: metric references resolve (and pin) before anything else.
  const { metrics, connectorIds, metricDefs } = await resolveMetricRefs(normalized);
  normalized.metrics = metrics;
  normalized.connectorIds = connectorIds;
  const timezone = normalized.timezone ?? await getWorkspaceTimezone(normalized.tenantId);
  const window = normalized.dateRange
    ? resolveDateRange(normalized.dateRange, { timezone, now: normalized.now ?? clock.now() })
    : null;
  if (window?.from && window?.to && window.from.getTime() > window.to.getTime()) {
    throw invalidQuery([{ field: 'dateRange', message: 'from must be on or before to' }]);
  }
  // rls: the actor's dataset grants and row rules (never from request input).
  const access = normalized.access ?? await resolveAccessScope({ tenantId: normalized.tenantId });
  assertQueryable(access, normalized.connectorIds);
  await assertDatasetsReady(normalized.tenantId, normalized.connectorIds);
  const options = {
    ...normalized,
    access,
    timezone,
    dateRange: window
      ? {
        field: window.field,
        ...(window.from ? { from: window.from.toISOString() } : {}),
        ...(window.to ? { to: window.to.toISOString() } : {}),
      }
      : null,
  };
  delete options.now;
  return { options, window, timezone, metricDefs };
}

/**
 * A dataset whose FIRST import is still queued / running, or failed, has no
 * data yet: refuse with 409 DATASET_NOT_READY instead of an empty result
 * that reads like "no rows matched". A dataset that already holds data
 * (lastSyncedAt set) stays queryable while it re-syncs.
 */
async function assertDatasetsReady(tenantId, connectorIds) {
  if (!tenantId || !connectorIds?.length) return;
  const pending = await Connector.find({
    tenantId: String(tenantId),
    _id: { $in: connectorIds },
    lastSyncedAt: null,
    syncStatus: { $in: ['queued', 'running', 'failed'] },
  }).select('name syncStatus').lean();
  if (!pending.length) return;
  const first = pending[0];
  const message = first.syncStatus === 'failed'
    ? `"${first.name}" has no data because its import failed. Open the dataset to see why, then upload the file or sync again.`
    : `"${first.name}" is still importing. Run the query again when the import has finished.`;
  throw new ApiError(409, message, {
    code: QUERY_ERROR_CODES.DATASET_NOT_READY,
    errors: pending.map((c) => ({
      field: 'connectorIds',
      message: `${c.name}: ${c.syncStatus === 'failed' ? 'import failed' : 'import in progress'}`,
      connectorId: String(c._id),
    })),
  });
}

/* ------------------------- metric references (ai-catalogue) --------------- */

/**
 * Resolve the `{ ref }` metrics of a normalised query through the metric
 * definitions contract (`metricDefinition.service.resolveMetricRef`, only
 * approved versions). Each reference is PINNED to the version it resolved
 * to ('metric:<key>@<version>'), so a prepared query, its cache key and its
 * attribution name exact definitions, and running the prepared query again
 * reads the same version.
 *
 * A metric reads its own dataset: a query without connectorIds is narrowed
 * to the referenced datasets; a query with connectorIds must include them.
 * The definition's dataset and filters are applied to that metric only
 * (conditional aggregation), so tenancy still comes from the base `$match`.
 *
 * @returns {Promise<{ metrics: object[], connectorIds: string[], metricDefs: Map<string, object>|null }>}
 * @throws {ApiError} 400 INVALID_QUERY for an unknown, unapproved or foreign metric.
 */
async function resolveMetricRefs({ tenantId, metrics, connectorIds }) {
  if (!metrics.some((m) => typeof m.ref === 'string')) return { metrics, connectorIds, metricDefs: null };
  const { resolveMetricRef } = await import('./metricDefinition.service.js');
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const metricDefs = new Map();
  const datasets = new Set();
  const resolved = [];
  for (const [i, m] of metrics.entries()) {
    if (typeof m.ref !== 'string') { resolved.push(m); continue; }
    const def = await resolveMetricRef({ tenantId, ref: m.ref });
    if (!def) {
      fail(`metrics[${i}].ref`, `"${m.ref}" is not an approved metric of this workspace`);
      resolved.push(m);
      continue;
    }
    const at = `metrics[${i}].ref`;
    const datasetId = String(def.connectorId ?? '');
    if (!OBJECT_ID_RE.test(datasetId)) fail(at, `metric "${def.key}" has no dataset`);
    else if (connectorIds.length && !connectorIds.includes(datasetId)) {
      fail(at, `metric "${def.key}" reads dataset ${datasetId}, which this query does not include`);
    }
    // Stored definitions were validated on save; hold them to the contract again.
    const parts = def.aggregation === 'ratio' ? [def.numerator, def.denominator] : [def];
    for (const part of parts) {
      if (!part || !METRIC_OPS.includes(part.aggregation)) { fail(at, `metric "${def.key}" has an invalid aggregation`); continue; }
      if (part.aggregation !== 'count' && !isSafeName(part.field)) fail(at, `metric "${def.key}" has an invalid field`);
      validateFilters(part.filters ?? [], `${at}.filters`, fail);
    }
    validateFilters(def.filters ?? [], `${at}.filters`, fail);
    const pinned = `metric:${def.key}@${def.version}`;
    metricDefs.set(pinned, { ...def, connectorId: datasetId });
    datasets.add(datasetId);
    resolved.push({ ref: pinned, ...(m.alias ? { alias: m.alias } : {}) });
  }
  if (errors.length) throw invalidQuery(errors);
  return {
    metrics: resolved,
    connectorIds: connectorIds.length ? connectorIds : [...datasets].sort(),
    metricDefs,
  };
}

/** `{ $and: [...] }` of the dataset match and filters that scope one metric definition. */
function metricCondition(connectorId, ...filterLists) {
  const conds = [{ $eq: ['$connectorId', new ObjectId(connectorId)] }];
  for (const list of filterLists) for (const f of list ?? []) conds.push(filterExpr(f));
  return { $and: conds };
}

/** A conditional accumulator for one aggregation of a metric definition. */
function conditionalAccumulator({ aggregation, field }, cond) {
  if (aggregation === 'count') return { $sum: { $cond: [cond, 1, 0] } };
  const path = dataPath(field);
  if (aggregation === 'count_distinct') {
    return { $addToSet: { $cond: [{ $and: [cond, { $ne: [{ $ifNull: [path, null] }, null] }] }, path, '$$REMOVE'] } };
  }
  return { [`$${aggregation}`]: { $cond: [cond, toNumber(path), null] } };
}

/**
 * Accumulators and output expression of one metric (plain or referenced).
 * `slot` names internal accumulators (`__m<i>...`) for outputs that need a
 * second step (distinct counts, ratios).
 *
 * @returns {{ accumulators: object, output: object|1 }}
 */
function metricStages(metric, slot, metricDefs) {
  const def = typeof metric.ref === 'string' ? metricDefs?.get(metric.ref) : null;
  if (typeof metric.ref === 'string' && !def) {
    throw invalidQuery([{ field: 'metrics', message: `metric "${metric.ref}" was not resolved` }]);
  }
  if (def && def.aggregation === 'ratio') {
    const n = `${slot}n`;
    const d = `${slot}d`;
    const numerator = def.numerator;
    const denominator = def.denominator;
    const numAcc = conditionalAccumulator(numerator, metricCondition(def.connectorId, def.filters, numerator.filters));
    const denAcc = conditionalAccumulator(denominator, metricCondition(def.connectorId, def.filters, denominator.filters));
    const sized = (agg, name) => (agg === 'count_distinct' ? { $size: `$${name}` } : `$${name}`);
    return {
      accumulators: { [n]: numAcc, [d]: denAcc },
      output: {
        $let: {
          vars: { n: sized(numerator.aggregation, n), d: sized(denominator.aggregation, d) },
          in: { $cond: [{ $or: [{ $eq: ['$$d', null] }, { $eq: ['$$d', 0] }] }, null, { $divide: ['$$n', '$$d'] }] },
        },
      },
    };
  }
  if (def) {
    const acc = conditionalAccumulator(def, metricCondition(def.connectorId, def.filters));
    return def.aggregation === 'count_distinct'
      ? { accumulators: { [slot]: acc }, output: { $size: `$${slot}` } }
      : { accumulators: { [slot]: acc }, output: `$${slot}` };
  }
  if (metric.op === 'count_distinct') {
    const path = dataPath(metric.field);
    const acc = { $addToSet: { $cond: [{ $ne: [{ $ifNull: [path, null] }, null] }, path, '$$REMOVE'] } };
    return { accumulators: { [slot]: acc }, output: { $size: `$${slot}` } };
  }
  return { accumulators: null, output: 1 };
}

/* ----------------------- period comparison (ai-catalogue) ------------------ */

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `instant` moved by `months` calendar months in `tz` (day clamped to the month). */
function shiftMonths(instant, months, tz) {
  const p = zonedParts(instant, tz);
  const target = addCalendarMonths({ year: p.year, month: p.month }, months);
  return zonedTimeToUtc({
    year: target.year,
    month: target.month,
    day: Math.min(p.day, daysInMonth(target.year, target.month)),
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    millisecond: instant.getUTCMilliseconds(),
  }, tz);
}

/** Months between two month starts in `tz`, or null when either is not 00:00 on the 1st. */
function wholeMonths(from, toExclusive, tz) {
  const a = zonedParts(from, tz);
  const b = zonedParts(toExclusive, tz);
  const aligned = (p) => p.day === 1 && p.hour === 0 && p.minute === 0 && p.second === 0;
  if (!aligned(a) || !aligned(b) || from.getUTCMilliseconds() !== 0 || toExclusive.getUTCMilliseconds() !== 0) return null;
  const n = (b.year - a.year) * 12 + (b.month - a.month);
  return n > 0 ? n : null;
}

/**
 * The comparison window of an absolute window. `previous_year` is the same
 * calendar window a year earlier. `previous_period` is the window of the
 * same length just before it; a window of whole calendar months moves by
 * that many months (so September is compared with August, not with the
 * 30 days before it).
 */
export function comparisonWindow({ field, from, to }, type, timezone = DEFAULT_TIMEZONE) {
  const tz = normalizeTimeZone(timezone);
  const end = new Date(to.getTime() + 1);
  if (type === 'previous_year') {
    return { field, preset: null, from: shiftMonths(from, -12, tz), to: new Date(shiftMonths(end, -12, tz).getTime() - 1) };
  }
  const months = wholeMonths(from, end, tz);
  if (months) {
    return { field, preset: null, from: shiftMonths(from, -months, tz), to: new Date(from.getTime() - 1) };
  }
  const length = end.getTime() - from.getTime();
  return { field, preset: null, from: new Date(from.getTime() - length), to: new Date(from.getTime() - 1) };
}

const COMPARE_SUFFIXES = Object.freeze(['_previous', '_change', '_change_pct']);

/** Run a prepared query and its comparison window, joining rows on the group fields. */
async function runCompared(options, window, timezone, metricDefs) {
  const { compare, ...base } = options;
  const errors = [];
  if (!window?.from || !window?.to) errors.push({ field: 'compare', message: 'needs a dateRange with a start and an end' });
  if (base.groupBy.some((g) => g.bucket)) errors.push({ field: 'compare', message: 'cannot be combined with a bucketed groupBy (compare totals or categories)' });
  if (!base.groupBy.length && !base.metrics.length) errors.push({ field: 'compare', message: 'needs metrics or groupBy' });
  const fields = base.groupBy.map((g) => g.field);
  const aliases = base.metrics.length ? base.metrics.map(metricAlias) : ['count'];
  const taken = new Set([...fields, ...aliases]);
  for (const alias of aliases) {
    for (const suffix of COMPARE_SUFFIXES) {
      if (taken.has(`${alias}${suffix}`)) errors.push({ field: 'compare', message: `the comparison column "${alias}${suffix}" clashes with an output of the query` });
    }
  }
  if (errors.length) throw invalidQuery(errors);

  const current = await runPrepared(base, window, timezone, metricDefs);
  const previousWindow = comparisonWindow(window, compare.type, timezone);
  const previousOptions = {
    ...base,
    dateRange: { field: window.field, from: previousWindow.from.toISOString(), to: previousWindow.to.toISOString() },
  };
  if (fields.length) {
    // Only the groups on this page, read in one page of the engine maximum.
    previousOptions.pagination = { page: 1, limit: LIMITS.maxLimit };
    const narrowing = fields.map((field) => ({ field, op: 'in', value: [...new Set(current.rows.map((r) => r[field]))] }));
    const narrowable = narrowing.every((f) => f.value.length > 0 && f.value.length <= LIMITS.inValues
      && f.value.every((v) => v !== null && v !== undefined && isScalar(v)));
    if (narrowable && base.filterGroups.length < LIMITS.filterGroups) {
      previousOptions.filterGroups = [...base.filterGroups, { filters: narrowing, filtersOp: 'and' }];
    }
  }
  const previous = await runPrepared(previousOptions, previousWindow, timezone, metricDefs);
  const keyOf = (row) => JSON.stringify(fields.map((f) => row[f] ?? null));
  const before = new Map(previous.rows.map((row) => [keyOf(row), row]));
  const rows = current.rows.map((row) => {
    const prior = before.get(keyOf(row)) ?? null;
    const out = { ...row };
    for (const alias of aliases) {
      const now = typeof row[alias] === 'number' ? row[alias] : null;
      const then = prior && typeof prior[alias] === 'number' ? prior[alias] : null;
      const change = now !== null && then !== null ? now - then : null;
      out[`${alias}_previous`] = then;
      out[`${alias}_change`] = change;
      out[`${alias}_change_pct`] = change !== null && then !== 0 ? change / Math.abs(then) : null;
    }
    return out;
  });
  const columns = [...current.columns, ...aliases.flatMap((a) => COMPARE_SUFFIXES.map((s) => `${a}${s}`))];
  return { ...current, rows, columns, compare: { type: compare.type, window: windowView(previousWindow) } };
}

/**
 * A result whose `window` names the preset that was asked for. Callers run
 * the PREPARED query (absolute window) so cache keys stay exact; this puts
 * the original preset back on the response without touching the cached copy.
 *
 * @param {object} result - engine result
 * @param {object|null|undefined} dateRange - the query's dateRange as asked
 * @returns {object}
 */
export function withRequestedPreset(result, dateRange) {
  if (!result?.window) return result;
  return { ...result, window: { ...result.window, preset: dateRange?.preset ?? null } };
}

/* ------------------------------- pipeline --------------------------------- */

/** Numeric view of a field: non-numeric values become null instead of aborting. */
function toNumber(path) {
  return { $convert: { input: path, to: 'double', onError: null, onNull: null } };
}

/** Resolve a filter/metric field to its Mongo path. Top-level fields map to `$<field>`; everything else is read from `data`. */
function dataPath(field) {
  return TOP_LEVEL_FIELDS.has(field) ? `$${field}` : `$data.${field}`;
}

/**
 * Business dates are limited to years 1-9999 (with a day of margin for time
 * zone shifts): MongoDB's date-part operators used for bucketing reject
 * anything outside that range and would fail the whole query.
 */
const MIN_BUSINESS_DATE = new Date('0001-01-02T00:00:00.000Z');
const MAX_BUSINESS_DATE = new Date('9999-12-30T00:00:00.000Z');

/**
 * A row value read as a business date: BSON dates as-is, ISO strings via
 * `$dateFromString` (strings without an offset are wall time in `tz`),
 * numbers as epoch milliseconds. Anything unreadable, or outside years
 * 1-9999, becomes null.
 */
function businessDate(path, tz) {
  const parsed = {
    $switch: {
      branches: [
        { case: { $eq: [{ $type: path }, 'date'] }, then: path },
        {
          case: { $eq: [{ $type: path }, 'string'] },
          then: {
            $cond: [
              { $regexMatch: { input: path, regex: '(Z|z|[+-][0-9]{2}:?[0-9]{2})$' } },
              { $dateFromString: { dateString: path, onError: null, onNull: null } },
              { $dateFromString: { dateString: path, timezone: tz, onError: null, onNull: null } },
            ],
          },
        },
        {
          case: { $in: [{ $type: path }, ['int', 'long', 'double', 'decimal']] },
          then: { $convert: { input: path, to: 'date', onError: null, onNull: null } },
        },
      ],
      default: null,
    },
  };
  return {
    $let: {
      vars: { d: parsed },
      in: {
        $cond: [
          { $and: [{ $gte: ['$$d', MIN_BUSINESS_DATE] }, { $lte: ['$$d', MAX_BUSINESS_DATE] }] },
          '$$d',
          null,
        ],
      },
    },
  };
}

/** Start of the bucket containing `dateRef`, as 'YYYY-MM-DD' in `tz` (null stays null). */
function bucketStart(dateRef, bucket, tz) {
  const format = (date, fmt, timezone) => ({ $dateToString: { date, format: fmt, timezone } });
  const guard = (expr) => ({ $cond: [{ $eq: [dateRef, null] }, null, expr] });
  switch (bucket) {
    case 'day': return guard(format(dateRef, '%Y-%m-%d', tz));
    case 'month': return guard(format(dateRef, '%Y-%m-01', tz));
    case 'year': return guard(format(dateRef, '%Y-01-01', tz));
    case 'week':
      return guard(format({
        $dateFromParts: {
          isoWeekYear: { $isoWeekYear: { date: dateRef, timezone: tz } },
          isoWeek: { $isoWeek: { date: dateRef, timezone: tz } },
          isoDayOfWeek: 1,
        },
      }, '%Y-%m-%d', 'UTC'));
    case 'quarter':
    default:
      return guard(format({
        $dateFromParts: {
          year: { $year: { date: dateRef, timezone: tz } },
          month: {
            $add: [{ $multiply: [{ $floor: { $divide: [{ $subtract: [{ $month: { date: dateRef, timezone: tz } }, 1] }, 3] } }, 3] }, 1],
          },
          day: 1,
        },
      }, '%Y-%m-%d', 'UTC'));
  }
}

/** Build the leading `$match` (tenancy + connector + ingestion window + not deleted). */
function buildBaseMatch({ tenantId, connectorIds, dateRange }) {
  const match = { tenantId, deletedAt: null };
  if (connectorIds.length) match.connectorId = { $in: connectorIds.map((id) => new ObjectId(id)) };
  if (dateRange && dateRange.field === 'ingestedAt') {
    match.ingestedAt = {};
    if (dateRange.from) match.ingestedAt.$gte = new Date(dateRange.from);
    if (dateRange.to) match.ingestedAt.$lte = new Date(dateRange.to);
  }
  return match;
}

/** Business-date window stages (`$addFields` + `$match`) for a data column. */
function buildDateStages(dateRange, tz) {
  if (!dateRange || dateRange.field === 'ingestedAt') return [];
  const bounds = {};
  if (dateRange.from) bounds.$gte = new Date(dateRange.from);
  if (dateRange.to) bounds.$lte = new Date(dateRange.to);
  return [
    { $addFields: { __window: businessDate(dataPath(dateRange.field), tz) } },
    { $match: { __window: { $ne: null, ...bounds } } },
  ];
}

/** Translate a single (validated) filter clause into an `$expr` fragment. */
function filterExpr({ field, op, value }) {
  const path = dataPath(field);
  // Values are wrapped in $literal so a string such as "$data.x" is compared
  // as text, never evaluated as a field path or expression.
  const lit = (v) => (field === 'connectorId' ? new ObjectId(v) : { $literal: v });
  switch (op) {
    case 'eq': return { $eq: [path, lit(value)] };
    case 'neq': return { $ne: [path, lit(value)] };
    case 'in': return { $in: [path, value.map(lit)] };
    case 'nin': return { $not: [{ $in: [path, value.map(lit)] }] };
    case 'exists':
      return value
        ? { $ne: [{ $ifNull: [path, null] }, null] }
        : { $eq: [{ $ifNull: [path, null] }, null] };
    default: {
      // gt / gte / lt / lte: compare numerically. CSV values arrive as
      // strings, and BSON ordering would otherwise compare a string against
      // a number by type, not value. Non-numeric values never match.
      return { $and: [{ $ne: [toNumber(path), null] }, { [`$${op}`]: [toNumber(path), value] }] };
    }
  }
}

/** `$match` stages for one group of filters honouring its `filtersOp`. */
function buildFilterStages(filters, filtersOp) {
  if (!filters.length) return [];
  const conds = filters.map(filterExpr);
  if (filtersOp === 'or' && conds.length > 1) return [{ $match: { $expr: { $or: conds } } }];
  return conds.map((cond) => ({ $match: { $expr: cond } }));
}

/**
 * rls: stages enforcing a data access scope. Rows of denied datasets are
 * dropped; for each dataset with row rules a row must satisfy every rule
 * (`none` = no row of that dataset). A missing or foreign scope matches
 * nothing (fail closed).
 */
function buildAccessStages(access) {
  if (!isAccessScope(access)) return [{ $match: { _id: { $in: [] } } }];
  if (access.bypass) return [];
  const stages = [];
  if (access.denied.length) {
    stages.push({ $match: { connectorId: { $nin: access.denied.map((id) => new ObjectId(id)) } } });
  }
  const conds = access.rowScopes.map((scope) => ({
    $or: [
      { $ne: ['$connectorId', new ObjectId(scope.connectorId)] },
      scope.none ? false : { $and: scope.filters.map(filterExpr) },
    ],
  }));
  if (conds.length) stages.push({ $match: { $expr: { $and: conds } } });
  return stages;
}

/** Build a `$sum`/`$avg`/etc. accumulator for a metric. */
function metricAccumulator(metric) {
  if (metric.op === 'count') return { $sum: 1 };
  // vizbuilder: counting aggregations.
  if (metric.op === 'count_non_null') return { $sum: { $cond: [{ $eq: [{ $ifNull: [dataPath(metric.field), null] }, null] }, 0, 1] } };
  if (metric.op === 'count_distinct') return { $addToSet: dataPath(metric.field) };
  return { [`$${metric.op}`]: toNumber(dataPath(metric.field)) };
}

/** `$addFields` for bucketed group fields + the `$group` / `$project` pair. */
function buildGroupStages(groupBy, metrics, tz, metricDefs = null) {
  const pre = {};
  const _id = {};
  groupBy.forEach((g, i) => {
    if (g.bucket) {
      pre[`__bucket${i}`] = businessDate(dataPath(g.field), tz);
      _id[g.field] = bucketStart(`$__bucket${i}`, g.bucket, tz);
    } else {
      _id[g.field] = dataPath(g.field);
    }
  });
  const accumulators = {};
  // ai-catalogue: outputs that are not a plain accumulator (distinct counts,
  // metric references, ratios) are computed from internal `__m<i>` slots.
  const derived = {};
  metrics.forEach((m, i) => {
    const { accumulators: extra, output } = metricStages(m, `__m${i}`, metricDefs);
    if (extra) {
      Object.assign(accumulators, extra);
      derived[metricAlias(m)] = output;
    } else {
      accumulators[metricAlias(m)] = metricAccumulator(m);
    }
  });
  if (Object.keys(accumulators).length === 0) accumulators.count = { $sum: 1 };
  const excluded = excludedAccumulators(metrics);

  const projectSpec = { _id: 0 };
  for (const g of groupBy) projectSpec[g.field] = `$_id.${g.field}`;
  // No group fields: one aggregate over the whole filtered dataset.
  for (const alias of Object.keys(accumulators)) if (!alias.startsWith('__m')) projectSpec[alias] = 1;
  Object.assign(projectSpec, derived);
  // vizbuilder: exclusion counters pass through (stripped from rows later).
  Object.assign(accumulators, excluded);
  for (const key of Object.keys(excluded)) projectSpec[key] = 1;
  return {
    pre: Object.keys(pre).length ? [{ $addFields: pre }] : [],
    group: [{ $group: { _id: groupBy.length ? _id : null, ...accumulators } }, { $project: projectSpec }],
  };
}

/**
 * vizbuilder: per numeric metric, count the values that are present but not
 * numeric (dropped by `$convert ... onError: null`), so callers can surface
 * "n values excluded". Output keys `__excl<i>` are stripped from rows.
 */
const NUMERIC_OPS = new Set(['sum', 'avg', 'min', 'max']);
function excludedAccumulators(metrics) {
  const out = {};
  metrics.forEach((m, i) => {
    if (!NUMERIC_OPS.has(m.op) || !m.field) return;
    const path = dataPath(m.field);
    out[`__excl${i}`] = {
      $sum: { $cond: [{ $and: [{ $ne: [{ $ifNull: [path, null] }, null] }, { $eq: [toNumber(path), null] }] }, 1, 0] },
    };
  });
  return out;
}

/** vizbuilder: sum `__excl<i>` counters of the returned rows into `{ alias: n }` (only non-zero). */
function collectExcluded(rawRows, metrics) {
  const out = {};
  metrics.forEach((m, i) => {
    const n = rawRows.reduce((acc, row) => acc + (Number(row[`__excl${i}`]) || 0), 0);
    if (n > 0) out[metricAlias(m)] = n;
  });
  return out;
}

/** `$sort` for grouped results: the requested order, then every group field (stable pages). */
function buildGroupedSort(orderBy, groupBy) {
  const spec = {};
  for (const { field, direction } of orderBy) spec[field] = direction === 'desc' ? -1 : 1;
  for (const g of groupBy) if (spec[g.field] === undefined) spec[g.field] = 1;
  return Object.keys(spec).length ? [{ $sort: spec }] : [];
}

/**
 * Projection + `$sort` for raw rows. Data fields are sorted through
 * internal `__sort<i>` keys (removed from the output) so a column named like
 * a row property cannot clash with the projection.
 */
function buildRawStages(orderBy) {
  const project = { _id: 0, connectorId: 1, sourceRowId: 1, data: 1, ingestedAt: 1 };
  const sort = {};
  orderBy.forEach(({ field, direction }, i) => {
    const dir = direction === 'desc' ? -1 : 1;
    if (TOP_LEVEL_FIELDS.has(field)) sort[field] = dir;
    else {
      project[`__sort${i}`] = `$data.${field}`;
      sort[`__sort${i}`] = dir;
    }
  });
  if (!Object.keys(sort).length) sort.ingestedAt = -1;
  if (sort.sourceRowId === undefined) sort.sourceRowId = 1;
  return [{ $project: project }, { $sort: sort }];
}

/**
 * Pipeline stages shared by paged queries (`queryRows`) and row streams
 * (`openRowStream`): the leading match/filters (`prefix`) and the stages
 * that shape and order the result rows (`rowStages`). `group` is the
 * `$group`/`$project` pair of a grouped query (null in raw mode).
 */
function buildQueryStages(options, metricDefs = null) {
  const { tenantId, connectorIds, filters, filtersOp, filterGroups, dateRange, metrics, groupBy, orderBy, timezone } = options;
  // Metrics without groupBy aggregate everything into one row (a KPI).
  const groupMode = groupBy.length > 0 || metrics.length > 0;
  const prefix = [
    { $match: buildBaseMatch({ tenantId, connectorIds, dateRange }) },
    // rls: dataset grants + row rules, before any client-controlled stage.
    ...buildAccessStages(options.access),
    ...buildDateStages(dateRange, timezone),
    ...buildFilterStages(filters, filtersOp),
    ...filterGroups.flatMap((group) => buildFilterStages(group.filters, group.filtersOp)),
  ];
  if (groupMode) {
    const { pre, group } = buildGroupStages(groupBy, metrics, timezone, metricDefs);
    prefix.push(...pre);
    return { groupMode, prefix, group, rowStages: [...group, ...buildGroupedSort(orderBy, groupBy)] };
  }
  return { groupMode, prefix, group: null, rowStages: buildRawStages(orderBy) };
}

/** Map a driver failure to the engine's typed errors. */
function aggregateError(err, timezone) {
  // MaxTimeMSExpired (code 50): report a typed, actionable error.
  if (err?.code === 50 || err?.codeName === 'MaxTimeMSExpired') {
    return new ApiError(408, 'The query took too long. Narrow the date range or add filters.', { code: QUERY_ERROR_CODES.QUERY_TIMEOUT });
  }
  if (!(err instanceof ApiError) && /time ?zone/i.test(String(err?.message))) {
    return invalidQuery([{ field: 'timezone', message: `the database does not recognise the time zone "${timezone}"` }]);
  }
  return err;
}

/** The resolved window as returned to callers. */
function windowView(window) {
  return window
    ? { field: window.field, preset: window.preset, from: window.from?.toISOString() ?? null, to: window.to?.toISOString() ?? null }
    : null;
}

/**
 * Run an analytics query against the ConnectorRow collection.
 * See the contract at the top of this file.
 */
export async function queryRows(rawOptions) {
  const { options, window, timezone, metricDefs } = await prepareQuery(rawOptions || {});
  // ai-catalogue: period-over-period comparison runs the query twice.
  if (options.compare) return runCompared(options, window, timezone, metricDefs);
  return runPrepared(options, window, timezone, metricDefs);
}

/** Execute one prepared query (absolute window, resolved metric references). */
async function runPrepared(options, window, timezone, metricDefs) {
  const { tenantId, metrics, groupBy, pagination } = options;

  const page = pagination.page ?? DEFAULT_PAGE;
  const limit = pagination.limit ?? DEFAULT_LIMIT;
  const skip = (page - 1) * limit;
  const { groupMode, prefix, group, rowStages } = buildQueryStages(options, metricDefs);

  const rowsPipeline = [...rowStages, { $skip: skip }, { $limit: limit }];
  const totalPipeline = groupMode ? [...group.slice(0, 1), { $count: 'n' }] : [{ $count: 'n' }];
  const pipeline = [...prefix, { $facet: { rows: rowsPipeline, total: totalPipeline } }];

  let facet;
  try {
    [facet] = await queryLimiter.run(tenantId, () => timeAnalyticsQuery(() =>
      ConnectorRow.aggregate(pipeline).option({ maxTimeMS: env.analytics.queryTimeoutMs })));
  } catch (err) {
    throw aggregateError(err, timezone);
  }
  const rawRows = (facet && facet.rows) || [];
  const total = (facet && facet.total && facet.total[0] && facet.total[0].n) || 0;

  const rows = normalizeRows(rawRows);
  const columns = computeColumns(rows, groupMode, groupBy, metrics);

  return {
    // vizbuilder: values excluded from numeric metrics (non-numeric input).
    excluded: groupMode ? collectExcluded(rawRows, metrics) : {},
    rows,
    total,
    page,
    pages: total === 0 ? 0 : Math.ceil(total / limit),
    limit,
    columns,
    executedAt: clock.now().toISOString(),
    groupMode,
    timezone,
    window: windowView(window),
  };
}

/** Most columns a raw row stream reports (each data key is one column). */
export const STREAM_MAX_COLUMNS = 2000;

/**
 * Open a cursor over the WHOLE result of a query (no pages), for consumers
 * that write every row somewhere (report artefacts, analytics exports).
 *
 * The query goes through the same contract and preparation as `queryRows`
 * (presets resolve once, in the workspace time zone); `pagination` is not
 * accepted here because a stream always covers the whole result. Rows come
 * in the same order and shape as `queryRows` pages. The aggregation runs
 * under `maxTimeMS` (whole-cursor budget) with `allowDiskUse`, and holds one
 * of the workspace's analytics slots (analytics.limiter.js) while the
 * cursor is open.
 *
 * `columns` is known before the first row: the group fields and metric
 * aliases of a grouped query, or every data key of the matching rows
 * (sorted, at most `maxColumns`, else 422 TOO_MANY_COLUMNS) in raw mode.
 *
 * @returns {Promise<{ groupMode: boolean, columns: string[], timezone: string,
 *   window: object|null, rows: AsyncGenerator<object> }>}
 */
export async function openRowStream(rawOptions, {
  batchSize = 1000,
  maxTimeMS = env.analytics.queryTimeoutMs,
  maxColumns = STREAM_MAX_COLUMNS,
} = {}) {
  if (isPlainObject(rawOptions) && rawOptions.pagination !== undefined) {
    throw invalidQuery([{ field: 'pagination', message: 'is not accepted: an export always contains the whole result' }]);
  }
  const { options, window, timezone, metricDefs } = await prepareQuery(rawOptions || {});
  if (options.compare) {
    throw invalidQuery([{ field: 'compare', message: 'is not accepted: a row stream (export, report artefact) has no comparison window' }]);
  }
  const { tenantId, metrics, groupBy } = options;
  const { groupMode, prefix, rowStages } = buildQueryStages(options, metricDefs);

  let columns;
  if (groupMode) {
    columns = computeColumns([], true, groupBy, metrics);
  } else {
    const keyPipeline = [
      ...prefix,
      { $project: { _id: 0, k: { $map: { input: { $objectToArray: { $cond: [{ $eq: [{ $type: '$data' }, 'object'] }, '$data', {}] } }, in: '$$this.k' } } } },
      { $unwind: '$k' },
      { $group: { _id: '$k' } },
      { $sort: { _id: 1 } },
      { $limit: maxColumns + 1 },
    ];
    let keys;
    try {
      keys = await queryLimiter.run(tenantId, () =>
        ConnectorRow.aggregate(keyPipeline).option({ maxTimeMS, allowDiskUse: true }));
    } catch (err) {
      throw aggregateError(err, timezone);
    }
    columns = keys.map((k) => k._id).filter((k) => typeof k === 'string' && !isSensitiveFieldName(k));
    if (columns.length > maxColumns) {
      throw new ApiError(422, `The result has more than ${maxColumns} columns; filter the query or select fewer datasets.`, { code: 'TOO_MANY_COLUMNS' });
    }
  }

  const pipeline = [...prefix, ...rowStages];
  async function* rows() {
    await queryLimiter.acquire(tenantId);
    let cursor = null;
    try {
      cursor = ConnectorRow.aggregate(pipeline).option({ maxTimeMS, allowDiskUse: true }).cursor({ batchSize });
      for await (const doc of cursor) yield normalizeRow(doc);
    } catch (err) {
      throw aggregateError(err, timezone);
    } finally {
      if (cursor) await cursor.close().catch(() => {});
      queryLimiter.release(tenantId);
    }
  }
  return { groupMode, columns, timezone, window: windowView(window), rows: rows() };
}

/** Coerce ObjectIds into strings and drop internal sort keys. */
function normalizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === '_id' || key.startsWith('__sort') || key.startsWith('__excl')) continue;
    out[key] = value;
  }
  if (out.connectorId && typeof out.connectorId !== 'string') out.connectorId = String(out.connectorId);
  // security: rows ingested before the ingestion sanitizer may still hold
  // credential-like keys; strip them from every returned row.
  if (out.data && typeof out.data === 'object') out.data = stripSensitiveFields(out.data);
  return out;
}

function normalizeRows(rows) {
  return rows.map(normalizeRow);
}

function computeColumns(rows, groupMode, groupBy, metrics) {
  if (groupMode) {
    const cols = groupBy.map((g) => g.field);
    if (metrics.length) for (const m of metrics) cols.push(metricAlias(m));
    else cols.push('count');
    return cols;
  }
  const seen = new Set();
  for (const row of rows) {
    const data = row.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const key of Object.keys(data)) seen.add(key);
    }
  }
  return [...seen].sort();
}

export default {
  queryRows,
  openRowStream,
  metricAlias,
  prepareQuery,
  validateQuery,
  normalizeQuery,
  resolveDateRange,
  withRequestedPreset,
  // ai-catalogue
  validateCompare,
  comparisonWindow,
  QUERY_KEYS,
  FILTER_ENVELOPE_KEYS,
  DATE_PRESETS,
  DATE_BUCKETS,
  QUERY_ERROR_CODES,
  _meta: { source: 'ConnectorRow', tenancy: 'tenant' },
};
