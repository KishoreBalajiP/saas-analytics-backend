/**
 * API Key Routes (Sprint 9 - implemented).
 * Protected by JWT auth + RBAC (api_keys.* permissions).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import * as apiKeyController from '../controllers/apiKey.controller.js';
// billing: minting API keys needs the api_access plan feature.
import { requireFeature } from '../middleware/requireFeature.middleware.js';

const router = Router();

// Every route needs an authenticated tenant user AND a resolved tenant:
// controllers read the tenant from req.tenant.id (set by resolveTenant from
// the JWT claim). Without it the repositories would have no tenant filter.

router.post(
  '/',
  authenticate,
  resolveTenant,
  permission('api_keys', 'create'),
  requireFeature('api_access'),
  apiKeyController.createApiKey,
);

router.get(
  '/',
  authenticate,
  resolveTenant,
  permission('api_keys', 'view'),
  apiKeyController.listApiKeys,
);

// devapi: scope catalogue (before /:id).
router.get(
  '/scopes',
  authenticate,
  resolveTenant,
  permission('api_keys', 'view'),
  apiKeyController.listScopes,
);

router.get(
  '/:id',
  authenticate,
  resolveTenant,
  permission('api_keys', 'view'),
  apiKeyController.getApiKey,
);

router.patch(
  '/:id',
  authenticate,
  resolveTenant,
  permission('api_keys', 'update'),
  apiKeyController.updateApiKey,
);

router.post(
  '/:id/revoke',
  authenticate,
  resolveTenant,
  permission('api_keys', 'delete'),
  apiKeyController.revokeApiKey,
);

// devapi: rotation (overlap window) and per-key usage.
router.post(
  '/:id/rotate',
  authenticate,
  resolveTenant,
  permission('api_keys', 'update'),
  // Rotation mints a new working secret, so it needs the plan feature too.
  requireFeature('api_access'),
  apiKeyController.rotateApiKey,
);

router.get(
  '/:id/usage',
  authenticate,
  resolveTenant,
  permission('api_keys', 'view'),
  apiKeyController.getApiKeyUsage,
);

export default router;