/**
 * AccessLog (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Per-request HTTP trace, higher cardinality than AuditLog. Captured by
 *   `accessLog.middleware.js` for every authenticated request and buffered
 *   by `services/accessLog.service.js`. Read/aggregated via
 *   `routes/access-log.routes.js`.
 *
 * DESIGN CONSTRAINTS
 *   - NEVER stores request/response bodies, and never stores header values
 *     (Authorization is captured only in redacted form `Bearer ***`).
 *   - `tenantId` is nullable (platform-admin requests have no tenant scope).
 *   - Append-only at the application level: rows are written once via the
 *     repository and pruned only by the retention/cleanup job.
 *   - `event` tags a subset of captures for ops analysis (e.g. `impersonate`).
 *
 * INDEXES
 *   - { tenantId: 1, occurredAt: -1 }
 *   - { actorId: 1, occurredAt: -1 }
 *   - { path: 1, occurredAt: -1 }          // aggregate top paths
 *   - { statusCode: 1, occurredAt: -1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'AccessLog';
export const ACTOR_TYPES = Object.freeze(['admin', 'user', 'service', 'system']);
export const DEFAULT_EVENT = 'request';

const accessLogSchema = new mongoose.Schema(
  {
    actorType: { type: String, enum: [...ACTOR_TYPES], default: 'system' },
    actorId: { type: String, default: null, index: true },
    tenantId: { type: String, default: null, index: true },
    method: { type: String, default: 'GET' },
    path: { type: String, default: '/', index: true },
    statusCode: { type: Number, default: 200, index: true },
    latencyMs: { type: Number, default: 0 },
    requestSize: { type: Number, default: 0 },
    responseSize: { type: Number, default: 0 },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    requestId: { type: String, default: null },
    event: { type: String, default: DEFAULT_EVENT },
    error: {
      code: { type: String, default: null },
      message: { type: String, default: null },
    },
  },
  { timestamps: { createdAt: 'occurredAt', updatedAt: false } },
);

accessLogSchema.index({ tenantId: 1, occurredAt: -1 });
accessLogSchema.index({ actorId: 1, occurredAt: -1 });
accessLogSchema.index({ path: 1, occurredAt: -1 });
accessLogSchema.index({ statusCode: 1, occurredAt: -1 });

accessLogSchema.plugin(paginate);

export const AccessLogSchema = accessLogSchema;
export const AccessLog = mongoose.model(MODEL_NAME, accessLogSchema);
export default AccessLog;
