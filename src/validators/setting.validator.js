/**
 * Setting Validators (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Request shape for the platform settings surface (`/api/v1/settings`).
 *   Shape only: the VALUE of a setting is validated per key by
 *   `services/settingRules.js` (type, range, format) and refused with a
 *   400 + field error, because the generic engine below cannot know each
 *   key's rule (and drops empty strings, which are legitimate values).
 *
 * SCHEMAS
 *   - listSchema       GET  /                  ?group&search
 *   - keyParamSchema   GET  /:key, /:key/secret
 *   - updateSchema     PUT  /:key              { value, version?, reason? }
 *   - resetSchema      POST /:key/reset        { version?, reason? }
 *   - historySchema    GET  /:key/history      ?page&limit
 *   - rollbackSchema   POST /:key/rollback     { toVersion, version?, reason? }
 */

import { SETTINGS_GROUPS } from '../services/tenantSettings.service.js';

/** Catalogue keys: `<group>.<name>`, lowercase. */
export const SETTING_KEY_PATTERN = '^[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)+$';

const keyParam = { key: { type: 'string', required: true, maxLength: 100, pattern: SETTING_KEY_PATTERN } };
const version = { type: 'integer', min: 0 };
const reason = { type: 'string', maxLength: 500 };

/** @type {import('./index.js').Schema} */
export const listSchema = {
  params: {},
  query: {
    group: { type: 'string', oneOf: SETTINGS_GROUPS.filter((group) => group !== 'feature_flags') },
    search: { type: 'string', maxLength: 100 },
  },
};

/** @type {import('./index.js').Schema} */
export const keyParamSchema = { params: keyParam, query: {} };

/** @type {import('./index.js').Schema} */
export const updateSchema = {
  params: keyParam,
  body: { value: { type: 'any' }, version, reason },
};

/** @type {import('./index.js').Schema} */
export const resetSchema = { params: keyParam, body: { version, reason } };

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

export default {
  listSchema,
  keyParamSchema,
  updateSchema,
  resetSchema,
  historySchema,
  rollbackSchema,
  SETTING_KEY_PATTERN,
};
