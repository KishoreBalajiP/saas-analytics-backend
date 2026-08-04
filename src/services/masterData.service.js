/**
 * Master Data Service (architecture placeholder).
 *
 * PURPOSE
 *   Business logic for the global catalogue (countries, currencies,
 *   plans, themes, languages, ...). Two read paths: admin (uncached) and
 *   tenant-cached (passed through `src/cache/`).
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listCatalogue(name, locale), getItem, createItem, updateItem,
 *     deleteItem, importCsv, exportCatalogue
 *
 * CODING GUIDELINES
 *   - Optimistic concurrency via `If-Match`. Service layer raises 409.
 *   - System-bound items cannot be deleted.
 *   - Per-catalogue format lives in `services/masterData.formatters.js`
 *     (planned); the service delegates.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const list = notImplementedStub('masterData.service', 'list');
export const getById = notImplementedStub('masterData.service', 'getById');
export const create = notImplementedStub('masterData.service', 'create');
export const update = notImplementedStub('masterData.service', 'update');
export const remove = notImplementedStub('masterData.service', 'remove');
export const importCsv = notImplementedStub('masterData.service', 'importCsv');
export const exportCatalogue = notImplementedStub('masterData.service', 'exportCatalogue');

export default {
  list, getById, create, update, remove, importCsv, exportCatalogue,
  _meta: { cachedReads: true },
};
