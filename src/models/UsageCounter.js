/**
 * UsageCounter (Phase 6 - implemented).
 *
 * PURPOSE
 *   Per-tenant, per-metric, per-period counter that backs the quota
 *   enforcement. One document per `(tenantId, metric, period)`. Updated
 *   atomically with `findOneAndUpdate + $inc + upsert` so concurrent
 *   writes at the quota boundary cannot exceed the limit by more than
 *   one document.
 *
 * PERIOD SEMANTICS
 *   - `current`: state-driven metrics (members, connectors, dashboards,
 *     reports, alerts, scheduledReports, storedRows). The value is the
 *     current authoritative count; reconciliation may overwrite.
 *   - `YYYY-MM-DD` (UTC) or `YYYY-MM`: metered metrics (see
 *     `METRIC_PERIODS`). The period is the reset boundary; switching the
 *     period implicitly resets the counter (the previous row ages out of
 *     the active query and is removed by the `expiresAt` TTL index).
 *
 * PLUGINS
 *   paginate, optimisticConcurrency, audit (module `iam.usage`).
 *   Deliberately NOT `tenantScope`: the repository scopes by `tenantId`
 *   explicitly to keep queries simple and so a single tenant's
 *   counter resolution is one query.
 *
 * INDEXES
 *   - unique({ tenantId, metric, period })
 *   - { tenantId: 1, metric: 1, period: 1 }
 *   - TTL on `expiresAt` (metered rows only; `current` rows keep null)
 */

import mongoose from 'mongoose';
import { paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'UsageCounter';

/** Canonical metric identifiers. New metrics MUST be added here. */
export const USAGE_METRICS = Object.freeze([
  'members',
  'connectors',
  'dashboards',
  'reports',
  'alerts',
  'scheduledReports',
  'storedRows',
  'apiCallsPerDay',
  // ai-ask: AI questions asked per UTC day.
  'aiQuestionsPerDay',
]);

/** Counter kinds. */
export const COUNTER_KINDS = Object.freeze(['current', 'cumulative']);

/**
 * Reset period of each metered metric. Metrics not listed here are
 * resource counts kept in the `current` period.
 */
export const METRIC_PERIODS = Object.freeze({
  apiCallsPerDay: 'day',
  // ai-ask
  aiQuestionsPerDay: 'day',
});

/** Period granularity of a metric: 'current' (resource count) or 'day'. */
export function periodOf(metric) {
  return METRIC_PERIODS[metric] ?? 'current';
}

/**
 * The counter row key for `metric` at instant `at`: 'current' for resource
 * counts, the UTC calendar day (`YYYY-MM-DD`) for daily metered metrics.
 */
export function periodKeyFor(metric, at = new Date()) {
  if (periodOf(metric) === 'day') return new Date(at).toISOString().slice(0, 10);
  return 'current';
}

/** When the period containing `at` ends (exclusive), or null for 'current'. */
export function periodEndFor(metric, at = new Date()) {
  if (periodOf(metric) !== 'day') return null;
  const d = new Date(at);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

const usageCounterSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    metric: { type: String, enum: [...USAGE_METRICS], required: true, index: true },
    period: { type: String, required: true, default: 'current', index: true },
    kind: { type: String, enum: [...COUNTER_KINDS], required: true, default: 'current' },
    value: { type: Number, required: true, default: 0 },
    lastIncrementedAt: { type: Date, default: null },
    lastReconciledAt: { type: Date, default: null },
    updatedBy: { type: String, default: null },
    // Metered (per-period) rows expire after the retention window; resource
    // count rows (`period: 'current'`) keep null and never expire.
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

usageCounterSchema.index({ tenantId: 1, metric: 1, period: 1 }, { unique: true });
usageCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

usageCounterSchema.plugin(paginate);
usageCounterSchema.plugin(optimisticConcurrency);
usageCounterSchema.plugin(audit, { module: 'iam.usage' });

export const UsageCounterSchema = usageCounterSchema;
export const UsageCounter = mongoose.model(MODEL_NAME, usageCounterSchema);
export default UsageCounter;
