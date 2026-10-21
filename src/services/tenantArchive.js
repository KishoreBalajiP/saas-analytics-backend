/**
 * Tenant archive format (roadmap 2.9 - backups and recovery).
 *
 * WHY IT EXISTS
 *   The export writer, the import reader and the restore drill must agree
 *   byte for byte on how documents are serialised, how checksums are
 *   computed and how ids are remapped. This module is that shared contract.
 *
 * FORMAT (`analivo.tenant-export`, version 1) - a gzip-compressed tar:
 *   manifest.json                     counts, checksums, exclusions, redactions
 *   README.txt                        human description of the layout
 *   collections/<collection>.jsonl    one document per line, relaxed
 *                                     MongoDB Extended JSON (EJSON)
 *   datasets/<connectorId>.csv        one CSV per dataset (connector rows)
 *   reference/permissions.jsonl       platform permission keys the tenant's
 *                                     roles reference (for re-linking)
 *
 * CHECKSUMS
 *   - Every member has `sha256` (of its exact bytes) and `bytes`.
 *   - Every collection also has `contentSha256`: an order-independent digest
 *     of its documents. Each document is serialised canonically (relaxed
 *     EJSON, object keys sorted recursively) and hashed with SHA-256; the
 *     collection digest is SHA-256 of `"<count>:<hex(sum of the document
 *     digests mod 2^256)>"`. The import verifies a restored tenant by
 *     reading it back, undoing the id remapping, and recomputing this value,
 *     so a round trip is proven equal without keeping every document in
 *     memory. For collections whose ids are not referenced (`idReferenced:
 *     false`) the document digest leaves `_id` out.
 *
 * ID REMAPPING
 *   `remapValue` replaces ObjectIds, and 24-hex tokens inside strings, that
 *   appear in an id map (old -> new). Tokens are only replaced on hex
 *   boundaries, so longer hex strings (hashes) are never touched. The same
 *   function with the inverse map undoes it.
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;

export const ARCHIVE_FORMAT = 'analivo.tenant-export';
export const ARCHIVE_FORMAT_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const README_FILE = 'README.txt';
export const PERMISSIONS_REFERENCE_FILE = 'reference/permissions.jsonl';

const MOD_256 = 1n << 256n;
const HEX_ID_TOKEN = /(?<![0-9a-fA-F])[0-9a-fA-F]{24}(?![0-9a-fA-F])/g;

/** Typed error for malformed or inconsistent archives (maps to 4xx/exit 1). */
export class ArchiveError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.details = details ?? null;
    this.isOperational = true;
  }
}

/* ------------------------------ serialisation ---------------------------- */

/**
 * One JSONL line for a document (relaxed EJSON, natural key order).
 * @param {Object} doc
 * @returns {string}
 */
export function serializeDocument(doc) {
  return EJSON.stringify(doc, { relaxed: true });
}

/**
 * Parse one JSONL line back into a document (BSON types restored).
 * @param {string} line
 * @returns {Object}
 */
export function parseDocument(line) {
  let value;
  try {
    value = EJSON.parse(line, { relaxed: true });
  } catch {
    throw new ArchiveError('ARCHIVE_DOCUMENT_INVALID', 'A collection file contains a line that is not valid Extended JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArchiveError('ARCHIVE_DOCUMENT_INVALID', 'A collection file contains a line that is not a document');
  }
  return value;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/**
 * Canonical text of a document: relaxed EJSON with keys sorted recursively.
 * @param {Object} doc
 * @returns {string}
 */
export function canonicalDocument(doc) {
  return JSON.stringify(sortKeys(EJSON.serialize(doc, { relaxed: true })));
}

/** SHA-256 hex of a string or Buffer. */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Order-independent digest accumulator for a collection (see header).
 */
export class CollectionDigest {
  /**
   * @param {Object} [options]
   * @param {boolean} [options.includeId=true] - include `_id` in each document digest.
   */
  constructor({ includeId = true } = {}) {
    this.includeId = includeId;
    this.count = 0;
    this.sum = 0n;
  }

  /** Add one document. */
  add(doc) {
    let subject = doc;
    if (!this.includeId && doc && Object.prototype.hasOwnProperty.call(doc, '_id')) {
      subject = { ...doc };
      delete subject._id;
    }
    const hex = sha256Hex(canonicalDocument(subject));
    this.sum = (this.sum + BigInt(`0x${hex}`)) % MOD_256;
    this.count += 1;
  }

  /** Final digest string. */
  digest() {
    return sha256Hex(`${this.count}:${this.sum.toString(16).padStart(64, '0')}`);
  }
}

/* -------------------------------- remapping ------------------------------ */

function isObjectId(value) {
  return Boolean(value) && typeof value === 'object' && value._bsontype === 'ObjectId' && typeof value.toHexString === 'function';
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function remapString(value, map) {
  if (value.length < 24) return value;
  return value.replace(HEX_ID_TOKEN, (token) => {
    const mapped = map.get(token.toLowerCase());
    return mapped ? mapped.toHexString() : token;
  });
}

/**
 * Deep-remap ids in a value. `map` is a Map<lowercase hex, ObjectId>.
 * Strings are only rewritten on whole 24-hex tokens present in the map;
 * BSON values other than ObjectId (dates, binaries, decimals) are kept.
 *
 * @param {*} value
 * @param {Map<string, import('mongoose').Types.ObjectId>} map
 * @returns {*}
 */
export function remapValue(value, map) {
  if (map.size === 0 || value === null || value === undefined) return value;
  if (typeof value === 'string') return remapString(value, map);
  if (isObjectId(value)) return map.get(value.toHexString()) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapValue(item, map));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[remapString(key, map)] = remapValue(inner, map);
    return out;
  }
  return value;
}

/**
 * Remap a document according to a catalogue policy: `'deep'` remaps the
 * whole document, an array of field names remaps only those fields.
 *
 * @param {Object} doc
 * @param {'deep'|string[]} policy
 * @param {Map<string, import('mongoose').Types.ObjectId>} map
 * @returns {Object}
 */
export function remapDocument(doc, policy, map) {
  if (policy === 'deep') return remapValue(doc, map);
  const out = { ...doc };
  for (const field of policy) {
    if (Object.prototype.hasOwnProperty.call(out, field)) out[field] = remapValue(out[field], map);
  }
  return out;
}

/** Inverse of an id map (new hex -> old ObjectId). */
export function invertIdMap(map) {
  const inverse = new Map();
  for (const [oldHex, newId] of map) inverse.set(newId.toHexString(), new mongoose.Types.ObjectId(oldHex));
  return inverse;
}

/* ---------------------------------- CSV ---------------------------------- */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Render one CSV cell (RFC 4180 quoting). Strings that a spreadsheet would
 * evaluate as a formula are prefixed with `'` (CSV injection guard); the
 * JSONL copy in `collections/` keeps the exact value.
 *
 * @param {*} value
 * @returns {string}
 */
export function csvCell(value) {
  let text;
  if (value === null || value === undefined) text = '';
  else if (typeof value === 'string') text = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') text = String(value);
  else if (value instanceof Date) text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
  else if (isObjectId(value)) text = value.toHexString();
  else text = EJSON.stringify(value, { relaxed: true });
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render a CSV line (no trailing newline). */
export function csvLine(values) {
  return values.map(csvCell).join(',');
}

/* -------------------------------- manifest ------------------------------- */

const SAFE_MEMBER = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HEX24 = /^[0-9a-f]{24}$/;

function fail(message, details) {
  throw new ArchiveError('ARCHIVE_MANIFEST_INVALID', message, details);
}

function checkFileRecord(record, label) {
  if (!record || typeof record !== 'object') fail(`${label} is missing`);
  if (typeof record.file !== 'string' || !SAFE_MEMBER.test(record.file) || record.file.split('/').includes('..')) {
    fail(`${label} names an unsafe file`);
  }
  if (!Number.isInteger(record.bytes) || record.bytes < 0) fail(`${label} has an invalid size`);
  if (typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)) fail(`${label} has an invalid sha256`);
}

/**
 * Structural validation of an untrusted manifest. Collection entries must
 * name exported catalogue models with their expected collection and file.
 *
 * @param {*} manifest
 * @param {Object} catalogue - `{ exportedEntry(model), collectionNameOf(model), collectionFileOf(model) }`.
 * @returns {Object} the manifest.
 */
export function validateManifest(manifest, catalogue) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest.json is not an object');
  if (manifest.format !== ARCHIVE_FORMAT) fail(`manifest.json is not an ${ARCHIVE_FORMAT} manifest`);
  if (manifest.formatVersion !== ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError('ARCHIVE_VERSION_UNSUPPORTED', `Archive format version ${manifest.formatVersion} is not supported`);
  }
  if (typeof manifest.exportId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(manifest.exportId)) fail('manifest.exportId is invalid');
  if (!manifest.tenant || typeof manifest.tenant.id !== 'string' || !HEX24.test(manifest.tenant.id)) fail('manifest.tenant.id is invalid');
  if (!Array.isArray(manifest.collections) || manifest.collections.length === 0) fail('manifest.collections is empty');

  const seenModels = new Set();
  const seenFiles = new Set();
  for (const [index, entry] of manifest.collections.entries()) {
    const label = `manifest.collections[${index}]`;
    checkFileRecord(entry, label);
    const known = catalogue.exportedEntry(entry.model);
    if (!known) fail(`${label} names a collection that is not part of tenant exports`, { model: entry.model });
    if (entry.collection !== catalogue.collectionNameOf(entry.model) || entry.file !== catalogue.collectionFileOf(entry.model)) {
      fail(`${label} does not match the expected collection layout`, { model: entry.model });
    }
    if (seenModels.has(entry.model)) fail(`${label} repeats ${entry.model}`);
    if (!Number.isInteger(entry.count) || entry.count < 0) fail(`${label} has an invalid count`);
    if (typeof entry.contentSha256 !== 'string' || !SHA256.test(entry.contentSha256)) fail(`${label} has an invalid contentSha256`);
    seenModels.add(entry.model);
    seenFiles.add(entry.file);
  }
  if (!seenModels.has('Tenant')) fail('manifest.collections has no Tenant entry');

  for (const [index, dataset] of (manifest.datasets ?? []).entries()) {
    const label = `manifest.datasets[${index}]`;
    checkFileRecord(dataset, label);
    if (typeof dataset.connectorId !== 'string' || !HEX24.test(dataset.connectorId)) fail(`${label} has an invalid connectorId`);
    if (!Number.isInteger(dataset.rows) || dataset.rows < 0) fail(`${label} has an invalid row count`);
    if (seenFiles.has(dataset.file)) fail(`${label} repeats a file`);
    seenFiles.add(dataset.file);
  }
  for (const [index, reference] of (manifest.references ?? []).entries()) {
    const label = `manifest.references[${index}]`;
    checkFileRecord(reference, label);
    if (seenFiles.has(reference.file)) fail(`${label} repeats a file`);
    seenFiles.add(reference.file);
  }
  if (!Array.isArray(manifest.datasets ?? [])) fail('manifest.datasets must be an array');
  if (!Array.isArray(manifest.references ?? [])) fail('manifest.references must be an array');
  return manifest;
}

/**
 * Every archive member a manifest lists (excluding the manifest itself and
 * the README), with its expected size and checksum.
 *
 * @param {Object} manifest - validated manifest.
 * @returns {Array<{ file: string, bytes: number, sha256: string }>}
 */
export function listedFiles(manifest) {
  return [
    ...manifest.collections,
    ...(manifest.datasets ?? []),
    ...(manifest.references ?? []),
  ].map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }));
}

/** README shipped inside every archive. */
export function readmeText({ exportId, tenantName, createdAt }) {
  return [
    `Analivo workspace data export ${exportId}`,
    `Workspace: ${tenantName}`,
    `Created: ${createdAt}`,
    '',
    'Layout',
    '  manifest.json                  counts, SHA-256 checksums, excluded collections and redactions',
    '  collections/<name>.jsonl       one record per line in MongoDB Extended JSON (relaxed)',
    '  datasets/<connectorId>.csv     your dataset rows as CSV (one file per data source)',
    '  reference/permissions.jsonl    permission keys referenced by your roles',
    '',
    'Secrets are not included: password hashes, connector credentials, API keys, embed',
    'tokens, sessions and invitation tokens are redacted or left out (see manifest.json).',
    'CSV cells that start with = + - @ are prefixed with an apostrophe so spreadsheet',
    'applications do not evaluate them; the JSONL files keep the exact values.',
    '',
  ].join('\n');
}

export default {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  MANIFEST_FILE,
  README_FILE,
  PERMISSIONS_REFERENCE_FILE,
  ArchiveError,
  serializeDocument,
  parseDocument,
  canonicalDocument,
  sha256Hex,
  CollectionDigest,
  remapValue,
  remapDocument,
  invertIdMap,
  csvCell,
  csvLine,
  validateManifest,
  listedFiles,
  readmeText,
};
