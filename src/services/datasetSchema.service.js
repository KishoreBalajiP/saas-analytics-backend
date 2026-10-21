/**
 * Dataset schema service (datasets, roadmap 3.7).
 *
 * Contract (used by the visualization builder and AI packages):
 *   getSchema({ tenantId, connectorId }) -> { connectorId, version, profiledAt,
 *     fields: [{ name, type, nullable, nullRate, distinctEstimate, personal,
 *     displayName, sample }], dateField, keyField } | null
 *   listSchemas({ tenantId }) -> Array<same shape>
 *
 * profileConnector({ tenantId, connectorId }) re-infers the schema from a
 * sample of the connector's rows; the sync worker calls it after a
 * successful sync.
 */

import mongoose from 'mongoose';
import { DatasetSchema } from '../models/DatasetSchema.js';
import { ConnectorRow } from '../models/ConnectorRow.js';

const SAMPLE_ROWS = 1000;
const SAMPLE_VALUES = 3;
const MATCH_RATIO = 0.95;
const PERSONAL_NAME_RE = /(e-?mail|phone|mobile|first_?name|last_?name|full_?name|surname|address|street|postcode|zip|ssn|passport|birth|dob|ip_?addr)/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE_RES = [/^\d{4}-\d{2}-\d{2}$/, /^\d{4}\/\d{1,2}\/\d{1,2}$/, /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/];
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const BOOL_VALUES = new Set(['true', 'false', 'yes', 'no']);

/** Classify one non-null value. */
export function classifyValue(value) {
  if (value instanceof Date) return 'datetime';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value !== 'string') return 'string';
  const text = value.trim();
  if (INT_RE.test(text)) return 'integer';
  if (NUM_RE.test(text)) return 'number';
  if (BOOL_VALUES.has(text.toLowerCase())) return 'boolean';
  if (DATETIME_RE.test(text)) return 'datetime';
  if (DATE_RES.some((re) => re.test(text))) return 'date';
  return 'string';
}

const isNull = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Pick the field type that covers at least 95% of the non-null values. */
function pickType(counts, total) {
  if (total === 0) return 'string';
  const share = (...types) => types.reduce((n, t) => n + (counts[t] || 0), 0) / total;
  if (share('integer') >= MATCH_RATIO) return 'integer';
  if (share('integer', 'number') >= MATCH_RATIO) return 'number';
  if (share('boolean') >= MATCH_RATIO) return 'boolean';
  if (share('date') >= MATCH_RATIO) return 'date';
  if (share('date', 'datetime') >= MATCH_RATIO) return 'datetime';
  return 'string';
}

/** Infer typed fields from plain row data objects (pure; testable). */
export function inferFields(rows = []) {
  const stats = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const [name, value] of Object.entries(row)) {
      if (!stats.has(name)) stats.set(name, { nulls: 0, counts: {}, distinct: new Set(), samples: [], email: 0 });
      const s = stats.get(name);
      if (isNull(value)) { s.nulls += 1; continue; }
      const t = classifyValue(value);
      s.counts[t] = (s.counts[t] || 0) + 1;
      const key = value instanceof Date ? value.toISOString() : String(value);
      if (s.distinct.size < 10000) s.distinct.add(key);
      if (s.samples.length < SAMPLE_VALUES && !s.samples.includes(key)) s.samples.push(key);
      if (typeof value === 'string' && EMAIL_RE.test(value.trim())) s.email += 1;
    }
  }
  const total = rows.length || 1;
  return [...stats.entries()].map(([name, s]) => {
    // Rows that do not carry the key at all count as nulls too.
    const nonNull = Object.values(s.counts).reduce((a, b) => a + b, 0);
    const nulls = total - nonNull;
    const personal = PERSONAL_NAME_RE.test(name) || (nonNull > 0 && s.email / nonNull >= 0.5);
    return {
      name,
      type: pickType(s.counts, nonNull),
      nullable: nulls > 0,
      nullRate: Math.round((nulls / total) * 1000) / 1000,
      distinctEstimate: s.distinct.size,
      personal,
      displayName: null,
      sample: personal ? s.samples.map(() => '***') : s.samples,
    };
  });
}

function guessDateField(fields) {
  const dates = fields.filter((f) => f.type === 'date' || f.type === 'datetime');
  return (dates.find((f) => /date|time|_at$|day/i.test(f.name)) ?? dates[0])?.name ?? null;
}

function guessKeyField(fields, sampled) {
  const candidates = fields.filter((f) => !f.nullable && sampled > 0 && f.distinctEstimate === sampled
    && ['string', 'integer'].includes(f.type));
  return (candidates.find((f) => /(^|_)id$|key$/i.test(f.name)) ?? null)?.name ?? null;
}

function toContract(doc) {
  if (!doc) return null;
  return {
    connectorId: String(doc.connectorId),
    version: doc.version,
    profiledAt: doc.profiledAt instanceof Date ? doc.profiledAt.toISOString() : doc.profiledAt,
    fields: (doc.fields ?? []).map((f) => ({
      name: f.name,
      type: f.type,
      nullable: Boolean(f.nullable),
      nullRate: f.nullRate ?? 0,
      distinctEstimate: f.distinctEstimate ?? 0,
      personal: Boolean(f.personal),
      displayName: f.displayName ?? null,
      sample: f.sample ?? [],
    })),
    dateField: doc.dateField ?? null,
    keyField: doc.keyField ?? null,
  };
}

/** Typed schema of one connector's dataset, or null when never profiled. */
export async function getSchema({ tenantId, connectorId } = {}) {
  if (!tenantId || !connectorId) return null;
  const doc = await DatasetSchema.findOne({ tenantId, connectorId: String(connectorId) }).lean();
  return toContract(doc);
}

/** Every profiled schema of a tenant. */
export async function listSchemas({ tenantId } = {}) {
  if (!tenantId) return [];
  const docs = await DatasetSchema.find({ tenantId }).sort({ connectorId: 1 }).lean();
  return docs.map(toContract);
}

/**
 * Re-profile a connector from a sample of its newest rows and persist the
 * result as the next schema version. Display names, personal flags and the
 * chosen date/key fields of the previous version are carried over.
 */
export async function profileConnector({ tenantId, connectorId, dataVersion = 0 } = {}) {
  if (!tenantId || !connectorId || !mongoose.isValidObjectId(String(connectorId))) return null;
  const rows = await ConnectorRow.find(
    { tenantId, connectorId: new mongoose.Types.ObjectId(String(connectorId)), deletedAt: null },
    { data: 1 },
  ).sort({ ingestedAt: -1 }).limit(SAMPLE_ROWS).lean();
  const data = rows.map((r) => r.data);
  const fields = inferFields(data);
  const previous = await DatasetSchema.findOne({ tenantId, connectorId: String(connectorId) }).lean();
  const prevByName = new Map((previous?.fields ?? []).map((f) => [f.name, f]));
  for (const f of fields) {
    const prev = prevByName.get(f.name);
    if (prev?.displayName) f.displayName = prev.displayName;
  }
  const names = new Set(fields.map((f) => f.name));
  const keep = (name) => (name && names.has(name) ? name : null);
  const doc = await DatasetSchema.findOneAndUpdate(
    { tenantId, connectorId: String(connectorId) },
    {
      $set: {
        fields,
        profiledAt: new Date(),
        dataVersion,
        version: (previous?.version ?? 0) + 1,
        dateField: keep(previous?.dateField) ?? guessDateField(fields),
        keyField: keep(previous?.keyField) ?? guessKeyField(fields, data.length),
      },
      $setOnInsert: { tenantId },
    },
    { upsert: true, new: true, lean: true },
  );
  return toContract(doc);
}

export default { getSchema, listSchemas, profileConnector, inferFields, classifyValue };
