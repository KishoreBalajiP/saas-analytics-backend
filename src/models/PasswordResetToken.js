/**
 * Password reset token (Phase 1).
 *
 * Only a SHA-256 digest is persisted. The opaque token is generated once,
 * delivered by email, and atomically marked used by the reset operation.
 */

import mongoose from 'mongoose';
import { tenantScope, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'PasswordResetToken';
export const PASSWORD_RESET_PORTALS = Object.freeze(['user', 'admin']);

const passwordResetTokenSchema = new mongoose.Schema(
  {
    portal: { type: String, enum: [...PASSWORD_RESET_PORTALS], required: true, index: true },
    actorId: { type: String, required: true, index: true },
    tenantId: { type: String, default: null, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

passwordResetTokenSchema.index({ actorId: 1, portal: 1, usedAt: 1 });
passwordResetTokenSchema.plugin(tenantScope, { optional: true });
passwordResetTokenSchema.plugin(paginate);
passwordResetTokenSchema.plugin(optimisticConcurrency);
passwordResetTokenSchema.plugin(audit, { module: 'iam.password_resets' });

export const PasswordResetTokenSchema = passwordResetTokenSchema;
export const PasswordResetToken = mongoose.model(MODEL_NAME, passwordResetTokenSchema);
export default PasswordResetToken;
