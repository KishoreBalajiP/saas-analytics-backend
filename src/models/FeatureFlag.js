/**
 * FeatureFlag (architecture placeholder - NO schema).
 *
 * PURPOSE
 *   Runtime gating of features. Decouples deployment from release. Flags
 *   resolve through `/feature-flags/resolve` on the hot path; cached.
 *
 * PLANNED FIELDS
 *   _id, key (unique), name, description?,
 *   type: 'boolean' | 'string' | 'number' | 'json',
 *   defaultValue,
 *   rollout?: {
 *     strategy: 'all' | 'tenantId' | 'percentage' | 'attribute',
 *     tenantIds?: string[],
 *     percentage?: number,            // 0..100, hashed bucketing
 *     attributeRules?: Array<{ key, op, value }>,
 *   },
 *   createdAt, updatedAt, updatedBy
 *
 * PLANNED INDEXES
 *   - unique(key)
 *   - { 'rollout.tenantIds': 1 }
 */

export const MODEL_NAME = 'FeatureFlag';
export const ROLLOUT_STRATEGIES = Object.freeze([
  'all', 'tenantId', 'percentage', 'attribute',
]);

export default Object.freeze({
  name: MODEL_NAME,
  rolloutStrategies: ROLLOUT_STRATEGIES,
  schemaImplemented: false,
  seeAlso: ['src/modules/platform/feature-flags/README.md'],
});
