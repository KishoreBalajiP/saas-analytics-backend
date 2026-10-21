/**
 * SecuritySignal (roadmap 2.6 - platform security detection).
 *
 * PURPOSE
 *   Per-minute request counters for the request-level detection rules,
 *   written in batches by `services/securityDetection/signals.js` (fed by
 *   `middleware/securitySignals.middleware.js`). One row per
 *   (kind, subject, minute bucket); counts are `$inc`-merged so many
 *   instances can flush into the same row.
 *
 * KINDS (subject in brackets)
 *   - api_key.request        [api key id]       calls made with a valid key
 *   - api_key.auth_failed    [public prefix]    refused calls naming a key
 *   - rate_limit.hit         [tenant:<id> | ip:<range>]  429 responses
 *   - tenant.request         [tenant id]        authenticated request volume
 *   - connector.auth_failed  [connector id]     webhook signature refusals
 *   - webhook.unknown_token  [ip:<range>]       refusals for unknown webhook tokens
 *
 * PRIVACY
 *   No credentials ever: API keys by id or their public lookup prefix,
 *   webhook connectors by id (the URL token is resolved in memory and
 *   dropped), client addresses reduced to a /24 (IPv4) or /48 (IPv6) range.
 *
 * RETENTION
 *   TTL index on `expiresAt` (bucket + RETENTION_SECURITY_SIGNAL_DAYS).
 *
 * INDEXES
 *   - unique { kind, subject, bucket }
 *   - { kind: 1, bucket: -1 }
 *   - { expiresAt: 1 } TTL
 */

import mongoose from 'mongoose';
import { paginate } from './plugins/index.js';

export const MODEL_NAME = 'SecuritySignal';

export const SIGNAL_KINDS = Object.freeze([
  'api_key.request',
  'api_key.auth_failed',
  'rate_limit.hit',
  'tenant.request',
  'connector.auth_failed',
  'webhook.unknown_token',
]);
/** Distinct IP ranges / actors kept per row per flush. */
export const MAX_SET_ENTRIES = 20;

const securitySignalSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: [...SIGNAL_KINDS], required: true },
    subject: { type: String, required: true, maxlength: 200 },
    tenantId: { type: String, default: null },
    bucket: { type: Date, required: true },
    count: { type: Number, default: 0 },
    clientErrors: { type: Number, default: 0 },
    serverErrors: { type: Number, default: 0 },
    ipRanges: { type: [String], default: [] },
    actors: { type: [String], default: [] },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true },
);

securitySignalSchema.index({ kind: 1, subject: 1, bucket: 1 }, { unique: true });
securitySignalSchema.index({ kind: 1, bucket: -1 });
securitySignalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

securitySignalSchema.plugin(paginate);

export const SecuritySignalSchema = securitySignalSchema;
export const SecuritySignal = mongoose.models[MODEL_NAME] || mongoose.model(MODEL_NAME, securitySignalSchema);
export default SecuritySignal;
