/** Tenant owner/member invitation. Only a digest of the emailed token is stored. */
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
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  acceptedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  acceptedBy: { type: String, default: null },
}, { timestamps: true });

schema.index({ tenantId: 1, invitedEmail: 1, status: 1 });
schema.index(
  { tenantId: 1, invitedEmail: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);
schema.plugin(tenantScope);
schema.plugin(paginate);
schema.plugin(optimisticConcurrency);
schema.plugin(audit, { module: 'iam.tenant_invitations' });

export const TenantInvitationSchema = schema;
export const TenantInvitation = mongoose.model(MODEL_NAME, schema);
export default TenantInvitation;
