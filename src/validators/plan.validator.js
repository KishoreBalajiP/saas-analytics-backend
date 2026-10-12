/**
 * Plan catalogue validators (Phase 6 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the plan catalogue. The plan's `data` field on
 *   `MasterData` carries the structured entitlement shape; this validator is
 *   the only place the shape is enforced so a Plan can never hold an
 *   invalid limit.
 *
 * CODING GUIDELINES
 *   - Limits are `{ max: number >= 0, hard: boolean }`. Negative or
 *     non-finite `max` is rejected.
 *   - Features are flat booleans. No nested feature trees.
 *   - `status` is one of the four canonical plan lifecycle values.
 *   - The validator runs at the door; the service layer never sees an
 *     invalid shape.
 */

const PLAN_STATUSES = Object.freeze(['active', 'disabled', 'archived', 'deprecated']);
const PLAN_TIER_MIN = 0;
const PLAN_TIER_MAX = 99;

const KNOWN_LIMIT_KEYS = Object.freeze([
  'members',
  'connectors',
  'dashboards',
  'reports',
  'alerts',
  'scheduledReports',
  'storedRows',
  'apiCallsPerDay',
]);

const KNOWN_FEATURE_KEYS = Object.freeze([
  'dashboards',
  'reports',
  'alerts',
  'scheduled_reports',
  'audit_export',
  'sso',
  'embed',
  'webhook_connectors',
]);

function limitSchema() {
  return {
    type: 'object',
    required: ['max', 'hard'],
    properties: {
      max: { type: 'integer', min: 0 },
      hard: { type: 'boolean' },
    },
  };
}

function limitsSchema() {
  const properties = {};
  for (const key of KNOWN_LIMIT_KEYS) properties[key] = limitSchema();
  return { type: 'object', properties };
}

function featuresSchema() {
  const properties = {};
  for (const key of KNOWN_FEATURE_KEYS) properties[key] = { type: 'boolean' };
  return { type: 'object', properties };
}

export const planStatusEnum = PLAN_STATUSES;

export const planDataSchema = {
  type: 'object',
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 1000 },
    status: { type: 'string', enum: [...PLAN_STATUSES] },
    tier: { type: 'integer', min: PLAN_TIER_MIN, max: PLAN_TIER_MAX },
    trialDays: { type: 'integer', min: 0, max: 365 },
    graceDays: { type: 'integer', min: 0, max: 90 },
    features: featuresSchema(),
    limits: limitsSchema(),
  },
};

export const createSchema = {
  body: {
    code: { type: 'string', required: true, minLength: 1, maxLength: 60, pattern: /^[a-z0-9_-]+$/ },
    name: { type: 'string', required: true, minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 1000 },
    data: planDataSchema,
    isSystem: { type: 'boolean' },
  },
};

export const updateSchema = {
  body: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 1000 },
    data: planDataSchema,
    isSystem: { type: 'boolean' },
  },
  params: {
    id: { type: 'objectId', required: true },
  },
};

export const listSchema = {
  query: {
    page: { type: 'integer', min: 1, max: 1000 },
    limit: { type: 'integer', min: 1, max: 100 },
    search: { type: 'string', maxLength: 200 },
  },
};

export const idParamSchema = {
  params: {
    id: { type: 'objectId', required: true },
  },
};

export const planConstants = Object.freeze({
  KNOWN_LIMIT_KEYS,
  KNOWN_FEATURE_KEYS,
  PLAN_STATUSES,
  PLAN_TIER_MIN,
  PLAN_TIER_MAX,
  /** Safety net for entitlement overrides; see plan section 7.3. */
  OVERRIDE_SAFETY_FACTOR: 1000,
});

export default {
  planStatusEnum,
  planDataSchema,
  createSchema,
  updateSchema,
  listSchema,
  idParamSchema,
  planConstants,
};
