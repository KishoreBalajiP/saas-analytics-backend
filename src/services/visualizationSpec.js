/**
 * Visualization spec (roadmap 3.5, vizbuilder).
 *
 * PURPOSE
 *   A typed, per-widget-type presentation contract stored on
 *   `Widget.visualization`, validated at save time against the widget's
 *   query, and resolved at execution time into the explicit
 *   `{ dimensions, measures, xField, ... }` the renderer honours (the
 *   renderer never guesses dimensions from value types).
 *
 * SPEC KEYS (all optional; allowed keys depend on the widget type)
 *   xField        groupBy field used as the category / time axis
 *   series        metric aliases plotted as measures
 *   numberFormat  'number' | 'integer' | 'percent' | 'currency' | 'compact'
 *   currency      ISO 4217 code (with numberFormat 'currency')
 *   unit          short unit label (<= 16 chars)
 *   sort          { by: 'dimension' | 'measure', direction: 'asc' | 'desc' }
 *   limit         top N categories (1..50; bar and pie)
 *   showOther     add an "Other" bucket for categories beyond the top N
 *   nullHandling  'skip' | 'zero' | 'label'
 *   pageSize      rows per page (1..200; table)
 *   columns       output columns to show, in order (table)
 *
 * RULES
 *   - kpi: needs at least one aggregate metric and no groupBy.
 *   - bar / line / area / pie: need at least one groupBy field.
 *   - pie: exactly one measure.
 *   Violations are a 400 INVALID_VISUALIZATION with field errors
 *   (`visualization.xField`, `query.metrics`, ...).
 */

import ApiError from '../utils/ApiError.js';
import { metricAlias } from './analytics.engine.js';

export const VISUALIZATION_ERROR_CODE = 'INVALID_VISUALIZATION';
export const NUMBER_FORMATS = Object.freeze(['number', 'integer', 'percent', 'currency', 'compact']);
export const NULL_HANDLING = Object.freeze(['skip', 'zero', 'label']);
export const TOP_N_MAX = 50;
export const PAGE_SIZE_MAX = 200;

const COMMON = ['numberFormat', 'currency', 'unit'];
const ALLOWED_KEYS = Object.freeze({
  kpi: [...COMMON, 'series'],
  bar: [...COMMON, 'xField', 'series', 'sort', 'limit', 'showOther', 'nullHandling'],
  pie: [...COMMON, 'xField', 'series', 'sort', 'limit', 'showOther', 'nullHandling'],
  doughnut: [...COMMON, 'xField', 'series', 'sort', 'limit', 'showOther', 'nullHandling'],
  scatter: [...COMMON, 'xField', 'series', 'nullHandling'],
  line: [...COMMON, 'xField', 'series', 'sort', 'nullHandling'],
  area: [...COMMON, 'xField', 'series', 'sort', 'nullHandling'],
  table: [...COMMON, 'columns', 'pageSize', 'sort'],
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Output names of a query: dimensions (groupBy fields) and measures (metric aliases). */
export function queryOutputs(query) {
  const q = isObj(query) ? query : {};
  const groupBy = Array.isArray(q.groupBy) ? q.groupBy : [];
  const metrics = Array.isArray(q.metrics) ? q.metrics : [];
  const dimensions = groupBy.map((g) => (typeof g === 'string' ? g : g?.field)).filter(Boolean);
  const measures = metrics.filter(isObj).map(metricAlias);
  const grouped = dimensions.length > 0 || measures.length > 0;
  return { dimensions, measures: grouped && !measures.length ? ['count'] : measures, hasMetrics: measures.length > 0, groupBy };
}

/**
 * Validate a widget's visualization spec against its type and (already
 * validated) query. Returns the normalised spec (only known keys).
 * @throws {ApiError} 400 INVALID_VISUALIZATION
 */
export function validateVisualization({ type, query, visualization }) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  const spec = visualization === undefined || visualization === null ? {} : visualization;
  const out = {};
  if (!isObj(spec)) {
    fail('visualization', 'must be an object');
    throw new ApiError(400, 'Invalid visualization', { code: VISUALIZATION_ERROR_CODE, errors });
  }
  const allowed = new Set(ALLOWED_KEYS[type] ?? []);
  const { dimensions, measures, hasMetrics } = queryOutputs(query);

  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) fail(`visualization.${key}`, `is not supported for ${type} widgets`);
  }
  const has = (k) => allowed.has(k) && spec[k] !== undefined && spec[k] !== null;

  if (has('xField')) {
    if (!dimensions.includes(spec.xField)) fail('visualization.xField', `must be a groupBy field (${dimensions.join(', ') || 'none'})`);
    else out.xField = spec.xField;
  }
  if (has('series')) {
    if (!Array.isArray(spec.series) || !spec.series.length) fail('visualization.series', 'must be a non-empty array of metric names');
    else {
      spec.series.forEach((s, i) => {
        if (!measures.includes(s)) fail(`visualization.series[${i}]`, `must be a metric of the query (${measures.join(', ') || 'none'})`);
      });
      out.series = [...spec.series];
    }
  }
  if (has('numberFormat')) {
    if (!NUMBER_FORMATS.includes(spec.numberFormat)) fail('visualization.numberFormat', `must be one of ${NUMBER_FORMATS.join(', ')}`);
    else out.numberFormat = spec.numberFormat;
  }
  if (has('currency')) {
    if (typeof spec.currency !== 'string' || !/^[A-Z]{3}$/.test(spec.currency)) fail('visualization.currency', 'must be a 3-letter ISO currency code');
    else out.currency = spec.currency;
  }
  if (has('unit')) {
    if (typeof spec.unit !== 'string' || spec.unit.length > 16) fail('visualization.unit', 'must be a string up to 16 characters');
    else out.unit = spec.unit;
  }
  if (has('sort')) {
    const s = spec.sort;
    if (!isObj(s) || !['dimension', 'measure'].includes(s.by) || (s.direction !== undefined && !['asc', 'desc'].includes(s.direction))) {
      fail('visualization.sort', 'must be { by: "dimension"|"measure", direction?: "asc"|"desc" }');
    } else out.sort = { by: s.by, direction: s.direction ?? (s.by === 'measure' ? 'desc' : 'asc') };
  }
  if (has('limit')) {
    if (!intIn(spec.limit, 1, TOP_N_MAX)) fail('visualization.limit', `must be an integer between 1 and ${TOP_N_MAX}`);
    else out.limit = spec.limit;
  }
  if (has('showOther')) {
    if (typeof spec.showOther !== 'boolean') fail('visualization.showOther', 'must be a boolean');
    else out.showOther = spec.showOther;
  }
  if (has('nullHandling')) {
    if (!NULL_HANDLING.includes(spec.nullHandling)) fail('visualization.nullHandling', `must be one of ${NULL_HANDLING.join(', ')}`);
    else out.nullHandling = spec.nullHandling;
  }
  if (has('pageSize')) {
    if (!intIn(spec.pageSize, 1, PAGE_SIZE_MAX)) fail('visualization.pageSize', `must be an integer between 1 and ${PAGE_SIZE_MAX}`);
    else out.pageSize = spec.pageSize;
  }
  if (has('columns')) {
    if (!Array.isArray(spec.columns) || spec.columns.some((c) => typeof c !== 'string' || !c)) fail('visualization.columns', 'must be an array of column names');
    else out.columns = [...spec.columns];
  }

  // Type rules.
  if (type === 'kpi') {
    if (!hasMetrics) fail('query.metrics', 'a KPI widget needs at least one aggregate metric');
    if (dimensions.length) fail('query.groupBy', 'a KPI widget shows one aggregate value: remove groupBy');
  }
  if (['bar', 'line', 'area', 'pie', 'doughnut', 'scatter'].includes(type) && !dimensions.length) {
    fail('query.groupBy', `a ${type} widget needs at least one groupBy field`);
  }
  if (type === 'scatter') {
    const n = out.series ? out.series.length : measures.length;
    if (n < 2) fail(out.series ? 'visualization.series' : 'query.metrics', 'a scatter widget needs two measures (x and y)');
  }
  if (type === 'pie' || type === 'doughnut') {
    const n = out.series ? out.series.length : measures.length;
    if (n !== 1) fail(out.series ? 'visualization.series' : 'query.metrics', `a ${type} widget plots exactly one measure`);
  }
  if (out.showOther && out.limit === undefined) fail('visualization.limit', 'is required with showOther');

  if (errors.length) throw new ApiError(400, 'Invalid visualization', { code: VISUALIZATION_ERROR_CODE, errors });
  return out;
}

/**
 * Resolve the stored spec with defaults into the explicit shape the renderer
 * honours. Never throws (stored specs from before validation degrade to defaults).
 */
export function resolveVisualization({ type, query, visualization }) {
  const spec = isObj(visualization) ? visualization : {};
  const { dimensions, measures, groupBy } = queryOutputs(query);
  const xField = dimensions.includes(spec.xField) ? spec.xField : dimensions[0] ?? null;
  const x = groupBy.find((g) => (typeof g === 'string' ? g : g?.field) === xField);
  const series = Array.isArray(spec.series) && spec.series.every((s) => measures.includes(s)) ? spec.series : measures;
  return {
    type,
    xField,
    xBucket: x && typeof x === 'object' ? x.bucket ?? null : null,
    dimensions,
    measures: series,
    numberFormat: spec.numberFormat ?? 'number',
    currency: spec.currency ?? null,
    unit: spec.unit ?? null,
    sort: spec.sort ?? null,
    limit: spec.limit ?? null,
    showOther: Boolean(spec.showOther),
    nullHandling: spec.nullHandling ?? 'skip',
    pageSize: spec.pageSize ?? null,
    columns: Array.isArray(spec.columns) ? spec.columns : null,
  };
}

export default { validateVisualization, resolveVisualization, queryOutputs };
