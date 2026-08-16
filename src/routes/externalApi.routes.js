/**
 * External API Routes (Sprint 9 - implemented).
 *
 * All endpoints require X-Api-Key header (apiKeyAuth middleware).
 * Scopes are enforced inline via externalApiService.requireScope.
 * Dedicated rate limiter (config.security.rateLimit.external).
 *
 * MIDDLEWARE ORDER
 *   authenticateApiKey -> externalLimiter -> handler
 */

import { Router } from 'express';
import { authenticateApiKey } from '../middleware/apiKeyAuth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimiter.middleware.js';
import env from '../config/env.js';
import * as externalController from '../controllers/externalApi.controller.js';

const router = Router();

const externalLimiter = createRateLimiter({
  windowMs: env.security.rateLimit.external.windowMs,
  limit: env.security.rateLimit.external.max,
});

// Inline authenticateApiKey on each route so ci:check-routes sees the auth guard.
// Order: authenticateApiKey (validates X-Api-Key, attaches req.apiKey + req.tenant)
//        externalLimiter (per-IP rate limit for external surface)
router.get(
  '/datasets',
  authenticateApiKey,
  externalLimiter,
  externalController.listDatasets,
);

router.get(
  '/datasets/:datasetId',
  authenticateApiKey,
  externalLimiter,
  externalController.getDataset,
);

router.get(
  '/datasets/:datasetId/query',
  authenticateApiKey,
  externalLimiter,
  externalController.queryDataset,
);

router.get(
  '/datasets/:datasetId/rows',
  authenticateApiKey,
  externalLimiter,
  externalController.listDatasetRows,
);

router.get(
  '/dashboards/:dashboardId',
  authenticateApiKey,
  externalLimiter,
  externalController.getDashboard,
);

export default router;