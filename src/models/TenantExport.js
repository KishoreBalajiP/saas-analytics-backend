/**
 * TenantExport (roadmap 2.9 - backups and recovery).
 *
 * PURPOSE
 *   One row per tenant data export: a portable archive of everything a
 *   workspace owns (metadata collections as JSON lines, one CSV per dataset,
 *   and a manifest with counts and checksums). The row tracks the request
 *   through `queued -> processing -> completed | failed`, then `expired`
 *   once the artefact is deleted from storage.
 *
 * DESIGN CONSTRAINTS
 *   - `exportId` (`tex_<ulid>`) is the public id; `_id` is never exposed.
 *   - At most ONE export per tenant may be queued or processing. `inFlight`
 *     is `true` only in those states and a partial unique index on
 *     `{ tenantId }` enforces the rule atomically (no read-then-write race).
 *   - `leaseUntil` bounds both states: a queued row past it was never picked
 *     up, a processing row past it lost its worker. The expiry job fails
 *     such rows so a tenant is never blocked by a dead export.
 *   - `storageKey` is internal and never returned by the API; downloads go
 *     through short-lived signed URLs minted per request.
 *   - Rows carry no tenant data, only bookkeeping (counts, checksums).
 *
 * INDEXES
 *   - unique(exportId)
 *   - { tenantId: 1, createdAt: -1 }                 listing per tenant
 *   - unique partial { tenantId: 1 } (inFlight)      one active export
 *   - { status: 1, expiresAt: 1 }                    expiry sweep
 *   - { status: 1, leaseUntil: 1 }                   abandoned-export sweep
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'TenantExport';
export const TENANT_EXPORT_STATUSES = Object.freeze(['queued', 'processing', 'completed', 'failed', 'expired']);
export const TENANT_EXPORT_ORIGINS = Object.freeze(['tenant', 'platform']);
export const TENANT_EXPORT_ACTOR_TYPES = Object.freeze(['user', 'admin', 'system']);

const requesterSchema = new mongoose.Schema(
  {
    type: { type: String, enum: [...TENANT_EXPORT_ACTOR_TYPES], required: true },
    id: { type: String, default: null },
    email: { type: String, default: null },
  },
  { _id: false },
);

const collectionCountSchema = new mongoose.Schema(
  {
    model: { type: String, required: true },
    // MongoDB collection name (`collection` is a reserved Mongoose path).
    name: { type: String, required: true },
    count: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const errorSchema = new mongoose.Schema(
  {
    code: { type: String, default: null },
    message: { type: String, default: null },
  },
  { _id: false },
);

const tenantExportSchema = new mongoose.Schema(
  {
    exportId: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    origin: { type: String, enum: [...TENANT_EXPORT_ORIGINS], required: true },
    requestedBy: { type: requesterSchema, required: true },
    reason: { type: String, default: null, maxlength: 500 },
    status: { type: String, enum: [...TENANT_EXPORT_STATUSES], default: 'queued' },
    // true while queued/processing, absent otherwise (partial unique index).
    inFlight: { type: Boolean, default: undefined },
    leaseUntil: { type: Date, default: null },
    attempts: { type: Number, default: 0, min: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    storageKey: { type: String, default: null },
    fileName: { type: String, default: null },
    sizeBytes: { type: Number, default: null },
    sha256: { type: String, default: null },
    manifestSha256: { type: String, default: null },
    summary: {
      collections: { type: Number, default: 0 },
      records: { type: Number, default: 0 },
      datasets: { type: Number, default: 0 },
      datasetRows: { type: Number, default: 0 },
    },
    collections: { type: [collectionCountSchema], default: [] },
    error: { type: errorSchema, default: null },
  },
  { timestamps: true },
);

tenantExportSchema.index({ tenantId: 1, createdAt: -1 });
tenantExportSchema.index(
  { tenantId: 1 },
  { unique: true, partialFilterExpression: { inFlight: true }, name: 'tenantId_inFlight_unique' },
);
tenantExportSchema.index({ status: 1, expiresAt: 1 });
tenantExportSchema.index({ status: 1, leaseUntil: 1 });

tenantExportSchema.plugin(paginate);

export const TenantExportSchema = tenantExportSchema;
export const TenantExport = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, tenantExportSchema);
export default TenantExport;
