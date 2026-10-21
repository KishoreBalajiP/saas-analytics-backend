/**
 * Embed Routes (roadmap 3.2 - signed, origin-bound embed sessions).
 *
 * Management (tenant JWT + RBAC):
 *   POST /embed/tokens               embed.create   mint a signed embed token
 *   GET  /embed/tokens               embed.view
 *   GET  /embed/tokens/:id           embed.view
 *   POST /embed/tokens/:id/revoke    embed.delete   (embed tokens and share links)
 *   POST /embed/shares               embed.create   public share link
 *   GET  /embed/config               settings.view  workspace embed settings
 *   PUT  /embed/config               settings.update
 * Server-to-server mint (API key, scope embed:create):
 *   POST /embed/api/tokens
 * Public (no JWT; own CORS in middleware/embedCors.middleware.js; tokens
 * only in bodies / Authorization header, never in the URL):
 *   POST /embed/public/session       exchange signed token -> embed session
 *   POST /embed/public/view          render with `Authorization: Bearer <session>`
 *   POST /embed/public/share         render a public share link { secret }
 * Legacy:
 *   GET  /embed/:token               410 EMBED_TOKEN_MIGRATED
 */

// rls: embeds query with the creator's data access.
import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { authenticateApiKey } from '../middleware/apiKeyAuth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimiter.middleware.js';
import env from '../config/env.js';
import * as embedController from '../controllers/embed.controller.js';
import ApiError from '../utils/ApiError.js';
// billing: plan feature gate (embedding).
import { requireFeature } from '../middleware/requireFeature.middleware.js';
import entitlementService from '../services/entitlement.service.js';

const router = Router();

// ---------- Management (JWT + RBAC) ----------
router.post('/tokens', authenticate, resolveTenant, permission('embed', 'create'), requireFeature('embedding'), embedController.createEmbedToken);
router.get('/tokens', authenticate, resolveTenant, permission('embed', 'view'), embedController.listEmbedTokens);
router.get('/tokens/:id', authenticate, resolveTenant, permission('embed', 'view'), embedController.getEmbedToken);
router.post('/tokens/:id/revoke', authenticate, resolveTenant, permission('embed', 'delete'), embedController.revokeEmbedToken);
router.post('/shares', authenticate, resolveTenant, permission('embed', 'create'), requireFeature('embedding'), embedController.createShareLink);
router.get('/config', authenticate, resolveTenant, permission('settings', 'view'), embedController.getConfig);
router.put('/config', authenticate, resolveTenant, permission('settings', 'update'), embedController.updateConfig);

// ---------- Server-to-server mint (API key) ----------
router.post('/api/tokens', authenticateApiKey('embed:create'), embedController.createEmbedTokenWithApiKey);

// ---------- Public embed surface ----------
const embedLimiter = createRateLimiter({
  windowMs: env.security.rateLimit.embed.windowMs,
  limit: env.security.rateLimit.embed.max,
});

router.post(
  '/public/session', // ci:routes-exempt: public embed handshake, signed-token gated
  embedLimiter, embedController.exchangeSession
);
router.post(
  '/public/view', // ci:routes-exempt: public embed view, embed-session gated
  embedLimiter, embedController.viewEmbed
);
router.post(
  '/public/share', // ci:routes-exempt: public share link, secret gated
  embedLimiter, embedController.viewShare
);

// Legacy URL-path tokens leak into access logs: refused after migration.
router.get(
  '/:token', // ci:routes-exempt: legacy refusal only
  embedLimiter, (req, res, next) => next(new ApiError(410, 'URL-path embed tokens are no longer accepted; mint a signed embed token and use the embed SDK', { code: 'EMBED_TOKEN_MIGRATED' }))
);

export default router;
