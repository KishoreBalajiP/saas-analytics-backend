/**
 * External API Routes (Sprint 9; devapi roadmap 3.3).
 *
 * Mounted twice (routes/index.js): `/external/v1` (versioned, documented in
 * the OpenAPI reference at `/external/openapi.json`) and `/external`
 * (legacy alias, same handlers).
 *
 * MIDDLEWARE ORDER (API:limiter-order)
 *   authenticateApiKey (validates X-Api-Key + IP allow-list, meters the
 *   daily quota, records usage) -> apiKeyRateLimit (per key) -> handler
 *
 * Every route here must appear in src/openapi/externalApi.spec.js
 * (tests/devapi asserts it).
 */

import { Router } from 'express';
import { authenticateApiKey, apiKeyRateLimit } from '../middleware/apiKeyAuth.middleware.js';
// rls: data access follows the key's creator.
import { apiKeyDataActor } from '../middleware/dataAccess.middleware.js';
import { createRateLimiter } from '../middleware/rateLimiter.middleware.js';
import env from '../config/env.js';
import * as externalController from '../controllers/externalApi.controller.js';
// billing: plan feature gate (api_access) on every external API route.
import { requireFeature } from '../middleware/requireFeature.middleware.js';

const router = Router();

// Public docs only: per-IP limiter (no key involved).
const docsLimiter = createRateLimiter({
  windowMs: env.security.rateLimit.external.windowMs,
  limit: env.security.rateLimit.external.max,
});

router.get(
  '/openapi.json', // ci:routes-exempt: public API reference document, no data
  docsLimiter,
  externalController.openApiSpec,
);

router.get(
  '/datasets',
  authenticateApiKey(),
  requireFeature('api_access'),
  apiKeyRateLimit,
  apiKeyDataActor,
  externalController.listDatasets,
);

router.get(
  '/datasets/:datasetId',
  authenticateApiKey(),
  requireFeature('api_access'),
  apiKeyRateLimit,
  apiKeyDataActor,
  externalController.getDataset,
);

router.get(
  '/datasets/:datasetId/query',
  authenticateApiKey(),
  requireFeature('api_access'),
  apiKeyRateLimit,
  apiKeyDataActor,
  externalController.queryDataset,
);

router.get(
  '/datasets/:datasetId/rows',
  authenticateApiKey(),
  requireFeature('api_access'),
  apiKeyRateLimit,
  apiKeyDataActor,
  externalController.listDatasetRows,
);

router.get(
  '/dashboards/:dashboardId',
  authenticateApiKey(),
  requireFeature('api_access'),
  apiKeyRateLimit,
  apiKeyDataActor,
  externalController.getDashboard,
);

// devapi: leaked-key kill switch; the only mutation (audited).
router.delete(
  '/keys/self',
  authenticateApiKey(),
  apiKeyRateLimit,
  externalController.revokeSelf,
);

export default router;
