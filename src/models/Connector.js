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
 *
 * WEBHOOK INBOUND
 *   A webhook-type connector carries a `webhookToken` (a public, URL-safe
 *   secret) used to address its inbound route: `POST /webhooks/:webhookToken`.
 *   The route verifies the `X-Saas-Signature` HMAC over the raw body using the
 *   connector's (decrypted) `signingSecret` before enqueueing.
 *
 * PLUGINS
 *   tenantScope (a connector always belongs to a tenant), softDelete,
 *   paginate, optimisticConcurrency, audit (module `connectors`).
 *
 * INDEXES
 *   - { tenantId: 1, type: 1 }
 *   - unique(webhookToken) sparse (only webhook connectors carry it)
 */

import mongoose from 'mongoose';
import { tenantScope, softDelete, paginate, optimisticConcurrency, audit } from './plugins/index.js';

export const MODEL_NAME = 'Connector';
export const CONNECTOR_TYPES = Object.freeze(['csv', 'webhook']);
export const CONNECTOR_STATUSES = Object.freeze(['active', 'paused', 'error']);

const connectorSchema = new mongoose.Schema(
  {
    tenantId: { type: String, required: true, index: true },
    type: { type: String, enum: [...CONNECTOR_TYPES], required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    status: { type: String, enum: [...CONNECTOR_STATUSES], default: 'active', index: true },
    // Encrypted envelope of the connector config (credentials, endpoints...).
    config: { type: String, default: null },
    // Public, URL-safe token addressing the inbound webhook route (webhook type).
    webhookToken: { type: String, default: null, unique: true, sparse: true, index: true },
    // Plain (non-secret) field mapping { sourceField: 'source', targetField: 'target' } or array.
    fieldMapping: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Last ingestion bookkeeping.
    lastSyncedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    errorCount: { type: Number, default: 0 },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true },
);

connectorSchema.index({ tenantId: 1, type: 1 });

connectorSchema.plugin(tenantScope);
connectorSchema.plugin(softDelete);
connectorSchema.plugin(paginate);
connectorSchema.plugin(optimisticConcurrency);
connectorSchema.plugin(audit, { module: 'connectors' });

export const ConnectorSchema = connectorSchema;
export const Connector = mongoose.model(MODEL_NAME, connectorSchema);
export default Connector;
