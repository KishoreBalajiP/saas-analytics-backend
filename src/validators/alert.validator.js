/**
 * Alert Validator (Sprint 7 - implemented).
 *
 * Exports `validate()`-compatible SCHEMA OBJECTS (not functions) consumed by
 * `src/routes/alert.routes.js`. The alert model is SINGLE-CONDITION
 * (metric / condition / threshold), matching `alert.service.createRule`.
 *
 * METRIC: `metric` must name an output of the rule's query (a metric alias,
 * or `count` when the query has no metrics) and `groupEvaluation` is one of
 * total | any | all; both are checked in `alert.service.js` (400
 * ALERT_METRIC_INVALID / field errors).
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
    groupEvaluation: 'string',
    condition: 'string|required',
    threshold: 'number|required',
    thresholdHigh: 'number',
    schedule: 'object',
    cooldownMinutes: 'integer',
    repeatMode: 'string',
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
    groupEvaluation: 'string',
    condition: 'string',
    threshold: 'number',
    thresholdHigh: 'number',
    schedule: 'object',
    cooldownMinutes: 'integer',
    repeatMode: 'string',
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
