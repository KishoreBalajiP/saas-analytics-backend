/**
 * Subscription validators (Phase 6 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the subscription HTTP surface. Lifecycle
 *   transitions are NOT encoded here; the service layer owns the state
 *   graph (`assertTransition`). This validator is purely about input
 *   shape and limits.
 *
 * ENDPOINTS
 *   - getSubscription     GET    /tenants/:id/subscription
 *   - createSubscription  POST   /tenants/:id/subscription
 *   - updateSubscription  PATCH  /tenants/:id/subscription
 *   - cancelSubscription  POST   /tenants/:id/subscription/cancel
 *   - changePlan          POST   /tenants/:id/subscription/change-plan
 *   - adminList           GET    /admin/subscriptions
 *   - adminGet            GET    /admin/subscriptions/:tenantId
 *   - adminChangePlan     POST   /admin/subscriptions/:tenantId/change-plan
 *   - adminSetState       POST   /admin/subscriptions/:tenantId/set-state
 */

export const createSchema = {
  params: {
    id: { type: 'objectId', required: true },
  },
  body: {
    planId: { type: 'string', required: true, maxLength: 60 },
    state: {
      type: 'string',
      enum: ['trialing', 'active', 'past_due', 'canceled', 'expired', 'restricted'],
    },
    trialDays: { type: 'integer', min: 0, max: 365 },
    cancelAtPeriodEnd: { type: 'boolean' },
    reason: { type: 'string', maxLength: 500 },
  },
};

export const updateSchema = {
  params: {
    id: { type: 'objectId', required: true },
  },
  body: {
    planId: { type: 'string', maxLength: 60 },
    state: {
      type: 'string',
      enum: ['trialing', 'active', 'past_due', 'canceled', 'expired', 'restricted'],
    },
    cancelAtPeriodEnd: { type: 'boolean' },
    reason: { type: 'string', maxLength: 500 },
  },
};

export const cancelSchema = {
  params: {
    id: { type: 'objectId', required: true },
  },
  body: {
    reason: { type: 'string', maxLength: 500 },
    immediate: { type: 'boolean' },
  },
};

export const changePlanSchema = {
  params: {
    id: { type: 'objectId', required: true },
  },
  body: {
    planId: { type: 'string', required: true, maxLength: 60 },
    reason: { type: 'string', maxLength: 500 },
  },
};

export const listSchema = {
  query: {
    page: { type: 'integer', min: 1, max: 1000 },
    limit: { type: 'integer', min: 1, max: 100 },
    state: {
      type: 'string',
      enum: ['trialing', 'active', 'past_due', 'canceled', 'expired', 'restricted'],
    },
    planId: { type: 'string', maxLength: 60 },
  },
};

export const tenantIdParamSchema = {
  params: {
    tenantId: { type: 'objectId', required: true },
  },
};

export const adminChangePlanSchema = {
  params: {
    tenantId: { type: 'objectId', required: true },
  },
  body: {
    planId: { type: 'string', required: true, maxLength: 60 },
    reason: { type: 'string', required: true, minLength: 1, maxLength: 500 },
  },
};

export const adminSetStateSchema = {
  params: {
    tenantId: { type: 'objectId', required: true },
  },
  body: {
    state: {
      type: 'string',
      required: true,
      enum: ['trialing', 'active', 'past_due', 'canceled', 'expired', 'restricted'],
    },
    reason: { type: 'string', required: true, minLength: 1, maxLength: 500 },
    graceEndsAt: { type: 'date' },
  },
};

export const adminListSchema = {
  query: {
    page: { type: 'integer', min: 1, max: 1000 },
    limit: { type: 'integer', min: 1, max: 100 },
    state: {
      type: 'string',
      enum: ['trialing', 'active', 'past_due', 'canceled', 'expired', 'restricted'],
    },
    planId: { type: 'string', maxLength: 60 },
    search: { type: 'string', maxLength: 200 },
  },
};

export const reconcileSchema = {
  query: {
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

export const paginatedTenantParamSchema = {
  params: {
    tenantId: { type: 'objectId', required: true },
  },
  query: {
    page: { type: 'integer', min: 1, max: 1000 },
    limit: { type: 'integer', min: 1, max: 100 },
  },
};

export default {
  createSchema,
  updateSchema,
  cancelSchema,
  changePlanSchema,
  listSchema,
  tenantIdParamSchema,
  adminChangePlanSchema,
  adminSetStateSchema,
  adminListSchema,
  reconcileSchema,
  paginatedTenantParamSchema,
};
