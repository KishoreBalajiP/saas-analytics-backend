/**
 * Tenant Import Service (roadmap 2.9 - backups and recovery).
 *
 * PURPOSE
 *   Restores a tenant export archive into a database, for restore drills and
 *   for re-creating a workspace from its export:
 *
 *     openArchive    extract a `.tar.gz` (or use a directory) and read the
 *                    manifest
 *     verifyArchive  every listed file exists with the listed size and
 *                    SHA-256, and nothing unlisted is present
 *     importTenant   insert the documents into a target connection
 *                      - mode 'clone' (default): a NEW tenant; every
 *                        document id is remapped (old -> new) consistently,
 *                        globally unique keys are rewritten and the tenant is
 *                        created `disabled` so nothing runs for it
 *                      - mode 'preserve': ids kept as they are (an empty
 *                        scratch database only; refused when the tenant
 *                        already exists in the target)
 *     verifyImport   read the restored tenant back, undo the remapping and
 *                    the rewrites, and recompute counts and content
 *                    checksums: a round trip must reproduce the manifest
 *     rollbackImport remove everything an import wrote
 *
 * SECURITY (an archive is untrusted input)
 *   - The manifest is validated structurally; only catalogue collections can
 *     be written, at their catalogue collection names.
 *   - Every document must belong to the archive's tenant (`tenantId`, the
 *     tenant's own `_id`, or a role of that tenant), so a crafted archive
 *     cannot write into another workspace.
 *   - Writes use the raw driver (exact documents, no model side effects)
 *     against the connection the caller passes; nothing here connects to a
 *     database by itself.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

import { extractTarGz } from '../utils/tarArchive.js';
import catalogue, {
  EXPORTED,
  exportedEntry,
  collectionNameOf,
} from './tenantDataCatalogue.js';
import {
  MANIFEST_FILE,
  README_FILE,
  ArchiveError,
  CollectionDigest,
  parseDocument,
  remapDocument,
  invertIdMap,
  validateManifest,
  listedFiles,
} from './tenantArchive.js';

const BATCH_SIZE = 500;
/** Longest accepted JSONL line (the BSON document limit plus EJSON overhead). */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export { ArchiveError };

/* --------------------------------- archive ------------------------------- */

/**
 * Open an archive: a `.tar.gz` file is extracted into a fresh temporary
 * directory; a directory is used as it is.
 *
 * @param {Object} opts
 * @param {string} opts.source - archive file or extracted directory.
 * @param {string} [opts.workDir] - parent of the extraction directory.
 * @returns {Promise<{ dir: string, manifest: Object, archive: { file: string|null, bytes: number|null, sha256: string|null }, cleanup: () => Promise<void> }>}
 */
export async function openArchive({ source, workDir = os.tmpdir() } = {}) {
  if (typeof source !== 'string' || source.length === 0) throw new ArchiveError('ARCHIVE_SOURCE_MISSING', 'An archive file or directory is required');
  let stat;
  try {
    stat = await fsp.stat(source);
  } catch {
    throw new ArchiveError('ARCHIVE_SOURCE_MISSING', `Archive source "${source}" does not exist`);
  }

  let dir = source;
  let cleanup = async () => {};
  const archive = { file: null, bytes: null, sha256: null };
  if (stat.isFile()) {
    archive.file = path.resolve(source);
    archive.bytes = stat.size;
    archive.sha256 = await hashFile(source);
    await fsp.mkdir(workDir, { recursive: true });
    dir = await fsp.mkdtemp(path.join(workDir, 'analivo-restore-'));
    cleanup = () => fsp.rm(dir, { recursive: true, force: true });
    try {
      await extractTarGz({ file: source, destDir: dir });
    } catch (err) {
      await cleanup();
      if (err?.name === 'TarError') throw new ArchiveError(err.code, err.message);
      throw new ArchiveError('ARCHIVE_UNREADABLE', 'The archive could not be read as a .tar.gz file');
    }
  } else if (!stat.isDirectory()) {
    throw new ArchiveError('ARCHIVE_SOURCE_MISSING', `Archive source "${source}" is not a file or directory`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    await cleanup();
    throw new ArchiveError('ARCHIVE_MANIFEST_INVALID', 'manifest.json is missing or is not valid JSON');
  }
  try {
    validateManifest(manifest, catalogue);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { dir, manifest, archive, cleanup };
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function walkFiles(root, rel = '') {
  const out = [];
  for (const entry of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walkFiles(root, child)));
    else out.push(child);
  }
  return out;
}

/**
 * Check every file the manifest lists (size + SHA-256) and that the archive
 * holds nothing else.
 *
 * @returns {Promise<{ ok: boolean, files: Array<Object>, unexpected: string[] }>}
 */
export async function verifyArchive({ dir, manifest }) {
  const files = [];
  const expected = new Set([MANIFEST_FILE, README_FILE]);
  for (const record of listedFiles(manifest)) {
    expected.add(record.file);
    const full = path.join(dir, record.file);
    let actual = null;
    try {
      const stat = await fsp.stat(full);
      actual = { bytes: stat.size, sha256: await hashFile(full) };
    } catch {
      actual = null;
    }
    files.push({
      file: record.file,
      expected: { bytes: record.bytes, sha256: record.sha256 },
      actual,
      ok: Boolean(actual) && actual.bytes === record.bytes && actual.sha256 === record.sha256,
    });
  }
  const unexpected = (await walkFiles(dir)).filter((file) => !expected.has(file));
  return { ok: files.every((f) => f.ok) && unexpected.length === 0, files, unexpected };
}

/** Async iterator over the documents of one collection file. */
async function* readDocuments(dir, file) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(dir, file), { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length === 0) continue;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new ArchiveError('ARCHIVE_DOCUMENT_TOO_LARGE', `${file} contains a record larger than allowed`);
    yield parseDocument(line);
  }
}

function isObjectId(value) {
  return Boolean(value) && typeof value === 'object' && value._bsontype === 'ObjectId';
}

/* --------------------------------- import -------------------------------- */

function ownershipError(file, message) {
  return new ArchiveError('ARCHIVE_FOREIGN_RECORD', `${file}: ${message}`);
}

/**
 * Check that a document belongs to the archive's tenant.
 */
function assertOwned(entry, doc, { sourceTenantId, sourceRoleIds, file }) {
  if (!isObjectId(doc._id) && typeof doc._id !== 'string') throw ownershipError(file, 'a record has no usable _id');
  if (entry.scope === 'self') {
    if (!isObjectId(doc._id) || doc._id.toHexString() !== sourceTenantId) throw ownershipError(file, 'the workspace record does not match the manifest');
  } else if (entry.scope === 'tenant') {
    if (String(doc.tenantId ?? '') !== sourceTenantId) throw ownershipError(file, 'a record belongs to a different workspace');
  } else if (entry.scope === 'roles') {
    if (!sourceRoleIds.has(String(doc.roleId ?? ''))) throw ownershipError(file, 'a role grant references a role outside the workspace');
  }
}

async function collectionHasTenantData(connection, entry, { tenantId, tenantObjectId }) {
  const name = collectionNameOf(entry.model);
  if (entry.scope === 'self') return (await connection.collection(name).countDocuments({ _id: tenantObjectId }, { limit: 1 })) > 0;
  if (entry.scope === 'tenant') return (await connection.collection(name).countDocuments({ tenantId }, { limit: 1 })) > 0;
  return false;
}

/**
 * Import an opened archive into `connection`.
 *
 * @param {Object} opts
 * @param {string} opts.dir - extracted archive directory.
 * @param {Object} opts.manifest - validated manifest.
 * @param {import('mongoose').Connection} [opts.connection=mongoose.connection]
 * @param {'clone'|'preserve'} [opts.mode='clone']
 * @param {boolean} [opts.buildIndexes=false] - create the model indexes first
 *   (scratch databases; unique constraints then apply to the restored data).
 * @param {Date} [opts.now]
 * @returns {Promise<Object>} import result (pass it to verifyImport / rollbackImport).
 */
export async function importTenant({ dir, manifest, connection = mongoose.connection, mode = 'clone', buildIndexes = false, now = new Date() } = {}) {
  if (!['clone', 'preserve'].includes(mode)) throw new ArchiveError('IMPORT_MODE_INVALID', 'mode must be "clone" or "preserve"');
  if (!connection?.db) throw new ArchiveError('IMPORT_TARGET_UNAVAILABLE', 'The target database connection is not open');
  const started = Date.now();
  const sourceTenantId = manifest.tenant.id;
  const byModel = new Map(manifest.collections.map((c) => [c.model, c]));
  const entries = EXPORTED.filter((entry) => byModel.has(entry.model));

  // Pass 1: ownership of every document, id map, role ids.
  const sourceRoleIds = new Set();
  const idMap = new Map();
  const roleEntry = byModel.get('Role');
  if (roleEntry) {
    for await (const doc of readDocuments(dir, roleEntry.file)) {
      if (String(doc.tenantId ?? '') !== sourceTenantId) throw ownershipError(roleEntry.file, 'a record belongs to a different workspace');
      sourceRoleIds.add(String(doc._id));
    }
  }
  for (const entry of entries) {
    const file = byModel.get(entry.model).file;
    let count = 0;
    for await (const doc of readDocuments(dir, file)) {
      assertOwned(entry, doc, { sourceTenantId, sourceRoleIds, file });
      if (mode === 'clone' && entry.idReferenced && isObjectId(doc._id)) {
        const hex = doc._id.toHexString();
        if (idMap.has(hex)) throw new ArchiveError('ARCHIVE_DUPLICATE_ID', `${file}: duplicate record id`);
        idMap.set(hex, new mongoose.Types.ObjectId());
      }
      count += 1;
    }
    if (count !== byModel.get(entry.model).count) {
      throw new ArchiveError('ARCHIVE_COUNT_MISMATCH', `${file} holds ${count} records, the manifest lists ${byModel.get(entry.model).count}`);
    }
  }

  const targetTenantId = mode === 'clone' ? idMap.get(sourceTenantId).toHexString() : sourceTenantId;
  const tenantObjectId = new mongoose.Types.ObjectId(targetTenantId);

  if (mode === 'preserve') {
    for (const entry of entries) {
      if (await collectionHasTenantData(connection, entry, { tenantId: targetTenantId, tenantObjectId })) {
        throw new ArchiveError('IMPORT_TARGET_NOT_EMPTY', `The target already holds data of workspace ${targetTenantId} (${collectionNameOf(entry.model)}); use an empty scratch database or mode "clone"`);
      }
    }
  }

  if (buildIndexes) {
    for (const entry of entries) {
      const model = connection.models[entry.model] ?? connection.model(entry.model, mongoose.model(entry.model).schema);
      await model.init();
      await model.createIndexes();
    }
  }

  const suffix = crypto.randomBytes(4).toString('hex');
  const result = {
    mode,
    sourceTenantId,
    tenantId: targetTenantId,
    exportId: manifest.exportId,
    idMap,
    roleIds: [...sourceRoleIds].map((id) => (mode === 'clone' && idMap.has(id) ? idMap.get(id).toHexString() : id)),
    rewrites: [],
    collections: [],
    durationMs: 0,
  };

  let current = null;
  try {
    for (const entry of entries) {
      current = entry.model;
      const record = byModel.get(entry.model);
      const collection = connection.collection(collectionNameOf(entry.model));
      let batch = [];
      let inserted = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        await collection.insertMany(batch, { ordered: true });
        inserted += batch.length;
        batch = [];
      };
      for await (const source of readDocuments(dir, record.file)) {
        let doc = source;
        if (mode === 'clone') {
          if (Array.isArray(entry.remap)) {
            // Fields remapped by name are references by definition: one that
            // names a record outside the archive (a dataset row of a deleted
            // connector) still gets a consistent new id, or the clone would
            // collide with the source on unique keys such as
            // { connectorId, sourceRowId }.
            for (const field of entry.remap) {
              const value = source[field];
              if (isObjectId(value) && !idMap.has(value.toHexString())) idMap.set(value.toHexString(), new mongoose.Types.ObjectId());
            }
          }
          doc = remapDocument(source, entry.remap, idMap);
          if (!entry.idReferenced) doc._id = new mongoose.Types.ObjectId();
          if (entry.cloneRewrites) {
            for (const { field, value } of entry.cloneRewrites(source, { suffix, now, exportId: manifest.exportId })) {
              result.rewrites.push({
                model: entry.model,
                id: String(doc._id),
                field,
                hadValue: Object.prototype.hasOwnProperty.call(source, field),
                original: source[field],
              });
              doc[field] = value;
            }
          }
        }
        batch.push(doc);
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
      result.collections.push({ model: entry.model, collection: collectionNameOf(entry.model), inserted });
    }
  } catch (err) {
    await rollbackImport({ connection, result }).catch(() => null);
    if (err?.code === 11000) {
      // Name the collection and index, never the colliding values.
      const message = String(err.writeErrors?.[0]?.errmsg ?? err.message ?? '');
      const index = /index: (\S+)/.exec(message)?.[1] ?? Object.keys(err.keyPattern ?? {}).join('_') ?? null;
      throw new ArchiveError(
        'IMPORT_DUPLICATE_KEY',
        `A restored ${current} record collides with an existing unique value (index ${index || 'unknown'}) in the target database`,
        { model: current, index: index || null },
      );
    }
    throw err;
  }

  result.durationMs = Date.now() - started;
  return result;
}

/**
 * Remove everything `importTenant` wrote (by the target tenant id).
 *
 * @returns {Promise<{ deleted: number }>}
 */
export async function rollbackImport({ connection = mongoose.connection, result }) {
  let deleted = 0;
  const tenantObjectId = new mongoose.Types.ObjectId(result.tenantId);
  for (const entry of EXPORTED) {
    const collection = connection.collection(collectionNameOf(entry.model));
    let filter;
    if (entry.scope === 'self') filter = { _id: tenantObjectId };
    else if (entry.scope === 'tenant') filter = { tenantId: result.tenantId };
    else filter = { roleId: { $in: result.roleIds } };
    const outcome = await collection.deleteMany(filter);
    deleted += outcome.deletedCount ?? 0;
  }
  return { deleted };
}

/**
 * Verify a restored tenant against the manifest: counts per collection,
 * content checksums (after undoing id remapping and clone rewrites) and
 * dataset row counts per connector.
 *
 * @param {Object} opts
 * @param {Object} opts.manifest
 * @param {Object} opts.result - from `importTenant`.
 * @param {import('mongoose').Connection} [opts.connection=mongoose.connection]
 * @returns {Promise<{ ok: boolean, collections: Array<Object>, datasets: Array<Object> }>}
 */
export async function verifyImport({ manifest, result, connection = mongoose.connection }) {
  const inverse = result.mode === 'clone' ? invertIdMap(result.idMap) : new Map();
  const rewrites = new Map();
  for (const rewrite of result.rewrites) {
    const key = `${rewrite.model}:${rewrite.id}`;
    if (!rewrites.has(key)) rewrites.set(key, []);
    rewrites.get(key).push(rewrite);
  }
  const tenantObjectId = new mongoose.Types.ObjectId(result.tenantId);

  const collections = [];
  for (const record of manifest.collections) {
    const entry = exportedEntry(record.model);
    let filter;
    if (entry.scope === 'self') filter = { _id: tenantObjectId };
    else if (entry.scope === 'tenant') filter = { tenantId: result.tenantId };
    else filter = { roleId: { $in: result.roleIds } };

    const digest = new CollectionDigest({ includeId: entry.idReferenced });
    const cursor = connection.collection(collectionNameOf(entry.model)).find(filter, { batchSize: BATCH_SIZE });
    for await (const stored of cursor) {
      let doc = { ...stored };
      for (const rewrite of rewrites.get(`${entry.model}:${String(stored._id)}`) ?? []) {
        if (rewrite.hadValue) doc[rewrite.field] = rewrite.original;
        else delete doc[rewrite.field];
      }
      if (inverse.size > 0) doc = remapDocument(doc, entry.remap, inverse);
      digest.add(doc);
    }
    const actual = { count: digest.count, contentSha256: digest.digest() };
    collections.push({
      model: record.model,
      collection: record.collection,
      expected: { count: record.count, contentSha256: record.contentSha256 },
      actual,
      ok: actual.count === record.count && actual.contentSha256 === record.contentSha256,
    });
  }

  const datasets = [];
  const rowCollection = connection.collection(collectionNameOf('ConnectorRow'));
  for (const dataset of manifest.datasets ?? []) {
    const sourceId = dataset.connectorId;
    const targetId = result.mode === 'clone' && result.idMap.has(sourceId) ? result.idMap.get(sourceId) : new mongoose.Types.ObjectId(sourceId);
    const rows = await rowCollection.countDocuments({ tenantId: result.tenantId, connectorId: targetId });
    datasets.push({ connectorId: sourceId, expectedRows: dataset.rows, actualRows: rows, ok: rows === dataset.rows });
  }

  return {
    ok: collections.every((c) => c.ok) && datasets.every((d) => d.ok),
    collections,
    datasets,
  };
}

export default {
  openArchive,
  verifyArchive,
  importTenant,
  verifyImport,
  rollbackImport,
  ArchiveError,
};
