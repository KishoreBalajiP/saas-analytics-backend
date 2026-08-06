/**
 * LoginAttempt (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Append-only record of every authentication attempt. Complements the
 *   persisted `failedAttempts` / `lockedUntil` counters on `User` / `Admin`
 *   with a queryable audit trail (who, from where, when, why).
 *
 * DESIGN CONSTRAINTS
 *   - APPEND-ONLY: rows are created, never updated or deleted (except by
 *     the retention purge path in Sprint 7+). The `softDelete` and
 *     `optimisticConcurrency` plugins are deliberately NOT applied.
 *   - The `audit` plugin is NOT applied: this collection is itself the
 *     attempt record; emitting an audit event per attempt would be noise.
 *   - `actorId` may be absent (e.g. unknown email) - the attempt is keyed
 *     by `email` instead so lockout decisions stay complete.
 *   - `tenantId` is nullable because platform-admin attempts have none
 *     (`tenantScope` applied with `optional: true`).
 *
 * PLUGINS
 *   tenantScope (optional), paginate.
 *
 * INDEXES
 *   - { actorId: 1, occurredAt: -1 }
 *   - { email: 1, occurredAt: -1 }
 *   - { ip: 1, occurredAt: -1 }
 */

import mongoose from 'mongoose';
import { tenantScope, paginate } from './plugins/index.js';

export const MODEL_NAME = 'LoginAttempt';
export const ATTEMPT_ACTOR_TYPES = Object.freeze(['user', 'admin']);
export const ATTEMPT_REASONS = Object.freeze([
  'invalid_credentials',
  'account_locked',
  'mfa_required',
  'mfa_failed',
  'success',
  'suspended',
  'unknown_email',
]);

const loginAttemptSchema = new mongoose.Schema(
  {
    actorId: { type: String, default: null },
    actorType: { type: String, enum: [...ATTEMPT_ACTOR_TYPES], default: 'user' },
    email: { type: String, required: true, lowercase: true, trim: true },
    tenantId: { type: String, default: null },
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    success: { type: Boolean, required: true },
    reason: { type: String, enum: [...ATTEMPT_REASONS], default: 'invalid_credentials' },
    occurredAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

loginAttemptSchema.index({ actorId: 1, occurredAt: -1 });
loginAttemptSchema.index({ email: 1, occurredAt: -1 });
loginAttemptSchema.index({ ip: 1, occurredAt: -1 });

loginAttemptSchema.plugin(tenantScope, { optional: true });
loginAttemptSchema.plugin(paginate);

export const LoginAttemptSchema = loginAttemptSchema;
export const LoginAttempt = mongoose.model(MODEL_NAME, loginAttemptSchema);
export default LoginAttempt;
