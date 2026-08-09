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

/** Create a catalogue entry. */
export async function create(catalogue, doc, by) {
  return repository.create(catalogue, { ...doc, createdBy: by ?? null, updatedBy: by ?? null });
}

/** Patch a catalogue entry. */
export async function update(catalogue, id, patch, by) {
  return repository.update(catalogue, id, patch, by);
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

export default { list, getById, create, update, remove, _meta: { cachedReads: false } };
