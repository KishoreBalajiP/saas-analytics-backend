/**
 * FeatureFlag (Sprint 3 - implemented).
 *
 * PURPOSE
 *   Runtime gating of features. Decouples deployment from release. Flags
 *   resolve through the feature-flag service on the hot path; reads are
 *   cached. The platform catalogue is seeded (idempotently) during tenant
 *   onboarding; the full `/feature-flags` admin API lands in Sprint 5.
 *
 * DESIGN CONSTRAINTS
 *   - Flags are PLATFORM-global (no `tenantId`); per-tenant reach is
 *     expressed through `rollout`, not ownership. `tenantScope` is
 *     therefore intentionally not applied.
 *   - `enabled` is a master switch; `rollout.strategy` further narrows
 *     reach. A disabled flag resolves to its `defaultValue` everywhere.
 *   - `percentage` uses stable hashed bucketing on the tenant id so a
 *     tenant's assignment is deterministic across requests.
 *
 * PLUGINS
 *   softDelete, paginate, optimisticConcurrency, audit
 *   (module `platform.feature_flags`).
 *
 * INDEXES
 *   - unique(key)
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
    key: { type: String, required: true, unique: true, trim: true, lowercase: true },
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
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

featureFlagSchema.plugin(softDelete);
featureFlagSchema.plugin(paginate);
featureFlagSchema.plugin(optimisticConcurrency);
featureFlagSchema.plugin(audit, { module: 'platform.feature_flags' });

export const FeatureFlagSchema = featureFlagSchema;
export const FeatureFlag = mongoose.model(MODEL_NAME, featureFlagSchema);
export default FeatureFlag;
