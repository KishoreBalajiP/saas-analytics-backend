/**
 * Observability routes (roadmap 2.8), mounted at the API root.
 *
 * ENDPOINTS
 *   GET  /metrics        Prometheus exposition. Bearer METRICS_TOKEN; 404
 *                        when no token is configured (never public).
 *   GET  /status         Public status summary: overall and per-component
 *                        operational | degraded | outage. No internals;
 *                        cached STATUS_CACHE_TTL_MS.
 *   POST /client-errors  Frontend crash reports. Public (a crash can happen
 *                        before sign-in), rate-limited per IP
 *                        (CLIENT_ERROR_RATE_LIMIT_MAX per minute), body
 *                        validated and bounded, scrubbed before it reaches
 *                        the error reporter. Nothing is stored.
 *
 * The admin JSON view of the same metrics stays at
 * GET /monitoring/metrics (adminAuth + monitoring.view).
 */

import { Router } from 'express';
import env from '../config/env.js';
import { metricsAuth } from '../middleware/metricsAuth.middleware.js';
import { createRateLimiter, ipKey } from '../middleware/rateLimiter.middleware.js';
import { validateRequest } from '../middleware/validation.middleware.js';
import { clientErrorSchema } from '../validators/clientError.validator.js';
import observabilityController from '../controllers/observability.controller.js';

const router = Router();

const clientErrorLimiter = createRateLimiter({
  name: 'client-errors',
  windowMs: 60 * 1000,
  limit: env.observability?.clientErrorRateLimitMax ?? 20,
  keyGenerator: ipKey,
});

router.get('/metrics', // ci:routes-exempt: machine endpoint guarded by the METRICS_TOKEN bearer (metricsAuth)
  metricsAuth, observabilityController.getPrometheusMetrics);
router.get('/status', // ci:routes-exempt: public status summary without internals, cached
  observabilityController.getStatus);
router.post('/client-errors', // ci:routes-exempt: public crash intake, rate-limited per IP + validated
  clientErrorLimiter, validateRequest(clientErrorSchema), observabilityController.reportClientError);

export default router;
