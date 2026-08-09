/**
 * Connector Service (Sprint 4 - implemented).
 *
 * WHY IT EXISTS
 *   Business layer for the connector feature. Owns the rules that the
 *   controllers and the sync worker both rely on: config validation +
 *   encryption, webhook token issuance, CSV preview/sync, webhook signature
 *   verification and the ingest pipeline that persists `ConnectorRow`s
 *   through the shared sync engine.
 *
 * RESPONSIBILITY
 *   - CRUD: create / list / get / update / soft-delete connectors. `config`
 *     is always encrypted at rest (`utils/encryption.js`); a redacted
 *     summary is what leaves this layer (secrets never travel to clients).
 *   - CSV: preview a buffer, or enqueue a stream-parse sync job.
 *   - Webhook: resolve by token, verify HMAC + timestamp (fail closed),
 *     normalise the payload and enqueue an ingest job.
 *   - Worker: `processSyncMessage` runs the provider pipeline (streaming
 *     CSV or arrays) through `ingestRecords` and persists via
 *     `connectorRowRepository.upsertRows` (idempotent on `sourceRowId`).
 *
 * ENCRYPTION CONTEXT
 *   Secrets are scoped with `{ tenantId, purpose: 'connector' }` so a leaked
 *   master secret alone does not decrypt another tenant's credentials.
 *
 * @module connector-service
 */

import crypto from 'node:crypto';
import env from '../config/env.js';
import { CONNECTOR_TYPES } from '../models/Connector.js';
import connectorRepository from '../repositories/connector.repository.js';
import connectorRowRepository from '../repositories/connectorRow.repository.js';
import { createConnector, listConnectors } from '../connectors/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
// Side-effect import: registers the `csv` + `webhook` providers in the
// ConnectorRegistry at boot so `createConnector`/`listConnectors` work.
import '../modules/connectors/index.js';
import {
  ConnectorError,
  ConnectorConfigError,
  ConnectorValidationError,
  WebhookSignatureError,
} from '../modules/connectors/shared/errors.js';
import { validateConfig, validateFieldMapping } from '../modules/connectors/shared/validators.js';
import { ingestRecords } from '../modules/connectors/shared/sync-engine.js';
import { verifyWebhook } from '../modules/connectors/webhook/webhook.verify.js';
import { connectorQueue } from '../queues/connector.queue.js';

/* ------------------------------ helpers ---------------------------------- */

const encryptionContext = (tenantId) => ({
  tenantId,
  purpose: env.connectors.encryptionPurpose,
});

const encryptConfig = (config, tenantId) =>
  encrypt(JSON.stringify(config ?? {}), encryptionContext(tenantId));

const decryptConfig = async (connector) => {
  if (!connector?.config) return {};
  const plain = await decrypt(connector.config, encryptionContext(connector.tenantId));
  try {
    return JSON.parse(plain);
  } catch {
    throw new ConnectorConfigError('Stored connector config is not valid JSON');
  }
};

/** Non-secret view of a config for API responses (secrets never leave the server). */
function redactConfig(type, config) {
  if (type === 'webhook') {
    return {
      toleranceSeconds: config?.toleranceSeconds,
      requireTimestamp: config?.requireTimestamp ?? false,
      signingSecretConfigured: Boolean(config?.signingSecret),
    };
  }
  return {
    delimiter: config?.delimiter ?? ',',
    hasHeader: config?.hasHeader ?? true,
  };
}

/** Public-safe connector shape for API responses. */
function toPublic(connector) {
  if (!connector) return null;
  const { config, _decryptedConfig, ...rest } = connector;
  return {
    ...rest,
    configSummary: redactConfig(connector.type, _decryptedConfig ?? {}),
  };
}

/* -------------------------------- CRUD ----------------------------------- */

/**
 * Create a connector. Config is validated then encrypted at rest.
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} [input.actorId]
 * @param {string} input.type - 'csv' | 'webhook'
 * @param {string} input.name
 * @param {Object} [input.config]
 * @param {Object|Array} [input.fieldMapping]
 * @returns {Promise<Object>} public connector (includes `webhookToken`).
 */
export async function createConnectorRecord({ tenantId, actorId = null, type, name, config = {}, fieldMapping } = {}) {
  if (!CONNECTOR_TYPES.includes(type)) {
    throw new ConnectorConfigError(`Unsupported connector type "${type}"`, [
      { field: 'type', message: `must be one of ${CONNECTOR_TYPES.join(', ')}` },
    ]);
  }
  const verdict = validateConfig(type, config);
  if (!verdict.valid) throw new ConnectorConfigError(`Invalid ${type} connector configuration`, verdict.errors);
  const mappingVerdict = validateFieldMapping(fieldMapping);
  if (!mappingVerdict.valid) throw new ConnectorValidationError('Invalid field mapping', mappingVerdict.errors);

  const webhookToken = type === 'webhook' ? crypto.randomBytes(24).toString('base64url') : undefined;

  const saved = await connectorRepository.create({
    tenantId,
    type,
    name,
    status: 'active',
    config: await encryptConfig(config, tenantId),
    fieldMapping: fieldMapping ?? {},
    webhookToken,
    createdBy: actorId,
  });
  return toPublic(saved);
}

/** Paginated list of connectors for a tenant. */
export async function listConnectorRecords({ tenantId, page = 1, limit = 20, type } = {}) {
  const result = await connectorRepository.list({
    tenantId,
    filter: type ? { type } : {},
    page,
    limit,
  });
  return { ...result, docs: result.docs.map((c) => toPublic({ ...c, _decryptedConfig: {} })) };
}

/** Single connector (public shape). */
export async function getConnectorRecord({ tenantId, connectorId }) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector not found', { statusCode: 404 });
  const config = await decryptConfig(connector);
  return toPublic({ ...connector, _decryptedConfig: config });
}

/**
 * Update a connector. `config` (when present) is re-validated and
 * re-encrypted; `type` is immutable.
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.connectorId
 * @param {string} [input.actorId]
 * @param {Object} [input.patch]
 * @returns {Promise<Object>} updated public connector.
 */
export async function updateConnectorRecord({ tenantId, connectorId, actorId = null, patch = {} } = {}) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector not found', { statusCode: 404 });
  if (patch.type && patch.type !== connector.type) {
    throw new ConnectorConfigError('Connector type is immutable');
  }
  if (patch.fieldMapping !== undefined) {
    const mappingVerdict = validateFieldMapping(patch.fieldMapping);
    if (!mappingVerdict.valid) throw new ConnectorValidationError('Invalid field mapping', mappingVerdict.errors);
  }

  const updates = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.fieldMapping !== undefined) updates.fieldMapping = patch.fieldMapping;
  if (patch.config !== undefined) {
    const nextConfig = { ...(await decryptConfig(connector)), ...patch.config };
    const verdict = validateConfig(connector.type, nextConfig);
    if (!verdict.valid) throw new ConnectorConfigError(`Invalid ${connector.type} connector configuration`, verdict.errors);
    updates.config = await encryptConfig(nextConfig, tenantId);
  }
  updates.updatedBy = actorId;

  const updated = await connectorRepository.update(connectorId, updates);
  if (!updated) throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector not found', { statusCode: 404 });
  const config = await decryptConfig(updated);
  return toPublic({ ...updated, _decryptedConfig: config });
}

/** Soft-delete a connector. */
export async function deleteConnectorRecord({ tenantId, connectorId, actorId = null } = {}) {
  const removed = await connectorRepository.remove(connectorId, actorId);
  if (!removed) throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector not found', { statusCode: 404 });
  return removed;
}

/** List connector rows for a connector (tenant-scoped). */
export async function listConnectorRows({ tenantId, connectorId, page = 1, limit = 50 } = {}) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector not found', { statusCode: 404 });
  return connectorRowRepository.list({ connectorId, tenantId, page, limit });
}

/** Registered connector types/capabilities for UI + discovery. */
export function listConnectorTypes() {
  return listConnectors();
}

/**
 * Validate a persisted connector's stored config without ingesting anything.
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.connectorId
 * @returns {Promise<{ valid: boolean, errors: Array, connector: Object }>}
 */
export async function validateConnectorRecord({ tenantId, connectorId } = {}) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector not found', { statusCode: 404 });
  const config = await decryptConfig(connector);
  const instance = createConnector(connector.type, { id: connectorId, config, tenantId });
  const verdict = await instance.validate();
  return { valid: verdict.valid, errors: verdict.errors ?? [], connector: toPublic({ ...connector, _decryptedConfig: config }) };
}

/* ------------------------------- CSV ------------------------------------- */

/**
 * Preview the first rows of an uploaded CSV using the connector's config.
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.connectorId
 * @param {Buffer} input.buffer
 * @param {number} [input.limit]
 * @returns {Promise<{ fields: string[], sample: Array, meta: Object }>}
 */
export async function previewCsvUpload({ tenantId, connectorId, buffer, limit = 10 } = {}) {
  if (!buffer) throw new ConnectorValidationError('CSV preview requires an uploaded file');
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector not found', { statusCode: 404 });
  const config = await decryptConfig(connector);
  const instance = createConnector(connector.type, { id: connectorId, config, tenantId });
  const verdict = await instance.validate();
  if (!verdict.valid) throw new ConnectorConfigError('Invalid connector configuration', verdict.errors);
  return instance.preview({ buffer, limit });
}

/**
 * Enqueue a CSV sync job. The upload buffer is carried in the message
 * (base64) and the worker streams it through the parser + sync engine.
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.connectorId
 * @param {Buffer} input.buffer
 * @param {string} [input.filename]
 * @param {string} [input.actorId]
 * @returns {Promise<{ accepted: boolean, jobType: string, filename: string|null }>}
 */
export async function syncCsvUpload({ tenantId, connectorId, buffer, filename = null, actorId = null } = {}) {
  if (!buffer || buffer.length === 0) throw new ConnectorValidationError('CSV sync requires an uploaded file');
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector not found', { statusCode: 404 });
  const config = await decryptConfig(connector);
  const instance = createConnector(connector.type, { id: connectorId, config, tenantId });
  const verdict = await instance.validate();
  if (!verdict.valid) throw new ConnectorConfigError('Invalid connector configuration', verdict.errors);

  await connectorQueue.enqueue({
    connectorId,
    tenantId,
    jobType: 'ingest',
    payload: { buffer: buffer.toString('base64'), filename, mimetype: 'text/csv' },
  }, { name: 'csv-sync', jobId: `csv-${connectorId}-${Date.now()}` });

  return { accepted: true, jobType: 'ingest', filename };
}

/* ------------------------------- Webhook --------------------------------- */

/**
 * Handle an inbound webhook: resolve by token, verify the HMAC signature
 * (fail closed), normalise the payload and enqueue an ingest job.
 *
 * @param {Object} input
 * @param {string} input.webhookToken
 * @param {Buffer} input.rawBody - EXACT request body bytes.
 * @param {Object} input.headers - lower-cased headers.
 * @returns {Promise<{ accepted: boolean, received: number }>}
 */
export async function handleWebhook({ webhookToken, rawBody, headers } = {}) {
  if (!webhookToken) throw new WebhookSignatureError('Missing webhook token');
  const connector = await connectorRepository.findByWebhookToken(webhookToken);
  // Fail closed and stay opaque: unknown tokens get the same 401 as a bad
  // signature so they cannot be enumerated.
  if (!connector) throw new WebhookSignatureError('Invalid webhook signature');

  const config = await decryptConfig(connector);
  verifyWebhook({
    rawBody,
    headers,
    secret: config.signingSecret,
    rule: {
      toleranceSeconds: config.toleranceSeconds ?? env.connectors.webhookToleranceSeconds,
      requireTimestamp: config.requireTimestamp ?? false,
    },
  });

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new ConnectorValidationError('Webhook body must be valid JSON');
  }

  const instance = createConnector(connector.type, { id: String(connector._id), config, tenantId: connector.tenantId });
  const records = await instance.ingest({ payload });

  await connectorQueue.enqueue({
    connectorId: String(connector._id),
    tenantId: connector.tenantId,
    jobType: 'ingest',
    payload: { records },
  }, { name: 'webhook-ingest', jobId: `webhook-${connector._id}-${Date.now()}` });

  return { accepted: true, received: records.length };
}

/* -------------------------------- worker ---------------------------------- */

/**
 * Process a sync queue message (the connector queue consumer handler).
 * Resolves the connector, runs the provider pipeline through the shared
 * sync engine and persists rows idempotently.
 *
 * @param {Object} job
 * @param {Object} job.data
 * @param {string} job.data.connectorId
 * @param {string} job.data.tenantId
 * @param {string} job.data.jobType
 * @param {Object} job.data.payload
 * @returns {Promise<Object>} sync result metrics.
 */
export async function processSyncMessage(job = {}) {
  const { connectorId, tenantId, jobType, payload = {} } = job.data ?? {};
  if (!connectorId || !tenantId) {
    throw new ConnectorValidationError('Sync message is missing connectorId or tenantId');
  }
  if (jobType !== 'ingest') {
    throw new ConnectorValidationError(`Unsupported connector job type "${jobType}"`);
  }

  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) {
    throw new ConnectorError('CONNECTOR_NOT_FOUND', 'Connector no longer exists', { statusCode: 404 });
  }
  const config = await decryptConfig(connector);
  const instance = createConnector(connector.type, { id: connectorId, config, tenantId });

  let records;
  if (payload.buffer) {
    records = instance.ingest({ buffer: Buffer.from(payload.buffer, 'base64') });
  } else {
    records = payload.records ?? [];
  }

  let result;
  try {
    result = await ingestRecords({
      records,
      fieldMapping: connector.fieldMapping,
      persist: (batch) => connectorRowRepository.upsertRows(connectorId, tenantId, batch),
    });
  } catch (err) {
    await connectorRepository.bumpError(connectorId, err?.message ?? 'Sync failed');
    throw err;
  }

  const lastError = result.errors.length > 0 ? `ingested with ${result.errors.length} field errors` : null;
  await connectorRepository.update(connectorId, {
    lastSyncedAt: new Date(),
    lastError,
    errorCount: result.errors.length > 0 ? (connector.errorCount ?? 0) + 1 : 0,
  });

  return result;
}

export default {
  createConnectorRecord,
  listConnectorRecords,
  getConnectorRecord,
  updateConnectorRecord,
  deleteConnectorRecord,
  listConnectorRows,
  listConnectorTypes,
  validateConnectorRecord,
  previewCsvUpload,
  syncCsvUpload,
  handleWebhook,
  processSyncMessage,
};
