/**
 * Embed Routes (Sprint 9 - implemented).
 *
 * Two surfaces:
 *   1. Management (tenant-scoped, JWT auth + RBAC): /api/v1/embed/tokens
 *   2. Public read (token-based, NO JWT): /api/v1/embed/:token
 *      - Marked // ci:routes-exempt: public embed read (token-gated)
 *      - CORS: allow all origins (config.security.embed.corsAllowAllOrigins)
 *      - Dedicated rate limiter (config.security.rateLimit.embed)
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { authenticateApiKey, requireScope } from '../middleware/apiKeyAuth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimiter.middleware.js';
import cors from 'cors';
import env from '../config/env.js';
import * as embedController from '../controllers/embed.controller.js';
import * as embedService from '../services/embed.service.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';

const router = Router();

// ---------- Management (JWT + RBAC) ----------
router.post(
  '/tokens',
  authenticate,
  permission('embed', 'create'),
  embedController.createEmbedToken,
);

router.get(
  '/tokens',
  authenticate,
  permission('embed', 'view'),
  embedController.listEmbedTokens,
);

router.get(
  '/tokens/:id',
  authenticate,
  permission('embed', 'view'),
  embedController.getEmbedToken,
);

router.post(
  '/tokens/:id/revoke',
  authenticate,
  permission('embed', 'delete'),
  embedController.revokeEmbedToken,
);

// ---------- Public Embed Read (Token-gated) ----------
const embedLimiter = createRateLimiter({
  windowMs: env.security.rateLimit.embed.windowMs,
  limit: env.security.rateLimit.embed.max,
});

const embedCors = cors({
  origin: env.security.embed.corsAllowAllOrigins ? true : env.cors.origins,
  credentials: false, // no cookies on embed
});

/**
 * GET /api/v1/embed/:token
 * Public read of an embedded dashboard/widget.
 * Token is resolved via embedService.resolveToken (SHA-256 lookup).
 * ci:routes-exempt: public embed read, token-gated, no JWT.
 */
router.get(
  '/:token', // ci:routes-exempt: public embed read, token-gated, no JWT
  embedCors,
  embedLimiter,
  async (req, res, next) => {
    try {
      const { tenantId, dashboardId, widgetId } = await embedService.resolveToken(req.params.token);
      const result = await embedService.executeEmbed({ tenantId, dashboardId, widgetId });
      return ApiResponse.ok(res, result);
    } catch (err) {
      // Normalize all failures to 404/401 opaque errors.
      if (err?.message?.includes('published') || err?.message?.includes('expired') || err?.message?.includes('deleted')) {
        return next(ApiError.unauthorized('Invalid or expired embed token'));
      }
      return next(ApiError.notFound('Embed not found'));
    }
  },
);

export default router;