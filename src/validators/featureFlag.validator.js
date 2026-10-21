/**
 * Feature Flag Validators (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Request shape for `/api/v1/feature-flags`. Shape only: the flag key
 *   format, rollout strategy / percentage / allow-list (including whether
 *   each allow-listed tenant exists) are validated by
 *   `services/featureFlag.service.js`, which answers 400 with field errors
 *   such as `rollout.tenantIds[2]`.
 */

/** `<namespace>.<name>`, lowercase, at least one dot. */
export const FLAG_KEY_PATTERN = '^[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)+$';

const keyParam = { key: { type: 'string', required: true, maxLength: 100, pattern: FLAG_KEY_PATTERN } };
const version = { type: 'integer', min: 0 };
const reason = { type: 'string', maxLength: 500 };
const flagBody = {
  name: { type: 'string', maxLength: 120 },
  description: { type: 'string', maxLength: 500 },
  enabled: { type: 'boolean' },
  rollout: { type: 'object' },
  reason,
};

/** @type {import('./index.js').Schema} */
export const listSchema = {
  query: {
    search: { type: 'string', maxLength: 100 },
    enabled: { type: 'boolean' },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** @type {import('./index.js').Schema} */
export const keyParamSchema = { params: keyParam };

/** @type {import('./index.js').Schema} */
export const createSchema = {
  body: { key: { type: 'string', required: true, maxLength: 100 }, ...flagBody },
};

/** @type {import('./index.js').Schema} */
export const updateSchema = { params: keyParam, body: { ...flagBody, version } };

/** @type {import('./index.js').Schema} */
export const deleteSchema = { params: keyParam, query: { version, reason } };

/** @type {import('./index.js').Schema} */
export const historySchema = {
  params: keyParam,
  query: {
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** @type {import('./index.js').Schema} */
export const rollbackSchema = {
  params: keyParam,
  body: { toVersion: { type: 'integer', required: true, min: 0 }, version, reason },
};

/** @type {import('./index.js').Schema} */
export const previewSchema = { query: { tenantId: { type: 'objectId', required: true } } };

export default {
  listSchema,
  keyParamSchema,
  createSchema,
  updateSchema,
  deleteSchema,
  historySchema,
  rollbackSchema,
  previewSchema,
  FLAG_KEY_PATTERN,
};
