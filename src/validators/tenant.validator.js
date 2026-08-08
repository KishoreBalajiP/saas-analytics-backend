/**
 * Tenant Validators (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Declarative request-shape schemas consumed by `validate(schema)` from
 *   `src/validators/index.js`. Covers the full `/tenants` surface: CRUD,
 *   lifecycle, onboarding, members, settings and ownership.
 *
 * RESPONSIBILITY
 *   - createTenantSchema / updateTenantSchema / listTenantSchema - CRUD
 *   - lifecycleSchema (suspend / restore / disable / archive)
 *   - initializeSchema (onboarding)
 *   - membersSchema / statisticsSchema / billingSchema - read surfaces
 *   - settingsGetSchema / settingsUpdateSchema - tenant settings
 *   - changeOwnerSchema - ownership reassignment
 *
 * CODING GUIDELINES
 *   - `status` is NEVER accepted on create/update: lifecycle transitions
 *     go through the dedicated endpoints only.
 *   - Enums are imported from the model so validators never drift from
 *     the persisted shape.
 *   - `owner` and `values` are nested objects validated via `custom` (the
 *     engine has no nested-schema support yet).
 */

import { TENANT_STATUSES } from '../models/Tenant.js';
import { SETTINGS_GROUPS } from '../services/tenantSettings.service.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Optional owner payload: `{ email?, name?, password? }`. */
const ownerRule = {
  type: 'object',
  custom: (value) => {
    if (value == null) return true;
    if (typeof value !== 'object' || Array.isArray(value)) return 'owner must be an object';
    if (value.email !== undefined && !EMAIL_RE.test(String(value.email))) {
      return 'owner.email must be a valid email';
    }
    if (value.name !== undefined && typeof value.name !== 'string') return 'owner.name must be a string';
    if (value.password !== undefined && (typeof value.password !== 'string' || value.password.length < 8)) {
      return 'owner.password must be at least 8 characters';
    }
    return true;
  },
};

/** @type {import('../index.js').Schema} */
export const createTenantSchema = {
  body: {
    name: { type: 'string', required: true, minLength: 2, maxLength: 120 },
    logoUrl: { type: 'url' },
    planId: { type: 'string', maxLength: 64 },
    billingEmail: { type: 'email' },
    country: { type: 'string', minLength: 2, maxLength: 2 },
    defaultLocale: { type: 'string', minLength: 2, maxLength: 16 },
    defaultTimezone: { type: 'string', minLength: 1, maxLength: 64 },
    defaultCurrency: { type: 'string', minLength: 3, maxLength: 3 },
    trialEndsAt: { type: 'date' },
    initialize: { type: 'boolean' },
    owner: ownerRule,
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const updateTenantSchema = {
  body: {
    name: { type: 'string', minLength: 2, maxLength: 120 },
    logoUrl: { type: 'url' },
    planId: { type: 'string', maxLength: 64 },
    billingEmail: { type: 'email' },
    country: { type: 'string', minLength: 2, maxLength: 2 },
    defaultLocale: { type: 'string', minLength: 2, maxLength: 16 },
    defaultTimezone: { type: 'string', minLength: 1, maxLength: 64 },
    defaultCurrency: { type: 'string', minLength: 3, maxLength: 3 },
    trialEndsAt: { type: 'date' },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const listTenantSchema = {
  body: {},
  params: {},
  query: {
    status: { type: 'string', oneOf: [...TENANT_STATUSES] },
    search: { type: 'string', maxLength: 120 },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** Shared by suspend / restore / disable / archive. */
export const lifecycleSchema = {
  body: {
    reason: { type: 'string', maxLength: 500 },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const initializeSchema = {
  body: {
    owner: ownerRule,
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const membersSchema = {
  body: {},
  params: {
    id: 'objectId|required',
  },
  query: {
    search: { type: 'string', maxLength: 120 },
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

/** @type {import('../index.js').Schema} */
export const statisticsSchema = {
  body: {},
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const billingSchema = {
  body: {},
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const settingsGetSchema = {
  body: {},
  params: {
    id: 'objectId|required',
  },
  query: {
    group: { type: 'string', oneOf: [...SETTINGS_GROUPS] },
    includeSecrets: { type: 'boolean' },
  },
};

/** @type {import('../index.js').Schema} */
export const settingsUpdateSchema = {
  body: {
    group: { type: 'string', required: true, oneOf: [...SETTINGS_GROUPS] },
    values: {
      type: 'object',
      required: true,
      custom: (value) => (
        value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
          ? true
          : 'values must be a non-empty object'
      ),
    },
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

/** @type {import('../index.js').Schema} */
export const changeOwnerSchema = {
  body: {
    userId: 'objectId|required',
  },
  params: {
    id: 'objectId|required',
  },
  query: {},
};

export default {
  createTenantSchema,
  updateTenantSchema,
  listTenantSchema,
  lifecycleSchema,
  initializeSchema,
  membersSchema,
  statisticsSchema,
  billingSchema,
  settingsGetSchema,
  settingsUpdateSchema,
  changeOwnerSchema,
  _meta: { phase: '3 - implemented' },
};
