/**
 * ComplianceLog (Sprint 8 - implemented).
 *
 * PURPOSE
 *   Data-subject request lifecycle (GDPR/CCPA-style export, delete, restrict,
 *   consent withdraw). Holds the state machine
 *   `received -> in_progress -> completed | rejected | cancelled`. Even a
 *   "no data found" outcome produces a row (proof of search).
 *
 * DESIGN CONSTRAINTS
 *   - `requestId` is the public, URL-safe reference (`crq_<uuid>`).
 *   - `tenantScope` is empty for cross-tenant compliance flows; it lists the
 *     tenants touched otherwise.
 *   - `evidenceKey` points at a storage artifact (or the presigned URL is
 *     derived from it). Never stores the raw data, only references.
 *   - Transitions are validated by the repository (`status in fromStates`);
 *     the model itself stays a plain document holder.
 *
 * INDEXES
 *   - unique(requestId)
 *   - { subjectId: 1, type: 1, createdAt: -1 }
 *   - { status: 1, dueBy: 1 }
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'ComplianceLog';
export const REQUEST_TYPES = Object.freeze([
  'export', 'delete', 'restrict', 'consent.withdraw',
]);
export const REQUEST_STATUSES = Object.freeze([
  'received', 'in_progress', 'completed', 'rejected', 'cancelled',
]);
export const SUBJECT_TYPES = Object.freeze(['user', 'tenant']);

const complianceLogSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true },
    type: { type: String, enum: [...REQUEST_TYPES], required: true },
    subjectId: { type: String, required: true, index: true },
    subjectType: { type: String, enum: [...SUBJECT_TYPES], default: 'user' },
    subjectEmail: { type: String, default: null },
    requesterId: { type: String, default: null },
    requesterType: { type: String, enum: [...SUBJECT_TYPES, 'admin'], default: 'user' },
    tenantScope: { type: [String], default: [] },
    status: { type: String, enum: [...REQUEST_STATUSES], default: 'received', index: true },
    reason: { type: String, default: null },
    evidenceKey: { type: String, default: null },
    dueBy: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    cancelledReason: { type: String, default: null },
  },
  { timestamps: true },
);

complianceLogSchema.index({ subjectId: 1, type: 1, createdAt: -1 });
complianceLogSchema.index({ status: 1, dueBy: 1 });

complianceLogSchema.plugin(paginate);

export const ComplianceLogSchema = complianceLogSchema;
export const ComplianceLog = mongoose.model(MODEL_NAME, complianceLogSchema);
export default ComplianceLog;
