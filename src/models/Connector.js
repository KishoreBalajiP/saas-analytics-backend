/**
 * Connector (Sprint 4 - implemented).
 *
 * PURPOSE
 *   A persisted, tenant-scoped data source the platform ingests from. The
 *   connector row stores identity + metadata (type, name, status) plus the
 *   provider configuration as an ENCRYPTED blob (`config` envelope produced by
 *   `utils/encryption.js`). Plain `fieldMapping` is not secret and stays in the
 *   clear so the field-mapping UI can render it without decrypting.
 *
 * TYPES
 *   `csv`     - file upload connector (parses CSV into rows).
 *   `webhook` - inbound provider events behind an HMAC-verified endpoint.
 *   `xlsx`    - spreadsheet upload connector (Sprint 9, parses .xlsx rows).
 *   `mongodb` - external MongoDB source (Sprint 9, authenticated pull sync;
 *               credentials stay encrypted and are never logged).
 *
 * WEBHOOK INBOUND
 *   A webhook-type connector carries a `webhookToken` (a public, URL-safe
 *   secret) used to address its inbound route: `POST /webhooks/:webhookToken`.
 *   The route verifies the `X-Saas-Signature` HMAC using the connector's
 *   (decrypted) `signingSecret` before enqueueing. `webhookSignatureVersion`
 *   selects the scheme: 2 (every new connector) signs `${timestamp}.${body}`
 *   and requires `X-Saas-Timestamp`; 1 / absent is the legacy body-only
 *   scheme kept for connectors created before v2. `webhookToleranceSeconds`
 *   mirrors the (non-secret) timestamp window so requests can be pre-checked
 *   before the encrypted config is decrypted.
 *
 * PLUGINS
 *   tenantScope (a connector always belongs to a tenant), softDelete,
 *   paginate, optimisticConcurrency, audit (module `connectors`).
 *
 * INDEXES
 *   - { tenantId: 1, type: 1 }
 *   - { syncStatus: 1, syncLeaseUntil: 1 } (stale-sync reaper)
 *   - unique(webhookToken) sparse (only webhook connectors carry it)
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Connector';
export const CONNECTOR_TYPES = Object.freeze(['csv', 'webhook', 'xlsx', 'mongodb']);
export const CONNECTOR_STATUSES = Object.freeze(['active', 'paused', 'error']);
export const CONNECTOR_SYNC_STATUSES = Object.freeze(['idle', 'queued', 'running', 'succeeded', 'failed']);

const connectorSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    type: { type: String, enum: [...CONNECTOR_TYPES], required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: [...CONNECTOR_STATUSES], default: 'active', index: true },
    // Encrypted envelope of the connector config (credentials, endpoints...).
    config: { type: String, default: null },
    // Public, URL-safe token addressing the inbound webhook route (webhook
    // type). `default: undefined` (rather than null) keeps the field ABSENT
    // for non-webhook connectors so the sparse unique index never indexes a
    // null and CSV connectors cannot collide on `webhookToken: null`.
    webhookToken: { type: String, default: undefined, unique: true, sparse: true, index: true },
    // Webhook signature scheme (1 = legacy body-only, 2 = timestamp-bound).
    // Absent on non-webhook connectors and on webhooks created before v2.
    webhookSignatureVersion: { type: Number, enum: [1, 2], default: undefined },
    // Non-secret copy of the webhook timestamp tolerance (seconds).
    webhookToleranceSeconds: { type: Number, min: 1, max: 3600, default: undefined },
    // Plain (non-secret) field mapping { sourceField: 'source', targetField: 'target' } or array.
    fieldMapping: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Last ingestion bookkeeping.
    lastSyncedAt: { type: Date, default: null },
    syncStatus: { type: String, enum: [...CONNECTOR_SYNC_STATUSES], default: 'idle', index: true },
    syncRequestedAt: { type: Date, default: null },
    // Lease on the queued/running sync (roadmap 1.4). Renewed while the
    // worker runs; once it expires the sync may be re-queued and the
    // stale-job reaper recovers the connector.
    syncLeaseUntil: { type: Date, default: null },
    // SyncRun record of the sync currently queued/running (null when idle).
    currentSyncRunId: { type: String, default: null },
    lastError: { type: String, default: null },
    errorCount: { type: Number, default: 0 },
    // Dataset version: incremented whenever this connector's rows change
    // (sync, ingest, purge). Analytics and widget cache keys include it so a
    // sync invalidates cached results immediately.
    dataVersion: { type: Number, default: 0 },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

connectorSchema.index({ tenantId: 1, type: 1 });
// Stale-job reaper scan: syncs stuck in queued/running past their lease.
connectorSchema.index({ syncStatus: 1, syncLeaseUntil: 1 });

connectorSchema.plugin(tenantScope);
connectorSchema.plugin(softDelete);
connectorSchema.plugin(paginate);
connectorSchema.plugin(optimisticConcurrency);
connectorSchema.plugin(audit, { module: 'connectors' });

export const ConnectorSchema = connectorSchema;
export const Connector = mongoose.model(MODEL_NAME, connectorSchema);
export default Connector;
