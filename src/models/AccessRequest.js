import mongoose from 'mongoose';
import { audit } from './plugins/index.js';

export const ACCESS_REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

const accessRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    workspaceName: { type: String, required: true, trim: true, maxlength: 120 },
    reason: { type: String, default: '', trim: true, maxlength: 500 },
    status: { type: String, enum: ACCESS_REQUEST_STATUSES, default: 'pending', index: true },
    reference: { type: String, required: true, unique: true, index: true },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: null },
    decisionNote: { type: String, default: '', maxlength: 500 },
    tenantId: { type: String, default: null },
    invitationId: { type: String, default: null },
  },
  { timestamps: true },
);

accessRequestSchema.index({ email: 1, workspaceName: 1, status: 1 });
accessRequestSchema.plugin(audit, { module: 'platform.access_requests' });

export const AccessRequest = mongoose.model('AccessRequest', accessRequestSchema);
export default AccessRequest;
