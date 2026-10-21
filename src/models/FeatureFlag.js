/**
 * FeatureFlag (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Runtime gating of features. Decouples deployment from release. Flags
 *   resolve through the feature-flag service on the hot path; reads are
 *   cached. The platform catalogue is seeded (idempotently) during tenant
 *   onboarding and managed over `/api/v1/feature-flags` (roadmap 2.4) with
 *   versioned history and rollback.
 *
 * DESIGN CONSTRAINTS
 *   - Flags are PLATFORM-global (no `tenantId`); per-tenant reach is
 *     expressed through `rollout`, not ownership. `tenantScope` is
 *     therefore intentionally not applied.
 *   - `enabled` is a master switch; `rollout.strategy` further narrows
 *     reach. A disabled flag resolves to its `defaultValue` everywhere.
 *   - `percentage` uses stable hashed bucketing on (flag key, tenant id) so
 *     a tenant's assignment is deterministic across requests and independent
 *     between flags.
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit
 *   (module `platform.feature_flags`).
 *
 * INDEXES
 *   - unique partial(key) over live rows (`deletedAt: null`)
 *   - { 'rollout.tenantIds': 1 }
 */

import mongoose from 'mongoose';
import { softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'FeatureFlag';
export const ROLLOUT_STRATEGIES = Object.freeze([
  'all', 'tenantId', 'percentage', 'attribute',
]);
export const VALUE_TYPES = Object.freeze(['boolean', 'string', 'number', 'json']);

const featureFlagSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    type: { type: String, enum: [...VALUE_TYPES], default: 'boolean' },
    defaultValue: { type: mongoose.Schema.Types.Mixed, default: false },
    enabled: { type: Boolean, default: true, index: true },
    rollout: {
      strategy: { type: String, enum: [...ROLLOUT_STRATEGIES], default: 'all' },
      tenantIds: { type: [String], default: [], index: true },
      percentage: { type: Number, min: 0, max: 100, default: 100 },
      attributeRules: { type: [mongoose.Schema.Types.Mixed], default: [] },
    },
    isReadonly: { type: Boolean, default: false },
    // Resource version for optimistic concurrency and the revision history
    // (`ConfigRevision`, kind `feature_flag`); bumped on every change.
    version: { type: Number, default: 0 },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

// members (db.07): the key is unique among live flags only, so a deleted
// flag does not block re-creating (or re-seeding) the same key.
featureFlagSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

featureFlagSchema.plugin(softDelete);
featureFlagSchema.plugin(paginate);
featureFlagSchema.plugin(optimisticConcurrency);
featureFlagSchema.plugin(audit, { module: 'platform.feature_flags' });

export const FeatureFlagSchema = featureFlagSchema;
export const FeatureFlag = mongoose.model(MODEL_NAME, featureFlagSchema);
export default FeatureFlag;
