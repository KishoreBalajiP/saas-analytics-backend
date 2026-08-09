/**
 * Master Data Repository (Sprint 5 - implemented).
 *
 * PURPOSE
 *   Data-access surface for the global reference catalogue
 *   (`models/MasterData.js`). A single partitioned collection keyed by
 *   `catalogue` + `locale` + `code`; the repository enforces the catalogue
 *   constraint on every method so a caller can never cross partitions.
 *
 * RESPONSIBILITY
 *   - list(catalogue, opts)
 *   - findById(catalogue, id)
 *   - create(catalogue, doc)
 *   - update(catalogue, id, patch, by)
 *   - softDelete(catalogue, id, by)
 *
 * CODING GUIDELINES
 *   - `catalogue` is validated at the door (lowercase `[a-z0-9_]+`).
 *   - Reads return lean objects; writes return the saved doc.
 *   - Duplicate `(catalogue, locale, code)` surfaces as 409.
 *   - Tenant isolation is n/a (global catalogue) - see the model.
 */

import mongoose from 'mongoose';
import { MasterData } from '../models/MasterData.js';
import ApiError from '../utils/ApiError.js';

const { ObjectId } = mongoose.Types;
const CATALOGUE_RE = /^[a-z0-9_]+$/;

function normaliseCatalogue(catalogue) {
  const value = String(catalogue ?? '').trim().toLowerCase();
  if (!CATALOGUE_RE.test(value)) {
    throw ApiError.badRequest(`Invalid catalogue "${catalogue}" (expected lowercase [a-z0-9_]+)`);
  }
  return value;
}

function toId(id) {
  if (!id || !/^[0-9a-fA-F]{24}$/.test(String(id))) return null;
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
}

/** Paginated, locale-scoped list for a catalogue. */
export async function list(catalogue, { page = 1, limit = 50, locale = 'en', search } = {}) {
  const filter = { catalogue: normaliseCatalogue(catalogue) };
  if (locale) filter.locale = locale;
  if (search) {
    filter.$or = [{ name: new RegExp(String(search), 'i') }, { code: new RegExp(String(search), 'i') }];
  }
  const result = await MasterData.paginate(filter, {
    page,
    limit,
    lean: true,
    sort: { isSystem: -1, code: 1 },
  });
  return {
    docs: result.docs,
    total: result.totalDocs,
    page: result.page,
    limit: result.limit,
    pages: result.totalPages,
  };
}

/** Fetch a single entry by id (catalogue partition enforced). */
export async function findById(catalogue, id) {
  const _id = toId(id);
  if (!_id) throw ApiError.badRequest('Invalid id');
  const doc = await MasterData.findOne({ _id, catalogue: normaliseCatalogue(catalogue) }).lean();
  if (!doc) throw ApiError.notFound('Master data item not found');
  return doc;
}

/** Create a catalogue entry. */
export async function create(catalogue, doc) {
  const data = { ...doc, catalogue: normaliseCatalogue(catalogue) };
  try {
    const created = await MasterData.create(data);
    return created.toObject();
  } catch (err) {
    if (err?.code === 11000) {
      throw ApiError.conflict('A master data item with this code already exists in this locale');
    }
    throw err;
  }
}

/** Patch a catalogue entry. */
export async function update(catalogue, id, patch, by) {
  const _id = toId(id);
  if (!_id) throw ApiError.badRequest('Invalid id');
  const doc = await MasterData.findOneAndUpdate(
    { _id, catalogue: normaliseCatalogue(catalogue) },
    { $set: { ...patch, updatedBy: by ?? null } },
    { new: true, runValidators: true, lean: true },
  );
  if (!doc) throw ApiError.notFound('Master data item not found');
  return doc;
}

/** Soft-delete a catalogue entry. Idempotent-ish: 404 when already gone. */
export async function softDelete(catalogue, id, by) {
  const _id = toId(id);
  if (!_id) throw ApiError.badRequest('Invalid id');
  const doc = await MasterData.findOne({ _id, catalogue: normaliseCatalogue(catalogue) });
  if (!doc) throw ApiError.notFound('Master data item not found');
  // Respect the soft-delete contract (refuses if already removed via withDeleted).
  if (doc.isDeleted && doc.isDeleted()) return null;
  await doc.softDelete(by ?? null);
  return null;
}

export default { list, findById, create, update, softDelete };
