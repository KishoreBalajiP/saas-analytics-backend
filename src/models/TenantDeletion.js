/**
 * TenantDeletion (roadmap 2.10, ten.14).
 *
 * PURPOSE
 *   One record per workspace deletion: who asked and when, the grace period,
 *   cancellation, the purge attempts, and the verification report that every
 *   collection holds zero records of the tenant after the purge. The record
 *   outlives the tenant: it is the evidence of the deletion (retention in
 *   `constants/retention.members.js`). It holds no tenant content.
 *
 * LIFECYCLE
 *   `scheduled` -> `purging` -> `purged`
 *   `scheduled` -> `cancelled`                  (platform admin, before purge)
 *   `purging`   -> `failed` -> `purging` ...     (retried until max attempts)
 *   `open` is true while the deletion is scheduled, purging or failed; at most
 *   one open record exists per tenant (partial unique index).
 *
 * PLUGINS
 *   paginate (admin listing). Not tenant-scoped: it is platform evidence and
 *   is excluded from the purge itself.
 *
 * INDEXES
 *   - unique partial { tenantId } while `open`
 *   - { tenantId: 1, createdAt: -1 } (latest record of a tenant)
 *   - { status: 1, purgeAfter: 1 } (due scan)
 *   - { createdAt: -1 } (admin listing)
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'TenantDeletion';
export const TENANT_DELETION_STATUSES = Object.freeze(['scheduled', 'purging', 'purged', 'failed', 'cancelled']);
export const TENANT_DELETION_SOURCES = Object.freeze(['owner_request', 'archive_retention', 'admin']);
export const OPEN_DELETION_STATUSES = Object.freeze(['scheduled', 'purging', 'failed']);

const actorSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['user', 'admin', 'system'], required: true },
    id: { type: String, default: null },
  },
  { _id: false },
);

const collectionReportSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    deleted: { type: Number, default: 0 },
    remaining: { type: Number, default: 0 },
  },
  { _id: false },
);

const retainedReportSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    count: { type: Number, default: 0 },
    policy: { type: String, default: null },
  },
  { _id: false },
);

const tenantDeletionSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    tenantSlug: { type: String, default: null },
    tenantName: { type: String, default: null },
    status: { type: String, enum: [...TENANT_DELETION_STATUSES], default: 'scheduled' },
    open: { type: Boolean, default: true },
    source: { type: String, enum: [...TENANT_DELETION_SOURCES], required: true },
    requestedBy: { type: actorSchema, required: true },
    requestedAt: { type: Date, required: true },
    reason: { type: String, default: null, maxlength: 500 },
    purgeAfter: { type: Date, required: true },
    // Tenant status before the request, restored when the deletion is cancelled.
    previousStatus: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: actorSchema, default: null },
    cancelReason: { type: String, default: null, maxlength: 500 },
    attempts: { type: Number, default: 0, min: 0 },
    leaseUntil: { type: Date, default: null },
    // A failed purge is retried by a later run, not the same one (backoff).
    retryAfter: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    purgedAt: { type: Date, default: null },
    lastError: {
      code: { type: String, default: null },
      message: { type: String, default: null },
    },
    verification: {
      ok: { type: Boolean, default: null },
      checkedAt: { type: Date, default: null },
      collections: { type: [collectionReportSchema], default: [] },
      retained: { type: [retainedReportSchema], default: [] },
      storage: {
        deleted: { type: Number, default: 0 },
        remaining: { type: Number, default: 0 },
      },
    },
  },
  { timestamps: true },
);

tenantDeletionSchema.index({ tenantId: 1 }, { unique: true, partialFilterExpression: { open: true } });
tenantDeletionSchema.index({ tenantId: 1, createdAt: -1 });
tenantDeletionSchema.index({ status: 1, purgeAfter: 1 });
tenantDeletionSchema.index({ createdAt: -1 });

tenantDeletionSchema.plugin(paginate);

export const TenantDeletionSchema = tenantDeletionSchema;
export const TenantDeletion = mongoose.model(MODEL_NAME, tenantDeletionSchema);
export default TenantDeletion;
