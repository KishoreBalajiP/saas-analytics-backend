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
 *   - GET    /:connectorId/sync-runs   - sync history (paginated; `status` filter)
 *   - POST   /:connectorId/preview     - CSV/XLSX header/sample preview (multipart `file`)
 *   - POST   /:connectorId/sync        - enqueue CSV/XLSX sync (multipart `file`)
 *   - POST   /:connectorId/sync-mongodb - enqueue a MongoDB pull sync
 *
 * UPLOADS
 *   `connectorFileUpload` sniffs the content and rejects oversize files with
 *   413 FILE_TOO_LARGE and unsupported / mismatched types with 415
 *   UNSUPPORTED_FILE_TYPE / FILE_TYPE_MISMATCH before any parsing.
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
import { connectorFileUpload } from '../middleware/upload.middleware.js';
import connectorController from '../controllers/connector.controller.js';

const router = Router();

// Auth + tenant resolution are inlined per route (in this exact order) so that:
//   (a) the `ci:check-routes` guard can see an auth guard on every endpoint, and
//   (b) middleware order is preserved: `authenticate` attaches `req.user`,
//       `resolveTenant` then reads `req.user.tenantId` (JWT claim) as a fallback
//       to the `X-Tenant-Id` header.
router.get('/types', authenticate, resolveTenant, permission('connectors', 'view'), connectorController.listTypes);
router.get('/', authenticate, resolveTenant, permission('connectors', 'view'), connectorController.list);
router.post('/', authenticate, resolveTenant, permission('connectors', 'create'), connectorController.create);
router.get('/:connectorId', authenticate, resolveTenant, permission('connectors', 'view'), connectorController.getById);
router.patch('/:connectorId', authenticate, resolveTenant, permission('connectors', 'update'), connectorController.update);
router.delete('/:connectorId', authenticate, resolveTenant, permission('connectors', 'delete'), connectorController.remove);
router.post('/:connectorId/validate', authenticate, resolveTenant, permission('connectors', 'view'), connectorController.validate);
router.get('/:connectorId/rows', authenticate, resolveTenant, permission('connectors', 'view'), connectorController.listRows);
// datasets: typed dataset schema.
router.get('/:connectorId/schema', authenticate, resolveTenant, permission('connectors', 'view'), connectorController.getSchema);
router.post('/:connectorId/schema/refresh', authenticate, resolveTenant, permission('connectors', 'sync'), connectorController.refreshSchema);
router.get('/:connectorId/discover', authenticate, resolveTenant, permission('connectors', 'view'), connectorController.discover);
router.get('/:connectorId/sync-runs', authenticate, resolveTenant, permission('connectors', 'view'), connectorController.listSyncRuns);
// One registration per public path. The service dispatches CSV/XLSX behavior
// from the persisted connector type; duplicate Express registrations would
// shadow XLSX requests behind the first CSV handler.
router.post('/:connectorId/preview', authenticate, resolveTenant, permission('connectors', 'preview'), connectorFileUpload, connectorController.previewFile);
router.post('/:connectorId/sync', authenticate, resolveTenant, permission('connectors', 'sync'), connectorFileUpload, connectorController.syncFile);
router.post('/:connectorId/sync-mongodb', authenticate, resolveTenant, permission('connectors', 'sync'), connectorController.syncMongoDB);

export default router;
