/**
 * /api/v1/files routes (roadmap 1.5).
 *
 * ENDPOINTS
 *   - GET /:token   download a stored artefact   signed token (no session)
 *
 * WHY NO SESSION
 *   Browsers follow a download link without the in-memory access token, so
 *   the link carries its own short-lived HMAC grant (see
 *   `storage.service.signedDownloadUrl`). The grant is minted only after
 *   the tenant, permission and ownership checks of the endpoint that hands
 *   it out (`GET /reports/:id/download`, `GET /analytics/exports/:id/download`).
 */

import { Router } from 'express';
import { createRateLimiter } from '../middleware/rateLimiter.middleware.js';
import env from '../config/env.js';
import fileController from '../controllers/file.controller.js';

const router = Router();

const downloadLimiter = createRateLimiter({
  name: 'file-download',
  windowMs: 60 * 1000,
  limit: env.security.rateLimit.max,
});

router.get(
  '/:token', // ci:routes-exempt: self-authenticating short-lived HMAC download grant
  downloadLimiter,
  fileController.downloadFile,
);

export default router;
