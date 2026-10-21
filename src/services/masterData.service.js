/**
 * Master Data Service (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Business logic for the global reference catalogue (countries, currencies,
 *   plans, themes, ...). Reads hit MongoDB directly and are fast enough for a
 *   small catalogue; a follow-up sprint can add per-catalogue caching behind a
 *   version-token invalidation strategy.
 *
 * RESPONSIBILITY
 *   - list(catalogue, opts)     GET    /master-data/:catalogue
 *   - getById(catalogue, id)    GET    /master-data/:catalogue/:id
 *   - create(catalogue, doc,by) POST   /master-data/:catalogue
 *   - update(catalogue,id,by)   PATCH  /master-data/:catalogue/:id
 *   - remove(catalogue,id,by)   DELETE /master-data/:catalogue/:id
 *
 * CODING GUIDELINES
 *   - `catalogue` partitioning is enforced in the repository.
 *   - System-bound items cannot be deleted (returns 409).
 *   - Writes are admin-only (enforced at the route layer with `adminAuth`).
 */

import ApiError from '../utils/ApiError.js';
import * as repository from '../repositories/masterData.repository.js';

/** Read a (possibly searched, paginated) catalogue page. */
export async function list(catalogue, opts = {}) {
  return repository.list(catalogue, opts);
}

/** Fetch a single catalogue entry. */
export async function getById(catalogue, id) {
  return repository.findById(catalogue, id);
}

/** billing: exact lookup by code (never a search pattern). */
export async function getByCode(catalogue, code, opts = {}) {
  return repository.findByCode(catalogue, code, opts);
}

/** Fields a create may set (the catalogue comes from the path). */
const CREATE_FIELDS = Object.freeze(['code', 'name', 'locale', 'data', 'isSystem']);

/** Fields an update may change; `isSystem` is fixed at creation. */
const UPDATE_FIELDS = Object.freeze(['code', 'name', 'locale', 'data']);

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) out[field] = source[field];
  }
  return out;
}

/** Create a catalogue entry from whitelisted fields only. */
export async function create(catalogue, doc, by) {
  return repository.create(catalogue, { ...pick(doc, CREATE_FIELDS), createdBy: by ?? null, updatedBy: by ?? null });
}

/** Patch a catalogue entry (whitelisted fields only; never `isSystem`). */
export async function update(catalogue, id, patch, by) {
  const set = pick(patch, UPDATE_FIELDS);
  if (Object.keys(set).length === 0) throw ApiError.badRequest('Nothing to update');
  return repository.update(catalogue, id, set, by);
}

/** Delete a catalogue entry (system-bound items are refused with 409). */
export async function remove(catalogue, id, by) {
  const _id = String(id ?? '');
  const doc = await repository.findById(catalogue, id);
  if (doc && doc.isSystem) {
    throw ApiError.conflict('System-bound master data items cannot be deleted');
  }
  const deleted = await repository.softDelete(catalogue, id, by);
  return { deleted: true };
}

export default { list, getById, getByCode, create, update, remove, _meta: { cachedReads: false } };
