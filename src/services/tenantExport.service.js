/**
 * Tenant Export Service (roadmap 2.9 - backups and recovery).
 *
 * PURPOSE
 *   Portable export of everything a workspace owns. A workspace Owner (or a
 *   platform admin, for support) requests an export; the export queue
 *   consumer builds a `.tar.gz` archive (JSON lines per collection, one CSV
 *   per dataset, a manifest with counts and checksums, see
 *   `tenantArchive.js`), stores it, and the requester downloads it through
 *   a short-lived signed URL until it expires.
 *
 * FLOW
 *   requestExport   -> TenantExport row (queued, one in flight per tenant)
 *                      + export queue job `{ kind: 'tenant-data' }`
 *   processExport   -> claim (lease) -> build archive -> storage -> completed
 *                      -> email the requester (no link in the email)
 *   issueDownloadUrl-> permission-checked; S3 presigned URL, or an app URL
 *                      carrying an HMAC token (local storage)
 *   openDownload    -> verifies that token and streams the archive
 *   revokeExport    -> deletes the archive before it expires
 *   sweep           -> deletes expired archives, fails abandoned exports
 *
 * SECURITY
 *   - Every read is scoped by tenant id; the worker re-reads the row and
 *     the tenant at execution time (a tenant-requested export of a workspace
 *     that is no longer active is not built).
 *   - Secrets never enter the archive (catalogue redactions/exclusions).
 *   - Download URLs live minutes, never outlive the archive, and are only
 *     minted for completed, unexpired exports. Workspace members cannot
 *     download exports a platform admin requested.
 *   - Requests, link issuance, downloads, completion, failure and expiry are
 *     all on the audit trail.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { once } from 'node:events';
import mongoose from 'mongoose';

import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import logger from '../utils/logger.js';
import clock from '../utils/clock.js';
import { ulid } from '../utils/id.js';
import { sanitizeError } from '../utils/sanitizeError.js';
import { writeTarGz } from '../utils/tarArchive.js';
import tenantExportRepository from '../repositories/tenantExport.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import { isTenantActive } from '../jobs/tenantGuard.js';
import * as storageService from './storage.service.js';
import * as queueService from './queue.service.js';
import { QUEUE_NAMES } from '../queues/constants.js';
import { emit as emitAudit } from './auditLog.service.js';
import { securityEvent } from './securityEvent.service.js';
import { enqueueEmail } from './outbox.service.js';
// backups: registered template for the export-ready email (config registry).
import { TENANT_EXPORT_READY_TEMPLATE } from '../templates/emails/tenantDataExport.js';
import {
  EXPORTED,
  EXCLUDED,
  collectionNameOf,
  collectionFileOf,
  selectionFilter,
  redactDocument,
} from './tenantDataCatalogue.js';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MANIFEST_FILE,
  README_FILE,
  PERMISSIONS_REFERENCE_FILE,
  CollectionDigest,
  serializeDocument,
  parseDocument,
  csvLine,
  readmeText,
} from './tenantArchive.js';

/** Queue job kind routed by `jobs/export.worker.js`. */
export const TENANT_EXPORT_JOB_KIND = 'tenant-data';
/** Audit module of every tenant export event. */
export const AUDIT_MODULE = 'data_exports';

/** Typed error codes returned by the tenant export surface. */
export const TENANT_EXPORT_ERRORS = Object.freeze({
  NOT_FOUND: 'EXPORT_NOT_FOUND',
  IN_PROGRESS: 'EXPORT_IN_PROGRESS',
  RATE_LIMITED: 'EXPORT_RATE_LIMITED',
  NOT_READY: 'EXPORT_NOT_READY',
  EXPIRED: 'EXPORT_EXPIRED',
  DOWNLOAD_FORBIDDEN: 'EXPORT_DOWNLOAD_FORBIDDEN',
  LINK_INVALID: 'DOWNLOAD_LINK_INVALID',
  LINK_EXPIRED: 'DOWNLOAD_LINK_EXPIRED',
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  TENANT_NOT_ACTIVE: 'TENANT_NOT_ACTIVE',
});

const E = TENANT_EXPORT_ERRORS;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TOKEN_VERSION = 'v1';
const TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{10,600}\.[A-Za-z0-9_-]{43}$/;
const PLATFORM_DISPLAY = 'Platform support';

function typed(statusCode, code, message) {
  return new ApiError(statusCode, message, { code });
}

function config() {
  return env.tenantExport;
}

/* ------------------------------ public views ----------------------------- */

/**
 * API shape of an export row. `audience` decides how much of the requester
 * a viewer sees: workspace members never see which platform admin asked.
 *
 * @param {Object} row
 * @param {{ audience: 'tenant'|'platform', now?: Date }} options
 * @returns {Object}
 */
export function toPublic(row, { audience, now = clock.now() }) {
  const hidden = audience === 'tenant' && row.origin === 'platform';
  const expired = row.status === 'expired' || (row.status === 'completed' && row.expiresAt && new Date(row.expiresAt) <= now);
  return {
    exportId: row.exportId,
    tenantId: row.tenantId,
    status: expired ? 'expired' : row.status,
    origin: row.origin,
    requestedBy: hidden
      ? { type: 'admin', id: null, email: null, display: PLATFORM_DISPLAY }
      : { type: row.requestedBy?.type ?? 'system', id: row.requestedBy?.id ?? null, email: row.requestedBy?.email ?? null, display: row.requestedBy?.email ?? null },
    reason: hidden ? null : row.reason ?? null,
    createdAt: row.createdAt ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    expiresAt: row.expiresAt ?? null,
    fileName: row.fileName ?? null,
    sizeBytes: row.sizeBytes ?? null,
    sha256: row.sha256 ?? null,
    summary: row.summary ?? null,
    collections: (row.collections ?? []).map(({ model, name, count }) => ({ model, collection: name, count })),
    error: row.error ?? null,
    downloadable: !expired && row.status === 'completed' && (audience === 'platform' || row.origin === 'tenant'),
  };
}

function actorFor(row) {
  return {
    type: row.requestedBy?.type === 'admin' ? 'admin' : row.requestedBy?.type === 'user' ? 'user' : 'system',
    id: row.requestedBy?.id ?? 'system',
    display: row.requestedBy?.email ?? undefined,
  };
}

/* --------------------------------- request ------------------------------- */

/**
 * Request a tenant export.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {'tenant'|'platform'} opts.origin - who is asking (workspace or platform admin).
 * @param {{ type: 'user'|'admin', id: string, email?: string|null }} opts.actor
 * @param {string|null} [opts.reason] - support reason (platform requests).
 * @param {string|null} [opts.requestId]
 * @returns {Promise<Object>} public view of the queued export.
 */
export async function requestExport({ tenantId, origin, actor, reason = null, requestId = null } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!['tenant', 'platform'].includes(origin)) throw ApiError.badRequest('origin must be "tenant" or "platform"');
  if (!actor?.id || !['user', 'admin'].includes(actor.type)) throw ApiError.forbidden('Authenticated identity is required');

  const tenant = await findTenant(tenantId);
  if (!tenant) throw typed(404, E.TENANT_NOT_FOUND, 'Tenant not found');
  if (origin === 'tenant' && tenant.status !== 'active') {
    throw typed(403, E.TENANT_NOT_ACTIVE, 'This workspace is not active');
  }

  const now = clock.now();
  const cfg = config();
  if (origin === 'tenant') {
    const recent = await tenantExportRepository.countRequestedSince(tenantId, { since: new Date(now.getTime() - DAY_MS) });
    if (recent >= cfg.dailyLimit) {
      throw typed(429, E.RATE_LIMITED, `A workspace can request ${cfg.dailyLimit} data exports per 24 hours. Try again later.`);
    }
  }

  const exportId = `tex_${ulid().toLowerCase()}`;
  let row;
  try {
    row = await tenantExportRepository.create({
      exportId,
      tenantId: String(tenantId),
      origin,
      requestedBy: { type: actor.type, id: String(actor.id), email: actor.email ?? null },
      reason: reason ? String(reason).slice(0, 500) : null,
      leaseUntil: new Date(now.getTime() + cfg.queuedTimeoutMs),
    });
  } catch (err) {
    if (err?.code === 11000 && (err?.keyPattern?.tenantId || /inFlight/.test(String(err?.message)))) {
      const current = await tenantExportRepository.findInFlight(tenantId).catch(() => null);
      throw new ApiError(409, 'An export of this workspace is already being prepared. Wait for it to finish.', {
        code: E.IN_PROGRESS,
        errors: current ? [{ field: 'exportId', message: current.exportId }] : undefined,
      });
    }
    throw err;
  }

  try {
    await queueService.enqueue(
      QUEUE_NAMES.EXPORT_JOBS,
      { exportId, tenantId: String(tenantId), kind: TENANT_EXPORT_JOB_KIND },
      { jobId: exportId, name: 'tenant-data-export' },
    );
  } catch (err) {
    // The job never reached the queue: release the in-flight slot.
    await tenantExportRepository.markFailed({ exportId, error: sanitizeError(err, { fallbackCode: 'QUEUE_UNAVAILABLE' }) }).catch(() => null);
    throw err;
  }

  await emitAudit({
    actor: { type: actor.type, id: String(actor.id), display: actor.email ?? undefined },
    action: 'tenant_export.requested',
    module: AUDIT_MODULE,
    resource: { type: 'tenantExport', id: exportId },
    tenantId: String(tenantId),
    after: { exportId, origin },
    reason: reason ?? (origin === 'tenant' ? 'Workspace data export requested' : 'Platform data export requested'),
    requestId,
  });
  await securityEvent('TENANT_EXPORT_REQUESTED', {
    actor: { type: actor.type, id: String(actor.id) },
    tenantId: String(tenantId),
    reason,
    metadata: { exportId, origin },
  });

  return toPublic(row, { audience: origin, now });
}

/* ---------------------------------- reads -------------------------------- */

/**
 * List a tenant's exports (newest first).
 * @returns {Promise<{ items: Object[], meta: Object }>}
 */
export async function listExports({ tenantId, audience, page = 1, limit = 20 } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const result = await tenantExportRepository.listForTenant(tenantId, { page, limit: Math.min(Math.max(1, limit), 100) });
  const now = clock.now();
  return {
    items: result.docs.map((row) => toPublic(row, { audience, now })),
    meta: { page: result.page, limit: result.limit, total: result.total, pages: result.pages },
  };
}

/** One export of a tenant (404 when it belongs to another tenant). */
export async function getExport({ tenantId, exportId, audience } = {}) {
  const row = await requireRow(tenantId, exportId);
  return toPublic(row, { audience });
}

async function requireRow(tenantId, exportId) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (typeof exportId !== 'string' || !/^tex_[0-9a-z]{26}$/.test(exportId)) throw typed(404, E.NOT_FOUND, 'Export not found');
  const row = await tenantExportRepository.findForTenant(tenantId, exportId);
  if (!row) throw typed(404, E.NOT_FOUND, 'Export not found');
  return row;
}

/* -------------------------------- downloads ------------------------------ */

function tokenKey() {
  return crypto.createHmac('sha256', env.security.jwtSecret).update('analivo:tenant-export-download:v1').digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', tokenKey()).update(payload).digest('base64url');
}

/**
 * Mint a download token (local storage driver).
 * @returns {string}
 */
export function signDownloadToken({ exportId, tenantId, expiresAt, actor }) {
  const payload = Buffer.from(JSON.stringify({
    e: exportId,
    t: String(tenantId),
    x: Math.floor(expiresAt.getTime() / 1000),
    a: actor?.type ?? 'system',
    i: actor?.id ? String(actor.id) : null,
  })).toString('base64url');
  return `${TOKEN_VERSION}.${payload}.${sign(`${TOKEN_VERSION}.${payload}`)}`;
}

/**
 * Verify a download token. Throws 401 DOWNLOAD_LINK_INVALID or 410
 * DOWNLOAD_LINK_EXPIRED.
 * @returns {{ exportId: string, tenantId: string, expiresAt: Date, actor: Object }}
 */
export function verifyDownloadToken(token, { now = clock.now() } = {}) {
  const invalid = () => typed(401, E.LINK_INVALID, 'This download link is not valid');
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalid();
  const [version, payload, signature] = token.split('.');
  const expected = sign(`${version}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw invalid();
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof claims?.e !== 'string' || typeof claims?.t !== 'string' || !Number.isInteger(claims?.x)) throw invalid();
  if (claims.x * 1000 <= now.getTime()) throw typed(410, E.LINK_EXPIRED, 'This download link has expired. Request a new one.');
  return {
    exportId: claims.e,
    tenantId: claims.t,
    expiresAt: new Date(claims.x * 1000),
    actor: { type: ['user', 'admin'].includes(claims.a) ? claims.a : 'system', id: claims.i ?? 'system' },
  };
}

function assertDownloadable(row, { audience, now }) {
  if (audience === 'tenant' && row.origin === 'platform') {
    throw typed(403, E.DOWNLOAD_FORBIDDEN, 'This export was prepared by platform support and can only be downloaded by them');
  }
  if (row.status === 'expired' || (row.status === 'completed' && (!row.expiresAt || new Date(row.expiresAt) <= now))) {
    throw typed(410, E.EXPIRED, 'This export has expired. Request a new one.');
  }
  if (row.status !== 'completed' || !row.storageKey) {
    throw typed(409, E.NOT_READY, 'This export is not ready to download');
  }
}

/**
 * Mint a short-lived download URL for a completed export.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.exportId
 * @param {'tenant'|'platform'} opts.audience
 * @param {{ type: string, id: string, email?: string }} opts.actor
 * @param {string} opts.baseUrl - public origin of this API (for local storage URLs).
 * @param {string|null} [opts.requestId]
 * @returns {Promise<{ url: string, expiresAt: Date, fileName: string, sizeBytes: number, sha256: string }>}
 */
export async function issueDownloadUrl({ tenantId, exportId, audience, actor, baseUrl, requestId = null } = {}) {
  const row = await requireRow(tenantId, exportId);
  const now = clock.now();
  assertDownloadable(row, { audience, now });

  const remainingSec = Math.floor((new Date(row.expiresAt).getTime() - now.getTime()) / 1000);
  const ttlSec = Math.min(config().downloadUrlTtlSeconds, remainingSec);
  if (ttlSec < 1) throw typed(410, E.EXPIRED, 'This export has expired. Request a new one.');
  const expiresAt = new Date(now.getTime() + ttlSec * 1000);

  let url;
  if (storageService.getDriver().provider === 's3') {
    url = await storageService.presignedUrl(row.storageKey, {
      ttlSec,
      contentType: 'application/gzip',
      contentDisposition: `attachment; filename="${row.fileName}"`,
    });
  } else {
    const token = signDownloadToken({ exportId: row.exportId, tenantId: row.tenantId, expiresAt, actor });
    url = `${String(baseUrl ?? '').replace(/\/+$/, '')}${env.app.apiPrefix}/data-exports/download/${token}`;
  }

  await emitAudit({
    actor: { type: actor.type, id: String(actor.id), display: actor.email ?? undefined },
    action: 'tenant_export.download_issued',
    module: AUDIT_MODULE,
    resource: { type: 'tenantExport', id: row.exportId },
    tenantId: row.tenantId,
    after: { exportId: row.exportId, linkExpiresAt: expiresAt.toISOString(), audience },
    reason: 'Download link issued',
    requestId,
  });
  await securityEvent('TENANT_EXPORT_DOWNLOAD_ISSUED', {
    actor: { type: actor.type, id: String(actor.id) },
    tenantId: row.tenantId,
    metadata: { exportId: row.exportId, audience },
  });

  return { url, expiresAt, fileName: row.fileName, sizeBytes: row.sizeBytes, sha256: row.sha256 };
}

/**
 * Resolve a signed download link (local storage) into a stream.
 *
 * @param {Object} opts
 * @param {string} opts.token
 * @param {string|null} [opts.ip]
 * @param {string|null} [opts.requestId]
 * @returns {Promise<{ stream: import('node:stream').Readable, fileName: string, sizeBytes: number|null, sha256: string|null }>}
 */
export async function openDownload({ token, ip = null, requestId = null } = {}) {
  const now = clock.now();
  const claims = verifyDownloadToken(token, { now });
  const row = await tenantExportRepository.findForTenant(claims.tenantId, claims.exportId);
  if (!row) throw typed(404, E.NOT_FOUND, 'Export not found');
  // The issuer already passed the audience check; only state and expiry
  // can have changed since.
  assertDownloadable(row, { audience: 'platform', now });

  let stream;
  try {
    stream = await storageService.createReadStream(row.storageKey);
  } catch (err) {
    logger.warn({ err: { message: err?.message }, exportId: row.exportId }, 'tenant export artefact missing');
    throw typed(410, E.EXPIRED, 'This export is no longer available. Request a new one.');
  }

  await emitAudit({
    actor: claims.actor,
    action: 'tenant_export.downloaded',
    module: AUDIT_MODULE,
    resource: { type: 'tenantExport', id: row.exportId },
    tenantId: row.tenantId,
    after: { exportId: row.exportId },
    reason: 'Export archive downloaded',
    ip,
    requestId,
  }).catch((err) => logger.warn({ err: { message: err?.message } }, 'could not audit tenant export download'));
  await securityEvent('TENANT_EXPORT_DOWNLOADED', { actor: claims.actor, tenantId: row.tenantId, metadata: { exportId: row.exportId } });

  return { stream, fileName: row.fileName, sizeBytes: row.sizeBytes ?? null, sha256: row.sha256 ?? null };
}

/**
 * Delete a completed export's archive now (before it expires), for example
 * once it was downloaded or when a link may have leaked. Idempotent for an
 * already expired export.
 *
 * @returns {Promise<Object>} public view (status `expired`).
 */
export async function revokeExport({ tenantId, exportId, audience, actor, requestId = null } = {}) {
  const row = await requireRow(tenantId, exportId);
  if (audience === 'tenant' && row.origin === 'platform') {
    throw typed(403, E.DOWNLOAD_FORBIDDEN, 'This export was prepared by platform support and can only be managed by them');
  }
  if (row.status === 'expired') return toPublic(row, { audience });
  if (row.status !== 'completed') throw typed(409, E.NOT_READY, 'Only a finished export can be deleted');

  if (row.storageKey) await storageService.del(row.storageKey);
  const now = clock.now();
  const updated = (await tenantExportRepository.markExpired({ exportId: row.exportId, now }))
    ?? (await tenantExportRepository.findForTenant(tenantId, exportId));
  await emitAudit({
    actor: { type: actor.type, id: String(actor.id), display: actor.email ?? undefined },
    action: 'tenant_export.deleted',
    module: AUDIT_MODULE,
    resource: { type: 'tenantExport', id: row.exportId },
    tenantId: row.tenantId,
    after: { exportId: row.exportId },
    reason: 'Export archive deleted before expiry',
    requestId,
  });
  return toPublic(updated, { audience, now });
}

/* ------------------------------- processing ------------------------------ */

async function findTenant(tenantId) {
  try {
    return await tenantRepository.findById(String(tenantId));
  } catch (err) {
    if (err?.name === 'CastError') return null;
    throw err;
  }
}

/** Streaming file writer that hashes and counts what it writes. */
class HashingWriter {
  constructor(filePath) {
    this.stream = fs.createWriteStream(filePath);
    this.hash = crypto.createHash('sha256');
    this.bytes = 0;
    this.error = null;
    this.stream.on('error', (err) => { this.error = err; });
  }

  async write(text) {
    if (this.error) throw this.error;
    const chunk = Buffer.from(text, 'utf8');
    this.hash.update(chunk);
    this.bytes += chunk.length;
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
  }

  async close() {
    if (this.error) throw this.error;
    await new Promise((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(resolve);
    });
    return { bytes: this.bytes, sha256: this.hash.digest('hex') };
  }

  destroy() {
    this.stream.destroy();
  }
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}

function rowDataObject(raw) {
  const data = raw?.data;
  if (data && typeof data === 'object' && !Array.isArray(data) && !(data instanceof Date)) return data;
  return { value: data ?? null };
}

/**
 * Write the archive content of one tenant into `stageDir`.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId
 * @param {Object} opts.row - export row (manifest metadata).
 * @param {string} opts.stageDir
 * @param {() => Promise<void>} [opts.tick] - called per document (lease renewal).
 * @returns {Promise<{ manifest: Object, members: Array<{ name: string, path: string }> }>}
 */
export async function buildArchiveContent({ tenantId, row, stageDir, tick = async () => {} }) {
  const cfg = config();
  for (const dir of ['collections', 'datasets', 'reference', '.tmp']) {
    await fsp.mkdir(path.join(stageDir, dir), { recursive: true });
  }
  const ctx = { tenantId: String(tenantId), roleIds: [], permissionIds: new Set(), connectors: [], tenant: null };
  const collections = [];
  let datasets = [];
  let orphanRows = 0;

  for (const entry of EXPORTED) {
    const collection = mongoose.model(entry.model).collection;
    const file = collectionFileOf(entry.model);
    const writer = new HashingWriter(path.join(stageDir, file));
    const digest = new CollectionDigest({ includeId: entry.idReferenced });
    let count = 0;

    const emitDoc = async (raw) => {
      const doc = redactDocument(entry, raw);
      await writer.write(`${serializeDocument(doc)}\n`);
      digest.add(doc);
      count += 1;
      if (entry.model === 'Tenant') ctx.tenant = doc;
      else if (entry.model === 'Role') ctx.roleIds.push(String(doc._id));
      else if (entry.model === 'RolePermission' && doc.permissionId) ctx.permissionIds.add(String(doc.permissionId));
      else if (entry.model === 'Connector') ctx.connectors.push({ _id: doc._id, name: doc.name ?? '', type: doc.type ?? null });
      await tick();
    };

    try {
      if (entry.datasetRows) {
        ({ datasets, orphanRows } = await exportDatasetRows({ collection, ctx, stageDir, emitDoc, maxColumns: cfg.maxCsvColumns }));
      } else {
        const cursor = collection.find(selectionFilter(entry, ctx), { batchSize: 500 });
        for await (const raw of cursor) await emitDoc(raw);
      }
    } catch (err) {
      // Release the file handle before the work directory is removed.
      writer.destroy();
      throw err;
    }
    const info = await writer.close();
    collections.push({
      model: entry.model,
      collection: collectionNameOf(entry.model),
      file,
      count,
      bytes: info.bytes,
      sha256: info.sha256,
      contentSha256: digest.digest(),
      idReferenced: entry.idReferenced,
      redactions: entry.redactions ?? [],
    });
    if (entry.model === 'Tenant' && count !== 1) {
      const err = new Error('The workspace record could not be read');
      err.code = E.TENANT_NOT_FOUND;
      throw err;
    }
  }

  const references = [await writePermissionReference({ stageDir, permissionIds: ctx.permissionIds })];
  await fsp.rm(path.join(stageDir, '.tmp'), { recursive: true, force: true });

  const createdAt = clock.now().toISOString();
  const registered = new Set(mongoose.modelNames());
  const manifest = {
    format: ARCHIVE_FORMAT,
    formatVersion: ARCHIVE_FORMAT_VERSION,
    exportId: row.exportId,
    createdAt,
    origin: row.origin,
    requestedBy: { type: row.requestedBy?.type ?? 'system', id: row.requestedBy?.id ?? null },
    tenant: { id: String(tenantId), name: ctx.tenant?.name ?? null, slug: ctx.tenant?.slug ?? null },
    source: { app: env.app.name, version: env.app.version },
    consistency: 'Each collection is read once while the export runs; the archive is not a point-in-time snapshot. Counts and checksums describe exactly what the archive contains.',
    digest: {
      algorithm: 'sha256',
      document: 'canonical relaxed MongoDB Extended JSON (object keys sorted recursively); _id omitted when idReferenced is false',
      collection: 'sha256("<count>:" + 64-hex-digit (sum of document digests mod 2^256))',
    },
    csv: { delimiter: ',', lineEnding: 'CRLF', header: true, encoding: 'utf-8', formulaEscaping: "cells starting with = + - @ tab or CR are prefixed with '" },
    collections,
    datasets,
    orphanDatasetRows: orphanRows,
    references,
    excluded: EXCLUDED.map(({ model, reason }) => ({
      model,
      collection: registered.has(model) ? collectionNameOf(model) : null,
      reason,
    })),
  };

  await fsp.writeFile(path.join(stageDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.writeFile(
    path.join(stageDir, README_FILE),
    readmeText({ exportId: row.exportId, tenantName: ctx.tenant?.name ?? String(tenantId), createdAt }),
  );

  const members = [
    { name: MANIFEST_FILE, path: path.join(stageDir, MANIFEST_FILE) },
    { name: README_FILE, path: path.join(stageDir, README_FILE) },
    ...collections.map((c) => ({ name: c.file, path: path.join(stageDir, c.file) })),
    ...datasets.map((d) => ({ name: d.file, path: path.join(stageDir, d.file) })),
    ...references.map((r) => ({ name: r.file, path: path.join(stageDir, r.file) })),
  ];
  return { manifest, members };
}

/**
 * Export dataset rows: every row goes to the JSONL copy, and each connector
 * also gets a CSV of its row data. Rows whose connector no longer exists are
 * exported to the JSONL copy only (`orphanDatasetRows`).
 */
async function exportDatasetRows({ collection, ctx, stageDir, emitDoc, maxColumns }) {
  const datasets = [];
  for (const connector of ctx.connectors) {
    const hex = connector._id.toHexString?.() ?? String(connector._id);
    const tmpPath = path.join(stageDir, '.tmp', `${hex}.ndjson`);
    const tmp = new HashingWriter(tmpPath);
    const columns = [];
    const seen = new Set();
    let truncatedColumns = false;
    let rows = 0;
    const cursor = collection.find({ tenantId: ctx.tenantId, connectorId: connector._id }, { batchSize: 500 });
    for await (const raw of cursor) {
      await emitDoc(raw);
      const data = rowDataObject(raw);
      for (const key of Object.keys(data)) {
        if (seen.has(key)) continue;
        if (columns.length < maxColumns) {
          seen.add(key);
          columns.push(key);
        } else {
          truncatedColumns = true;
        }
      }
      await tmp.write(`${serializeDocument({ d: data })}\n`);
      rows += 1;
    }
    await tmp.close();

    const file = `datasets/${hex}.csv`;
    const csv = new HashingWriter(path.join(stageDir, file));
    await csv.write(`${csvLine(columns)}\r\n`);
    const lines = readline.createInterface({ input: fs.createReadStream(tmpPath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      const { d } = parseDocument(line);
      await csv.write(`${csvLine(columns.map((key) => d[key]))}\r\n`);
    }
    const info = await csv.close();
    await fsp.rm(tmpPath, { force: true });
    datasets.push({
      connectorId: hex,
      name: connector.name,
      type: connector.type,
      file,
      rows,
      columns: columns.length,
      truncatedColumns,
      bytes: info.bytes,
      sha256: info.sha256,
    });
  }

  let orphanRows = 0;
  const known = ctx.connectors.map((c) => c._id);
  const orphans = collection.find({ tenantId: ctx.tenantId, connectorId: { $nin: known } }, { batchSize: 500 });
  for await (const raw of orphans) {
    await emitDoc(raw);
    orphanRows += 1;
  }
  return { datasets, orphanRows };
}

/** Platform permission keys referenced by the tenant's role grants. */
async function writePermissionReference({ stageDir, permissionIds }) {
  const writer = new HashingWriter(path.join(stageDir, PERMISSIONS_REFERENCE_FILE));
  const ids = [...permissionIds].filter((id) => /^[0-9a-f]{24}$/i.test(id)).map((id) => new mongoose.Types.ObjectId(id));
  let count = 0;
  if (ids.length > 0) {
    const cursor = mongoose.model('Permission').collection.find(
      { _id: { $in: ids } },
      { projection: { _id: 1, key: 1, module: 1, action: 1 } },
    );
    for await (const permission of cursor) {
      await writer.write(`${serializeDocument({ _id: permission._id, key: permission.key, module: permission.module, action: permission.action })}\n`);
      count += 1;
    }
  }
  const info = await writer.close();
  return { kind: 'permissions', file: PERMISSIONS_REFERENCE_FILE, count, bytes: info.bytes, sha256: info.sha256 };
}

function archiveFileName(row, slug, now) {
  const safeSlug = String(slug ?? 'workspace').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40) || 'workspace';
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `analivo-export-${safeSlug}-${stamp}-${row.exportId}.tar.gz`;
}

/**
 * Build and store one export (queue consumer entry point). Never throws for
 * export failures: the row is marked failed and the result says so.
 *
 * @param {Object} opts
 * @param {string} opts.exportId
 * @returns {Promise<{ exportId: string, status: string, error?: Object }>}
 */
export async function processExport({ exportId } = {}) {
  if (!exportId) throw ApiError.badRequest('exportId is required');
  const cfg = config();
  const claimed = await tenantExportRepository.claim({
    exportId,
    now: clock.now(),
    leaseMs: cfg.leaseMs,
    maxAttempts: cfg.maxAttempts,
  });
  if (!claimed) {
    // Already finished, being processed elsewhere, or out of attempts (the
    // expiry sweep fails it): a replayed job must not run twice.
    const current = await tenantExportRepository.findByExportId(exportId);
    return { exportId, status: current?.status ?? 'missing', skipped: true };
  }

  const tenantId = claimed.tenantId;
  const fail = async (err) => {
    const error = sanitizeError(err, { fallbackCode: 'EXPORT_FAILED' });
    await tenantExportRepository.markFailed({ exportId, error }).catch(() => null);
    await emitAudit({
      actor: { type: 'service', id: 'tenant-export', display: 'tenant-export' },
      action: 'tenant_export.failed',
      module: AUDIT_MODULE,
      resource: { type: 'tenantExport', id: exportId },
      tenantId,
      after: { exportId, error },
      result: 'failure',
      errorCode: error.code,
      reason: 'Tenant data export failed',
    }).catch(() => null);
    return { exportId, status: 'failed', error };
  };

  if (claimed.origin === 'tenant' && !(await isTenantActive(tenantId))) {
    const err = new Error('The workspace is no longer active');
    err.code = E.TENANT_NOT_ACTIVE;
    return fail(err);
  }
  if (!(await findTenant(tenantId))) {
    const err = new Error('The workspace no longer exists');
    err.code = E.TENANT_NOT_FOUND;
    return fail(err);
  }

  let workDir = null;
  let storageKey = null;
  let lastRenewal = Date.now();
  const tick = async () => {
    if (Date.now() - lastRenewal < cfg.leaseMs / 3) return;
    lastRenewal = Date.now();
    await tenantExportRepository.renewLease({ exportId, leaseUntil: new Date(clock.now().getTime() + cfg.leaseMs) });
  };

  try {
    const base = cfg.workDir || os.tmpdir();
    await fsp.mkdir(base, { recursive: true });
    workDir = await fsp.mkdtemp(path.join(base, `analivo-${exportId}-`));
    const stageDir = path.join(workDir, 'stage');
    await fsp.mkdir(stageDir);

    const { manifest, members } = await buildArchiveContent({ tenantId, row: claimed, stageDir, tick });
    const now = clock.now();
    const fileName = archiveFileName(claimed, manifest.tenant.slug, now);
    const archivePath = path.join(workDir, fileName);
    await writeTarGz({ entries: members, outFile: archivePath });
    const { sha256, size } = await hashFile(archivePath);
    const manifestSha256 = (await hashFile(path.join(stageDir, MANIFEST_FILE))).sha256;

    storageKey = `tenant-exports/${tenantId}/${exportId}.tar.gz`;
    await storageService.putFile(storageKey, archivePath, { contentType: 'application/gzip' });

    const summary = {
      collections: manifest.collections.length,
      records: manifest.collections.reduce((sum, c) => sum + c.count, 0),
      datasets: manifest.datasets.length,
      datasetRows: manifest.datasets.reduce((sum, d) => sum + d.rows, 0),
    };
    const completedAt = clock.now();
    const completed = await tenantExportRepository.markCompleted({
      exportId,
      now: completedAt,
      fields: {
        storageKey,
        fileName,
        sizeBytes: size,
        sha256,
        manifestSha256,
        summary,
        collections: manifest.collections.map((c) => ({ model: c.model, name: c.collection, count: c.count })),
        expiresAt: new Date(completedAt.getTime() + cfg.ttlHours * HOUR_MS),
      },
    });
    if (!completed) {
      // The row stopped being ours (failed by the sweep after a lost lease):
      // do not leave an artefact nobody can download.
      await storageService.del(storageKey).catch(() => null);
      return { exportId, status: 'discarded' };
    }

    await emitAudit({
      actor: { type: 'service', id: 'tenant-export', display: 'tenant-export' },
      action: 'tenant_export.completed',
      module: AUDIT_MODULE,
      resource: { type: 'tenantExport', id: exportId },
      tenantId,
      after: { exportId, sizeBytes: size, sha256, summary },
      reason: 'Tenant data export completed',
    }).catch((err) => logger.warn({ err: { message: err?.message }, exportId }, 'could not audit tenant export completion'));
    await notifyRequester(completed);

    return { exportId, status: 'completed', sizeBytes: size, sha256, summary };
  } catch (err) {
    if (storageKey) await storageService.del(storageKey).catch(() => null);
    logger.error({ err: { message: err?.message }, exportId }, 'tenant export failed');
    return fail(err);
  } finally {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => null);
  }
}

/** Tell the requester the archive is ready (no link: downloads need sign-in). */
async function notifyRequester(row) {
  const to = row.requestedBy?.email;
  if (!to) return;
  const where = row.origin === 'platform'
    ? `${env.cors.clientUrl}/admin/tenants/${row.tenantId}`
    : `${env.cors.clientUrl}/settings`;
  const expires = new Date(row.expiresAt).toISOString();
  try {
    await enqueueEmail({
      tenantId: row.tenantId,
      to,
      template: TENANT_EXPORT_READY_TEMPLATE,
      idempotencyKey: `tenant-export-ready:${row.exportId}`,
      // Flat scalar variables; the text lives in templates/emails/tenantDataExport.js.
      variables: { exportId: row.exportId, expiresAt: expires, location: where },
    });
  } catch (err) {
    logger.warn({ err: { message: err?.message }, exportId: row.exportId }, 'could not send tenant export notification');
  }
}

/* --------------------------------- sweeps -------------------------------- */

/**
 * Delete expired archives and fail abandoned exports (expiry job).
 *
 * @param {Object} [opts]
 * @param {number} [opts.limit=100] - rows per category per run.
 * @returns {Promise<{ expired: number, abandoned: number, errors: number }>}
 */
export async function sweep({ limit = 100 } = {}) {
  const now = clock.now();
  let expired = 0;
  let abandoned = 0;
  let errors = 0;

  for (const row of await tenantExportRepository.findExpired({ now, limit })) {
    try {
      if (row.storageKey) await storageService.del(row.storageKey);
      const marked = await tenantExportRepository.markExpired({ exportId: row.exportId, now });
      if (!marked) continue;
      expired += 1;
      await emitAudit({
        actor: { type: 'service', id: 'tenant-export', display: 'tenant-export' },
        action: 'tenant_export.expired',
        module: AUDIT_MODULE,
        resource: { type: 'tenantExport', id: row.exportId },
        tenantId: row.tenantId,
        after: { exportId: row.exportId },
        reason: 'Export archive expired and was deleted',
      }).catch(() => null);
    } catch (err) {
      errors += 1;
      logger.warn({ err: { message: err?.message }, exportId: row.exportId }, 'could not expire tenant export');
    }
  }

  for (const row of await tenantExportRepository.findAbandoned({ now, limit })) {
    const error = row.status === 'queued'
      ? { code: 'EXPORT_NOT_STARTED', message: 'The export was not picked up in time. Request a new one.' }
      : { code: 'EXPORT_ABANDONED', message: 'The export stopped before it finished. Request a new one.' };
    const failed = await tenantExportRepository.markFailed({ exportId: row.exportId, now, error }).catch(() => null);
    if (!failed) continue;
    abandoned += 1;
    await emitAudit({
      actor: { type: 'service', id: 'tenant-export', display: 'tenant-export' },
      action: 'tenant_export.failed',
      module: AUDIT_MODULE,
      resource: { type: 'tenantExport', id: row.exportId },
      tenantId: row.tenantId,
      after: { exportId: row.exportId, error },
      result: 'failure',
      errorCode: error.code,
      reason: 'Tenant data export abandoned',
    }).catch(() => null);
  }

  return { expired, abandoned, errors };
}

export default {
  TENANT_EXPORT_JOB_KIND,
  TENANT_EXPORT_ERRORS,
  requestExport,
  listExports,
  getExport,
  issueDownloadUrl,
  openDownload,
  revokeExport,
  signDownloadToken,
  verifyDownloadToken,
  processExport,
  buildArchiveContent,
  sweep,
  toPublic,
};
