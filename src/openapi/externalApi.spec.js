/**
 * OpenAPI 3.1 reference for the external (X-Api-Key) API (devapi, roadmap 3.3).
 *
 * Served at GET /api/v1/external/openapi.json and rendered by the frontend
 * developer reference page. Keep in step with routes/externalApi.routes.js:
 * tests/devapi/openapi.test.js fails when a route is missing here.
 */

import { API_KEY_SCOPE_CATALOGUE } from '../models/ApiKey.js';

const ERROR_CODES = Object.freeze({
  INVALID_API_KEY: { status: 401, description: 'Missing, malformed, expired, revoked key, IP not allowed, or tenant not active' },
  INSUFFICIENT_SCOPE: { status: 403, description: 'The key lacks the scope this endpoint needs' },
  NOT_FOUND: { status: 404, description: 'Resource not found in this workspace (also for malformed ids)' },
  BAD_REQUEST: { status: 400, description: 'Invalid parameters; `errors` lists field messages' },
  INVALID_QUERY: { status: 400, description: 'Analytics query violates the query contract' },
  RATE_LIMITED: { status: 429, description: 'Per-key rate limit reached; see Retry-After' },
  QUOTA_EXCEEDED: { status: 429, description: 'Daily API-call quota spent; see X-Quota-Reset' },
  QUERY_TIMEOUT: { status: 408, description: 'Analytics query took too long' },
});

const errorResponse = (code) => ({
  description: ERROR_CODES[code].description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
      example: { success: false, statusCode: ERROR_CODES[code].status, code, message: ERROR_CODES[code].description, errors: [] },
    },
  },
});

const commonErrors = (...extra) => {
  const out = { 401: errorResponse('INVALID_API_KEY'), 403: errorResponse('INSUFFICIENT_SCOPE'), 429: errorResponse('RATE_LIMITED') };
  for (const code of extra) out[ERROR_CODES[code].status] = errorResponse(code);
  return out;
};

const idParam = (name, what) => ({ name, in: 'path', required: true, description: `${what} id (24 hex characters)`, schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } });
const pageParams = (maxLimit) => [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: maxLimit } },
];
const jsonParam = (name, description, example) => ({ name, in: 'query', description: `${description} (JSON-encoded)`, schema: { type: 'string' }, example: JSON.stringify(example) });

const ok = (description, schema, example) => ({
  200: { description, content: { 'application/json': { schema, example: { success: true, statusCode: 200, message: 'OK', data: example } } } },
});
const okList = (description, item, example) => ({
  200: {
    description,
    content: {
      'application/json': {
        schema: { allOf: [{ $ref: '#/components/schemas/Envelope' }, { properties: { data: { type: 'array', items: item }, meta: { $ref: '#/components/schemas/PageMeta' } } }] },
        example: { success: true, statusCode: 200, message: 'Listed', data: [example], meta: { page: 1, limit: 50, total: 1, pages: 1 } },
      },
    },
  },
});

const curl = (path) => [{ lang: 'curl', source: `curl -H "X-Api-Key: $ANALIVO_API_KEY" "https://api.analivo.example/api/v1/external/v1${path}"` }];

const DATASET_EXAMPLE = { id: '66f0c0ffee0000000000abcd', name: 'Orders', type: 'csv', status: 'active', lastSyncedAt: '2026-10-01T00:00:00.000Z' };

/** Build the spec (pure; no I/O). */
export function buildExternalApiSpec() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Analivo External API',
      version: '1.0.0',
      description: 'Read access to workspace datasets, analytics and published dashboards with a scoped API key sent as `X-Api-Key: <prefix>.<secret>`. Limits: per-key rate limit (429 RATE_LIMITED) and the workspace daily call quota (429 QUOTA_EXCEEDED, X-Quota-* headers).',
    },
    servers: [{ url: '/api/v1/external/v1', description: 'Versioned external API' }],
    security: [{ ApiKey: [] }],
    tags: [{ name: 'Datasets' }, { name: 'Analytics' }, { name: 'Dashboards' }, { name: 'Keys' }],
    paths: {
      '/datasets': {
        get: {
          operationId: 'listDatasets', tags: ['Datasets'], summary: 'List datasets', 'x-scope': 'datasets:read',
          parameters: pageParams(200),
          responses: { ...okList('Datasets', { $ref: '#/components/schemas/Dataset' }, DATASET_EXAMPLE), ...commonErrors('BAD_REQUEST') },
          'x-codeSamples': curl('/datasets'),
        },
      },
      '/datasets/{datasetId}': {
        get: {
          operationId: 'getDataset', tags: ['Datasets'], summary: 'Get a dataset', 'x-scope': 'datasets:read',
          parameters: [idParam('datasetId', 'Dataset')],
          responses: { ...ok('Dataset', { $ref: '#/components/schemas/Dataset' }, DATASET_EXAMPLE), ...commonErrors('NOT_FOUND') },
          'x-codeSamples': curl('/datasets/66f0c0ffee0000000000abcd'),
        },
      },
      '/datasets/{datasetId}/query': {
        get: {
          operationId: 'queryDataset', tags: ['Analytics'], summary: 'Run an analytics query', 'x-scope': 'analytics:query',
          parameters: [
            idParam('datasetId', 'Dataset'),
            jsonParam('metrics', 'Metrics', [{ alias: 'total', op: 'sum', field: 'amount' }]),
            jsonParam('groupBy', 'Group-by fields', [{ field: 'region' }]),
            jsonParam('filters', 'Filters', [{ field: 'region', op: 'eq', value: 'EU' }]),
            { name: 'filtersOp', in: 'query', schema: { type: 'string', enum: ['and', 'or'] } },
            jsonParam('dateRange', 'Date range', { field: 'orderedAt', preset: 'last_30_days' }),
            jsonParam('orderBy', 'Ordering', [{ field: 'total', dir: 'desc' }]),
            jsonParam('pagination', 'Pagination', { page: 1, limit: 100 }),
          ],
          responses: {
            ...ok('Query result', { $ref: '#/components/schemas/QueryResult' }, { rows: [{ region: 'EU', total: 1200 }], columns: ['region', 'total'], total: 1, page: 1, pages: 1, limit: 100 }),
            ...commonErrors('NOT_FOUND', 'INVALID_QUERY', 'QUERY_TIMEOUT'),
          },
          'x-codeSamples': curl('/datasets/66f0c0ffee0000000000abcd/query?metrics=%5B%7B%22alias%22%3A%22n%22%2C%22op%22%3A%22count%22%2C%22field%22%3A%22amount%22%7D%5D'),
        },
      },
      '/datasets/{datasetId}/rows': {
        get: {
          operationId: 'listDatasetRows', tags: ['Analytics'], summary: 'List raw rows', 'x-scope': 'analytics:query',
          parameters: [idParam('datasetId', 'Dataset'), ...pageParams(500)],
          responses: { ...okList('Rows', { type: 'object' }, { data: { region: 'EU', amount: 100 }, ingestedAt: '2026-10-01T00:00:00.000Z' }), ...commonErrors('NOT_FOUND', 'BAD_REQUEST') },
          'x-codeSamples': curl('/datasets/66f0c0ffee0000000000abcd/rows?limit=10'),
        },
      },
      '/dashboards/{dashboardId}': {
        get: {
          operationId: 'getDashboard', tags: ['Dashboards'], summary: 'Get a published dashboard', 'x-scope': 'dashboards:read',
          parameters: [idParam('dashboardId', 'Dashboard')],
          responses: { ...ok('Dashboard', { type: 'object' }, { _id: '66f0c0ffee0000000000beef', name: 'Revenue', status: 'published' }), ...commonErrors('NOT_FOUND') },
          'x-codeSamples': curl('/dashboards/66f0c0ffee0000000000beef'),
        },
      },
      '/keys/self': {
        delete: {
          operationId: 'revokeSelf', tags: ['Keys'], summary: 'Revoke the calling key (leaked-key kill switch)', 'x-scope': null,
          responses: { ...ok('Revoked', { type: 'object' }, { id: '66f0c0ffee0000000000f00d', revoked: true }), 401: errorResponse('INVALID_API_KEY'), 429: errorResponse('RATE_LIMITED') },
          'x-codeSamples': [{ lang: 'curl', source: 'curl -X DELETE -H "X-Api-Key: $ANALIVO_API_KEY" "https://api.analivo.example/api/v1/external/v1/keys/self"' }],
        },
      },
    },
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key', description: 'Scopes: ' + Object.entries(API_KEY_SCOPE_CATALOGUE).map(([k, v]) => `${k} (${v})`).join('; ') } },
      schemas: {
        Envelope: { type: 'object', properties: { success: { type: 'boolean' }, statusCode: { type: 'integer' }, message: { type: 'string' }, code: { type: 'string' }, data: {}, meta: { type: 'object' } } },
        Error: { type: 'object', required: ['success', 'statusCode', 'code', 'message'], properties: { success: { const: false }, statusCode: { type: 'integer' }, code: { type: 'string', enum: Object.keys(ERROR_CODES) }, message: { type: 'string' }, errors: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } } } },
        PageMeta: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, pages: { type: 'integer' } } },
        Dataset: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' }, status: { type: 'string' }, lastSyncedAt: { type: ['string', 'null'], format: 'date-time' } } },
        QueryResult: { type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } }, columns: { type: 'array', items: { type: 'string' } }, total: { type: 'integer' }, page: { type: 'integer' }, pages: { type: 'integer' }, limit: { type: 'integer' } } },
      },
    },
    'x-errorCodes': ERROR_CODES,
  };
}

export default { buildExternalApiSpec };
