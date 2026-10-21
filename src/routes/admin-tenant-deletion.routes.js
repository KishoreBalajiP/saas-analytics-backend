/**
 * /api/v1/admin/tenant-deletions routes (roadmap 2.10, ten.14).
 *
 * WHY IT EXISTS
 *   Platform admins review every workspace deletion (scheduled, purging,
 *   purged with its verification report, failed, cancelled). Cancelling a
 *   scheduled deletion is `POST /tenants/:id/deletion/cancel`.
 *
 * ENDPOINTS
 *   - GET /   paginated deletions (filter by status / tenantId)   iam.tenants.view
 *
 * MIDDLEWARE ORDER
 *   adminAuth -> permission('iam.tenants', 'view') -> adminScope.platform() -> validate -> handler
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { adminScope } from '../middleware/adminScope.middleware.js';
import { validate } from '../validators/index.js';
import { adminListDeletionsSchema } from '../validators/workspaceMembers.validator.js';
import tenantDeletionController from '../controllers/tenantDeletion.controller.js';

const router = Router();

router.get('/', adminAuth, permission('iam.tenants', 'view'), adminScope.platform(), validate(adminListDeletionsSchema), tenantDeletionController.listDeletions);

export default router;
