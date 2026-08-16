/**
 * Embed Service (Sprint 9 - implemented).
 *
 * PURPOSE
 *   Business layer for public embed tokens. A tenant creates a token for a
 *   PUBLISHED dashboard (optionally scoped to one widget). The token is
 *   returned once; only its SHA-256 hash is stored. The public route
 *   resolves the token hash, validates status + expiry, then delegates to
 *   the dashboard execution service.
 *
 * SECURITY CONTRACT
 *   - Tokens can ONLY be created for dashboards with `status === 'published'`.
 *   - `generateToken()` produces a high-entropy value returned ONCE; only
 *     `tokenHash` (SHA-256) is persisted.
 *   - `resolveToken(token)` checks `status === 'active'`, `expiresAt > now`,
 *     and `deletedAt === null`. On success it returns the owning `tenantId`,
 *     `dashboardId`, optional `widgetId`.
 *   - Revocation is permanent and immediate.
 */

import { generateToken, sha256 } from '../utils/crypto.js';
import env from '../config/env.js';
import embedTokenRepository from '../repositories/embedToken.repository.js';
import dashboardService from './dashboard.service.js';
import { EmbedToken, EMBED_TOKEN_STATUSES } from '../models/EmbedToken.js';
import ApiError from '../utils/ApiError.js';

/** Generate a new token + its hash. Returns { token, tokenHash }. */
function generateTokenMaterial() {
  const token = generateToken(32);
  const tokenHash = sha256(token);
  return { token, tokenHash };
}

/** Validate TTL against configured limits. */
function validateTtl(ttlSec) {
  if (ttlSec < 60) throw new Error('TTL must be at least 60 seconds');
  if (ttlSec > env.security.embed.maxTtlSec) {
    throw new Error(`TTL exceeds maximum of ${env.security.embed.maxTtlSec} seconds`);
  }
}

/**
 * Create an embed token for a published dashboard (optionally widget-scoped).
 * @returns {Promise<{ token: { id, name, dashboardId, widgetId, expiresAt }, secret: string }>}
 */
export async function createEmbedToken({ tenantId, dashboardId, widgetId = null, name = '', ttlSec = null, actorId = null } = {}) {
  // Verify dashboard exists, belongs to tenant, and is published.
  const dashboard = await dashboardService.getDashboard({ tenantId, dashboardId });
  if (!dashboard) throw ApiError.notFound('Dashboard not found');
  if (dashboard.status !== 'published') throw ApiError.badRequest('Only published dashboards can be embedded');

  // If widget-scoped, verify the widget belongs to this dashboard.
  if (widgetId) {
    const widget = await dashboardService.getWidget({ tenantId, dashboardId, widgetId });
    if (!widget) throw ApiError.notFound('Widget not found');
  }

  // Enforce per-dashboard active token cap.
  const activeCount = await embedTokenRepository.countActiveByDashboard(dashboardId);
  if (activeCount >= env.security.embed.maxActivePerDashboard) {
    throw new Error(`Active embed token limit reached for this dashboard (${env.security.embed.maxActivePerDashboard})`);
  }

  const { token, tokenHash } = generateTokenMaterial();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + (ttlSec ?? env.security.embed.defaultTtlSec) * 1000);
  validateTtl(ttlSec ?? env.security.embed.defaultTtlSec);

  const doc = await embedTokenRepository.create({
    tenantId,
    dashboardId,
    widgetId,
    name,
    tokenHash,
    status: 'active',
    expiresAt,
    createdBy: actorId,
  });

  return {
    token: {
      id: doc._id,
      name: doc.name,
      dashboardId: doc.dashboardId,
      widgetId: doc.widgetId,
      expiresAt: doc.expiresAt,
      status: doc.status,
      createdAt: doc.createdAt,
    },
    secret: token,
  };
}

/** List embed tokens for a tenant (optionally scoped to a dashboard). */
export async function listEmbedTokens({ tenantId, dashboardId, page = 1, limit = 20 } = {}) {
  const result = await embedTokenRepository.list({ tenantId, dashboardId, page, limit });
  return {
    ...result,
    docs: result.docs.map((t) => ({
      id: t._id,
      name: t.name,
      dashboardId: t.dashboardId,
      widgetId: t.widgetId,
      expiresAt: t.expiresAt,
      status: t.status,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
    })),
  };
}

/** Get a single token (redacted). */
export async function getEmbedToken({ tenantId, tokenId }) {
  const doc = await embedTokenRepository.findById(tokenId, { tenantId });
  if (!doc) return null;
  return {
    id: doc._id,
    name: doc.name,
    dashboardId: doc.dashboardId,
    widgetId: doc.widgetId,
    expiresAt: doc.expiresAt,
    status: doc.status,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
  };
}

/** Revoke (or soft-delete) an embed token. */
export async function revokeEmbedToken({ tenantId, tokenId, actorId = null, reason = '' } = {}) {
  const doc = await embedTokenRepository.findById(tokenId, { tenantId });
  if (!doc) return null;
  if (doc.status === 'revoked') return null;

  await embedTokenRepository.update(tokenId, {
    status: 'revoked',
    revokedAt: new Date(),
    revokedReason: reason,
    revokedBy: actorId,
    updatedBy: actorId,
  });
  return { id: doc._id, revoked: true };
}

/**
 * Resolve a plaintext token for the public embed route.
 * Returns { tenantId, dashboardId, widgetId } or throws.
 */
export async function resolveToken(token) {
  if (!token || typeof token !== 'string' || token.length < 16) {
    throw new Error('Invalid embed token');
  }
  const tokenHash = sha256(token);
  const doc = await embedTokenRepository.findByTokenHash(tokenHash);
  if (!doc) throw new Error('Invalid embed token');
  if (doc.status !== 'active') throw new Error('Embed token is not active');
  if (doc.expiresAt <= new Date()) throw new Error('Embed token has expired');
  if (doc.deletedAt) throw new Error('Embed token has been deleted');

  // Verify dashboard is still published (defence in depth).
  const dashboard = await dashboardService.getDashboard({ tenantId: doc.tenantId, dashboardId: doc.dashboardId });
  if (!dashboard || dashboard.status !== 'published') {
    throw new Error('Embedded dashboard is no longer published');
  }

  // Update lastUsedAt (best effort)
  embedTokenRepository.update(doc._id, { lastUsedAt: new Date() }).catch(() => {});

  return {
    tenantId: doc.tenantId,
    dashboardId: doc.dashboardId,
    widgetId: doc.widgetId,
  };
}

/**
 * Execute the embedded dashboard or widget using the analytics engine
 * (delegates to dashboardService.viewDashboard / executeWidget).
 * This is called by the public embed route after token resolution.
 */
export async function executeEmbed({ tenantId, dashboardId, widgetId, queryOverrides = {} } = {}) {
  if (widgetId) {
    return dashboardService.executeWidget({ tenantId, dashboardId, widgetId, queryOverrides });
  }
  return dashboardService.viewDashboard({ tenantId, dashboardId, queryOverrides });
}

export default {
  createEmbedToken,
  listEmbedTokens,
  getEmbedToken,
  revokeEmbedToken,
  resolveToken,
  executeEmbed,
  _meta: { statuses: EMBED_TOKEN_STATUSES },
};