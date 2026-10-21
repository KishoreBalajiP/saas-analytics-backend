/**
 * Metric definition validators (ai-catalogue).
 *
 * `validate()` schema objects for `src/routes/metric.routes.js`. Bodies are
 * passed through as objects here and held to the full definition rules in
 * `metricDefinition.service.sanitizeDefinition` (400 METRIC_INVALID with
 * field errors), which also checks filters against the engine contract.
 */

import { METRIC_STATUSES } from '../models/MetricDefinition.js';

const KEY = { type: 'string', required: true, pattern: '^[a-z][a-z0-9_]{0,63}$', message: 'key must be a metric key' };

const DEFINITION_BODY = {
  key: 'string',
  label: 'string',
  description: 'string',
  connectorId: 'objectId',
  aggregation: 'string',
  field: 'string',
  numerator: 'object',
  denominator: 'object',
  filters: 'array',
  unit: 'string',
  format: 'string',
  direction: 'string',
  owner: 'string',
};

export const metricListSchema = {
  query: {
    page: { type: 'integer', min: 1 },
    limit: { type: 'integer', min: 1, max: 100 },
    status: { type: 'string', oneOf: [...METRIC_STATUSES] },
    search: { type: 'string', maxLength: 100 },
    connectorId: 'objectId',
  },
};

export const metricCreateSchema = { body: DEFINITION_BODY };

export const metricKeySchema = {
  params: { key: KEY },
  query: { version: { type: 'integer', min: 1 } },
};

export const metricUpdateSchema = { params: { key: KEY }, body: DEFINITION_BODY };

export const metricApproveSchema = {
  params: { key: KEY, version: { type: 'integer', required: true, min: 1 } },
};

export const metricSuggestSchema = { body: { connectorId: 'objectId|required' } };

export default {
  metricListSchema,
  metricCreateSchema,
  metricKeySchema,
  metricUpdateSchema,
  metricApproveSchema,
  metricSuggestSchema,
};
