/**
 * Deterministic plan validator (ai-ask). The planner's choices are never
 * trusted: the dataset must be one of the caller's authorised datasets,
 * every field must exist in that dataset's (non-personal) schema, metric
 * references must be approved metrics of that dataset, types must fit
 * (no sum over text, no bucket over a non-date), and the result must pass
 * the engine's strict contract. Returns { ok, query, datasetId, errors }.
 */
import * as engine from '../analytics.engine.js';

const NUMERIC = new Set(['number', 'integer']);
const DATES = new Set(['date', 'datetime']);
export const MAX_LIMIT = 200;

export function validatePlan(plan, { datasets, metrics }) {
  const errors = [];
  const fail = (m) => errors.push(m);
  if (!plan || typeof plan !== 'object') return { ok: false, errors: ['plan is missing'] };
  const dataset = datasets.find((d) => d.id === plan.datasetId);
  if (!dataset) return { ok: false, errors: [`dataset "${String(plan.datasetId).slice(0, 40)}" is not available`] };
  const fields = new Map(dataset.fields.map((f) => [f.name, f.type]));
  const known = (name, at) => { if (!fields.has(name)) { fail(`${at}: unknown field "${String(name).slice(0, 60)}"`); return false; } return true; };

  const outMetrics = (plan.metrics ?? []).map((m, i) => {
    if (m.ref) {
      if (!metrics.some((x) => x.ref === m.ref && x.datasetId === dataset.id)) fail(`metrics[${i}]: unknown metric "${String(m.ref).slice(0, 60)}"`);
      return { ref: m.ref, ...(m.alias ? { alias: m.alias } : {}) };
    }
    if (m.op !== 'count' && known(m.field, `metrics[${i}]`) && ['sum', 'avg', 'min', 'max'].includes(m.op) && !NUMERIC.has(fields.get(m.field))) {
      fail(`metrics[${i}]: ${m.op} needs a numeric field, "${m.field}" is ${fields.get(m.field)}`);
    }
    return { op: m.op, ...(m.field && m.op !== 'count' ? { field: m.field } : {}), ...(m.alias ? { alias: m.alias } : {}) };
  });
  const groupBy = (plan.groupBy ?? []).map((g, i) => {
    if (known(g.field, `groupBy[${i}]`) && g.bucket && !DATES.has(fields.get(g.field))) fail(`groupBy[${i}]: bucket needs a date field`);
    return g.bucket ? { field: g.field, bucket: g.bucket } : { field: g.field };
  });
  const filters = (plan.filters ?? []).map((f, i) => { known(f.field, `filters[${i}]`); return { field: f.field, op: f.op, value: f.value ?? null }; });
  let dateRange;
  if (plan.dateRange) {
    if (known(plan.dateRange.field, 'dateRange') && !DATES.has(fields.get(plan.dateRange.field))) fail('dateRange: field must be a date');
    dateRange = Object.fromEntries(Object.entries(plan.dateRange).filter(([, v]) => v !== undefined && v !== ''));
  }
  const query = {
    metrics: outMetrics,
    groupBy,
    filters,
    ...(dateRange ? { dateRange } : {}),
    ...(plan.orderBy?.length ? { orderBy: plan.orderBy } : {}),
    pagination: { page: 1, limit: Math.min(MAX_LIMIT, Math.max(1, Number(plan.limit) || 50)) },
  };
  if (!errors.length) {
    try {
      engine.validateQuery(query);
    } catch (err) {
      for (const e of err.errors ?? [{ field: 'query', message: 'is invalid' }]) fail(`${e.field}: ${e.message}`);
    }
  }
  return { ok: errors.length === 0, query, datasetId: dataset.id, errors };
}

export default { validatePlan, MAX_LIMIT };
