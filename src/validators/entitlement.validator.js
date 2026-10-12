/**
 * Entitlement / usage validators (Phase 6 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the entitlement + usage HTTP surface.
 *
 * ENDPOINTS (workspace)
 *   - getUsage       GET  /tenants/:id/usage
 *
 * ENDPOINTS (admin overrides)
 *   - listOverrides    GET  /admin/entitlements/overrides
 *   - tenantOverrides  GET  /admin/entitlements/overrides/:tenantId
 *   - createOverride   POST /admin/entitlements/overrides/:tenantId
 *   - revokeOverride   POST /admin/entitlements/overrides/:id/revoke
 *
 * ENDPOINTS (admin usage)
 *   - adminUsage       GET  /admin/usage/:tenantId
 */

import { USAGE_METRICS } from '../models/UsageCounter.js';

export const getUsageSchema = {
  params: {
    id: { type: 'objectId', required: true },
  },
  query: {
    period: { type: 'string', maxLength: 32 },
  },
};

export const createOverrideSchema = {
  params: {
    tenantId: { type: 'objectId', required: true },
  },
  body: {
    metric: { type: 'string', maxLength: 60 },
    kind: { type: 'string', required: true, enum: ['feature', 'limit'] },
    value: { type: 'object', required: true },
    reason: { type: 'string', required: true, minLength: 1, maxLength: 500 },
    expiresAt: { type: 'date' },
  },
};

export const revokeOverrideSchema = {
  params: {
    id: { type: 'objectId', required: true },
  },
  body: {
    reason: { type: 'string', required: true, minLength: 1, maxLength: 500 },
  },
};

export const adminUsageSchema = {
  params: {
    tenantId: { type: 'objectId', required: true },
  },
  query: {
    period: { type: 'string', maxLength: 32 },
  },
};

export const adminListOverridesSchema = {
  query: {
    page: { type: 'integer', min: 1, max: 1000 },
    limit: { type: 'integer', min: 1, max: 100 },
    includeRevoked: { type: 'boolean' },
  },
};

export const tenantOverridesSchema = {
  params: {
    tenantId: { type: 'objectId', required: true },
  },
  query: {
    page: { type: 'integer', min: 1, max: 1000 },
    limit: { type: 'integer', min: 1, max: 100 },
    includeRevoked: { type: 'boolean' },
  },
};

export const KNOWN_METRICS = USAGE_METRICS;

export default {
  getUsageSchema,
  createOverrideSchema,
  revokeOverrideSchema,
  adminUsageSchema,
  adminListOverridesSchema,
  tenantOverridesSchema,
  KNOWN_METRICS,
};
