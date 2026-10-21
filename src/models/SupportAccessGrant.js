/**
 * SupportAccessGrant (roadmap 2.3 - support access redesign).
 *
 * PURPOSE
 *   The permission a workspace gives platform support to open read-only
 *   impersonation sessions, for a bounded window. Two kinds:
 *   - `consent`     granted by a workspace Owner/Admin from workspace
 *                   settings (`settings.configure`). Any in-scope support
 *                   admin may use it until it expires or is revoked.
 *   - `break_glass` requested by a support admin for an incident when the
 *                   workspace cannot consent, approved by a different, active
 *                   super admin. Usable only by the requesting admin and
 *                   flagged on every session and audit row it produces.
 *
 * LIFECYCLE
 *   consent:     active -> revoked                 (expiry is computed)
 *   break_glass: pending -> active | denied ; active -> revoked
 *   A grant is usable only while `status = active` and `expiresAt > now`.
 *
 * PRIVACY
 *   The tenant sees every grant (and who granted, requested or approved it)
 *   in workspace settings and in its audit history.
 *
 * PLUGINS
 *   tenantScope, paginate, optimisticConcurrency. Not the row-level `audit`
 *   plugin: every state change emits an explicit, tenant-visible domain row
 *   (`support.access` / `support.impersonation`) from the support services.
 *
 * INDEXES
 *   - { tenantId: 1, status: 1, expiresAt: -1 }   active grant lookup
 *   - { tenantId: 1, createdAt: -1 }              tenant history
 *   - { status: 1, kind: 1, createdAt: -1 }       pending break-glass queue
 */

import mongoose from 'mongoose';
import { tenantScope, paginate, optimisticConcurrency } from './plugins/index.js';
import { withPrefix } from '../utils/id.js';
import { SUPPORT_GRANT_KINDS, SUPPORT_GRANT_STATUSES } from '../constants/support.js';

export const MODEL_NAME = 'SupportAccessGrant';

const supportAccessGrantSchema = new mongoose.Schema(
  {
    grantId: { type: String, required: true, unique: true, default: () => withPrefix('sag') },
    tenantId: { type: String, required: true },
    kind: { type: String, enum: [...SUPPORT_GRANT_KINDS], required: true },
    status: { type: String, enum: [...SUPPORT_GRANT_STATUSES], required: true },
    // Why access is needed (tenant note for consent, incident reason for break-glass).
    reason: { type: String, default: null, maxlength: 500 },
    ticket: { type: String, default: null, maxlength: 120 },
    // Consent: the workspace user who granted it.
    grantedBy: { type: String, default: null },
    grantedByDisplay: { type: String, default: null },
    // Break-glass: the requesting support admin (the only admin who may use it).
    requestedBy: { type: String, default: null },
    requestedByDisplay: { type: String, default: null },
    // Break-glass: the super admin who approved or denied it.
    decidedBy: { type: String, default: null },
    decidedByDisplay: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionReason: { type: String, default: null, maxlength: 500 },
    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null },
    revokedByType: { type: String, enum: ['user', 'admin', 'system', null], default: null },
    revokedReason: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true },
);

supportAccessGrantSchema.index({ tenantId: 1, status: 1, expiresAt: -1 });
supportAccessGrantSchema.index({ tenantId: 1, createdAt: -1 });
supportAccessGrantSchema.index({ status: 1, kind: 1, createdAt: -1 });

supportAccessGrantSchema.plugin(tenantScope);
supportAccessGrantSchema.plugin(paginate);
supportAccessGrantSchema.plugin(optimisticConcurrency);

export const SupportAccessGrantSchema = supportAccessGrantSchema;
export const SupportAccessGrant = mongoose.models[MODEL_NAME]
  || mongoose.model(MODEL_NAME, supportAccessGrantSchema);
export default SupportAccessGrant;
