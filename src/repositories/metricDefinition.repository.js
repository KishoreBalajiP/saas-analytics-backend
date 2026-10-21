/**
 * MetricDefinition repository (ai-catalogue).
 *
 * PURPOSE
 *   Data access for versioned metric definitions (`models/MetricDefinition.js`).
 *
 * RESPONSIBILITY
 *   - listLatest       latest version per key (optionally by status), paged
 *   - listVersions     every version of one key, newest first
 *   - findVersion      one exact version
 *   - findLatest       newest version of a key (any status, or one status)
 *   - create           insert one immutable version
 *   - setStatus        conditional status change of one version (draft -> approved)
 *   - archiveKey       archive every version of a key
 *
 * CODING GUIDELINES
 *   - Every read and write filters by tenantId (aggregate bypasses the
 *     tenantScope plugin, so the filter is always explicit here).
 *   - Lean returns.
 */

import mongoose from 'mongoose';
import { MetricDefinition } from '../models/MetricDefinition.js';

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Latest version of each key. With `status`, the latest version IN that
 * status (so `approved` lists the version queries resolve to).
 *
 * @returns {Promise<{ docs: object[], total: number, page: number, limit: number, pages: number }>}
 */
export async function listLatest({ tenantId, status, search, connectorId, page = 1, limit = 20 } = {}) {
  if (!tenantId) throw new Error('metricDefinition.repository: tenantId is required');
  const match = { tenantId: String(tenantId) };
  if (status) match.status = status;
  else match.status = { $ne: 'archived' };
  if (connectorId) match.connectorId = new mongoose.Types.ObjectId(String(connectorId));
  if (search) {
    const re = new RegExp(escapeRegex(String(search).slice(0, 100)), 'i');
    match.$or = [{ key: re }, { label: re }];
  }
  const skip = (page - 1) * limit;
  const [facet] = await MetricDefinition.aggregate([
    { $match: match },
    { $sort: { key: 1, version: -1 } },
    { $group: { _id: '$key', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
    { $sort: { key: 1 } },
    { $facet: { docs: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'n' }] } },
  ]);
  const total = facet?.total?.[0]?.n ?? 0;
  return { docs: facet?.docs ?? [], total, page, limit, pages: total === 0 ? 0 : Math.ceil(total / limit) };
}

/** Every version of a key, newest first. */
export function listVersions({ tenantId, key }) {
  return MetricDefinition.find({ tenantId: String(tenantId), key }).sort({ version: -1 }).lean();
}

/** One exact version, or null. */
export function findVersion({ tenantId, key, version, status }) {
  const filter = { tenantId: String(tenantId), key, version };
  if (status) filter.status = status;
  return MetricDefinition.findOne(filter).lean();
}

/** Newest version of a key (optionally in one status), or null. */
export function findLatest({ tenantId, key, status }) {
  const filter = { tenantId: String(tenantId), key };
  if (status) filter.status = status;
  return MetricDefinition.findOne(filter).sort({ version: -1 }).lean();
}

/** Insert one version. Duplicate (tenant, key, version) raises code 11000. */
export async function create(data) {
  const doc = await MetricDefinition.create(data);
  return doc.toObject();
}

/**
 * Move one version from `from` to `to` atomically (null when it was not in
 * `from`, e.g. a concurrent approval).
 */
export function setStatus({ tenantId, key, version, from, to, set = {} }) {
  return MetricDefinition.findOneAndUpdate(
    { tenantId: String(tenantId), key, version, status: from },
    { $set: { status: to, ...set } },
    { new: true, lean: true },
  );
}

/** Archive every version of a key. Returns the number of versions changed. */
export async function archiveKey({ tenantId, key, by, at = new Date() }) {
  const res = await MetricDefinition.updateMany(
    { tenantId: String(tenantId), key, status: { $ne: 'archived' } },
    { $set: { status: 'archived', archivedBy: by ?? null, archivedAt: at } },
  );
  return res.modifiedCount ?? 0;
}

/** Highest approved version per key, for the given keys: Map key -> version. */
export async function approvedVersions({ tenantId, keys }) {
  if (!keys.length) return new Map();
  const rows = await MetricDefinition.aggregate([
    { $match: { tenantId: String(tenantId), key: { $in: keys }, status: 'approved' } },
    { $group: { _id: '$key', version: { $max: '$version' } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.version]));
}

/** Keys that already exist for a tenant among `keys`. */
export async function existingKeys({ tenantId, keys }) {
  if (!keys.length) return new Set();
  const found = await MetricDefinition.distinct('key', { tenantId: String(tenantId), key: { $in: keys } });
  return new Set(found);
}

export default { listLatest, listVersions, findVersion, findLatest, create, setStatus, archiveKey, existingKeys, approvedVersions };
