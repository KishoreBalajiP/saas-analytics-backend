/**
 * Master Data Repository (architecture placeholder).
 *
 * PURPOSE
 *   Stable data-access surface for the global catalogue. One underlying
 *   Mongo collection per catalogue (`countries`, `currencies`, etc.).
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - list(catalogue, { page, pageSize, locale }) -> { items, total }
 *   - findById(catalogue, id), create(catalogue, doc),
 *     update(catalogue, id, patch, { ifMatch }), softDelete(catalogue, id)
 *
 * CODING GUIDELINES
 *   - All writes MUST be `ifMatch`-safe when not system-bound.
 *   - Catalogue collection name MUST be validated at the model layer.
 *   - Reads return lean objects; writes return the created/updated doc.
 *
 * FUTURE EXTENSION
 *   - Per-catalogue filter indexes (locale-aware).
 *   - Audit emit (collection + id, action) on every write.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const list = notImplementedStub('masterData.repository', 'list');
export const findById = notImplementedStub('masterData.repository', 'findById');
export const create = notImplementedStub('masterData.repository', 'create');
export const update = notImplementedStub('masterData.repository', 'update');
export const softDelete = notImplementedStub('masterData.repository', 'softDelete');

export default {
  list, findById, create, update, softDelete,
  _meta: { collections: 'one-per-catalogue' },
};
