/**
 * /api/v1/master-data routes (Sprint 5 - implemented).
 *
 * WHY IT EXISTS
 *   Central catalogue for the reference data every module depends on
 *   (countries, currencies, plans, themes, ...). One write surface, one cached
 *   read surface.
 *
 * ENDPOINTS
 *   - GET    /:catalogue          list (public, cached)
 *   - GET    /:catalogue/:id      detail (public, cached)
 *   - POST   /:catalogue          create (admin only)
 *   - PATCH  /:catalogue/:id      update (admin only)
 *   - DELETE /:catalogue/:id      delete (admin only, refuses system-bound 409)
 *   - POST   /:catalogue/import   CSV import (admin only, 501)
 *   - POST   /:catalogue/export   export (admin only, 501)
 *
 * MIDDLEWARE ORDER
 *   reads    : optionalAuthenticate -> validate -> handler
 *   writes+  : adminAuth -> permission('master_data', <action>)
 *              -> adminScope.platform() -> validate -> handler
 *
 * SECURITY
 *   - Reads are intentionally public (reference data); the search term is
 *     escaped and length-capped before it reaches Mongo.
 *   - Writes require a platform admin holding `master_data.create` /
 *     `update` / `delete` (`export` for export) and are platform-wide:
 *     tenant-scoped admins are refused because the data is shared by every
 *     tenant. Only whitelisted fields from `req.validated.body` are written
 *     (`isSystem` cannot be changed after creation).
 *   - `validate()` guards the `catalogue` param so path traversal / stray
 *     keys never reach the repository.
 *   - `/:catalogue/import` and `/:catalogue/export` are POST routes; they do
 *     not collide with `/:catalogue/:id` because of the different HTTP verb.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { optionalAuthenticate } from '../middleware/auth.middleware.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { adminScope } from '../middleware/adminScope.middleware.js';
import masterDataValidator from '../validators/masterData.validator.js';
import masterDataController from '../controllers/masterData.controller.js';

const router = Router();

router.get('/:catalogue', optionalAuthenticate, validate(masterDataValidator.listSchema), masterDataController.listCatalogue);
router.get('/:catalogue/:id', optionalAuthenticate, validate(masterDataValidator.itemSchema), masterDataController.getItem);
router.post('/:catalogue', adminAuth, permission('master_data', 'create'), adminScope.platform(), validate(masterDataValidator.createSchema), masterDataController.createItem);
router.patch('/:catalogue/:id', adminAuth, permission('master_data', 'update'), adminScope.platform(), validate(masterDataValidator.updateSchema), masterDataController.updateItem);
router.delete('/:catalogue/:id', adminAuth, permission('master_data', 'delete'), adminScope.platform(), validate(masterDataValidator.itemSchema), masterDataController.deleteItem);
router.post('/:catalogue/import', adminAuth, permission('master_data', 'create'), adminScope.platform(), validate(masterDataValidator.catalogueSchema), masterDataController.importCsv);
router.post('/:catalogue/export', adminAuth, permission('master_data', 'export'), adminScope.platform(), validate(masterDataValidator.catalogueSchema), masterDataController.exportCatalogue);

export default router;
