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
 *   - Open the async request context (`utils/actorContext.js`) with the
 *     request id, client ip and user agent, so audit rows and security
 *     events written anywhere during the request carry them.
 *
 * HOW TO EXTEND
 *   Mount it before any middleware that wants `req.id` (morgan, rate
 *   limiter, error handler). If a tracing SDK (OpenTelemetry) is added later,
 *   this is the natural place to bridge trace IDs.
 */

import { v4 as uuidv4 } from 'uuid';
import logger from '../utils/logger.js';
import { runWithRequestContext } from '../utils/actorContext.js';
// observability: validated inbound ids + W3C trace context (roadmap 2.8).
import {
  normalizeRequestId,
  parseTraceparent,
  newTraceId,
  newSpanId,
  runWithTrace,
} from '../utils/traceContext.js';

const HEADER = 'x-request-id';

export function requestIdMiddleware(req, res, next) {
  const incoming = req.headers[HEADER];
  // An inbound id is reused only when it is 8-128 safe characters (finding
  // ops2.14); anything else is replaced so callers cannot forge log fields.
  const requestId = normalizeRequestId(incoming) ?? uuidv4();

  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  // Request-scoped logger; everything logged inside this request is linkable.
  req.log = logger.child({ requestId });

  // observability: continue an inbound W3C trace (or start one) and run the
  // rest of the request inside it, so services logging through the global
  // logger and jobs enqueued here carry the same requestId/traceId.
  const parent = parseTraceparent(req.headers.traceparent);
  const trace = {
    requestId,
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId(),
    parentSpanId: parent?.parentSpanId ?? null,
    flags: parent?.flags ?? '01',
  };
  req.traceId = trace.traceId;
  res.setHeader('traceresponse', `00-${trace.traceId}-${trace.spanId}-${trace.flags}`);

  // Audit request context (actorContext) nested inside the trace context.
  const userAgent = req.headers?.['user-agent'];
  runWithTrace(trace, () =>
    runWithRequestContext(
      { requestId, ip: req.ip ?? null, userAgent: typeof userAgent === 'string' ? userAgent : null },
      () => next(),
    ),
  );
}
