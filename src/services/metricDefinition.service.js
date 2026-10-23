/**
 * Metric definitions service (ai-catalogue, roadmap 4.A1; owner of the
 * metric definitions contract in the parallel build contracts).
 *
 * PURPOSE
 *   The tenant's catalogue of named, versioned business metrics ("semantic
 *   layer lite"). A definition names a dataset, an aggregation over a field
 *   (or a ratio of two aggregations), filters that apply to the metric only,
 *   a unit, a format and a direction. Queries reference approved metrics as
 *   `metric:<key>` (the engine resolves them through `resolveMetricRef`).
 *
 * CONTRACT (used by the engine, the AI packages, scorecards, starter dashboards)
 *   - list({ tenantId, status })            latest version per key
 *   - get({ tenantId, key, version })       one version (latest when omitted)
 *   - resolveMetricRef({ tenantId, ref })   'metric:<key>[@<version>]' ->
 *       { key, version, connectorId, aggregation, field, numerator,
 *         denominator, filters, unit, format, direction } or null.
 *       Only APPROVED versions resolve (unless includeDrafts).
 *
 * LIFECYCLE
 *   create   -> version 1, draft                         (metrics.manage)
 *   update   -> next version, draft (versions immutable)  (metrics.manage)
 *   approve  -> that draft version becomes approved      (metrics.approve)
 *   archive  -> every version archived, nothing resolves (metrics.manage)
 *   suggest  -> profiler drafts from the dataset schema   (metrics.manage)
 *
 * SECURITY
 *   Every read and write is scoped by tenantId; a definition's dataset must
 *   be a connector of the same tenant (checked on every write); filters are
 *   held to the engine's strict filter contract. Labels and descriptions are
 *   tenant text: consumers that pass them to a model treat them as data.
 */

import ApiError from '../utils/ApiError.js';
import * as engine from './analytics.engine.js';
import metricRepository from '../repositories/metricDefinition.repository.js';
import connectorRepository from '../repositories/connector.repository.js';
import { emit as auditEmit } from './auditLog.service.js';
import { getSchema } from './datasetSchema.service.js';
import {
  METRIC_AGGREGATIONS,
  METRIC_KINDS,
  METRIC_FORMATS,
  METRIC_DIRECTIONS,
  METRIC_STATUSES,
  METRIC_KEY_PATTERN,
  METRIC_LIMITS,
} from '../models/MetricDefinition.js';

export const METRIC_ERROR_CODES = Object.freeze({
  INVALID: 'METRIC_INVALID',
  NOT_FOUND: 'METRIC_NOT_FOUND',
  EXISTS: 'METRIC_EXISTS',
  NOT_DRAFT: 'METRIC_NOT_DRAFT',
  ARCHIVED: 'METRIC_ARCHIVED',
});

/** Most profiler suggestions per call. */
export const MAX_SUGGESTIONS = 10;

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const DEFINITION_FIELDS = Object.freeze([
  'key', 'label', 'description', 'connectorId', 'aggregation', 'field', 'numerator', 'denominator',
  'filters', 'unit', 'format', 'direction', 'owner',
]);
const PART_KEYS = new Set(['aggregation', 'field', 'filters']);
const NUMERIC_TYPES = new Set(['number', 'integer']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function invalid(errors, message = 'Invalid metric definition') {
  return new ApiError(400, message, { code: METRIC_ERROR_CODES.INVALID, errors });
}

function notFound(key) {
  return new ApiError(404, `Metric "${key}" not found`, { code: METRIC_ERROR_CODES.NOT_FOUND });
}

async function audit({ tenantId, actorId, action, key, after }) {
  try {
    await auditEmit({
      actor: actorId ? { type: 'user', id: String(actorId) } : { type: 'system', id: 'system' },
      action,
      module: 'metrics',
      resource: { type: 'metric', id: key },
      tenantId,
      after,
    });
  } catch {
    /* best-effort */
  }
}

/** Engine filter list, validated against the strict contract (errors under `at`). */
function sanitizeFilters(value, at, fail) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { fail(at, 'must be an array of filters'); return []; }
  if (value.length > METRIC_LIMITS.FILTERS_MAX) fail(at, `at most ${METRIC_LIMITS.FILTERS_MAX} filters`);
  try {
    // `at` ends with "filters"; the engine reports `filters[0].op` under that prefix.
    return engine.validateQuery({ filters: value }, { keys: ['filters'], prefix: at.slice(0, -'filters'.length) }).filters ?? [];
  } catch (err) {
    for (const e of err.errors ?? []) fail(e.field, e.message);
    return [];
  }
}

/** One aggregation (simple metric or a side of a ratio). */
function sanitizeAggregation({ aggregation, field }, at, fail, { allowRatio }) {
  const allowed = allowRatio ? METRIC_KINDS : METRIC_AGGREGATIONS;
  if (!allowed.includes(aggregation)) {
    fail(`${at}aggregation`, `must be one of ${allowed.join(', ')}`);
    return { aggregation, field: null };
  }
  if (aggregation === 'ratio') return { aggregation, field: null };
  const hasField = field !== undefined && field !== null && field !== '';
  if (aggregation === 'count') {
    if (hasField && !engine.isSafeName(field)) fail(`${at}field`, 'must be a field name without "$" or "."');
    return { aggregation, field: null };
  }
  if (!hasField) fail(`${at}field`, `is required for ${aggregation}`);
  else if (!engine.isSafeName(field)) fail(`${at}field`, 'must be a field name without "$" or "."');
  return { aggregation, field: hasField ? String(field) : null };
}

function sanitizePart(value, at, fail) {
  if (!isPlainObject(value)) { fail(at, 'must be an object { aggregation, field?, filters? }'); return null; }
  for (const k of Object.keys(value)) if (!PART_KEYS.has(k)) fail(`${at}.${k}`, 'is not a recognised field');
  const agg = sanitizeAggregation(value, `${at}.`, fail, { allowRatio: false });
  return { ...agg, filters: sanitizeFilters(value.filters, `${at}.filters`, fail) };
}

function optionalText(value, at, max, fail) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') { fail(at, 'must be a string'); return null; }
  const text = value.trim();
  if (text.length > max) fail(at, `must be at most ${max} characters`);
  return text || null;
}

/**
 * Validate a full definition (create, or an update merged onto the previous
 * version). Returns the normalised definition fields.
 *
 * @throws {ApiError} 400 METRIC_INVALID with field errors.
 */
export function sanitizeDefinition(input) {
  const errors = [];
  const fail = (field, message) => errors.push({ field, message });
  if (!isPlainObject(input)) throw invalid([{ field: 'body', message: 'must be an object' }]);
  for (const k of Object.keys(input)) if (!DEFINITION_FIELDS.includes(k)) fail(k, 'is not a recognised field');

  const key = typeof input.key === 'string' ? input.key.trim() : input.key;
  if (typeof key !== 'string' || !METRIC_KEY_PATTERN.test(key)) {
    fail('key', 'must start with a lowercase letter and use only a-z, 0-9 and _ (max 64)');
  }
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) fail('label', 'is required');
  else if (label.length > METRIC_LIMITS.LABEL_MAX) fail('label', `must be at most ${METRIC_LIMITS.LABEL_MAX} characters`);
  const description = optionalText(input.description, 'description', METRIC_LIMITS.DESCRIPTION_MAX, fail) ?? '';
  const connectorId = String(input.connectorId ?? '');
  if (!OBJECT_ID_RE.test(connectorId)) fail('connectorId', 'must be a dataset id');

  const out = {
    key,
    label,
    description,
    connectorId,
    ...sanitizeAggregation({ aggregation: input.aggregation, field: input.field }, '', fail, { allowRatio: true }),
    numerator: null,
    denominator: null,
    filters: sanitizeFilters(input.filters, 'filters', fail),
    unit: optionalText(input.unit, 'unit', METRIC_LIMITS.UNIT_MAX, fail),
    format: input.format ?? 'number',
    direction: input.direction ?? 'higher_is_better',
    owner: input.owner === undefined || input.owner === null || input.owner === '' ? null : String(input.owner).slice(0, 64),
  };
  if (out.aggregation === 'ratio') {
    out.numerator = sanitizePart(input.numerator, 'numerator', fail);
    out.denominator = sanitizePart(input.denominator, 'denominator', fail);
    if (out.format === 'number' && input.format === undefined) out.format = 'percent';
  } else {
    if (input.numerator !== undefined && input.numerator !== null) fail('numerator', 'is only allowed for a ratio');
    if (input.denominator !== undefined && input.denominator !== null) fail('denominator', 'is only allowed for a ratio');
  }
  if (!METRIC_FORMATS.includes(out.format)) fail('format', `must be one of ${METRIC_FORMATS.join(', ')}`);
  if (!METRIC_DIRECTIONS.includes(out.direction)) fail('direction', `must be one of ${METRIC_DIRECTIONS.join(', ')}`);
  if (errors.length) throw invalid(errors);
  return out;
}

async function assertDatasetOwned(tenantId, connectorId) {
  const connector = await connectorRepository.findById(String(connectorId), { tenantId: String(tenantId) });
  if (!connector) throw invalid([{ field: 'connectorId', message: 'must be a dataset of this workspace' }]);
  return connector;
}

/** Public view of a version. */
function present(doc, extra = {}) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    key: doc.key,
    version: doc.version,
    label: doc.label,
    description: doc.description ?? '',
    connectorId: doc.connectorId ? String(doc.connectorId) : null,
    aggregation: doc.aggregation,
    field: doc.field ?? null,
    numerator: doc.numerator ?? null,
    denominator: doc.denominator ?? null,
    filters: doc.filters ?? [],
    unit: doc.unit ?? null,
    format: doc.format,
    direction: doc.direction,
    owner: doc.owner ?? null,
    source: doc.source ?? 'manual',
    rationale: doc.rationale ?? null,
    status: doc.status,
    createdBy: doc.createdBy ?? null,
    approvedBy: doc.approvedBy ?? null,
    approvedAt: doc.approvedAt ?? null,
    archivedAt: doc.archivedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    ...extra,
  };
}

/** The resolved (contract) shape of a version. */
function resolvedView(doc) {
  return {
    key: doc.key,
    version: doc.version,
    label: doc.label,
    connectorId: String(doc.connectorId),
    aggregation: doc.aggregation,
    field: doc.field ?? null,
    numerator: doc.numerator ?? null,
    denominator: doc.denominator ?? null,
    filters: doc.filters ?? [],
    unit: doc.unit ?? null,
    format: doc.format,
    direction: doc.direction,
  };
}

/* ------------------------------- contract --------------------------------- */

/**
 * Latest version per key (with `status`, the latest version in that status:
 * `approved` lists what `metric:<key>` resolves to). Each entry carries
 * `approvedVersion` (the version queries use, or null).
 */
export async function list({ tenantId, status, search, connectorId, page = 1, limit = 50 } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (status !== undefined && status !== null && !METRIC_STATUSES.includes(status)) {
    throw invalid([{ field: 'status', message: `must be one of ${METRIC_STATUSES.join(', ')}` }]);
  }
  if (connectorId !== undefined && connectorId !== null && !OBJECT_ID_RE.test(String(connectorId))) {
    throw invalid([{ field: 'connectorId', message: 'must be a dataset id' }]);
  }
  const result = await metricRepository.listLatest({ tenantId, status: status ?? undefined, search, connectorId, page, limit });
  const approved = await metricRepository.approvedVersions({ tenantId, keys: result.docs.map((d) => d.key) });
  return { ...result, docs: result.docs.map((d) => present(d, { approvedVersion: approved.get(d.key) ?? null })) };
}

/** One version of a metric (latest when `version` is omitted), with its version list. */
export async function get({ tenantId, key, version } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (typeof key !== 'string' || !METRIC_KEY_PATTERN.test(key)) throw notFound(key);
  const versions = await metricRepository.listVersions({ tenantId, key });
  if (!versions.length) throw notFound(key);
  const doc = version === undefined || version === null
    ? versions[0]
    : versions.find((v) => v.version === Number(version));
  if (!doc) throw notFound(`${key}@${version}`);
  const approvedVersion = versions.find((v) => v.status === 'approved')?.version ?? null;
  return present(doc, {
    approvedVersion,
    versions: versions.map((v) => ({ version: v.version, status: v.status, createdAt: v.createdAt, createdBy: v.createdBy ?? null, approvedAt: v.approvedAt ?? null })),
  });
}

/**
 * Resolve a metric reference: 'metric:<key>' -> the highest approved version;
 * 'metric:<key>@<n>' -> version n when approved. Null when nothing resolves
 * (unknown, draft-only, archived, other tenant). `includeDrafts` lets a
 * reviewer preview an unapproved version; queries never pass it.
 */
export async function resolveMetricRef({ tenantId, ref, includeDrafts = false } = {}) {
  if (!tenantId || typeof ref !== 'string') return null;
  const match = engine.METRIC_REF_RE.exec(ref);
  if (!match) return null;
  const key = match[1];
  const version = match[2] ? Number(match[2]) : null;
  let doc;
  if (version) {
    doc = await metricRepository.findVersion({ tenantId, key, version });
    if (doc && doc.status !== 'approved' && !(includeDrafts && doc.status === 'draft')) doc = null;
  } else {
    doc = await metricRepository.findLatest({ tenantId, key, status: 'approved' });
    if (!doc && includeDrafts) doc = await metricRepository.findLatest({ tenantId, key, status: 'draft' });
  }
  return doc ? resolvedView(doc) : null;
}

/* ------------------------------- lifecycle -------------------------------- */

/** Create a metric: version 1, draft. 409 METRIC_EXISTS when the key is taken. */
export async function create({ tenantId, actorId = null, input, source = 'manual', rationale = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const def = sanitizeDefinition(input);
  await assertDatasetOwned(tenantId, def.connectorId);
  const existing = await metricRepository.findLatest({ tenantId, key: def.key });
  if (existing) {
    throw new ApiError(409, `A metric with key "${def.key}" already exists`, { code: METRIC_ERROR_CODES.EXISTS });
  }
  let doc;
  try {
    doc = await metricRepository.create({
      tenantId: String(tenantId), ...def, version: 1, status: 'draft', source, rationale, createdBy: actorId ? String(actorId) : null,
    });
  } catch (err) {
    if (err?.code === 11000) throw new ApiError(409, `A metric with key "${def.key}" already exists`, { code: METRIC_ERROR_CODES.EXISTS });
    throw err;
  }
  await audit({ tenantId, actorId, action: 'metric.created', key: def.key, after: { version: 1, status: 'draft', source } });
  return present(doc, { approvedVersion: null });
}

/**
 * Edit a metric: the patch is applied to the latest version and saved as
 * the NEXT version (draft). Stored versions never change, so a widget pinned
 * to an older approved version keeps its numbers.
 */
export async function update({ tenantId, key, actorId = null, patch = {} } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const latest = await metricRepository.findLatest({ tenantId, key });
  if (!latest) throw notFound(key);
  if (latest.status === 'archived') {
    throw new ApiError(409, `Metric "${key}" is archived`, { code: METRIC_ERROR_CODES.ARCHIVED });
  }
  if (!isPlainObject(patch) || !Object.keys(patch).length) throw invalid([{ field: 'body', message: 'nothing to change' }]);
  if (patch.key !== undefined && patch.key !== key) throw invalid([{ field: 'key', message: 'cannot be changed' }]);
  const base = Object.fromEntries(DEFINITION_FIELDS.map((f) => [f, latest[f]]));
  base.connectorId = String(latest.connectorId);
  const def = sanitizeDefinition({ ...base, ...patch, key });
  await assertDatasetOwned(tenantId, def.connectorId);
  let doc;
  try {
    doc = await metricRepository.create({
      tenantId: String(tenantId), ...def, version: latest.version + 1, status: 'draft', source: 'manual', createdBy: actorId ? String(actorId) : null,
    });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict(`Metric "${key}" was changed concurrently; reload and retry`);
    throw err;
  }
  await audit({ tenantId, actorId, action: 'metric.version_created', key, after: { version: doc.version, status: 'draft' } });
  return get({ tenantId, key, version: doc.version });
}

/** Approve one draft version (409 METRIC_NOT_DRAFT otherwise). */
export async function approve({ tenantId, key, version, actorId = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1) throw invalid([{ field: 'version', message: 'must be a version number' }]);
  const doc = await metricRepository.findVersion({ tenantId, key, version: v });
  if (!doc) throw notFound(`${key}@${v}`);
  if (doc.status !== 'draft') {
    throw new ApiError(409, `Version ${v} of "${key}" is ${doc.status}, not a draft`, { code: METRIC_ERROR_CODES.NOT_DRAFT });
  }
  const updated = await metricRepository.setStatus({
    tenantId, key, version: v, from: 'draft', to: 'approved',
    set: { approvedBy: actorId ? String(actorId) : null, approvedAt: new Date() },
  });
  if (!updated) throw new ApiError(409, `Version ${v} of "${key}" is no longer a draft`, { code: METRIC_ERROR_CODES.NOT_DRAFT });
  await audit({ tenantId, actorId, action: 'metric.approved', key, after: { version: v } });
  return get({ tenantId, key, version: v });
}

/** Archive every version of a metric: references stop resolving. */
export async function archive({ tenantId, key, actorId = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const latest = await metricRepository.findLatest({ tenantId, key });
  if (!latest) throw notFound(key);
  const changed = await metricRepository.archiveKey({ tenantId, key, by: actorId ? String(actorId) : null });
  await audit({ tenantId, actorId, action: 'metric.archived', key, after: { versions: changed } });
  return { key, archived: true, versions: changed };
}

/* ------------------------------- profiler --------------------------------- */

function slug(name) {
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(s) ? s : `f_${s}`;
}

/**
 * Draft metrics suggested from the dataset schema (datasets contract): a row
 * count, the sum of each numeric measure (not personal, not an identifier,
 * not constant) and the distinct count of the key field. Suggestions are
 * drafts a person must approve; keys that already exist are skipped.
 *
 * @returns {Promise<{ created: object[], skipped: Array<{ key: string, reason: string }> }>}
 */
export async function suggest({ tenantId, connectorId, actorId = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!OBJECT_ID_RE.test(String(connectorId ?? ''))) throw invalid([{ field: 'connectorId', message: 'must be a dataset id' }]);
  const connector = await assertDatasetOwned(tenantId, connectorId);
  const schema = await getSchema({ tenantId, connectorId: String(connector._id) });
  if (!schema) throw invalid([{ field: 'connectorId', message: 'has no schema yet; sync the dataset first' }]);
  const datasetSlug = slug(connector.name ?? 'dataset').slice(0, 30);
  const candidates = [{
    key: `${datasetSlug}_rows`.slice(0, 64),
    label: `${connector.name ?? 'Dataset'} rows`,
    aggregation: 'count',
    field: null,
    format: 'integer',
    rationale: `Number of rows in ${connector.name ?? 'the dataset'}.`,
  }];
  for (const field of schema.fields ?? []) {
    if (!NUMERIC_TYPES.has(field.type) || field.personal) continue;
    if (/(^id$|_id$)/i.test(field.name) || field.name === schema.keyField) continue;
    if (field.distinctEstimate !== undefined && field.distinctEstimate <= 1) continue;
    if (!engine.isSafeName(field.name)) continue;
    candidates.push({
      key: `total_${slug(field.name)}`.slice(0, 64),
      label: `Total ${field.displayName ?? field.name}`,
      aggregation: 'sum',
      field: field.name,
      format: field.type === 'integer' ? 'integer' : 'number',
      rationale: `${field.name} is numeric with ${(Number(field.nullRate ?? 0) * 100).toFixed(1)}% nulls; summed.`,
    });
  }
  if (schema.keyField && engine.isSafeName(schema.keyField)) {
    candidates.push({
      key: `distinct_${slug(schema.keyField)}`.slice(0, 64),
      label: `Distinct ${schema.keyField}`,
      aggregation: 'count_distinct',
      field: schema.keyField,
      format: 'integer',
      rationale: `${schema.keyField} looks like the record key; distinct values counted.`,
    });
  }
  const picked = candidates.slice(0, MAX_SUGGESTIONS);
  const taken = await metricRepository.existingKeys({ tenantId, keys: picked.map((c) => c.key) });
  const created = [];
  const skipped = [];
  for (const c of picked) {
    if (taken.has(c.key)) { skipped.push({ key: c.key, reason: 'exists' }); continue; }
    const { rationale, ...input } = c;
    try {
      created.push(await create({ tenantId, actorId, input: { ...input, connectorId: String(connector._id) }, source: 'profiler', rationale }));
    } catch (err) {
      skipped.push({ key: c.key, reason: err?.code === METRIC_ERROR_CODES.EXISTS ? 'exists' : 'invalid' });
    }
  }
  return { created, skipped };
}

/**
 * Field errors for every `metric:<key>` reference in an engine query that is
 * not an approved (active) metric: drafts, archived and deleted metrics are
 * rejected, like dashboards do (see dashboard.service metricRefErrors).
 */
export async function metricRefErrors({ tenantId, query, prefix = 'query.' } = {}) {
  const errors = [];
  const metrics = Array.isArray(query?.metrics) ? query.metrics : [];
  for (let i = 0; i < metrics.length; i += 1) {
    const ref = metrics[i]?.ref;
    if (typeof ref !== 'string') continue;
    const def = await resolveMetricRef({ tenantId, ref });
    if (!def) errors.push({ field: `${prefix}metrics[${i}].ref`, message: `"${ref}" is not an active metric (it may be a draft, archived or deleted)` });
  }
  return errors;
}

/** Throw 400 INVALID_QUERY unless every metric reference is approved. */
export async function assertMetricRefsActive({ tenantId, query, prefix = 'query.' } = {}) {
  const errors = await metricRefErrors({ tenantId, query, prefix });
  if (errors.length) throw new ApiError(400, 'Invalid analytics query', { code: engine.QUERY_ERROR_CODES.INVALID_QUERY, errors });
}

export default {
  list,
  get,
  resolveMetricRef,
  create,
  update,
  approve,
  archive,
  suggest,
  sanitizeDefinition,
  METRIC_ERROR_CODES,
};
