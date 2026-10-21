/**
 * Email Template Validators (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Request shape for `/api/v1/email-templates`. Shape only: placeholder
 *   syntax, the variable contract (unknown / missing required variables),
 *   lengths and the HTML safety rules are enforced by
 *   `services/emailTemplate.service.js#validateContent`, which answers 400
 *   EMAIL_TEMPLATE_INVALID with field errors.
 */

import { LOCALES } from '../models/EmailTemplate.js';

/** Built-in template keys: `<area>.<email>`. */
export const TEMPLATE_KEY_PATTERN = '^[a-z][a-z0-9_]*(?:\\.[a-z0-9_]+)+$';

const keyParam = { key: { type: 'string', required: true, maxLength: 100, pattern: TEMPLATE_KEY_PATTERN } };
const locale = { type: 'string', oneOf: [...LOCALES] };
const version = { type: 'integer', min: 0 };
const reason = { type: 'string', maxLength: 500 };

/** @type {import('./index.js').Schema} */
export const listSchema = { query: { locale } };

/** @type {import('./index.js').Schema} */
export const getSchema = { params: keyParam, query: { locale } };

/** @type {import('./index.js').Schema} */
export const updateSchema = {
  params: keyParam,
  body: {
    locale,
    subject: { type: 'string', required: true, maxLength: 1000 },
    text: { type: 'string', required: true },
    html: { type: 'string' },
    version,
    reason,
  },
};

/** @type {import('./index.js').Schema} */
export const resetSchema = { params: keyParam, body: { locale, version, reason } };

/** @type {import('./index.js').Schema} */
export const previewSchema = {
  params: keyParam,
  body: {
    locale,
    draft: { type: 'object' },
    variables: { type: 'object' },
  },
};

/** @type {import('./index.js').Schema} */
export const historySchema = {
  params: keyParam,
  query: {
    locale,
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** @type {import('./index.js').Schema} */
export const rollbackSchema = {
  params: keyParam,
  body: { locale, toVersion: { type: 'integer', required: true, min: 0 }, version, reason },
};

export default {
  listSchema,
  getSchema,
  updateSchema,
  resetSchema,
  previewSchema,
  historySchema,
  rollbackSchema,
  TEMPLATE_KEY_PATTERN,
};
