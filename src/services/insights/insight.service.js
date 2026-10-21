/**
 * Insight service (ai-insights, roadmap 4.A3).
 *
 * generate(): reads a metric's time series (and optional dimension split)
 * through the tenant-scoped engine, computes deterministic insights with
 * statistical guards, optionally narrates them (claim-checked, causal-lint),
 * and stores them in the feed. The metric is an engine metric: an approved
 * `{ ref: 'metric:<key>' }` (resolved by the engine through the metric
 * definitions contract) or an inline `{ op, field }`.
 */
import ApiError from '../../utils/ApiError.js';
import * as engine from '../analytics.engine.js';
import connectorRepository from '../../repositories/connector.repository.js';
import insightRepository from '../../repositories/insight.repository.js';
import { periodChange, topMovers, outlier } from './computations.js';
import { narrate } from './narrator.js';

const BUCKETS = ['day', 'week', 'month'];
const SAFE = /^[^$.\u0000-\u001f]{1,200}$/;

function sanitize(input) {
  const errors = [];
  const { connectorId, metric, dateField, dimension, bucket = 'month', dashboardId = null } = input ?? {};
  if (!/^[0-9a-fA-F]{24}$/.test(String(connectorId ?? ''))) errors.push({ field: 'connectorId', message: 'must be a dataset id' });
  if (!metric || typeof metric !== 'object') errors.push({ field: 'metric', message: 'must be { ref } or { op, field }' });
  if (!SAFE.test(String(dateField ?? ''))) errors.push({ field: 'dateField', message: 'must be a field name' });
  if (dimension !== undefined && dimension !== null && !SAFE.test(String(dimension))) errors.push({ field: 'dimension', message: 'must be a field name' });
  if (!BUCKETS.includes(bucket)) errors.push({ field: 'bucket', message: `must be one of ${BUCKETS.join(', ')}` });
  if (dashboardId !== null && !/^[0-9a-fA-F]{24}$/.test(String(dashboardId))) errors.push({ field: 'dashboardId', message: 'must be a dashboard id' });
  if (errors.length) throw ApiError.badRequest('Invalid insight request', errors);
  const m = metric.ref ? { ref: String(metric.ref), alias: 'value' } : { op: metric.op, ...(metric.field ? { field: metric.field } : {}), alias: 'value' };
  const metricKey = metric.ref ? String(metric.ref).replace(/^metric:/, '').split('@')[0] : `${metric.op}_${metric.field ?? ''}`;
  return { connectorId: String(connectorId), metric: m, dateField, dimension: dimension ?? null, bucket, dashboardId, metricKey };
}

export async function computeInsights({ tenantId, input }) {
  const req = sanitize(input);
  const connector = await connectorRepository.findById(req.connectorId, { tenantId });
  if (!connector) throw ApiError.badRequest('Invalid insight request', [{ field: 'connectorId', message: 'must be a dataset of this workspace' }]);
  const run = (q) => engine.queryRows({ ...q, tenantId, connectorIds: [req.connectorId] });
  const series = (await run({
    metrics: [req.metric], groupBy: [{ field: req.dateField, bucket: req.bucket }],
    orderBy: [{ field: req.dateField, direction: 'asc' }], pagination: { page: 1, limit: 200 },
  })).rows.filter((r) => r[req.dateField] !== null).map((r) => ({ period: r[req.dateField], value: Number(r.value) }));
  const label = req.metricKey;
  const out = [];
  if (series.length >= 2) {
    const [prev, cur] = series.slice(-2);
    const pc = periodChange({ current: cur.value, previous: prev.value, label });
    if (pc) out.push({ ...pc, window: { current: cur.period, previous: prev.period } });
    if (req.dimension) {
      const split = (await run({
        metrics: [req.metric], groupBy: [{ field: req.dimension }, { field: req.dateField, bucket: req.bucket }],
        pagination: { page: 1, limit: 200 },
      })).rows;
      const pick = (period) => Object.fromEntries(split.filter((r) => r[req.dateField] === period).map((r) => [String(r[req.dimension]), Number(r.value)]));
      const tm = topMovers({ currentByMember: pick(cur.period), previousByMember: pick(prev.period), label });
      if (tm) out.push({ ...tm, window: { current: cur.period, previous: prev.period } });
    }
  }
  const ol = outlier({ series, label });
  if (ol) out.push({ ...ol, window: { period: ol.facts.period } });
  return { req, insights: out, points: series.length };
}

export async function generate({ tenantId, actorId = null, input }) {
  const { req, insights, points } = await computeInsights({ tenantId, input });
  const docs = [];
  for (const ins of insights) {
    docs.push({
      tenantId: String(tenantId), dashboardId: req.dashboardId, metricKey: req.metricKey, connectorId: req.connectorId,
      type: ins.type, window: ins.window, cells: ins.cells, facts: ins.facts, narration: await narrate(ins), createdBy: actorId,
    });
  }
  const saved = await insightRepository.createMany(docs);
  return { insights: saved, points, suppressed: saved.length === 0 ? 'insufficient_data_or_no_change' : null };
}

export const list = (args) => insightRepository.list(args);

export async function dismiss({ tenantId, id, actorId }) {
  const doc = await insightRepository.update({ tenantId, id, set: { status: 'dismissed', dismissedBy: actorId } });
  if (!doc) throw ApiError.notFound('Insight not found');
  return doc;
}

export async function feedback({ tenantId, id, actorId, rating }) {
  if (!['up', 'down'].includes(rating)) throw ApiError.badRequest('rating must be up or down', [{ field: 'rating', message: 'must be up or down' }]);
  const doc = await insightRepository.update({ tenantId, id, set: { feedback: { rating, by: actorId, at: new Date() } } });
  if (!doc) throw ApiError.notFound('Insight not found');
  return doc;
}

export default { generate, computeInsights, list, dismiss, feedback };
