/**
 * Audit filter builder - the single safe path from request input to a Mongo
 * query for the audit trail.
 *
 * WHY IT EXISTS
 *   The audit trail is the favourite target for enumeration and tampering.
 *   Both the `/audit-logs` list endpoint and the export pipeline must turn
 *   untrusted filter input into a Mongo query WITHOUT ever echoing raw user
 *   objects into the query (the classic `$where` / `$ne` / `$regex`
 *   injection). Every value is coerced to a trimmed string (objects become
 *   opaque `[object Object]` strings - never spread), and the free-text
 *   `search` term is regex-escaped before it reaches `$regex`.
 *
 * HOW TO EXTEND
 *   Add a new filterable field by appending it to the whitelist AND the
 *   `buildAuditFilter` switch. Never accept arbitrary keys.
 */

/** The only keys accepted as audit filters. */
export const AUDIT_FILTER_KEYS = Object.freeze([
  'tenantId',
  'module',
  'action',
  'actorId',
  'actorType',
  'result',
  'resourceType',
  'resourceId',
  'dateFrom',
  'dateTo',
  'search',
]);

/** Searchable text fields for the free-text `search` term. */
const SEARCH_FIELDS = Object.freeze(['module', 'action', 'actorDisplay', 'reason', 'requestId']);

/**
 * Keep only the whitelisted filter keys, coercing every value to a trimmed
 * string (never an object/array). Unknown keys are dropped.
 *
 * @param {Object} [input]
 * @returns {Object} sanitised filter map.
 */
export function sanitizeAuditFilters(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const key of AUDIT_FILTER_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    out[key] = String(raw).trim();
  }
  return out;
}

/**
 * Build a safe Mongo filter from sanitised audit filters.
 *
 * @param {Object} [input] - sanitised filters (see `sanitizeAuditFilters`).
 * @returns {Object} Mongo query filter (no raw user objects, no unescaped
 *   `$regex`).
 */
export function buildAuditFilter(input = {}) {
  const filter = {};

  for (const key of ['tenantId', 'module', 'action', 'actorId', 'actorType', 'result', 'resourceType', 'resourceId']) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== '') {
      filter[key] = String(value).trim();
    }
  }

  if (input.dateFrom || input.dateTo) {
    const range = {};
    if (input.dateFrom) range.$gte = toDate(input.dateFrom);
    if (input.dateTo) range.$lte = toDate(input.dateTo);
    if (Object.keys(range).length > 0) filter.occurredAt = range;
  }

  if (input.search && String(input.search).trim()) {
    const term = escapeRegExp(String(input.search).trim());
    filter.$or = SEARCH_FIELDS.map((field) => ({
      [field]: { $regex: term, $options: 'i' },
    }));
  }

  return filter;
}

/** Parse an ISO/date string into a Date, rejecting invalid values. */
function toDate(value) {
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  AUDIT_FILTER_KEYS,
  sanitizeAuditFilters,
  buildAuditFilter,
};
