/**
 * RowPolicy (roadmap 4.E4, rls).
 *
 * PURPOSE
 *   A row-level security rule on one dataset: a member only sees rows where
 *   `data.<field>` equals (op `eq`) or is one of (op `in`) the values of the
 *   member's user attribute `<attribute>` (`User.attributes`). Several
 *   enabled rules on one dataset are AND-ed. A member without the attribute
 *   sees no rows of that dataset (fail closed). Applied server-side by the
 *   analytics engine on every query path; never widened by client filters.
 *
 * INDEXES
 *   { tenantId, connectorId, enabled }
 */

import mongoose from 'mongoose';
import { tenantScope, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'RowPolicy';
export const ROW_POLICY_OPS = Object.freeze(['eq', 'in']);

const rowPolicySchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    connectorId: { type: String, required: true },
    field: { type: String, required: true, trim: true, maxlength: 128 },
    op: { type: String, enum: [...ROW_POLICY_OPS], default: 'eq' },
    attribute: { type: String, required: true, trim: true, maxlength: 64 },
    enabled: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
  },
  { timestamps: true },
);

rowPolicySchema.index({ tenantId: 1, connectorId: 1, enabled: 1 });

rowPolicySchema.plugin(tenantScope);
rowPolicySchema.plugin(paginate);
rowPolicySchema.plugin(optimisticConcurrency);
rowPolicySchema.plugin(audit, { module: 'data_access' });

export const RowPolicy = mongoose.model(MODEL_NAME, rowPolicySchema);
export default RowPolicy;
