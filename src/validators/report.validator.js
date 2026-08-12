/**
 * Report Validator (Sprint 7 - implemented).
 *
 * Exports `validate()`-compatible SCHEMA OBJECTS (not functions) consumed by
 * `src/routes/report.routes.js`. Each field is declared so the `validate`
 * middleware preserves it on `req.validated` (unknown fields are dropped).
 *
 * SECURITY: nested `query` / `schedule` / `filters` are passed through as
 * objects and re-sanitised inside `report.service.js` (which only whitelists
 * `QUERY_FIELDS` and safe schedule fields). No raw Mongo/pipeline is built here.
 */

export const reportListSchema = {
  query: {
    page: 'integer',
    limit: 'integer',
    status: 'string',
    search: 'string',
  },
};

export const reportCreateSchema = {
  body: {
    name: 'string|required',
    description: 'string',
    source: 'string',
    dashboardId: 'objectId',
    widgetId: 'objectId',
    query: 'object',
    format: 'string',
    filters: 'object',
    schedule: 'object',
    status: 'string',
  },
};

export const reportUpdateSchema = {
  params: { id: 'objectId|required' },
  body: {
    name: 'string',
    description: 'string',
    source: 'string',
    dashboardId: 'objectId',
    widgetId: 'objectId',
    query: 'object',
    format: 'string',
    filters: 'object',
    schedule: 'object',
    status: 'string',
  },
};

export const reportRunSchema = {
  params: { id: 'objectId|required' },
  body: {
    format: 'string',
    filters: 'object',
  },
};

export const reportDownloadSchema = {
  params: { id: 'objectId|required' },
  query: { runId: 'objectId' },
};

export default {
  reportListSchema,
  reportCreateSchema,
  reportUpdateSchema,
  reportRunSchema,
  reportDownloadSchema,
};
