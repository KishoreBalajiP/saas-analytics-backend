/**
 * Analytics Engine (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Turns a normalised analytics query into a single MongoDB aggregation
 *   pipeline over the ingested `ConnectorRow` collection. Everything runs in
 *   the database - no row materialisation in Node - so even large connectors
 *   paginate cheaply.
 *
 * TENANCY
 *   `ConnectorRow` carries a tenantScope plugin (auto-filters `find`), but
 *   `aggregate()` bypasses query middleware. The engine therefore ALWAYS
 *   injects `tenantId` into the leading `$match`, and always excludes
 *   soft-deleted rows (`deletedAt: null`) - defence in depth, not an afterthought.
 *
 * CONTRACT
 *   queryRows({
 *     tenantId,            // string (required)
 *     connectorIds?,        // string[] (ObjectIds as strings)
 *     filters?,             // Array<{ field, op, value }>
 *     filtersOp?,           // 'and' | 'or' (default 'and')
 *     dateRange?,           // { from?, to? }
 *     metrics?,             // Array<{ alias, op, field }>
 *     groupBy?,             // Array<{ field }>
 *     orderBy?,             // Array<{ field, direction? }>
 *     pagination?,          // { page, limit }
 *   }) -> { rows, total, page, pages, limit, columns, executedAt, groupMode }
 *
 * FILTER OPERATORS: eq, neq, in, nin, gt, gte, lt, lte, exists
 * METRIC OPERATORS: count, sum, avg, min, max
 */

import mongoose from 'mongoose';
import { ConnectorRow } from '../models/ConnectorRow.js';

const { ObjectId } = mongoose.Types;

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Fields that live on the row document itself (vs inside `data`). */
const TOP_LEVEL_FIELDS = new Set(['connectorId', 'ingestedAt', 'sourceRowId', 'tenantId']);

/** Resolve a filter/metric field to its Mongo path. Top-level fields map to `$<field>`; everything else is read from `data`. */
function dataPath(field) {
  return TOP_LEVEL_FIELDS.has(field) ? `$${field}` : `$data.${field}`;
}

/** Coerce a value to an ObjectId, returning null when it is not a valid 24-hex string. */
function toObjectId(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!/^[0-9a-fA-F]{24}$/.test(str)) return null;
  try {
    return new ObjectId(str);
  } catch {
    return null;
  }
}

/** Build the leading `$match` (tenancy + connector + time window + not deleted). */
function buildBaseMatch({ tenantId, connectorIds, dateRange }) {
  const match = { tenantId, deletedAt: null };
  if (Array.isArray(connectorIds) && connectorIds.length) {
    const ids = connectorIds.map(toObjectId).filter(Boolean);
    if (ids.length) match.connectorId = { $in: ids };
  }
  if (dateRange && (dateRange.from || dateRange.to)) {
    match.ingestedAt = {};
    if (dateRange.from) match.ingestedAt.$gte = new Date(dateRange.from);
    if (dateRange.to) match.ingestedAt.$lte = new Date(dateRange.to);
  }
  return match;
}

/** Translate a single filter clause into an `$expr` fragment. */
function filterExpr({ field, op, value }) {
  let resolvedValue = value;
  if (field === 'connectorId' && typeof value === 'string') {
    const oid = toObjectId(value);
    if (!oid) return null;
    resolvedValue = oid;
  }
  const path = dataPath(field);
  switch (op) {
    case 'eq':
      return { $eq: [path, resolvedValue] };
    case 'neq':
      return { $ne: [path, resolvedValue] };
    case 'in':
      return { $in: [path, Array.isArray(resolvedValue) ? resolvedValue : [resolvedValue]] };
    case 'nin':
      return { $nin: [path, Array.isArray(resolvedValue) ? resolvedValue : [resolvedValue]] };
    case 'exists':
      return resolvedValue
        ? { $ne: [{ $ifNull: [path, null] }, null] }
        : { $eq: [{ $ifNull: [path, null] }, null] };
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const n = Number(resolvedValue);
      if (!Number.isFinite(n)) return null;
      const map = { gt: '$gt', gte: '$gte', lt: '$lt', lte: '$lte' };
      return { [map[op]]: [path, n] };
    }
    default:
      return null;
  }
}

/** Split a filter list into `$match` stages honouring `filtersOp`. */
function buildFilterStages(filters, filtersOp) {
  if (!Array.isArray(filters) || filters.length === 0) return [];
  const conds = [];
  for (const filter of filters) {
    const expr = filterExpr(filter);
    if (expr) conds.push(expr);
  }
  if (conds.length === 0) return [];
  if (filtersOp === 'or' && conds.length > 1) {
    return [{ $match: { $expr: { $or: conds } } }];
  }
  return conds.map((cond) => ({ $match: { $expr: cond } }));
}

/** Default alias for a metric when the caller omits one. */
function metricAlias(metric) {
  return metric.alias ?? `${metric.op}_${metric.field}`;
}

/** Build a `$sum`/`$avg`/etc. accumulator for a metric. */
function metricAccumulator(metric) {
  const path = dataPath(metric.field);
  switch (metric.op) {
    case 'count':
      return { $sum: 1 };
    case 'sum':
      return { $sum: { $toDouble: path } };
    case 'avg':
      return { $avg: { $toDouble: path } };
    case 'min':
      return { $min: { $toDouble: path } };
    case 'max':
      return { $max: { $toDouble: path } };
    default:
      return null;
  }
}

/** Build the `$group` + `$project` pair for grouped queries. */
function buildGroupStage(groupBy, metrics) {
  const _id = {};
  for (const g of groupBy) _id[g.field] = dataPath(g.field);

  const accumulators = {};
  for (const m of metrics || []) {
    const acc = metricAccumulator(m);
    if (acc) accumulators[metricAlias(m)] = acc;
  }
  if (Object.keys(accumulators).length === 0) accumulators.count = { $sum: 1 };

  const group = { $group: { _id, ...accumulators } };
  const projectSpec = { _id: 0 };
  for (const g of groupBy) projectSpec[g.field] = `$_id.${g.field}`;
  for (const alias of Object.keys(accumulators)) projectSpec[alias] = 1;
  return [group, { $project: projectSpec }];
}

/** Translate user-supplied ordering into a `$sort` spec (plain top-level keys). */
function buildSortStage(orderBy, groupMode, groupBy, orderByDataFields) {
  const spec = {};
  if (Array.isArray(orderBy) && orderBy.length) {
    for (const { field, direction = 'asc' } of orderBy) {
      // In grouped mode every groupBy field / metric alias is already top-level.
      // In raw mode orderBy data fields are projected to top-level upstream.
      const key = TOP_LEVEL_FIELDS.has(field) ? field : field;
      spec[key] = direction === 'desc' ? -1 : 1;
    }
    if (Object.keys(spec).length) return { $sort: spec };
  }
  if (groupMode) {
    if (groupBy?.[0]) spec[groupBy[0].field] = 1;
    return Object.keys(spec).length ? { $sort: spec } : null;
  }
  // Deterministic default for raw rows.
  return { $sort: { ingestedAt: -1, sourceRowId: 1 } };
}

function normalizePagination(pagination) {
  const page = Math.max(1, Number(pagination?.page) || DEFAULT_PAGE);
  const limit = Math.min(Math.max(1, Number(pagination?.limit) || DEFAULT_LIMIT), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Run an analytics query against the ConnectorRow collection.
 */
export async function queryRows(options) {
  const {
    tenantId,
    connectorIds = [],
    filters = [],
    filtersOp = 'and',
    dateRange = null,
    metrics = [],
    groupBy = [],
    orderBy = [],
    pagination = {},
  } = options || {};

  const { page, limit, skip } = normalizePagination(pagination);
  const groupMode = Array.isArray(groupBy) && groupBy.length > 0;

  const baseMatch = buildBaseMatch({ tenantId, connectorIds, dateRange });
  const filterStages = buildFilterStages(filters, filtersOp);
  const groupStages = groupMode ? buildGroupStage(groupBy, metrics) : [];

  let rowsPipeline;
  let orderByDataFields = [];
  if (groupMode) {
    const sortStage = buildSortStage(orderBy, true, groupBy, []);
    rowsPipeline = [...filterStages, ...groupStages, sortStage, { $skip: skip }, { $limit: limit }];
  } else {
    orderByDataFields = (Array.isArray(orderBy) ? orderBy : [])
      .filter((o) => !TOP_LEVEL_FIELDS.has(o.field))
      .map((o) => o.field);
    const rawProject = { _id: 0, connectorId: 1, sourceRowId: 1, data: 1, ingestedAt: 1 };
    for (const f of orderByDataFields) rawProject[f] = `$data.${f}`;
    const sortStage = buildSortStage(orderBy, false, [], orderByDataFields) || { $sort: { ingestedAt: -1, sourceRowId: 1 } };
    rowsPipeline = [
      ...filterStages,
      { $project: rawProject },
      sortStage,
      { $skip: skip },
      { $limit: limit },
    ];
  }

  const totalPipeline = [...filterStages, ...groupStages, { $count: 'n' }];
  const pipeline = [
    { $match: baseMatch },
    {
      $facet: {
        rows: rowsPipeline,
        total: totalPipeline,
      },
    },
  ];

  const [facet] = await ConnectorRow.aggregate(pipeline);
  const rawRows = (facet && facet.rows) || [];
  const total = (facet && facet.total && facet.total[0] && facet.total[0].n) || 0;

  const rows = normalizeRows(rawRows);
  const columns = computeColumns(rows, groupMode, groupBy, metrics);

  return {
    rows,
    total,
    page,
    pages: total === 0 ? 0 : Math.ceil(total / limit),
    limit,
    columns,
    executedAt: new Date().toISOString(),
    groupMode,
  };
}

/** Coerce ObjectIds returned by the aggregation into stable strings. */
function normalizeRows(rows) {
  return rows.map((row) => {
    const out = { ...row };
    if (out._id !== undefined) delete out._id;
    if (out.connectorId && !(typeof out.connectorId === 'string')) {
      out.connectorId = String(out.connectorId);
    }
    return out;
  });
}

function computeColumns(rows, groupMode, groupBy, metrics) {
  if (groupMode) {
    const cols = [...(groupBy || []).map((g) => g.field)];
    if (Array.isArray(metrics) && metrics.length) {
      for (const m of metrics) cols.push(metricAlias(m));
    } else {
      cols.push('count');
    }
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

export default { queryRows, _meta: { source: 'ConnectorRow', tenancy: 'tenant' } };
