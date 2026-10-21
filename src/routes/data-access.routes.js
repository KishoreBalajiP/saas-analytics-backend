/**
 * /api/v1/data-access routes (roadmap 4.E4, rls): dataset grants, row-level
 * security rules, user attributes and preview-as-user.
 *
 * ENDPOINTS
 *   - GET    /datasets/:connectorId                 access + rules     data_access.view
 *   - PUT    /datasets/:connectorId                 { restricted, grants }  data_access.configure
 *   - POST   /datasets/:connectorId/policies        { field, op, attribute } data_access.configure
 *   - DELETE /policies/:policyId                                        data_access.configure
 *   - GET    /users/:userId/attributes                                  data_access.view
 *   - PUT    /users/:userId/attributes              { attributes }      data_access.configure
 *   - POST   /preview                               { userId, query }   data_access.configure
 *
 * Bodies are validated strictly by `dataAccess.service` (field errors, 400).
 * DEPENDS: billing requireFeature(row_level_security) to be added at
 * integration (not shimmed).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import controller from '../controllers/dataAccess.controller.js';
// billing: changing row-level security needs a plan with row_level_security
// (existing rules keep being enforced when a plan lapses).
import { requireFeature } from '../middleware/requireFeature.middleware.js';

const router = Router();

router.get('/datasets/:connectorId', authenticate, resolveTenant, permission('data_access', 'view'), controller.getDataset);
router.put('/datasets/:connectorId', authenticate, resolveTenant, permission('data_access', 'configure'), requireFeature('row_level_security'), controller.setDataset);
router.post('/datasets/:connectorId/policies', authenticate, resolveTenant, permission('data_access', 'configure'), requireFeature('row_level_security'), controller.addPolicy);
router.delete('/policies/:policyId', authenticate, resolveTenant, permission('data_access', 'configure'), requireFeature('row_level_security'), controller.removePolicy);
router.get('/users/:userId/attributes', authenticate, resolveTenant, permission('data_access', 'view'), controller.getAttributes);
router.put('/users/:userId/attributes', authenticate, resolveTenant, permission('data_access', 'configure'), requireFeature('row_level_security'), controller.setAttributes);
router.post('/preview', authenticate, resolveTenant, permission('data_access', 'configure'), requireFeature('row_level_security'), controller.preview);

export default router;
