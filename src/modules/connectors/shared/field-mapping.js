/**
 * Shared field-mapping layer.
 *
 * WHY IT EXISTS
 *   Every connector ingests records whose field names/types do not match the
 *   target schema (a CSV column `cust_id` maps to `customerId`; a webhook
 *   `total_usd` maps to `amount` as a number). This module is the single
 *   place that normalises source records into the platform's canonical
 *   shape, so the sync engine and every future provider share one mapping
 *   contract.
 *
 * MAPPING FORMS (both supported, mutually exclusive per connector):
 *   Simple object - source field per target:
 *     { customerId: 'cust_id', amount: 'total' }
 *
 *   Declarative array - per-field source, target, type + transform:
 *     [
 *       { source: 'cust_id', target: 'customerId', type: 'string' },
 *       { source: 'total', target: 'amount', type: 'number', transform: 'round2' },
 *       { source: 'date', target: 'occurredAt', type: 'date' },
 *     ]
 *
 * TRANSFORMS (built-ins; see TRANSFORMS). A `transform` may also be a
 *   function for fully custom behaviour.
 *
 * IDEMPOTENCY
 *   `deriveSourceRowId(record, mapping)` returns a stable key per source row:
 *   the `idField` value when configured, otherwise a SHA-256 of the record.
 *   The `{ connectorId, sourceRowId }` unique index then makes replays of
 *   the same source rows a no-op.
 */

import crypto from 'node:crypto';

/** Normalise a value to `type`. Returns `null` when coercion fails. */
const TYPES = Object.freeze({
  string: (v) => (v === null || v === undefined ? null : String(v).trim()),
  number: (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  },
  integer: (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  },
  boolean: (v) => {
    if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
    return null;
  },
  date: (v) => {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  },
  json: (v) => {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'string') {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v;
  },
});

/** Built-in value transforms applied after type coercion. */
const TRANSFORMS = Object.freeze({
  trim: (v) => (typeof v === 'string' ? v.trim() : v),
  lower: (v) => (typeof v === 'string' ? v.toLowerCase() : v),
  upper: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
  round2: (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v),
  round0: (v) => (typeof v === 'number' ? Math.round(v) : v),
  int: (v) => (typeof v === 'number' ? Math.trunc(v) : v),
  string: (v) => (v === null || v === undefined ? null : String(v)),
});

/**
 * Normalise a single raw value to `type`, then apply `transform`.
 *
 * @param {*} value
 * @param {Object} [opts]
 * @param {string} [opts.type='string']
 * @param {string|Function} [opts.transform]
 * @returns {*}
 */
export function normalizeValue(value, { type = 'string', transform } = {}) {
  const coerced = (TYPES[type] ?? TYPES.string)(value);
  if (coerced === null) return null;
  if (typeof transform === 'function') return transform(coerced);
  if (typeof transform === 'string' && typeof TRANSFORMS[transform] === 'function') {
    return TRANSFORMS[transform](coerced);
  }
  return coerced;
}

/** Stable serialisation (sorted keys) so row hashes are deterministic. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

/** Parse a mapping into the declarative array form. */
export function normalizeMapping(mapping) {
  if (!mapping) return [];
  if (Array.isArray(mapping)) return mapping;
  if (typeof mapping === 'object') {
    return Object.entries(mapping).map(([target, spec]) => {
      if (typeof spec === 'string') return { source: spec, target };
      if (spec && typeof spec === 'object') {
        return { source: spec.source ?? null, target, type: spec.type, transform: spec.transform };
      }
      return { source: null, target };
    });
  }
  return [];
}

/**
 * Map one raw source record into the canonical shape.
 *
 * @param {Object} record - raw source record.
 * @param {Object|Array} [mapping] - field mapping (either form).
 * @returns {{ data: Object, skipped: string[], errors: Array<{field: string, message: string}> }}
 */
export function mapRecord(record, mapping) {
  const rules = normalizeMapping(mapping);
  const data = {};
  const skipped = [];
  const errors = [];

  if (rules.length === 0) {
    // No mapping declared - pass the record through unchanged.
    return { data: { ...(record ?? {}) }, skipped, errors };
  }

  for (const rule of rules) {
    const { source, target, type, transform } = rule;
    if (!target) continue;
    const raw = source != null ? record?.[source] : record?.[target];
    if (raw === undefined || raw === null || raw === '') {
      if (rule.required) {
        errors.push({ field: target, message: `Field "${target}" is required but missing` });
      }
      skipped.push(target);
      continue;
    }
    const value = normalizeValue(raw, { type, transform });
    if (value === null) {
      if (rule.required) {
        errors.push({ field: target, message: `Field "${target}" could not be normalised to ${type ?? 'string'}` });
      }
      skipped.push(target);
      continue;
    }
    data[target] = value;
  }

  return { data, skipped, errors };
}

/**
 * Apply a field mapping to a collection of raw records.
 *
 * @param {Array|Iterable} records - raw source records.
 * @param {Object|Array} [mapping]
 * @returns {Array<{ sourceRowId: string, data: Object, skipped: string[], errors: Array }>}
 */
export function applyFieldMapping(records, mapping) {
  return (records ?? []).map((record) => {
    const { data, skipped, errors } = mapRecord(record, mapping);
    return { sourceRowId: deriveSourceRowId(record, mapping), data, skipped, errors };
  });
}

/**
 * Derive a stable, unique `sourceRowId` for a source record. Prefers the
 * configured `idField` (e.g. a webhook event id or a CSV customer id);
 * otherwise hashes the record so identical replays produce the same key.
 *
 * @param {Object} record - raw source record.
 * @param {Object|Array} [mapping]
 * @returns {string}
 */
export function deriveSourceRowId(record, mapping) {
  const idField = mapping?.idField ?? mapping?.id;
  if (idField && record?.[idField] !== undefined && record[idField] !== null && record[idField] !== '') {
    return `${idField}:${String(record[idField])}`;
  }
  return crypto.createHash('sha256').update(stableStringify(record ?? {})).digest('hex');
}

export default {
  normalizeValue,
  normalizeMapping,
  mapRecord,
  applyFieldMapping,
  deriveSourceRowId,
  TYPES,
  TRANSFORMS,
};
