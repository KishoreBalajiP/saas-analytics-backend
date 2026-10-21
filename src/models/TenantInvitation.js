/**
 * Tenant owner/member invitation. Only a digest of the emailed token is stored.
 *
 * LIFECYCLE (roadmap 2.10, ten.12)
 *   `pending` -> `accepted` | `revoked` | `expired`. Rows are history and are
 *   never removed at expiry: the invitation-expiry sweep moves a pending row
 *   past `expiresAt` to `expired` (and gives its seat back). Retention of the
 *   history is declared in `constants/retention.members.js`.
 *
 * INDEXES
 *   - unique(tokenHash)
 *   - unique partial { tenantId, invitedEmail } while `pending`
 *   - { tenantId, invitedEmail, status }
 *   - { status, expiresAt } (expiry sweep; replaces the old TTL index)
 *   - { tenantId, status, createdAt } (members page listing)
 */
import mongoose from 'mongoose';
import { tenantScope, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'TenantInvitation';
export const INVITATION_STATUSES = Object.freeze(['pending', 'accepted', 'revoked', 'expired']);

const schema = new mongoose.Schema({
  tenantId: { type: String, required: true, index: true },
  invitedEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
  roleId: { type: String, required: true },
  roleName: { type: String, required: true },
  invitedBy: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, select: false },
  status: { type: String, enum: [...INVITATION_STATUSES], default: 'pending', index: true },
  // No TTL index: expired invitations stay as history (the expiry sweep
  // uses the { status, expiresAt } index). An old TTL index `expiresAt_1`
  // is dropped by `npm run db:member-indexes`.
  expiresAt: { type: Date, required: true },
  acceptedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  expiredAt: { type: Date, default: null },
  acceptedBy: { type: String, default: null },
  revokedBy: { type: String, default: null },
  resendCount: { type: Number, default: 0, min: 0 },
  lastSentAt: { type: Date, default: null },
}, { timestamps: true });

schema.index({ tenantId: 1, invitedEmail: 1, status: 1 });
schema.index(
  { tenantId: 1, invitedEmail: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
schema.index({ status: 1, expiresAt: 1 });
schema.index({ tenantId: 1, status: 1, createdAt: -1 });
schema.plugin(tenantScope);
schema.plugin(paginate);
schema.plugin(optimisticConcurrency);
schema.plugin(audit, { module: 'iam.tenant_invitations' });

export const TenantInvitationSchema = schema;
export const TenantInvitation = mongoose.model(MODEL_NAME, schema);
export default TenantInvitation;
