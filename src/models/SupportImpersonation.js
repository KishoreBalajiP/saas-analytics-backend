/**
 * SupportImpersonation (roadmap 2.3 - support access redesign).
 *
 * PURPOSE
 *   Durable record of one read-only support session: which operator (admin)
 *   acted as which workspace user, under which grant, why, and for how long.
 *   The backing `Session` is short-lived and TTL-purged at expiry, so this
 *   record is what the workspace (and platform audit) sees afterwards.
 *
 * LIFECYCLE
 *   active -> ended (stopped by the operator, ended from the tenant UI, or
 *   revoked with the grant). A record still `active` past `expiresAt` is
 *   reported as `expired` by the service.
 *
 * PLUGINS
 *   tenantScope, paginate. Not the row-level `audit` plugin: start and end
 *   emit explicit, tenant-visible domain rows from the support services.
 *
 * INDEXES
 *   - unique(sessionId)
 *   - { tenantId: 1, startedAt: -1 }          tenant history
 *   - { adminId: 1, startedAt: -1 }           operator history
 *   - { grantId: 1, status: 1 }               revoke-with-grant cascade
 */

import mongoose from 'mongoose';
import { tenantScope, paginate } from './plugins/index.js';
import { SUPPORT_GRANT_KINDS, SUPPORT_IMPERSONATION_STATUSES } from '../constants/support.js';

export const MODEL_NAME = 'SupportImpersonation';

const supportImpersonationSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    userId: { type: String, required: true },
    userDisplay: { type: String, default: null },
    adminId: { type: String, required: true },
    adminDisplay: { type: String, default: null },
    grantId: { type: String, required: true },
    kind: { type: String, enum: [...SUPPORT_GRANT_KINDS], required: true },
    breakGlass: { type: Boolean, default: false },
    readOnly: { type: Boolean, default: true },
    reason: { type: String, required: true, maxlength: 500 },
    ticket: { type: String, default: null, maxlength: 120 },
    status: { type: String, enum: [...SUPPORT_IMPERSONATION_STATUSES], default: 'active' },
    startedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    endedBy: { type: String, default: null },
    endedReason: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true },
);

supportImpersonationSchema.index({ tenantId: 1, startedAt: -1 });
supportImpersonationSchema.index({ adminId: 1, startedAt: -1 });
supportImpersonationSchema.index({ grantId: 1, status: 1 });

supportImpersonationSchema.plugin(tenantScope);
supportImpersonationSchema.plugin(paginate);

export const SupportImpersonationSchema = supportImpersonationSchema;
export const SupportImpersonation = mongoose.models[MODEL_NAME]
  || mongoose.model(MODEL_NAME, supportImpersonationSchema);
export default SupportImpersonation;
