/**
 * Security Alert Validators (roadmap 2.6).
 *
 * Request shapes for `/admin/security-alerts`, consumed by `validate(schema)`
 * from `src/validators/index.js`. Filter values are plain scalars; the
 * repository builds the query from them (no operator can reach Mongo).
 */

import { ALERT_STATUSES, ALERT_SEVERITIES, NOTE_MAX_LENGTH } from '../models/SecurityAlert.js';

const dateParam = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  custom: (value) => (Number.isNaN(new Date(value).getTime()) ? 'must be a valid ISO date' : true),
};

/** Comma-separated list whose items all belong to `allowed`. */
function listOf(allowed) {
  return {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    custom: (value) => {
      const items = String(value).split(',').map((item) => item.trim()).filter(Boolean);
      if (items.length === 0) return 'must not be empty';
      const unknown = items.filter((item) => !allowed.includes(item));
      return unknown.length === 0 ? true : `must be one or more of: ${allowed.join(', ')}`;
    },
  };
}

const idParams = { id: { type: 'objectId', required: true } };

/** GET /admin/security-alerts */
export const listSchema = {
  body: {},
  params: {},
  query: {
    status: listOf(ALERT_STATUSES),
    severity: listOf(ALERT_SEVERITIES),
    ruleId: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z0-9_.]+$' },
    tenantId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
    search: { type: 'string', minLength: 1, maxLength: 100 },
    from: dateParam,
    to: dateParam,
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** GET /admin/security-alerts/:id */
export const getSchema = { body: {}, params: idParams, query: {} };

/** POST /admin/security-alerts/:id/acknowledge (note optional). */
export const acknowledgeSchema = {
  body: { note: { type: 'string', maxLength: NOTE_MAX_LENGTH } },
  params: idParams,
  query: {},
};

/** POST /admin/security-alerts/:id/false-positive | /resolve (note required). */
export const closeSchema = {
  body: { note: { type: 'string', required: true, minLength: 3, maxLength: NOTE_MAX_LENGTH } },
  params: idParams,
  query: {},
};

export default { listSchema, getSchema, acknowledgeSchema, closeSchema };
