/**
 * AuditExport (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Tracks an audit-trail export request through its lifecycle
 *   `queued -> processing -> completed | failed`. The artifact (JSON or CSV)
 *   is materialised asynchronously by the export queue consumer and stored
 *   in the storage layer; this row records where it lives, when it expires,
 *   and how many rows it contains.
 *
 * DESIGN CONSTRAINTS
 *   - One row per `exportId` (`exp_<uuid>`), created when the HTTP request
 *     lands so the client gets an id to poll immediately.
 *   - `tenantId` is `null` for platform-wide exports (platform admins) and
 *     set for tenant-scoped exports (support admins); the service layer
 *     enforces the boundary, never this model.
 *   - `filters` stores the SANITISED filter set (whitelisted keys, scalar
 *     values) so the consumer re-derives the Mongo query without trusting
 *     request-shaped input twice.
 *   - Artifacts expire (`expiresAt`) and are removed by the cleanup job.
 *
 * INDEXES
 *   - unique(exportId)
 *   - { tenantId: 1, createdAt: -1 }
 *   - { status: 1, createdAt: -1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'AuditExport';
export const EXPORT_FORMATS = Object.freeze(['json', 'csv']);
export const EXPORT_STATUSES = Object.freeze(['queued', 'processing', 'completed', 'failed']);
export const EXPORT_KINDS = Object.freeze(['audit', 'access-log']);

const auditExportSchema = new mongoose.Schema(
  {
    exportId: { type: String, required: true, unique: true },
    kind: { type: String, enum: [...EXPORT_KINDS], default: 'audit' },
    tenantId: { type: String, default: null, index: true },
    requestedBy: { type: String, default: null },
    format: { type: String, enum: [...EXPORT_FORMATS], default: 'json' },
    filters: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: [...EXPORT_STATUSES], default: 'queued', index: true },
    storageKey: { type: String, default: null },
    fileName: { type: String, default: null },
    recordCount: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

auditExportSchema.index({ tenantId: 1, createdAt: -1 });
auditExportSchema.index({ status: 1, createdAt: -1 });

auditExportSchema.plugin(paginate);

export const AuditExportSchema = auditExportSchema;
export const AuditExport = mongoose.model(MODEL_NAME, auditExportSchema);
export default AuditExport;
