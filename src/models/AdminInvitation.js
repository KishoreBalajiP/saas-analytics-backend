/**
 * AdminInvitation (roadmap 2.2, adminauth).
 *
 * PURPOSE
 *   One-time invitation for a platform administrator. Inviting an admin
 *   creates the Admin record in status `pending` with no password, plus one
 *   of these rows; the emailed link lets the invitee set a password (and,
 *   for privileged types, enrol MFA). A pending admin cannot sign in.
 *
 * SECURITY
 *   - Only the SHA-256 digest of the emailed token is stored (`select: false`).
 *   - At most one `pending` invitation per admin (partial unique index); a
 *     resend supersedes the previous token.
 *   - Rows are kept after acceptance/revocation/expiry as history and are
 *     purged by the retention job (`constants/retention.adminauth.js`), not
 *     by a TTL index. The audit plugin is deliberately not applied (its
 *     snapshot would copy the token digest); every lifecycle step emits an
 *     explicit security event instead.
 *
 * INDEXES
 *   - unique(tokenHash)
 *   - unique(adminId) where status = pending
 *   - { status: 1, createdAt: -1 }, { email: 1, createdAt: -1 }
 */

import mongoose from 'mongoose';
import { paginate, optimisticConcurrency } from './plugins/index.js';

export const MODEL_NAME = 'AdminInvitation';
export const ADMIN_INVITATION_STATUSES = Object.freeze(['pending', 'accepted', 'revoked', 'expired']);

const schema = new mongoose.Schema(
  {
    adminId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    adminType: { type: String, required: true },
    invitedBy: { type: String, default: null },
    tokenHash: { type: String, required: true, select: false },
    status: { type: String, enum: [...ADMIN_INVITATION_STATUSES], default: 'pending' },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null },
    revokedReason: { type: String, default: null },
    sendCount: { type: Number, default: 1, min: 0 },
    lastSentAt: { type: Date, default: null },
    delivered: { type: Boolean, default: false },
  },
  { timestamps: true },
);

schema.index({ tokenHash: 1 }, { unique: true });
schema.index({ adminId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
schema.index({ status: 1, createdAt: -1 });
schema.index({ email: 1, createdAt: -1 });

schema.plugin(paginate);
schema.plugin(optimisticConcurrency);

export const AdminInvitationSchema = schema;
export const AdminInvitation = mongoose.model(MODEL_NAME, schema);
export default AdminInvitation;
