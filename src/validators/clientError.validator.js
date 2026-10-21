/**
 * Frontend error report validation (POST /api/v1/client-errors).
 *
 * Every field is bounded; unknown fields are dropped by the validator.
 */

export const CLIENT_ERROR_KINDS = Object.freeze(['boundary', 'error', 'unhandledrejection', 'manual']);

export const clientErrorSchema = {
  body: {
    kind: { type: 'string', required: true, oneOf: CLIENT_ERROR_KINDS },
    message: { type: 'string', required: true, minLength: 1, maxLength: 1000 },
    name: { type: 'string', maxLength: 120 },
    stack: { type: 'string', maxLength: 8000 },
    // Page URL / route pattern where the error happened (tokens are masked
    // server-side before the report leaves the process).
    url: { type: 'string', maxLength: 2000 },
    route: { type: 'string', maxLength: 200 },
    component: { type: 'string', maxLength: 200 },
    // X-Request-Id of the failed API call, when the error came from one.
    requestId: { type: 'string', maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
    statusCode: { type: 'integer', min: 0, max: 599 },
    code: { type: 'string', maxLength: 64, pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
    release: { type: 'string', maxLength: 64 },
    portal: { type: 'string', oneOf: ['tenant', 'admin', 'public', 'embed'] },
  },
  params: {},
  query: {},
};

export default { clientErrorSchema, CLIENT_ERROR_KINDS };
