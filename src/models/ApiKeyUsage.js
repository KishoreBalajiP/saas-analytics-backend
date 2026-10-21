/**
 * ApiKeyUsage (devapi package, roadmap 3.3).
 *
 * Per-key request counters for the external API: one row per
 * (key, UTC day, endpoint, HTTP status) with a `count`. Written with an
 * atomic upsert + $inc after each response (`apiKeyUsage.service.js`).
 * `endpoint` is the route pattern (`GET /datasets/:datasetId`), never the
 * concrete URL, so no ids or query strings are stored.
 */

import mongoose from 'mongoose';
import { tenantScope } from './plugins/index.js';

export const MODEL_NAME = 'ApiKeyUsage';

const apiKeyUsageSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    keyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (UTC)
    endpoint: { type: String, required: true, maxlength: 200 },
    status: { type: Number, required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: true },
);

apiKeyUsageSchema.index({ tenantId: 1, keyId: 1, day: 1, endpoint: 1, status: 1 }, { unique: true });
apiKeyUsageSchema.plugin(tenantScope);

export const ApiKeyUsage = mongoose.model(MODEL_NAME, apiKeyUsageSchema);
export default ApiKeyUsage;
