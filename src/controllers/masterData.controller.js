/**
 * Master Data Controller (Sprint 5 - implemented).
 *
 * PURPOSE
 *   HTTP layer for `/api/v1/master-data`. Reads are public + cached at the
 *   service layer; writes are admin-only (enforced by `adminAuth` on the
 *   route). System-bound items refuse deletion (409).
 *
 * RESPONSIBILITY
 *   - listCatalogue   GET    /:catalogue          (paginated)
 *   - getItem         GET    /:catalogue/:id
 *   - createItem      POST   /:catalogue
 *   - updateItem      PATCH  /:catalogue/:id
 *   - deleteItem      DELETE /:catalogue/:id
 *   - importCsv       POST   /:catalogue/import  (501)
 *   - exportCatalogue POST   /:catalogue/export  (501)
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import * as masterDataService from '../services/masterData.service.js';

const actorOf = (req) => req.user?.id ?? req.admin?.id ?? null;

/** GET /api/v1/master-data/:catalogue - list a catalogue. */
export const listCatalogue = asyncHandler(async (req, res) => {
  const { catalogue } = req.params;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 20), 100);
  const result = await masterDataService.list(catalogue, {
    page,
    limit,
    locale: req.query.locale ? String(req.query.locale) : undefined,
    search: req.query.search ? String(req.query.search) : undefined,
  });
  return ApiResponse.ok(res, result.docs, 'Master data', {
    total: result.total,
    page: result.page,
    pages: result.pages,
    limit: result.limit,
  });
});

/** GET /api/v1/master-data/:catalogue/:id - fetch an item. */
export const getItem = asyncHandler(async (req, res) => {
  const { catalogue, id } = req.params;
  const item = await masterDataService.getById(catalogue, id);
  return ApiResponse.ok(res, item, 'Master data item');
});

/** POST /api/v1/master-data/:catalogue - create an item. */
export const createItem = asyncHandler(async (req, res) => {
  const { catalogue } = req.params;
  const item = await masterDataService.create(catalogue, req.body, actorOf(req));
  return ApiResponse.created(res, item, 'Master data item created');
});

/** PATCH /api/v1/master-data/:catalogue/:id - update an item. */
export const updateItem = asyncHandler(async (req, res) => {
  const { catalogue, id } = req.params;
  const item = await masterDataService.update(catalogue, id, req.body, actorOf(req));
  return ApiResponse.ok(res, item, 'Master data item updated');
});

/** DELETE /api/v1/master-data/:catalogue/:id - soft-delete an item. */
export const deleteItem = asyncHandler(async (req, res) => {
  const { catalogue, id } = req.params;
  await masterDataService.remove(catalogue, id, actorOf(req));
  return ApiResponse.noContent(res);
});

/** POST /api/v1/master-data/:catalogue/import - CSV import (not yet available). */
export const importCsv = asyncHandler(async () => {
  throw ApiError.notImplemented('CSV import for master data is not available yet');
});

/** POST /api/v1/master-data/:catalogue/export - export (not yet available). */
export const exportCatalogue = asyncHandler(async () => {
  throw ApiError.notImplemented('Master data export is not available yet');
});

export default {
  listCatalogue,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  importCsv,
  exportCatalogue,
};
