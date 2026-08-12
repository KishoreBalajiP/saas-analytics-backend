/**
 * Alert Validator (Sprint 7 - implemented).
 *
 * Exports `validate()`-compatible SCHEMA OBJECTS (not functions) consumed by
 * `src/routes/alert.routes.js`. The alert model is SINGLE-CONDITION
 * (metric / condition / threshold), matching `alert.service.createRule`.
 *
 * SECURITY: `query` / `schedule` / `notification` are passed through as
 * objects and re-sanitised inside `alert.service.js` (which whitelists
 * `QUERY_FIELDS`, schedule fields, and `ALERT_CHANNELS`). No raw expression
 * is ever interpolated into a query string.
 */

export const alertListSchema = {
  query: {
    page: 'integer',
    limit: 'integer',
    enabled: 'boolean',
  },
};

export const alertCreateSchema = {
  body: {
    name: 'string|required',
    description: 'string',
    source: 'string',
    dashboardId: 'objectId',
    widgetId: 'objectId',
    query: 'object',
    metric: 'string',
    condition: 'string|required',
    threshold: 'number|required',
    thresholdHigh: 'number',
    schedule: 'object',
    cooldownMinutes: 'integer',
    notification: 'object',
    enabled: 'boolean',
  },
};

export const alertUpdateSchema = {
  params: { id: 'objectId|required' },
  body: {
    name: 'string',
    description: 'string',
    source: 'string',
    dashboardId: 'objectId',
    widgetId: 'objectId',
    query: 'object',
    metric: 'string',
    condition: 'string',
    threshold: 'number',
    thresholdHigh: 'number',
    schedule: 'object',
    cooldownMinutes: 'integer',
    notification: 'object',
    enabled: 'boolean',
  },
};

export const alertEventsSchema = {
  params: { id: 'objectId|required' },
  query: {
    page: 'integer',
    limit: 'integer',
  },
};

export default {
  alertListSchema,
  alertCreateSchema,
  alertUpdateSchema,
  alertEventsSchema,
};
