/**
 * Dashboard Validators (Sprint 6 - implemented).
 *
 * PURPOSE
 *   Declarative schemas for the `/api/v1/dashboards` surface, consumed by
 *   `validate(schema)` from `src/validators/index.js`. Shallow shape is
 *   validated here (422); the deeper safe-query / layout / filter rules are
 *   enforced by the dashboard service (400), mirroring the connector flow.
 *
 * RESPONSIBILITY
 *   - dashboard schemas : create / update / list
 *   - widget schemas    : create / update / list / execute
 *   - share schema      : grant a (revocable) email share
 *
 * CODING GUIDELINES
 *   - The tenant is NEVER accepted in the body/query/params - it always
 *     comes from the authenticated token via the controller.
 *   - `datasetId` is an ObjectId that MUST reference a tenant-owned
 *     connector; ownership is verified in the service.
 */

/** @type {import('../index.js').Schema} */
export const dashboardCreateSchema = {
  body: {
    name: { type: 'string', required: true, maxLength: 120 },
    description: { type: 'string', maxLength: 1000 },
    layout: { type: 'object' },
    filters: { type: 'object' },
    refresh: { type: 'object' },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const dashboardUpdateSchema = {
  body: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 1000 },
    status: { type: 'string', oneOf: ['draft', 'published', 'archived'] },
    layout: { type: 'object' },
    filters: { type: 'object' },
    refresh: { type: 'object' },
    // vizbuilder: who can see the dashboard (owner / dashboards.assign only).
    visibility: { type: 'string', oneOf: ['workspace', 'restricted'] },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const dashboardListSchema = {
  body: {},
  params: {},
  query: {
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
    status: { type: 'string', oneOf: ['draft', 'published', 'archived'] },
    search: { type: 'string', maxLength: 128 },
  },
};

/** @type {import('../index.js').Schema} */
export const widgetCreateSchema = {
  body: {
    name: { type: 'string', required: true, maxLength: 120 },
    type: { type: 'string', required: true, oneOf: ['kpi', 'table', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'] },
    datasetId: { type: 'objectId', required: true },
    query: { type: 'object' },
    visualization: { type: 'object' },
    position: { type: 'object' },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const widgetUpdateSchema = {
  body: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    type: { type: 'string', oneOf: ['kpi', 'table', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'] },
    datasetId: { type: 'objectId' },
    query: { type: 'object' },
    visualization: { type: 'object' },
    position: { type: 'object' },
  },
  params: {},
  query: {},
};

/** @type {import('../index.js').Schema} */
export const widgetListSchema = {
  body: {},
  params: {},
  query: {
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 200 },
  },
};

/** @type {import('../index.js').Schema} */
export const widgetExecuteSchema = {
  body: {},
  params: {},
  // JSON-encoded on the query string; parsed and checked against the
  // analytics query contract in the controller/service (400 INVALID_QUERY).
  query: {
    dateRange: { type: 'string' },
    filters: { type: 'string' },
    filtersOp: { type: 'string', oneOf: ['and', 'or'] },
    // vizbuilder: table paging.
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 200 },
  },
};

/** @type {import('../index.js').Schema} */
export const shareSchema = {
  // vizbuilder: share with a tenant user or role at view or edit level.
  body: {
    principalType: { type: 'string', required: true, oneOf: ['user', 'role'] },
    principalId: { type: 'objectId', required: true },
    level: { type: 'string', oneOf: ['view', 'edit'] },
  },
  params: {},
  query: {},
};

export default {
  dashboardCreateSchema,
  dashboardUpdateSchema,
  dashboardListSchema,
  widgetCreateSchema,
  widgetUpdateSchema,
  widgetListSchema,
  widgetExecuteSchema,
  shareSchema,
};
