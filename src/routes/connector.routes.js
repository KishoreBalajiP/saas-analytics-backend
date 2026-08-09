/**
 * /api/v1/connectors routes (Sprint 4 - implemented).
 *
 * WHY IT EXISTS
 *   HTTP surface for the connector feature: tenant-scoped CRUD, config
 *   validation, registered-type catalogue, ingested-row listing and CSV
 *   preview/sync (file upload). Backed by `services/connector.service.js`.
 *
 * ENDPOINTS
 *   - GET    /types                    - registered connector types/capabilities
 *   - GET    /                         - list connectors (paginated, filterable)
 *   - POST   /                         - create (config validated + encrypted)
 *   - GET    /:connectorId             - detail
 *   - PATCH  /:connectorId             - update (type immutable)
 *   - DELETE /:connectorId             - soft delete
 *   - POST   /:connectorId/validate    - validate stored config (no ingest)
 *   - GET    /:connectorId/rows        - ingested rows (paginated)
 *   - POST   /:connectorId/preview     - CSV header/sample preview (multipart `file`)
 *   - POST   /:connectorId/sync        - enqueue CSV sync (multipart `file`)
 *
 * MIDDLEWARE ORDER
 *   authenticate -> resolveTenant -> permission('connectors', <action>) -> handler
 *
 * SECURITY NOTES
 *   - `config` is encrypted at rest; only a redacted summary is returned.
 *   - `/types` is registered before `/:connectorId` so `types` is never
 *     treated as an id.
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { upload } from '../middleware/upload.middleware.js';
import connectorController from '../controllers/connector.controller.js';

const router = Router();

router.use(authenticate, resolveTenant);

router.get('/types', permission('connectors', 'view'), connectorController.listTypes);
router.get('/', permission('connectors', 'view'), connectorController.list);
router.post('/', permission('connectors', 'create'), connectorController.create);
router.get('/:connectorId', permission('connectors', 'view'), connectorController.getById);
router.patch('/:connectorId', permission('connectors', 'update'), connectorController.update);
router.delete('/:connectorId', permission('connectors', 'delete'), connectorController.remove);
router.post('/:connectorId/validate', permission('connectors', 'view'), connectorController.validate);
router.get('/:connectorId/rows', permission('connectors', 'view'), connectorController.listRows);
router.post('/:connectorId/preview', permission('connectors', 'preview'), upload.single('file'), connectorController.previewCsv);
router.post('/:connectorId/sync', permission('connectors', 'sync'), upload.single('file'), connectorController.syncCsv);

export default router;
