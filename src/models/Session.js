/**
 * Session (Sprint 1 - implemented).
 *
 * PURPOSE
 *   The live state of an authenticated actor: opaque refresh-token hash,
 *   device binding, and revocation records. Sessions are the single
 *   source of truth for "is this identity allowed right now" - JWTs are
 *   short-lived and cannot be revoked early.
 *
 * SECURITY
 *   - `refreshTokenHash` stores the Argon2id hash of the opaque refresh
 *     token. The raw token exists only at creation; it is hashed at rest
 *     (Sprint 1 common mistake 1).
 *   - `status: 'active' | 'revoked' | 'expired'`; revocation is recorded
 *     on `revokedAt` / `revokedReason` (no soft-delete plugin - expired
 *     sessions are purged by the TTL index on `expiresAt`).
 *   - JWT access tokens carry `sessionId`; the middleware rejects when
 *     the session is not `active`.
 *   - `authenticatedAt` + `familyId` survive rotation, so the absolute
 *     session lifetime is enforced from the original sign-in.
 *
 * PLUGINS
 *   tenantScope (optional: platform sessions have `tenantId: null`),
 *   paginate, optimisticConcurrency, audit (module `iam.sessions`).
 *
 * INDEXES
 *   - unique(refreshTokenHash)
 *   - { actorId: 1, status: 1 }
 *   - TTL on `expiresAt` (auto-purge)
 */

import mongoose from 'mongoose';
import { withPrefix, PREFIXES } from '../utils/id.js';
import { tenantScope, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Session';
export const SESSION_STATUSES = Object.freeze(['active', 'revoked', 'expired']);
export const ACTOR_TYPES = Object.freeze(['user', 'admin', 'service']);
// adminauth: a restricted session may only complete one pending step.
// `mfa_enrollment`: a privileged admin signed in without MFA and may only
// enrol it (see `authenticateToken({ allowRestrictions })`).
export const SESSION_RESTRICTION_MFA_ENROLLMENT = 'mfa_enrollment';
export const SESSION_RESTRICTIONS = Object.freeze([SESSION_RESTRICTION_MFA_ENROLLMENT]);

const sessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, default: () => withPrefix(PREFIXES.SESSION) },
    actorId: { type: String, required: true },
    actorType: { type: String, enum: [...ACTOR_TYPES], required: true },
    tenantId: { type: String, default: null },
    // Set when a support admin created this session on behalf of the actor
    // (Sprint 8 impersonation). The admin's id is recorded so an impersonation
    // session can be attributed, listed and revoked by its owner.
    impersonatedBy: { type: String, default: null },
    refreshTokenHash: { type: String, required: true },
    device: {
      id: { type: String, default: null },
      name: { type: String, default: '' },
      os: { type: String, default: '' },
      browser: { type: String, default: '' },
      fingerprint: { type: String, default: null },
    },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    issuedAt: { type: Date, default: () => new Date() },
    // Original sign-in time of this session family. Rotation copies it to
    // the successor, so the absolute lifetime (`AUTH_SESSION_ABSOLUTE_TTL`)
    // is measured from the login, never from the latest refresh. Null only
    // on sessions written before the field existed (issuedAt is used then).
    authenticatedAt: { type: Date, default: null },
    // Stable id shared by every rotation of one login (the first sessionId).
    familyId: { type: String, default: null },
    lastUsedAt: { type: Date, default: () => new Date() },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    status: { type: String, enum: [...SESSION_STATUSES], default: 'active', index: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    // Successor's sessionId once this session was rotated. Set in the same
    // atomic update that ends this session, so a refresh that lost a
    // concurrent rotation race can find the session that won.
    replacedBy: { type: String, default: null },
    // adminauth: null for a normal session, else one of SESSION_RESTRICTIONS.
    // Rotation copies it; enrolling MFA lifts it for the whole family.
    restriction: { type: String, enum: [...SESSION_RESTRICTIONS, null], default: null },
    // adminauth: last successful step-up (password + current code) on this
    // login. Sensitive admin actions need it within ADMIN_STEP_UP_TTL_MS.
    stepUpAt: { type: Date, default: null },
  },
  { timestamps: true },
);

sessionSchema.index({ actorId: 1, status: 1 });
sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });

sessionSchema.plugin(tenantScope, { optional: true });
sessionSchema.plugin(paginate);
sessionSchema.plugin(optimisticConcurrency);
sessionSchema.plugin(audit, { module: 'iam.sessions' });

export const SessionSchema = sessionSchema;
export const Session = mongoose.model(MODEL_NAME, sessionSchema);
export default Session;
