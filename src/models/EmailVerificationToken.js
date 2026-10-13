/**
 * Email verification token.
 *
 * A single-use token is sent to a newly registered workspace owner. Only the
 * SHA-256 digest is persisted so the raw token never lives in MongoDB.
 */

import mongoose from 'mongoose';
import { tenantScope, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'EmailVerificationToken';

const emailVerificationTokenSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    status: { type: String, enum: ['pending', 'used', 'expired'], default: 'pending', index: true },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    usedAt: { type: Date, default: null },
    // Delivery truth: whether the verification email actually left the
    // process. `unconfigured` means no mail transport is available (the
    // message was never sent), `failed` means the provider rejected it.
    // This is persisted so operators can tell "user never received" apart
    // from "user did not click the link".
    deliveryStatus: {
      type: String,
      enum: ['pending', 'sent', 'failed', 'unconfigured'],
      default: 'pending',
    },
    deliveryError: { type: String, default: null },
    lastSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);

emailVerificationTokenSchema.index({ userId: 1, usedAt: 1 });
emailVerificationTokenSchema.plugin(tenantScope, { optional: true });
emailVerificationTokenSchema.plugin(paginate);
emailVerificationTokenSchema.plugin(optimisticConcurrency);
emailVerificationTokenSchema.plugin(audit, { module: 'iam.email_verification' });

export const EmailVerificationTokenSchema = emailVerificationTokenSchema;
export const EmailVerificationToken = mongoose.model(MODEL_NAME, emailVerificationTokenSchema);
export default EmailVerificationToken;
