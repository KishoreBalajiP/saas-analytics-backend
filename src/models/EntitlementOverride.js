/**
 * EntitlementOverride (Phase 6 - implemented).
 *
 * PURPOSE
 *   A platform-admin-controlled, per-tenant adjustment on top of the
 *   plan-derived entitlement. Used to grant a temporary headroom on a
 *   limit (e.g. for a key account) or to flip a feature on for a single
 *   tenant. Revocation is soft (the row is kept for audit).
 *
 * SCOPE GUARD
 *   An override can never grant more than the highest plan's hard limit
 *   for the same metric times the safety factor (see
 *   `entitlement.service.js`). It is the entitlement service's job to
 *   enforce this; the schema accepts any value but the service clamps
 *   it on write.
 *
 * PLUGINS
 *   optimisticConcurrency, audit (module `iam.entitlements`).
 *   Deliberately NOT `tenantScope` and NOT `softDelete`: revocation is
 *   a `revokedAt` timestamp, not a row delete; the history must be
 *   preserved.
 *
 * INDEXES
 *   - { tenantId: 1, metric: 1, revokedAt: 1 }
 *   - { expiresAt: 1 }
 */

import mongoose from 'mongoose';
import { optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'EntitlementOverride';

export const OVERRIDE_KINDS = Object.freeze(['feature', 'limit']);
export const OVERRIDE_VALUE_KINDS = Object.freeze(['boolean', 'object']);

const entitlementOverrideSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    metric: { type: String, default: null, index: true },
    kind: { type: String, enum: [...OVERRIDE_KINDS], required: true },
    valueKind: { type: String, enum: [...OVERRIDE_VALUE_KINDS], required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    reason: { type: String, required: true },
    expiresAt: { type: Date, default: null, index: true },
    grantedBy: { type: String, required: true },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null },
    revokeReason: { type: String, default: null },
  },
  { timestamps: true, minimize: false },
);

entitlementOverrideSchema.index({ tenantId: 1, metric: 1, revokedAt: 1 });

entitlementOverrideSchema.plugin(optimisticConcurrency);
entitlementOverrideSchema.plugin(audit, { module: 'iam.entitlements' });

export const EntitlementOverrideSchema = entitlementOverrideSchema;
export const EntitlementOverride = mongoose.model(
  MODEL_NAME,
  entitlementOverrideSchema,
);
export default EntitlementOverride;
