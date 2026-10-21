/**
 * Connector Service (Sprint 4 - implemented).
 *
 * WHY IT EXISTS
 *   Business layer for the connector feature. Owns the rules that the
 *   controllers and the sync worker both rely on: config validation +
 *   encryption, egress policy, webhook token issuance, file preview/sync,
 *   webhook verification and the ingest pipeline that persists
 *   `ConnectorRow`s through the shared sync engine.
 *
 * RESPONSIBILITY
 *   - CRUD: create / list / get / update / soft-delete connectors. `config`
 *     is always encrypted at rest (`utils/encryption.js`); a redacted
 *     summary is what leaves this layer (secrets never travel to clients).
 *   - Delete cascade: rows purged, quotas released, the tenant's analytics
 *     cache invalidated, and dependants (widgets, reports, alerts) marked
 *     broken with their schedules stopped.
 *   - Files (CSV / XLSX): preview a buffer, or enqueue a stream-parse sync
 *     job. The sniffed file type must match the connector type.
 *   - Webhook: cheap pre-checks first (token shape, content type, size,
 *     connector state, tenant active, header format, timestamp window), then
 *     the cached signing key, HMAC over `${timestamp}.${body}`, replay
 *     claim, storedRows quota, and an ingest job.
 *   - Worker: `processSyncMessage` runs the provider pipeline under a
 *     wall-clock deadline and a row cap, persists via
 *     `connectorRowRepository.upsertRows` (idempotent on `sourceRowId`) and
 *     stores only tenant-safe error messages.
 *   - Ingestion (manual sync, webhook, worker) is refused when the tenant is
 *     not active or the connector is paused.
 *   - Sync runs (roadmap 1.4): every sync is a `SyncRun` record. A tracked
 *     sync takes the connector's sync slot with a lease
 *     (`CONNECTOR_SYNC_LEASE_MS`) renewed while the worker runs; a second
 *     request while a live sync holds the slot gets 409 `SYNC_IN_PROGRESS`,
 *     and a crashed worker's expired lease frees the slot (the stale-job
 *     reaper also marks its run `abandoned`). Syncs of tenants that are not
 *     active, or of paused connectors, are cancelled at execution time.
 *
 * ENCRYPTION CONTEXT
 *   Secrets are scoped with `{ tenantId, purpose: 'connector' }` so a leaked
 *   master secret alone does not decrypt another tenant's credentials.
 *
 * @module connector-service
 */

// rls: dataset grants and row-level security on raw row listings.
import dataAccess from './dataAccess.service.js';
import crypto from 'node:crypto';
import env from '../config/env.js';
import entitlementService from './entitlement.service.js';
import logger from '../utils/logger.js';
import ApiError from '../utils/ApiError.js';
import { ERROR_CODES } from '../config/constants.js';
import usageService from './usage.service.js';
import * as analyticsCache from './analytics.cache.js';
import * as auditLogService from './auditLog.service.js';
import { CONNECTOR_TYPES } from '../models/Connector.js';
import { BROKEN_REASONS } from '../models/plugins/dependencyHealth.js';
import connectorRepository from '../repositories/connector.repository.js';
import connectorRowRepository from '../repositories/connectorRow.repository.js';
import connectorDependantsRepository from '../repositories/connectorDependants.repository.js';
import { createConnector, listConnectors } from '../connectors/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { parseMongoUri, assertPublicMongoHosts } from '../utils/netGuard.js';
// Side-effect import: registers the `csv` + `webhook` providers in the
// ConnectorRegistry at boot so `createConnector`/`listConnectors` work.
import '../modules/connectors/index.js';
import {
  ConnectorError,
  ConnectorConfigError,
  ConnectorValidationError,
  WebhookSignatureError,
  RowLimitError,
  CONNECTOR_ERROR_CODES,
  toPublicSyncError,
} from '../modules/connectors/shared/errors.js';
import { validateConfig, validateFieldMapping, MAX_WEBHOOK_TOLERANCE_SECONDS } from '../modules/connectors/shared/validators.js';
import { ingestRecords, withDeadline } from '../modules/connectors/shared/sync-engine.js';
import { sniffFileKind } from '../modules/connectors/shared/file-type.js';
import {
  precheckWebhookHeaders,
  verifyPrechecked,
  assertTimestampInWindow,
  MAX_FUTURE_SKEW_SECONDS,
  SIGNATURE_VERSIONS,
  CURRENT_SIGNATURE_VERSION,
} from '../modules/connectors/webhook/webhook.verify.js';
import webhookKeyCache from '../modules/connectors/webhook/webhook.keyCache.js';
import { webhookPayloadTooLarge } from '../modules/connectors/webhook/webhook.body.js';
import { claimDelivery, releaseDelivery } from '../modules/connectors/webhook/webhook.replay.js';
import { connectorQueue } from '../queues/connector.queue.js';
import syncRunRepository from '../repositories/syncRun.repository.js';
// datasets: schema catalogue refreshed after each successful sync.
import { profileConnector as profileDatasetSchema, getSchema as getDatasetSchema } from './datasetSchema.service.js';
import { SYNC_RUN_STATUSES } from '../models/SyncRun.js';
import { isTenantActive as tenantGuardIsActive } from '../jobs/tenantGuard.js';
import { getInstanceId } from '../jobs/runtime.js';
import { sanitizeError } from '../utils/sanitizeError.js';

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
function redactConfig(type, config, connector = {}) {
  if (type === 'webhook') {
    const timestamped = (connector.webhookSignatureVersion ?? SIGNATURE_VERSIONS.LEGACY) >= SIGNATURE_VERSIONS.TIMESTAMPED;
    return {
      toleranceSeconds: config?.toleranceSeconds ?? connector.webhookToleranceSeconds,
      // v2 signatures always require the timestamp header.
      requireTimestamp: timestamped ? true : (config?.requireTimestamp ?? false),
      signingSecretConfigured: Boolean(config?.signingSecret),
    };
  }
  if (type === 'xlsx') {
    return {
      hasHeader: config?.hasHeader ?? true,
      sheet: config?.sheet ?? 0,
    };
  }
  if (type === 'mongodb') {
    // Extract host:port from URI without credentials.
    let host = 'unknown';
    try {
      const url = new URL(config?.uri ?? '');
      host = url.hostname + (url.port ? ':' + url.port : '');
    } catch {
      // ignore
    }
    return {
      host,
      database: config?.database,
      collection: config?.collection,
      filterConfigured: Boolean(config?.filter),
      hasCredentials: true,
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
    configSummary: redactConfig(connector.type, _decryptedConfig ?? {}, connector),
  };
}

const FILE_CONNECTOR_TYPES = Object.freeze(['csv', 'xlsx']);
const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const JSON_CONTENT_TYPE_RE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

const notFound = (message = 'Connector not found') =>
  new ConnectorError(CONNECTOR_ERROR_CODES.NOT_FOUND, message, { statusCode: 404 });

/**
 * True when the tenant exists and is `active` (unknown / malformed ids are
 * not). Other lookup failures (database unavailable) propagate, so a request
 * fails with 5xx and a queued job is retried instead of being skipped as if
 * the workspace were suspended. One implementation for the whole platform:
 * `jobs/tenantGuard.js`.
 */
function isTenantActive(tenantId) {
  return tenantGuardIsActive(tenantId, { onLookupError: 'throw' });
}

/**
 * Ingestion (manual sync, webhook) is refused at request time when the
 * workspace is suspended, disabled, archived or not yet active.
 */
async function assertTenantActive(tenantId) {
  if (!(await isTenantActive(tenantId))) {
    throw new ConnectorError(
      ERROR_CODES.TENANT_NOT_ACTIVE,
      'This workspace is not active, so syncs and webhook ingestion are disabled.',
      { statusCode: 403 },
    );
  }
}

/** A paused connector refuses every ingestion path. */
function assertConnectorActive(connector) {
  if (connector.status === 'paused') {
    throw new ConnectorError(
      CONNECTOR_ERROR_CODES.CONNECTOR_PAUSED,
      'This connector is paused. Resume it to sync or receive webhook data.',
      { statusCode: 409 },
    );
  }
}

/**
 * Egress policy at create / update time for network connectors. Resolves
 * DNS, so it only runs when private networks are NOT allowed (production);
 * the worker re-checks on every connection regardless.
 */
async function assertEgressAllowed(type, config) {
  if (type !== 'mongodb' || env.connectors.allowPrivateNetworks) return;
  await assertPublicMongoHosts(parseMongoUri(config?.uri));
}

/** The sniffed upload type must match the connector type. */
function assertFileMatchesConnector(connector, buffer, detectedType) {
  if (!FILE_CONNECTOR_TYPES.includes(connector.type)) {
    throw new ConnectorError('FILE_UPLOAD_NOT_SUPPORTED', `A ${connector.type} connector does not accept file uploads.`, { statusCode: 400 });
  }
  const kind = detectedType ?? sniffFileKind(buffer);
  if (kind !== connector.type) {
    const expected = connector.type === 'csv' ? '.csv (or .txt)' : '.xlsx';
    const code = kind === 'csv' || kind === 'xlsx'
      ? CONNECTOR_ERROR_CODES.FILE_TYPE_MISMATCH
      : CONNECTOR_ERROR_CODES.UNSUPPORTED_FILE_TYPE;
    throw new ConnectorError(code, `This connector accepts ${expected} files only.`, { statusCode: 415 });
  }
}

/** Map a preview parser failure to a typed, tenant-safe error. */
function toPreviewError(error, connectorType) {
  if (error instanceof ConnectorError) return error;
  const { message } = toPublicSyncError(error, connectorType);
  return new ConnectorError(CONNECTOR_ERROR_CODES.FILE_PARSE_FAILED, message, { statusCode: 422 });
}

async function audit({ tenantId, actorId, action, resourceId, after }) {
  try {
    await auditLogService.emit({
      actor: actorId ? { type: 'user', id: String(actorId) } : { type: 'system', id: 'system' },
      action,
      module: 'connectors',
      resource: { type: 'connector', id: String(resourceId) },
      after,
      tenantId,
    });
  } catch {
    // best-effort trail write; the connector operation already succeeded.
  }
}

/* ---------------------------- sync slot ---------------------------------- */

const syncLeaseMs = () => env.connectors.syncLeaseMs ?? 15 * 60 * 1000;
const syncRunRetentionDays = () => env.retention?.syncRunDays ?? 90;

/** True while a queued/running sync still holds a live lease. */
function hasLiveSync(connector, now = new Date()) {
  if (!['queued', 'running'].includes(connector?.syncStatus)) return false;
  if (connector.syncLeaseUntil) return new Date(connector.syncLeaseUntil) > now;
  if (!connector.syncRequestedAt) return false;
  return new Date(connector.syncRequestedAt).getTime() > now.getTime() - syncLeaseMs();
}

function syncInProgressError() {
  return new ConnectorError(
    'SYNC_IN_PROGRESS',
    'A sync is already queued or running for this connector; wait for it to finish',
    { statusCode: 409 },
  );
}

/**
 * Fail fast when a live sync holds the slot. The atomic claim in
 * `enqueueTrackedSync` remains the real guard.
 */
function assertNoLiveSync(connector) {
  if (hasLiveSync(connector)) throw syncInProgressError();
}

/* -------------------------------- CRUD ----------------------------------- */

/**
 * Create a connector. Config is validated (structure + egress policy) then
 * encrypted at rest. New webhook connectors use timestamp-bound (v2)
 * signatures.
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} [input.actorId]
 * @param {string} input.type - 'csv' | 'xlsx' | 'mongodb' | 'webhook'
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
  await assertEgressAllowed(type, config);

  // Connector-count quota: consumed atomically after validation, given back
  // if the create fails.
  const isWebhook = type === 'webhook';
  const saved = await usageService.withQuota({ tenantId, metric: 'connectors', by: actorId }, async () => connectorRepository.create({
    tenantId,
    type,
    name,
    status: 'active',
    config: await encryptConfig(config, tenantId),
    fieldMapping: fieldMapping ?? {},
    webhookToken: isWebhook ? crypto.randomBytes(24).toString('base64url') : undefined,
    webhookSignatureVersion: isWebhook ? CURRENT_SIGNATURE_VERSION : undefined,
    webhookToleranceSeconds: isWebhook && config.toleranceSeconds !== undefined ? config.toleranceSeconds : undefined,
    createdBy: actorId,
  }));
  return toPublic({ ...saved, _decryptedConfig: config });
}

/** Paginated list of connectors for a tenant. */
export async function listConnectorRecords({ tenantId, page = 1, limit = 20, type, excludeIds = [] } = {}) {
  const result = await connectorRepository.list({
    tenantId,
    // rls: `excludeIds` = datasets the caller may not see (dataAccess).
    filter: { ...(type ? { type } : {}), ...(excludeIds.length ? { _id: { $nin: excludeIds } } : {}) },
    page,
    limit,
  });
  return { ...result, docs: result.docs.map((c) => toPublic({ ...c, _decryptedConfig: {} })) };
}

/** Single connector (public shape). */
export async function getConnectorRecord({ tenantId, connectorId }) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw notFound();
  const config = await decryptConfig(connector);
  return toPublic({ ...connector, _decryptedConfig: config });
}

/**
 * Update a connector. `config` (when present) is re-validated (including
 * the egress policy) and re-encrypted; `type` is immutable. A webhook
 * connector can be upgraded to timestamp-bound signatures with
 * `webhookSignatureVersion: 2` (never downgraded).
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
  if (!connector) throw notFound();
  if (patch.type && patch.type !== connector.type) {
    throw new ConnectorConfigError('Connector type is immutable');
  }
  if (patch.fieldMapping !== undefined) {
    const mappingVerdict = validateFieldMapping(patch.fieldMapping);
    if (!mappingVerdict.valid) throw new ConnectorValidationError('Invalid field mapping', mappingVerdict.errors);
  }

  // Updating a connector does not create one, so it does not consume the
  // `connectors` quota (that counts connectors that exist).

  const updates = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.fieldMapping !== undefined) updates.fieldMapping = patch.fieldMapping;
  let currentConfig = null;
  if (patch.config !== undefined) {
    currentConfig = await decryptConfig(connector);
    const nextConfig = { ...currentConfig, ...patch.config };
    const verdict = validateConfig(connector.type, nextConfig);
    if (!verdict.valid) throw new ConnectorConfigError(`Invalid ${connector.type} connector configuration`, verdict.errors);
    await assertEgressAllowed(connector.type, nextConfig);
    updates.config = await encryptConfig(nextConfig, tenantId);
    currentConfig = nextConfig;
    if (connector.type === 'webhook' && nextConfig.toleranceSeconds !== undefined) {
      updates.webhookToleranceSeconds = nextConfig.toleranceSeconds;
    }
  }
  if (patch.webhookSignatureVersion !== undefined) {
    if (connector.type !== 'webhook') {
      throw new ConnectorConfigError('webhookSignatureVersion applies to webhook connectors only');
    }
    const requested = Number(patch.webhookSignatureVersion);
    const current = connector.webhookSignatureVersion ?? SIGNATURE_VERSIONS.LEGACY;
    if (!Object.values(SIGNATURE_VERSIONS).includes(requested)) {
      throw new ConnectorConfigError('Invalid webhook signature version', [
        { field: 'webhookSignatureVersion', message: `must be ${CURRENT_SIGNATURE_VERSION}` },
      ]);
    }
    if (requested < current) {
      throw new ConnectorConfigError('Webhook signature version cannot be downgraded', [
        { field: 'webhookSignatureVersion', message: 'timestamp-bound signatures cannot be turned off' },
      ]);
    }
    updates.webhookSignatureVersion = requested;
    if (requested >= SIGNATURE_VERSIONS.TIMESTAMPED && connector.webhookToleranceSeconds === undefined
      && updates.webhookToleranceSeconds === undefined) {
      const cfg = currentConfig ?? await decryptConfig(connector);
      if (typeof cfg.toleranceSeconds === 'number') {
        updates.webhookToleranceSeconds = Math.min(cfg.toleranceSeconds, MAX_WEBHOOK_TOLERANCE_SECONDS);
      }
    }
  }
  updates.updatedBy = actorId;

  const updated = await connectorRepository.update(connectorId, updates);
  if (!updated) throw notFound();
  webhookKeyCache.invalidate(connectorId);
  const config = currentConfig ?? await decryptConfig(updated);
  return toPublic({ ...updated, _decryptedConfig: config });
}

/**
 * Soft-delete a connector and cascade:
 *   - its ingested rows are deleted and the storedRows / connectors quota
 *     released (scheduledReports too, for report schedules it stops);
 *   - the tenant's cached analytics results are dropped (tenant-wide
 *     queries included the deleted rows);
 *   - widgets, reports and alerts that read from it are marked broken
 *     (`CONNECTOR_DELETED`), alerts disabled and report schedules stopped,
 *     so they show a clear state instead of failing on every run.
 *
 * @returns {Promise<Object>} the removed connector plus a `cascade` summary.
 */
export async function deleteConnectorRecord({ tenantId, connectorId, actorId = null } = {}) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw notFound();

  const removed = await connectorRepository.remove(connectorId, actorId);
  if (!removed) throw notFound();
  webhookKeyCache.invalidate(connectorId);

  // Deleting a dataset removes its rows: otherwise tenant-wide analytics
  // queries keep returning data from a connector the user deleted.
  const counted = await connectorRowRepository.count(connectorId, tenantId).catch(() => 0);
  const purged = await connectorRowRepository.deleteForConnector(connectorId, tenantId);
  // Release exactly the rows that were purged (the stored-rows meter counted
  // each of them when it was added).
  const rowCount = Number.isInteger(purged?.deletedCount) ? purged.deletedCount : counted;
  // Give back the capacity the connector and its rows were using.
  await usageService.release({ tenantId, metric: 'connectors', requested: 1, by: actorId });
  if (rowCount > 0) await usageService.release({ tenantId, metric: 'storedRows', requested: rowCount, by: actorId });

  // The connector is already gone, so a failure here must not fail the
  // request (a retry would 404 and never cascade): log it instead. The
  // dependants then fail at run time, as they did before the cascade.
  let dependants = { widgets: 0, reports: 0, reportSchedulesStopped: 0, alerts: 0 };
  try {
    dependants = await connectorDependantsRepository.markBrokenForConnector({
      tenantId,
      connectorId,
      reason: BROKEN_REASONS.CONNECTOR_DELETED,
    });
    // Report schedules the cascade switched off no longer hold a
    // scheduled-report slot.
    if (dependants.reportSchedulesStopped > 0) {
      await usageService.release({ tenantId, metric: 'scheduledReports', requested: dependants.reportSchedulesStopped, by: actorId });
    }
  } catch (error) {
    logger.error(
      { err: { message: error?.message }, tenantId: String(tenantId), connectorId: String(connectorId) },
      'connector delete: marking dependants broken failed',
    );
  }
  // Cached results computed from the deleted rows must not be served again.
  let cacheEntriesCleared = 0;
  try {
    cacheEntriesCleared = await analyticsCache.invalidateTenant(tenantId);
  } catch {
    // Cache unavailable: entries expire with their TTL; the delete stands.
  }

  const cascade = {
    rowsDeleted: rowCount,
    cacheEntriesCleared,
    widgetsBroken: dependants.widgets,
    reportsBroken: dependants.reports,
    alertsDisabled: dependants.alerts,
  };
  await audit({ tenantId, actorId, action: 'connector.deleted', resourceId: connectorId, after: { type: connector.type, ...cascade } });
  return { ...removed, cascade };
}

/** List connector rows for a connector (tenant-scoped). */
export async function listConnectorRows({ tenantId, connectorId, page = 1, limit = 50 } = {}) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw notFound();
  // rls: dataset grants and row rules of the current actor.
  const match = await dataAccess.rowListMatch({ tenantId, connectorId });
  return connectorRowRepository.list({ connectorId, tenantId, page, limit, match });
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
  if (!connector) throw notFound();
  const config = await decryptConfig(connector);
  const instance = createConnector(connector.type, { id: connectorId, config, tenantId });
  const verdict = await instance.validate();
  return { valid: verdict.valid, errors: verdict.errors ?? [], connector: toPublic({ ...connector, _decryptedConfig: config }) };
}

/* ---------------------------- files (CSV / XLSX) --------------------------- */

/**
 * Preview the first rows of an uploaded file using the connector's config.
 * The file type is sniffed from its bytes and must match the connector.
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.connectorId
 * @param {Buffer} input.buffer
 * @param {'csv'|'xlsx'} [input.detectedType] - set by the upload middleware.
 * @param {number} [input.limit]
 * @returns {Promise<{ fields: string[], sample: Array, meta: Object }>}
 */
export async function previewFileUpload({ tenantId, connectorId, buffer, detectedType, limit = 10 } = {}) {
  if (!buffer || buffer.length === 0) throw new ConnectorValidationError('Preview requires an uploaded file');
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw notFound();
  assertFileMatchesConnector(connector, buffer, detectedType);
  const config = await decryptConfig(connector);
  const instance = createConnector(connector.type, { id: connectorId, config, tenantId });
  const verdict = await instance.validate();
  if (!verdict.valid) throw new ConnectorConfigError('Invalid connector configuration', verdict.errors);
  try {
    return await instance.preview({ buffer, limit: Math.max(1, Math.min(Number(limit) || 10, 100)) });
  } catch (error) {
    throw toPreviewError(error, connector.type);
  }
}

/** @deprecated CSV-specific alias of `previewFileUpload`. */
export async function previewCsvUpload(input = {}) {
  return previewFileUpload(input);
}

/**
 * Enqueue a file (CSV / XLSX) sync. The worker streams the buffer through
 * the provider parser + sync engine. Refused when the tenant is not active,
 * the connector is paused, the file does not match the connector type, or a
 * live sync already holds the connector's sync slot (409 SYNC_IN_PROGRESS).
 *
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.connectorId
 * @param {Buffer} input.buffer
 * @param {string} [input.filename]
 * @param {'csv'|'xlsx'} [input.detectedType] - set by the upload middleware.
 * @param {string} [input.actorId]
 * @returns {Promise<{ accepted: boolean, jobType: string, filename: string|null, alreadyQueued: boolean, syncRunId: string, status: string }>}
 */
export async function syncFileUpload({ tenantId, connectorId, buffer, filename = null, detectedType, actorId = null } = {}) {
  if (!buffer || buffer.length === 0) throw new ConnectorValidationError('File sync requires an uploaded file');
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw notFound();
  await assertTenantActive(tenantId);
  assertConnectorActive(connector);
  assertFileMatchesConnector(connector, buffer, detectedType);
  assertNoLiveSync(connector);
  const config = await decryptConfig(connector);
  const instance = createConnector(connector.type, { id: connectorId, config, tenantId });
  const verdict = await instance.validate();
  if (!verdict.valid) throw new ConnectorConfigError('Invalid connector configuration', verdict.errors);

  // Syncing an existing connector does not consume the `connectors` quota.

  // storedRows is metered by the sync worker on the rows it really adds
  // (usageService.createStoredRowsSink). Here only refuse a tenant that is
  // already over its hard limit (or write-blocked); a refresh at the limit
  // is allowed because it adds no rows.
  await usageService.assertCapacity({ tenantId, metric: 'storedRows', requested: 0 });

  const isXlsx = connector.type === 'xlsx';
  const mimetype = isXlsx
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv';

  const run = await enqueueTrackedSync({
    connectorId,
    actorId,
    tenantId,
    filename,
    job: {
      connectorId,
      tenantId,
      jobType: 'ingest',
      payload: { buffer: buffer.toString('base64'), filename, mimetype },
    },
    options: { name: `${connector.type}-sync`, jobId: `${connector.type}-${connectorId}-${Date.now()}` },
  });

  return { accepted: true, jobType: 'ingest', filename, alreadyQueued: false, syncRunId: run.id, status: run.status };
}

/** @deprecated CSV-specific alias of `syncFileUpload`. */
export async function syncCsvUpload(input = {}) {
  return syncFileUpload(input);
}

/**
 * Enqueue a mongodb pull-sync job. No file upload — the worker connects
 * to the external MongoDB (through the egress policy) and pulls documents.
 * @param {Object} input
 * @param {string} input.tenantId
 * @param {string} input.connectorId
 * @param {string} [input.actorId]
 * @returns {Promise<{ accepted: boolean, jobType: string, alreadyQueued: boolean, syncRunId: string, status: string }>}
 */
export async function syncMongoDB({ tenantId, connectorId, actorId = null } = {}) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw notFound();
  if (connector.type !== 'mongodb') throw new ConnectorValidationError('Not a mongodb connector');
  await assertTenantActive(tenantId);
  assertConnectorActive(connector);
  assertNoLiveSync(connector);

  // Syncing an existing connector does not consume the `connectors` quota.

  const config = await decryptConfig(connector);
  const instance = createConnector(connector.type, { id: connectorId, config, tenantId });
  const verdict = await instance.validate();
  if (!verdict.valid) throw new ConnectorConfigError('Invalid connector configuration', verdict.errors);

  // storedRows is metered by the sync worker on the documents it really
  // adds (usageService.createStoredRowsSink); here only refuse a tenant that
  // is already over its hard limit or write-blocked.
  await usageService.assertCapacity({ tenantId, metric: 'storedRows', requested: 0 });

  const run = await enqueueTrackedSync({
    connectorId,
    actorId,
    tenantId,
    job: { connectorId, tenantId, jobType: 'ingest', payload: {} },
    options: { name: 'mongodb-sync', jobId: `mongodb-${connectorId}-${Date.now()}` },
  });

  return { accepted: true, jobType: 'ingest', alreadyQueued: false, syncRunId: run.id, status: run.status };
}

/* ------------------------------- Webhook --------------------------------- */

/** Decrypted webhook config for a connector, through the short-TTL key cache. */
function webhookConfigFor(connector) {
  return webhookKeyCache.getWebhookConfig(connector, decryptConfig);
}

/**
 * Handle an inbound webhook.
 *
 * Order matters: everything that can be checked WITHOUT the signing key
 * runs first, so a forged, stale or malformed request never triggers the
 * (scrypt-based) key derivation:
 *
 *   1. token shape            -> 401 (opaque, like an unknown token)
 *   2. JSON content type      -> 415 WEBHOOK_UNSUPPORTED_MEDIA_TYPE
 *   3. body present + size    -> 413 WEBHOOK_PAYLOAD_TOO_LARGE
 *   4. connector by token     -> 401 (opaque)
 *   5. connector not paused   -> 409 CONNECTOR_PAUSED
 *   6. tenant active          -> 403 TENANT_NOT_ACTIVE
 *   7. signature + timestamp headers (format, scheme, window) -> 401 WEBHOOK_*
 *   8. signing key (cached per connector, short TTL)
 *   9. HMAC verify (constant time) -> 401 WEBHOOK_SIGNATURE_INVALID
 *  10. replay claim           -> 409 WEBHOOK_REPLAYED
 *  11. JSON + records cap      -> 422 / 413 WEBHOOK_TOO_MANY_RECORDS
 *  12. storedRows quota       -> 409 QUOTA_EXCEEDED
 *  13. enqueue ingest job (the reservation is reconciled by the worker;
 *      the worker records the delivery as a `webhook` SyncRun)
 *
 * @param {Object} input
 * @param {string} input.webhookToken
 * @param {Buffer} input.rawBody - EXACT request body bytes.
 * @param {Object} input.headers - lower-cased headers.
 * @returns {Promise<{ accepted: boolean, received: number, signatureVersion: number }>}
 */
export async function handleWebhook({ webhookToken, rawBody, headers = {} } = {}) {
  if (typeof webhookToken !== 'string' || !WEBHOOK_TOKEN_RE.test(webhookToken)) {
    throw new WebhookSignatureError('Invalid webhook signature');
  }
  if (!JSON_CONTENT_TYPE_RE.test(String(headers['content-type'] ?? ''))) {
    throw new ConnectorError(
      CONNECTOR_ERROR_CODES.WEBHOOK_UNSUPPORTED_MEDIA_TYPE,
      'Webhook bodies must be JSON (Content-Type: application/json).',
      { statusCode: 415 },
    );
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new ConnectorValidationError('Webhook body must be a non-empty JSON document');
  }
  const { maxBodyBytes, maxRecords, legacySignaturesEnabled } = env.connectors.webhook;
  if (rawBody.length > maxBodyBytes) throw webhookPayloadTooLarge(maxBodyBytes);

  const connector = await connectorRepository.findByWebhookToken(webhookToken);
  // Fail closed and stay opaque: unknown tokens get the same 401 as a bad
  // signature so they cannot be enumerated.
  if (!connector || connector.type !== 'webhook') throw new WebhookSignatureError('Invalid webhook signature');
  assertConnectorActive(connector);
  await assertTenantActive(connector.tenantId);

  const connectorVersion = connector.webhookSignatureVersion ?? SIGNATURE_VERSIONS.LEGACY;
  const defaultTolerance = env.connectors.webhookToleranceSeconds;
  // The (non-secret) mirrored window gives an exact pre-check. A v2
  // connector without a mirror uses the default (its config has no custom
  // window); a legacy connector may keep its window only in the encrypted
  // config, so it is pre-checked against the outer bound and checked
  // exactly once the config is loaded.
  const mirroredTolerance = connector.webhookToleranceSeconds;
  const precheck = precheckWebhookHeaders({
    headers,
    connectorVersion,
    toleranceSeconds: mirroredTolerance
      ?? (connectorVersion >= SIGNATURE_VERSIONS.TIMESTAMPED ? defaultTolerance : MAX_WEBHOOK_TOLERANCE_SECONDS),
    legacyEnabled: legacySignaturesEnabled,
    maxLegacyToleranceSeconds: MAX_WEBHOOK_TOLERANCE_SECONDS,
  });

  // Only now: the signing key (cached; at most one derivation per TTL).
  const config = await webhookConfigFor(connector);
  // One effective window for both schemes (the one the UI shows).
  const toleranceSeconds = mirroredTolerance ?? config.toleranceSeconds ?? defaultTolerance;
  if (precheck.version === SIGNATURE_VERSIONS.LEGACY && precheck.timestamp === null && config.requireTimestamp === true) {
    throw new WebhookSignatureError('Missing X-Saas-Timestamp header (unix seconds)', CONNECTOR_ERROR_CODES.WEBHOOK_TIMESTAMP_MISSING);
  }
  if (precheck.timestamp !== null) assertTimestampInWindow(precheck.timestamp, toleranceSeconds);
  const signature = verifyPrechecked({ precheck, rawBody, secret: config.signingSecret });

  const connectorId = String(connector._id);
  const fresh = await claimDelivery({
    connectorId,
    signature,
    ttlSeconds: toleranceSeconds + MAX_FUTURE_SKEW_SECONDS + 60,
  });
  if (!fresh) {
    throw new ConnectorError(
      CONNECTOR_ERROR_CODES.WEBHOOK_REPLAYED,
      'This delivery was already received. Sign every delivery with a new timestamp.',
      { statusCode: 409 },
    );
  }

  let reserved = 0;
  // Unique per delivery: a queue that dedupes on job id must never drop a
  // second delivery accepted in the same millisecond. It also keys the
  // delivery's storedRows reservation.
  const jobId = `webhook-${connectorId}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new ConnectorValidationError('Webhook body must be valid JSON');
    }
    const instance = createConnector(connector.type, { id: connectorId, config, tenantId: connector.tenantId });
    const records = await instance.ingest({ payload });
    if (records.length > maxRecords) {
      throw new ConnectorError(
        CONNECTOR_ERROR_CODES.WEBHOOK_TOO_MANY_RECORDS,
        `A webhook delivery may carry at most ${maxRecords} records.`,
        { statusCode: 413, details: [{ field: 'body', message: `at most ${maxRecords} records per delivery`, maxRecords }] },
      );
    }
    if (records.length === 0) {
      return { accepted: true, received: 0, signatureVersion: precheck.version };
    }

    // Webhook rows count toward the storedRows quota like file syncs, through
    // the same meter: the delivery reserves its rows now (atomic; a hard
    // limit answers 409 QUOTA_EXCEEDED so the sender retries later instead
    // of losing records), and the worker's stored-rows sink draws the rows
    // it really adds from that reservation and gives the rest back (rows
    // that only updated an existing sourceRowId). Nothing is counted twice.
    // The reservation lives in the usage ledger under the job id, so a
    // retried or replayed message draws only what is still unstored and
    // reconciliation sees it as in use while the message waits.
    await usageService.reserve({
      tenantId: connector.tenantId,
      metric: 'storedRows',
      key: jobId,
      connectorId,
      requested: records.length,
    });
    reserved = records.length;

    await connectorQueue.enqueue({
      connectorId,
      tenantId: connector.tenantId,
      jobType: 'ingest',
      payload: { records, reservedRows: reserved, reservationKey: jobId, source: 'webhook' },
    }, { name: 'webhook-ingest', jobId });

    return { accepted: true, received: records.length, signatureVersion: precheck.version };
  } catch (error) {
    // A refusal for a retryable reason (quota, queue) must not make the
    // sender's retry look like a replay. Payload errors are deterministic
    // for this exact body, so those keep the claim.
    const payloadError = error?.code === CONNECTOR_ERROR_CODES.PAYLOAD_INVALID
      || error?.code === CONNECTOR_ERROR_CODES.WEBHOOK_TOO_MANY_RECORDS;
    if (!payloadError) await releaseDelivery({ connectorId, signature });
    if (reserved > 0) {
      // Settles the ledger entry too: if the queue did take the job after
      // all, its worker finds nothing to draw and meters the rows instead.
      await usageService.cancelReservation({ tenantId: connector.tenantId, metric: 'storedRows', key: jobId }).catch(() => {});
    }
    throw error;
  }
}

/* ------------------------------ sync runs --------------------------------- */

/** Generic message stored when the queue refuses a job (queue errors can name infrastructure hosts). */
const QUEUE_FAILURE_MESSAGE = 'The sync could not be queued. Retry later.';

/**
 * Take the connector's sync slot, record a `queued` SyncRun and enqueue the
 * job. Throws 409 `SYNC_IN_PROGRESS` when a live sync holds the slot, and a
 * typed 503 (`QUEUE_TIMEOUT` / `QUEUE_UNAVAILABLE`) when the queue does not
 * accept the job; in both cases nothing is left in flight. No quota is held
 * while a sync is queued: the worker meters the rows it really adds.
 *
 * @returns {Promise<{ id: string, status: string }>} the SyncRun.
 */
async function enqueueTrackedSync({
  connectorId,
  actorId,
  tenantId,
  job,
  options,
  trigger = 'manual',
  filename = null,
  recoveryAttempt = 0,
  recoveredFrom = null,
}) {
  const requestedAt = new Date();
  const leaseMs = syncLeaseMs();
  const syncRunId = syncRunRepository.newId();

  const claimed = await connectorRepository.markSyncQueued(connectorId, {
    requestedAt, by: actorId, tenantId, leaseMs, syncRunId,
  });
  if (!claimed) throw syncInProgressError();

  try {
    // The previous holder lost its lease (crashed worker): close its run.
    await closeOpenRuns({ tenantId, connectorId, exceptId: syncRunId, status: 'abandoned', now: requestedAt });

    await syncRunRepository.create({
      _id: syncRunId,
      tenantId,
      connectorId: String(connectorId),
      trigger,
      jobType: job.jobType,
      status: 'queued',
      requestedBy: actorId,
      filename,
      jobId: options?.jobId ?? null,
      maxAttempts: connectorQueue.maxAttempts ?? null,
      queuedAt: requestedAt,
      leaseUntil: new Date(requestedAt.getTime() + leaseMs),
      recoveryAttempt,
      recoveredFrom,
    });
  } catch (error) {
    // Never leave the slot held by a run that was not recorded.
    await connectorRepository.markSyncFailed(connectorId, {
      requestedAt,
      message: 'The sync could not be started; please retry shortly',
    }).catch(() => {});
    throw error;
  }

  try {
    await connectorQueue.enqueue({ ...job, syncRunId, trigger }, options);
    return { id: syncRunId, status: 'queued' };
  } catch (error) {
    // Keep the machine code (QUEUE_TIMEOUT / QUEUE_UNAVAILABLE), never the
    // raw message: queue errors can name infrastructure hosts.
    const { code } = sanitizeError(error, { fallbackCode: 'QUEUE_UNAVAILABLE' });
    await syncRunRepository.finish(syncRunId, {
      status: 'failed',
      error: { code, message: QUEUE_FAILURE_MESSAGE },
      retentionDays: syncRunRetentionDays(),
    }).catch(() => {});
    await connectorRepository.markSyncFailed(connectorId, {
      requestedAt,
      message: QUEUE_FAILURE_MESSAGE,
    });
    throw error;
  }
}

/** Close every open run of a connector except `exceptId` (reaper / takeover). */
async function closeOpenRuns({ tenantId, connectorId, exceptId = null, status, now = new Date(), reason }) {
  const open = await syncRunRepository.findOpenForConnector({ tenantId, connectorId }).catch(() => []);
  let closed = 0;
  for (const run of open) {
    if (exceptId && String(run._id) === String(exceptId)) continue;
    const done = await syncRunRepository.finish(run._id, {
      status,
      finishedAt: now,
      error: {
        code: 'LEASE_EXPIRED',
        message: reason ?? 'The worker running this sync stopped before it finished',
      },
      retentionDays: syncRunRetentionDays(),
    }).catch(() => null);
    if (done) closed += 1;
  }
  return closed;
}

/**
 * Re-queue an interrupted pull sync (stale-job reaper). Only connectors whose
 * data can be pulled again (MongoDB) can be recovered this way; file uploads
 * lived in the lost message.
 *
 * @returns {Promise<{ id: string, status: string }>}
 */
export async function requeueRecoveredSync({ connector, recoveredFrom = null, recoveryAttempt = 1 }) {
  const connectorId = String(connector._id);
  return enqueueTrackedSync({
    connectorId,
    actorId: null,
    tenantId: connector.tenantId,
    trigger: 'recovery',
    recoveryAttempt,
    recoveredFrom,
    job: { connectorId, tenantId: connector.tenantId, jobType: 'ingest', payload: {} },
    options: { name: `${connector.type}-sync`, jobId: `recovery-${connectorId}-${Date.now()}` },
  });
}

/** Sync-run history for one connector (tenant-scoped, paginated). */
export async function listSyncRuns({ tenantId, connectorId, status, page = 1, limit = 20 } = {}) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw notFound();
  if (status !== undefined && !SYNC_RUN_STATUSES.includes(status)) {
    throw new ConnectorValidationError('Invalid sync run status filter', [
      { field: 'status', message: `must be one of ${SYNC_RUN_STATUSES.join(', ')}` },
    ]);
  }
  const result = await syncRunRepository.listForConnector({ tenantId, connectorId: String(connector._id), status, page, limit });
  return { ...result, docs: result.docs.map(toPublicRun) };
}

/**
 * Public sync-run shape for tenant users: an allow-list, so worker internals
 * (host/pid instance id, queue job id, lease and heartbeat bookkeeping,
 * retention expiry) never reach the API.
 */
function toPublicRun(run) {
  if (!run) return null;
  return {
    id: String(run._id),
    connectorId: run.connectorId,
    trigger: run.trigger,
    jobType: run.jobType ?? null,
    status: run.status,
    attempts: run.attempts ?? 0,
    maxAttempts: run.maxAttempts ?? null,
    recoveryAttempt: run.recoveryAttempt ?? 0,
    recoveredFrom: run.recoveredFrom ?? null,
    requestedBy: run.requestedBy ?? null,
    filename: run.filename ?? null,
    queuedAt: run.queuedAt ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
    rows: run.rows ?? null,
    error: run.error ?? null,
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
  };
}

/* -------------------------------- worker ---------------------------------- */

/**
 * Result of a message the worker did not run. `skipped: true` + `reason`
 * (snake_case) and `skippedReason` (machine code) identify why; the metric
 * fields are zero so callers can treat it like an empty sync.
 */
const skipResult = (reason, code) => ({
  processed: 0,
  upserted: 0,
  matched: 0,
  errors: [],
  skipped: true,
  reason,
  skippedReason: code,
});

/**
 * A plan-limit refusal from the stored-rows meter (`QUOTA_EXCEEDED`), or a
 * subscription that blocks writes. Typed, written by us (tenant-safe), and
 * a queue retry cannot fix it: capacity comes back only when the tenant
 * frees rows or upgrades. Only our own `ApiError`s qualify: a driver or
 * source library error that happens to carry the same string code keeps
 * the generic, retryable treatment and never has its message stored.
 */
function isQuotaRefusal(error) {
  return error instanceof ApiError
    && (error.code === ERROR_CODES.QUOTA_EXCEEDED || error.code === ERROR_CODES.SUBSCRIPTION_WRITE_BLOCKED);
}

/**
 * Failures that a retry cannot fix: the file is unreadable or over a cap,
 * the egress policy refuses the host, the config or payload is invalid, or
 * the plan has no room for the new rows. Our own connector errors with a
 * 4xx status (this includes `ConnectorValidationError` and
 * `ConnectorConfigError`) and quota refusals. Source outages (502) and
 * timeouts (504) stay retryable.
 */
function isPermanentSyncError(error) {
  if (isQuotaRefusal(error)) return true;
  const status = Number(error?.statusCode);
  return error instanceof ConnectorError && status >= 400 && status < 500;
}

/** Tenant-safe `{ code, message }` for a failed sync (quota refusals keep their own). */
function publicSyncError(error, connectorType) {
  if (isQuotaRefusal(error)) return { code: error.code, message: String(error.message).slice(0, 500) };
  return toPublicSyncError(error, connectorType);
}

/**
 * Process a sync queue message (the connector queue consumer handler).
 * Resolves the connector, runs the provider pipeline through the shared
 * sync engine (deadline + row cap) and persists rows idempotently, recording
 * the attempt on the message's SyncRun (created here for untracked messages
 * such as webhook ingests).
 *
 * storedRows (roadmap 1.3) follows the rows the sync really adds, through
 * one meter for every source (`usageService.createStoredRowsSink`): each
 * batch's new sourceRowIds are drawn from the message's request-time
 * reservation (webhook deliveries: the usage-ledger entry named by
 * `payload.reservationKey`; older messages carry `payload.reservedRows`)
 * and anything beyond it is consumed against the plan limit; replays and
 * refreshes add nothing. Rows a failed attempt did not store go back to the
 * reservation for the retry. Whatever part of the reservation did not
 * become new rows is given back when the message is done (success, skip or
 * final failure). New rows past a hard limit fail the sync with
 * `QUOTA_EXCEEDED` (permanent).
 *
 * Skips (without throwing, so the queue does not retry) when the run was
 * already closed (reaped or superseded), the connector no longer exists, the
 * connector is paused, or the tenant is not active; storedRows reserved for
 * the message are given back. Exception: a webhook delivery (untracked, its
 * records are in the message) whose run was `abandoned` by the reaper or a
 * slot takeover is replayed under a fresh run, so its records are stored and
 * its reservation is settled. A failing tenant lookup is an error (retried),
 * not a skip; on the last attempt the run is closed `failed`, the slot freed
 * and the reservation given back before the error is rethrown.
 *
 * Failures store only tenant-safe messages (on the connector and the run).
 * Permanent failures (row / size caps, unreadable file, egress policy,
 * invalid config or payload) close the run `failed` once and are returned as
 * `{ failed: { code, message } }` instead of thrown, so the queue does not
 * retry them. A transient failure with retries left is recorded as
 * `retrying` and rethrown so the queue backs off and retries; the last
 * attempt closes the run `failed`.
 *
 * @param {Object} job
 * @param {Object} job.data
 * @param {string} job.data.connectorId
 * @param {string} job.data.tenantId
 * @param {string} job.data.jobType
 * @param {Object} job.data.payload
 * @param {string} [job.data.syncRunId]
 * @param {number} [job.attemptsMade] - attempts already made (queue).
 * @param {number} [job.attempts] - attempts allowed (queue).
 * @returns {Promise<Object>} sync result metrics, a skip result
 *   (`{ skipped: true, reason, skippedReason }`) or `{ failed }`.
 */
export async function processSyncMessage(job = {}) {
  const { connectorId, tenantId, jobType, payload = {}, syncRunId = null, trigger = null } = job.data ?? {};
  if (!connectorId || !tenantId) {
    throw new ConnectorValidationError('Sync message is missing connectorId or tenantId');
  }
  if (jobType !== 'ingest') {
    throw new ConnectorValidationError(`Unsupported connector job type "${jobType}"`);
  }

  const now = new Date();
  const leaseMs = syncLeaseMs();
  const retentionDays = syncRunRetentionDays();
  const attempt = (Number(job.attemptsMade) || 0) + 1;
  const maxAttempts = Number(job.attempts) || connectorQueue.maxAttempts || 1;
  const tracked = Boolean(syncRunId);
  // The stored-rows meter for this message; it draws on the request-time
  // reservation (if any; webhook deliveries keep it in the usage ledger
  // under `reservationKey`, so a retry draws only what earlier attempts did
  // not store) until `settle()` gives back the unused part.
  const storedRows = usageService.createStoredRowsSink({
    tenantId,
    connectorId,
    reservationKey: payload.reservationKey ?? null,
    reserved: payload.reservedRows,
    upsert: (batch) => connectorRowRepository.upsertRows(connectorId, tenantId, batch),
  });
  // Untracked webhook deliveries carry their records in the message. A run
  // closed as `abandoned` was closed by the stale-sync reaper or a slot
  // takeover, never by a worker, so none of its rows were recorded and its
  // storedRows reservation was never settled: a redelivered message is
  // replayed under a fresh run instead of being dropped.
  const replayable = !tracked && Array.isArray(payload.records);
  const isAbandoned = (candidate) => replayable && candidate?.status === 'abandoned';
  const createRun = () => syncRunRepository.create({
    ...(tracked ? { _id: syncRunId } : {}),
    tenantId,
    connectorId: String(connectorId),
    trigger: trigger ?? (payload.source === 'webhook' || Array.isArray(payload.records) ? 'webhook' : 'manual'),
    jobType,
    status: 'queued',
    jobId: job.id ? String(job.id) : null,
    maxAttempts,
    queuedAt: now,
    filename: payload.filename ?? null,
  });
  const startRun = (id) => syncRunRepository.markRunning(id, {
    attempt,
    maxAttempts,
    instanceId: getInstanceId(),
    now,
    leaseUntil: new Date(now.getTime() + leaseMs),
  });

  // Tracked messages carry their run id; untracked ones (webhook ingests)
  // find the run of an earlier attempt of the same queue job, if any.
  let run = tracked
    ? await syncRunRepository.findById(syncRunId, { tenantId })
    : await syncRunRepository.findByJobId({ tenantId, connectorId, jobId: job.id });
  if (run && !['queued', 'running', 'retrying'].includes(run.status)) {
    if (!isAbandoned(run)) {
      logger.info({ connectorId, syncRunId: String(run._id), status: run.status }, 'sync message skipped: run already closed');
      return skipResult('run_closed', 'SYNC_RUN_CLOSED');
    }
    logger.info({ connectorId, abandonedRunId: String(run._id) }, 'webhook delivery replayed: its earlier run was abandoned');
    run = null;
  }
  if (!run) run = await createRun();
  let runId = String(run._id);

  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) {
    await syncRunRepository.finish(runId, {
      status: 'cancelled',
      error: { code: CONNECTOR_ERROR_CODES.NOT_FOUND, message: 'The connector no longer exists' },
      retentionDays,
    });
    await storedRows.settle();
    return skipResult('connector_not_found', CONNECTOR_ERROR_CODES.NOT_FOUND);
  }
  // Slot owner for conditional connector writes (null = untracked work).
  const owner = tracked ? runId : null;

  // Execution-time checks: work queued before a suspension or a pause must
  // not run. A failing tenant lookup throws here (the queue retries).
  let tenantActive;
  try {
    tenantActive = await isTenantActive(tenantId);
  } catch (error) {
    // On the last attempt nothing will retry: close the run, free the slot
    // and give the reservation back now, instead of leaving them `queued`
    // until the lease expires.
    if (attempt >= maxAttempts) {
      const message = 'The sync could not be started; please retry shortly';
      logger.warn(
        { err: sanitizeError(error, { fallbackCode: 'SYNC_FAILED' }), connectorId, syncRunId: runId, attempt, maxAttempts },
        'connector sync could not start',
      );
      await syncRunRepository.finish(runId, {
        status: 'failed',
        error: { code: CONNECTOR_ERROR_CODES.SYNC_FAILED, message },
        retentionDays,
      }).catch(() => {});
      await connectorRepository.releaseSyncSlot(connectorId, {
        owner,
        patch: { syncStatus: 'failed', lastError: message },
      }).catch(() => {});
      await storedRows.settle();
    }
    throw error;
  }
  let skip = null;
  if (!tenantActive) {
    skip = {
      reason: 'tenant_not_active',
      code: ERROR_CODES.TENANT_NOT_ACTIVE,
      runMessage: 'The workspace is not active',
      lastError: 'Skipped: the workspace is not active.',
    };
  } else if (connector.status === 'paused') {
    skip = {
      reason: 'connector_paused',
      code: CONNECTOR_ERROR_CODES.CONNECTOR_PAUSED,
      runMessage: 'The connector is paused',
      lastError: 'Skipped: the connector is paused.',
    };
  }
  if (skip) {
    await syncRunRepository.finish(runId, {
      status: 'cancelled',
      error: { code: skip.code, message: skip.runMessage },
      retentionDays,
    });
    await connectorRepository.releaseSyncSlot(connectorId, {
      owner,
      patch: { syncStatus: 'failed', lastError: skip.lastError },
    });
    await storedRows.settle();
    return skipResult(skip.reason, skip.code);
  }

  let started = await startRun(runId);
  if (!started && replayable && isAbandoned(await syncRunRepository.findById(runId, { tenantId }))) {
    // Abandoned between lookup and start (reaper / slot takeover): the
    // delivery still carries its records, so replay it under a fresh run.
    logger.info({ connectorId, abandonedRunId: runId }, 'webhook delivery replayed: its run was abandoned before it started');
    runId = String((await createRun())._id);
    started = await startRun(runId);
  }
  if (!started) return skipResult('run_closed', 'SYNC_RUN_CLOSED');
  await connectorRepository.markSyncRunning(connectorId, { owner, leaseUntil: new Date(now.getTime() + leaseMs) });

  // Renew both leases while the pipeline runs, so only a dead worker's sync
  // is ever treated as stale.
  const heartbeat = setInterval(() => {
    const at = new Date();
    const leaseUntil = new Date(at.getTime() + leaseMs);
    Promise.all([
      syncRunRepository.heartbeat(runId, { now: at, leaseUntil }),
      connectorRepository.renewSyncLease(connectorId, { owner, leaseUntil }),
    ]).catch((err) => logger.warn({ err: { message: err?.message }, connectorId }, 'sync heartbeat failed'));
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();

  // New rows actually written (reported on a permanent failure).
  let persistedNew = 0;
  try {
    const config = await decryptConfig(connector);
    const instance = createConnector(connector.type, { id: connectorId, config, tenantId });
    let records;
    if (payload.buffer) {
      records = instance.ingest({ buffer: Buffer.from(payload.buffer, 'base64'), maxRows: env.connectors.maxRowsPerSync });
    } else if (connector.type === 'mongodb') {
      records = instance.ingest();
    } else {
      records = payload.records ?? [];
    }

    // Bound the number of records processed per sync job to prevent
    // unbounded dataset loads from corrupting usage counters or OOM.
    if (Array.isArray(records) && records.length > env.connectors.maxRowsPerSync) {
      throw new RowLimitError(env.connectors.maxRowsPerSync);
    }

    const result = await ingestRecords({
      records: withDeadline(records, env.connectors.syncTimeoutMs),
      fieldMapping: connector.fieldMapping,
      // Persist through the stored-rows meter (idempotent upsert on sourceRowId).
      persist: async (batch) => {
        const written = await storedRows(batch);
        persistedNew += Number(written?.upserted) || 0;
        return written;
      },
    });
    const lastError = result.errors.length > 0 ? `ingested with ${result.errors.length} field errors` : null;
    await connectorRepository.update(connectorId, {
      lastSyncedAt: new Date(),
      lastError,
      errorCount: result.errors.length > 0 ? (connector.errorCount ?? 0) + 1 : 0,
    });
    await connectorRepository.releaseSyncSlot(connectorId, { owner, patch: { syncStatus: 'succeeded' } });
    await syncRunRepository.finish(runId, {
      status: 'succeeded',
      rows: {
        received: result.processed,
        upserted: result.upserted,
        matched: result.matched,
        skipped: result.skipped,
        failed: result.errors.length,
      },
      retentionDays,
    });
    // Give back the part of the reservation that did not become new rows.
    await storedRows.settle();
    // datasets: re-profile the typed schema (best effort; never fails the sync).
    await profileDatasetSchema({ tenantId, connectorId, dataVersion: (connector.dataVersion ?? 0) + 1 })
      .catch((err) => logger.warn({ err: { message: err?.message }, connectorId }, 'dataset schema profiling failed'));

    return result;
  } catch (error) {
    const permanent = isPermanentSyncError(error);
    const final = permanent || attempt >= maxAttempts;
    // Never persist driver / library messages: they can contain hosts,
    // ports, user names or connection strings. The connector's lastError
    // and the run's error (both tenant-visible) get the public message;
    // operators get the sanitised original in the log.
    const record = publicSyncError(error, connector.type);
    logger.warn(
      { err: sanitizeError(error, { fallbackCode: 'SYNC_FAILED' }), connectorId, syncRunId: runId, attempt, maxAttempts, final },
      'connector sync attempt failed',
    );
    await connectorRepository.bumpError(connectorId, record.message);
    if (final) {
      await connectorRepository.releaseSyncSlot(connectorId, { owner, patch: { syncStatus: 'failed' } });
      await syncRunRepository.finish(runId, { status: 'failed', error: record, retentionDays });
      // No further attempt will settle the reservation: give back what did
      // not become new rows.
      await storedRows.settle();
      // A permanent error would fail identically on every retry: report it
      // on the run and stop here instead of burning the queue's attempts.
      if (permanent && attempt < maxAttempts) {
        return { processed: 0, skipped: 0, upserted: persistedNew, matched: 0, errors: [], failed: record };
      }
    } else {
      // Waiting for the queue's backoff retry: keep the slot, extend the lease.
      const leaseUntil = new Date(Date.now() + leaseMs);
      await connectorRepository.renewSyncLease(connectorId, { owner, leaseUntil, status: 'queued' });
      await syncRunRepository.markRetrying(runId, { error: record, leaseUntil });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

// datasets: typed schema of a connector's dataset (profiled on demand when missing).
export async function getConnectorSchema({ tenantId, connectorId } = {}) {
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw notFound();
  return (await getDatasetSchema({ tenantId, connectorId }))
    ?? profileDatasetSchema({ tenantId, connectorId, dataVersion: connector.dataVersion ?? 0 });
}

export default {
  getConnectorSchema,
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
  previewFileUpload,
  syncFileUpload,
  syncMongoDB,
  handleWebhook,
  processSyncMessage,
  listSyncRuns,
  requeueRecoveredSync,
};
