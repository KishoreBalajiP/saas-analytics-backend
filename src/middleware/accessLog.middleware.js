/**
 * accessLog.middleware.js (architecture placeholder).
 *
 * PURPOSE
 *   Captures every authenticated HTTP request as an `AccessLog` row.
 *   Lives at the very top of the middleware stack (after
 *   `requestId.middleware.js`). High cardinality - writes are batched
 *   by the service.
 *
 * RESPONSIBILITY (planned, NO implementation yet)
 *   - Subscribe to `res.finish` so latency includes the full response.
 *   - Capture { actorId?, actorType?, method, path, statusCode,
 *     latencyMs, ip, userAgent, requestId, apiKeyId?, error? }.
 *   - Redact `Authorization: Bearer ***`. Never capture request/response
 *     bodies.
 *   - Buffer and flush via `services/accessLog.service#capture` every
 *     N events or T ms.
 *
 * PHASE 1.2 BEHAVIOUR
 *   Fails closed with 501 when invoked. Mounted by app.js in Phase 2.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const accessLog = notImplementedStub('middleware.accessLog');

export default {
  accessLog,
  _meta: {
    phase: '1.2 - fail-closed placeholder',
    mountOrder: 'global, right after requestId.middleware.js',
    seeAlso: [
      'src/services/accessLog.service.js',
      'src/middleware/requestId.middleware.js',
    ],
  },
};
