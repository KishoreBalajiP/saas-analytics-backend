/**
 * /api/v1/reports routes (Sprint 7 - implemented).
 *
 * ENDPOINTS
 *   - GET    /                       list            reports.view
 *   - POST   /                       create          reports.create
 *   - GET    /:id                    detail+history  reports.view
 *   - PATCH  /:id                    update          reports.update
 *   - POST   /:id/run                ad-hoc run      reports.export
 *   - DELETE /:id                    soft-delete     reports.delete
 *   - GET    /:id/download           artefact URL    reports.export
 *
 * CODING GUIDELINES
 *   - Runs always go through `src/queues/analytics.queue.js`; the worker
 *     (`report.service.processRun`) generates the artefact off the hot path.
 *   - Artefacts live in `src/storage/`, never in MongoDB.
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import reportValidator from '../validators/report.validator.js';
import reportController from '../controllers/report.controller.js';

const router = Router();

const guarded = (action, ...mw) => [authenticate, resolveTenant, permission('reports', action), ...mw];
const idParam = { params: { id: 'objectId|required' } };

router.get('/', guarded('view', validate(reportValidator.reportListSchema)), reportController.listReports);
router.post('/', guarded('create', validate(reportValidator.reportCreateSchema)), reportController.createReport);
router.get('/:id', guarded('view', validate(idParam)), reportController.getReport);
router.patch('/:id', guarded('update', validate(reportValidator.reportUpdateSchema)), reportController.updateReport);
router.post('/:id/run', guarded('export', validate(reportValidator.reportRunSchema)), reportController.runReport);
router.delete('/:id', guarded('delete', validate(idParam)), reportController.deleteReport);
router.get('/:id/download', guarded('export', validate(reportValidator.reportDownloadSchema)), reportController.downloadReport);

export default router;
