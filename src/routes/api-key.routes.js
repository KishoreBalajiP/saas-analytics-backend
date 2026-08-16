/**
 * API Key Routes (Sprint 9 - implemented).
 * Protected by JWT auth + RBAC (api_keys.* permissions).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import * as apiKeyController from '../controllers/apiKey.controller.js';

const router = Router();

// All routes require authenticated user + tenant resolution.
// tenant.middleware runs before this in the main router stack.

router.post(
  '/',
  authenticate,
  permission('api_keys', 'create'),
  apiKeyController.createApiKey,
);

router.get(
  '/',
  authenticate,
  permission('api_keys', 'view'),
  apiKeyController.listApiKeys,
);

router.get(
  '/:id',
  authenticate,
  permission('api_keys', 'view'),
  apiKeyController.getApiKey,
);

router.patch(
  '/:id',
  authenticate,
  permission('api_keys', 'update'),
  apiKeyController.updateApiKey,
);

router.post(
  '/:id/revoke',
  authenticate,
  permission('api_keys', 'delete'),
  apiKeyController.revokeApiKey,
);

export default router;