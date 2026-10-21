/**
 * HTTP metrics middleware (roadmap 2.8, findings ops.07 / ops2.05).
 *
 * WHY IT EXISTS
 *   Request rate, error rate and latency by route are the first signals an
 *   on-call engineer alerts on. This middleware records, for every request,
 *   `analivo_http_requests_total{method,route,status}` and
 *   `analivo_http_request_duration_seconds{method,route,status_class}`, plus
 *   the in-flight gauge.
 *
 * ROUTE LABEL
 *   The label is the matched route TEMPLATE (`/api/v1/connectors/:id`), never
 *   the concrete URL, so ids and tokens cannot create series. Express sets
 *   `req.route` when a route matches, while `req.baseUrl` still holds that
 *   router's mount path; an accessor on `req.route` captures the mount path
 *   at that moment (by the time an error response is written the routers
 *   have unwound and `baseUrl` is gone). Ids in mount paths (`/tenants/:id`
 *   mounts) are normalised to `:id`; unmatched requests are `<unmatched>`.
 *
 * MOUNT
 *   Global, right after `requestId.middleware.js`.
 */

import { observeHttpRequest, httpRequestsInFlight, routeLabel } from '../utils/metrics.js';

const ROUTE_BASE = Symbol('observability.routeBase');
const KNOWN_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Route template label for a request (also used by the error reporter).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function requestRouteLabel(req) {
  if (!req) return '<unmatched>';
  const baseUrl = req[ROUTE_BASE] ?? req.baseUrl ?? '';
  return routeLabel({ route: req.route, baseUrl });
}

/**
 * Record request metrics when the response finishes (or the client goes
 * away, recorded as status 499).
 *
 * @type {import('express').RequestHandler}
 */
export function httpMetricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  let route;
  try {
    Object.defineProperty(req, 'route', {
      configurable: true,
      enumerable: true,
      get() {
        return route;
      },
      set(value) {
        route = value;
        req[ROUTE_BASE] = req.baseUrl ?? '';
      },
    });
  } catch {
    // A frozen or exotic request object: fall back to req.baseUrl at finish.
  }

  httpRequestsInFlight.inc();
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    httpRequestsInFlight.dec();
    try {
      const status = res.writableFinished || res.headersSent ? res.statusCode : 499;
      observeHttpRequest({
        method: KNOWN_METHODS.has(req.method) ? req.method : 'OTHER',
        route: requestRouteLabel(req),
        status,
        seconds: Number(process.hrtime.bigint() - started) / 1e9,
      });
    } catch {
      // Metrics never break a request.
    }
  };
  res.once('finish', record);
  res.once('close', record);
  next();
}

export default httpMetricsMiddleware;
