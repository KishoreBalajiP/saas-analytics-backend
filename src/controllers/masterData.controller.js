/**
 * Master Data Controller (architecture placeholder).
 *
 * PURPOSE
 *   HTTP-layer entry for `/api/v1/master-data`. Manages the catalogue
 *   lookups that every other module depends on (countries, currencies,
 *   plans, themes, ...). Writes are admin-only; reads are cached.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listCatalogue, getItem, createItem, updateItem, deleteItem
 *   - importCsv, exportToStorage
 *
 * CODING GUIDELINES
 *   - Optimistic concurrency via `If-Match` header on update (Phase 2).
 *   - Read endpoints may receive `?locale=` and `?page=` parameters.
 *   - The "delete refuses if system-bound" rule returns 409.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';

const notImplemented = (op) =>
  asyncHandler(async (_req, res) => {
    return ApiResponse.error(res, 501, `${op} is not implemented yet (Phase 1.2 architecture placeholder)`);
  });

export const listCatalogue = notImplemented('GET /master-data/:catalogue');
export const getItem = notImplemented('GET /master-data/:catalogue/:id');
export const createItem = notImplemented('POST /master-data/:catalogue');
export const updateItem = notImplemented('PATCH /master-data/:catalogue/:id');
export const deleteItem = notImplemented('DELETE /master-data/:catalogue/:id');
export const importCsv = notImplemented('POST /master-data/:catalogue/import');
export const exportCatalogue = notImplemented('POST /master-data/:catalogue/export');

export default {
  listCatalogue, getItem, createItem, updateItem, deleteItem,
  importCsv, exportCatalogue,
};
