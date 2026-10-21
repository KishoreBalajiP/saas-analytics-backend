/**
 * AiConsent (ai-ask): a workspace's recorded consent to send schemas and
 * aggregates to the AI provider. One document per tenant.
 * PLUGINS tenantScope.  INDEXES unique(tenantId).
 */
import mongoose from 'mongoose';
import { tenantScope } from './plugins/index.js';

const aiConsentSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true },
    granted: { type: Boolean, default: false },
    grantedBy: { type: String, default: null },
    grantedAt: { type: Date, default: null },
    revokedBy: { type: String, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
aiConsentSchema.index({ tenantId: 1 }, { unique: true });
aiConsentSchema.plugin(tenantScope);

export const AiConsent = mongoose.model('AiConsent', aiConsentSchema);
export default AiConsent;
