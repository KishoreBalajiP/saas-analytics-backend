/**
 * EmbedToken (Sprint 9 - implemented).
 *
 * PURPOSE
 *   A scoped, revocable, short-lived credential for the public embed
 *   surface (`GET /api/v1/embed/:token`). An embed token grants
 *   unauthenticated read access to a PUBLISHED dashboard (or a single
 *   widget within it) so the tenant can embed live analytics on an
 *   external website.
 *
 * SECURITY CONTRACT
 *   - The token is a 256-bit URL-safe random value returned to the caller
 *     once at issuance; only `tokenHash` = SHA-256(token) is persisted.
 *   - Tokens are scoped to exactly one dashboard (and optionally one
 *     widget). The embed service refuses to issue a token for a dashboard
 *     that is not `published`.
 *   - `expiresAt` is mandatory and enforced at every resolve (a short TTL
 *     is the default; tokens in URLs leak easily).
 *   - Revocation is permanent and immediate: once `status = 'revoked'`
 *     (or the record is soft-deleted) the token refuses to resolve.
 *
 * RESOLUTION
 *   The public route hashes the presented token, looks the row up by
 *   `tokenHash`, then checks `status` + `expiresAt` before delegating to
 *   the dashboard execution service scoped by the token's tenant.
 *
 * PLUGINS
 *   tenantScope, softDelete, paginate, optimisticConcurrency, audit
 *   (module `embed`).
 *
 * INDEXES
 *   - unique(tokenHash)
 *   - { tenantId: 1, dashboardId: 1 }
 *   - { tenantId: 1, status: 1 }
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'EmbedToken';

export const EMBED_TOKEN_STATUSES = Object.freeze(['active', 'revoked']);

export const EMBED_TOKEN_LIMITS = Object.freeze({
  NAME_MAX: 120,
  REVOKE_REASON_MAX: 500,
  DEFAULT_TTL_SEC: 24 * 60 * 60,
  MAX_TTL_SEC: 7 * 24 * 60 * 60,
});

const embedTokenSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    dashboardId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dashboard', required: true, index: true },
    // Optional single-widget scope; when present the token resolves only
    // that widget's analytics, otherwise the whole dashboard is rendered.
    widgetId: { type: mongoose.Schema.Types.ObjectId, ref: 'Widget', default: null, index: true },
    name: { type: String, default: '', maxlength: EMBED_TOKEN_LIMITS.NAME_MAX },
    // SHA-256 of the full token. Never stored or returned in plaintext.
    tokenHash: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: [...EMBED_TOKEN_STATUSES], default: 'active', index: true },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: '', maxlength: EMBED_TOKEN_LIMITS.REVOKE_REASON_MAX },
    revokedBy: { type: String, default: null },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

embedTokenSchema.index({ tenantId: 1, dashboardId: 1 });
embedTokenSchema.index({ tenantId: 1, status: 1 });

embedTokenSchema.plugin(tenantScope);
embedTokenSchema.plugin(softDelete);
embedTokenSchema.plugin(paginate);
embedTokenSchema.plugin(optimisticConcurrency);
embedTokenSchema.plugin(audit, { module: 'embed' });

export const EmbedTokenSchema = embedTokenSchema;
export const EmbedToken = mongoose.model(MODEL_NAME, embedTokenSchema);
export default EmbedToken;