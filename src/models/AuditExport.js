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
 *   - Artifacts expire (`expiresAt`, RETENTION_EXPORT_DAYS after completion):
 *     status polls then answer 410 EXPORT_EXPIRED, and the cleanup job
 *     deletes the stored object (status `expired`) and later the row.
 *
 * INDEXES
 *   - unique(exportId)
 *   - { tenantId: 1, createdAt: -1 }
 *   - { status: 1, createdAt: -1 }
 *   - { status: 1, expiresAt: 1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'AuditExport';
export const EXPORT_FORMATS = Object.freeze(['json', 'csv']);
// `expired`: the artefact's download window passed and the cleanup job
// deleted the stored object; the row stays (status polls get 410) until
// RETENTION_EXPORT_RECORD_DAYS, then it is deleted too.
export const EXPORT_STATUSES = Object.freeze(['queued', 'processing', 'completed', 'failed', 'expired']);
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
    // When the cleanup job deleted the stored artefact.
    purgedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true },
);

auditExportSchema.index({ tenantId: 1, createdAt: -1 });
auditExportSchema.index({ status: 1, createdAt: -1 });
// Cleanup scan for artefacts past their download window.
auditExportSchema.index({ status: 1, expiresAt: 1 });

auditExportSchema.plugin(paginate);

export const AuditExportSchema = auditExportSchema;
export const AuditExport = mongoose.model(MODEL_NAME, auditExportSchema);
export default AuditExport;
