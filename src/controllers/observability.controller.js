/**
 * Observability controller (roadmap 2.8).
 *
 * ENDPOINTS
 *   GET  /api/v1/metrics        Prometheus text exposition (metrics token).
 *   GET  /api/v1/status         public component health summary.
 *   POST /api/v1/client-errors  frontend crash reports (public, rate-limited).
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import { renderPrometheus, PROMETHEUS_CONTENT_TYPE, clientErrorsTotal } from '../utils/metrics.js';
import { getPublicStatus } from '../services/readiness.service.js';
import { buildErrorEvent, reportEvent } from '../services/errorReporter.service.js';
import { redactUrl } from '../utils/redact.js';
import '../services/metricsCollectors.service.js';

/** GET /metrics */
export const getPrometheusMetrics = asyncHandler(async (_req, res) => {
  const body = await renderPrometheus();
  res.setHeader('Content-Type', PROMETHEUS_CONTENT_TYPE);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(body);
});

/** GET /status - no internals: component names and states only. */
export const getStatus = asyncHandler(async (_req, res) => {
  const data = await getPublicStatus();
  res.setHeader('Cache-Control', 'public, max-age=15');
  return ApiResponse.ok(res, data, 'Platform status');
});

/**
 * POST /client-errors - one frontend error report. The report is rebuilt
 * server-side (only validated fields), scrubbed and handed to the error
 * reporter; nothing is stored. Always 202 so a broken reporter never
 * produces a second error in the browser.
 */
export const reportClientError = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  // Rebuild the error from validated fields only; the stack is the
  // client's (or none), never this handler's.
  const error = new Error(body.message);
  error.name = body.name || 'FrontendError';
  error.stack = body.stack || undefined;
  if (body.code) error.code = body.code;
  if (Number.isInteger(body.statusCode) && body.statusCode >= 100) error.statusCode = body.statusCode;

  const event = buildErrorEvent(error, {
    source: 'frontend',
    route: body.route,
    extra: {
      kind: body.kind,
      ...(body.url ? { url: redactUrl(body.url) } : {}),
      ...(body.route ? { route: body.route } : {}),
      ...(body.component ? { component: body.component } : {}),
      ...(body.requestId ? { apiRequestId: body.requestId } : {}),
      ...(body.release ? { release: body.release } : {}),
      ...(body.portal ? { portal: body.portal } : {}),
      reportRequestId: req.id ?? null,
    },
  });
  clientErrorsTotal.inc({ kind: body.kind });
  void reportEvent(event);
  return ApiResponse.accepted(res, { accepted: true }, 'Error report accepted');
});

export default { getPrometheusMetrics, getStatus, reportClientError };
