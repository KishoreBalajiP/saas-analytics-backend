/**
 * Request ID middleware.
 *
 * WHY IT EXISTS
 *   Every request gets a stable ID used to correlate logs, errors and
 *   upstream/downstream calls. Without it, debugging production incidents is
 *   painful once multiple services exist.
 *
 * RESPONSIBILITY
 *   - Reuse an incoming `X-Request-Id` header when present (important for
 *     tracing across services), otherwise generate a UUID.
 *   - Set `req.id` and echo `X-Request-Id` on the response.
 *   - Attach a request-scoped child logger at `req.log`.
 *
 * HOW TO EXTEND
 *   Mount it before any middleware that wants `req.id` (morgan, rate
 *   limiter, error handler). If a tracing SDK (OpenTelemetry) is added later,
 *   this is the natural place to bridge trace IDs.
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';

const HEADER = 'x-request-id';

export function requestIdMiddleware(req, res, next) {
  const incoming = req.headers[HEADER];
  const requestId =
    typeof incoming === 'string' && incoming.trim() ? incoming.trim() : uuidv4();

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  // Request-scoped logger; everything logged inside this request is linkable.
  req.log = logger.child({ requestId });

  next();
}
