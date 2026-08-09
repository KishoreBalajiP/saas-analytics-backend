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
 *   reads    : optionalAuthenticate  -> handler
 *   writes+  : adminAuth            -> handler
 *
 * SECURITY
 *   - Reads are intentionally public (reference data); writes require a
 *     platform admin. `validate()` guards the `catalogue` param so path
 *     traversal / stray keys never reach the repository.
 *   - `/:catalogue/import` and `/:catalogue/export` are POST routes; they do
 *     not collide with `/:catalogue/:id` because of the different HTTP verb.
 */

import { Router } from 'express';
import { validate } from '../validators/index.js';
import { optionalAuthenticate } from '../middleware/auth.middleware.js';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import masterDataValidator from '../validators/masterData.validator.js';
import masterDataController from '../controllers/masterData.controller.js';

const router = Router();

router.get('/:catalogue', optionalAuthenticate, validate(masterDataValidator.listSchema), masterDataController.listCatalogue);
router.get('/:catalogue/:id', optionalAuthenticate, masterDataController.getItem);
router.post('/:catalogue', adminAuth, validate(masterDataValidator.createSchema), masterDataController.createItem);
router.patch('/:catalogue/:id', adminAuth, validate(masterDataValidator.updateSchema), masterDataController.updateItem);
router.delete('/:catalogue/:id', adminAuth, masterDataController.deleteItem);
router.post('/:catalogue/import', adminAuth, masterDataController.importCsv);
router.post('/:catalogue/export', adminAuth, masterDataController.exportCatalogue);

export default router;
