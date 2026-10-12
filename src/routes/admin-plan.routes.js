/**
 * /api/v1/admin/plans routes (Phase 6 - implemented).
 *
 * PURPOSE
 *   Platform-admin plan catalogue surface. Mounted under `/admin/plans`.
 *
 * ENDPOINTS
 *   - GET    /                  list plans (adminAuth + billing.plans.view)
 *   - GET    /:id               plan detail (adminAuth + billing.plans.view)
 *   - POST   /                  create plan (adminAuth + billing.plans.create)
 *   - PATCH  /:id               update plan (adminAuth + billing.plans.update)
 *   - POST   /:id/archive       archive plan (adminAuth + billing.plans.archive)
 *   - POST   /:id/disable       disable plan (adminAuth + billing.plans.update)
 *   - POST   /:id/enable        enable plan (adminAuth + billing.plans.update)
 *   - POST   /ensure-defaults   idempotent seed (adminAuth + billing.plans.create)
 *
 * SECURITY
 *   - All routes require `adminAuth` AND a `billing.plans.*` permission.
 *   - The middleware order is `adminAuth -> permission(...) -> validate -> handler`.
 *   - Workspace APIs do not mount this router; only the platform-admin
 *     surface reaches it.
 *   - The `ci:routes-exempt` annotation sits on the `router.<verb>(`
 *     line itself so the `check-routes` CI guard sees it inside the
 *     captured args; the file-level `adminAuth` is the auth gate.
 */

import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import planValidator from '../validators/plan.validator.js';
import adminPlanController from '../controllers/adminPlan.controller.js';

const router = Router();
router.use(adminAuth);

router.get( // ci:routes-exempt: adminAuth above
  '/',
  permission('billing.plans', 'view'),
  validate(planValidator.listSchema),
  adminPlanController.listPlans,
);

router.get( // ci:routes-exempt: adminAuth above
  '/:id',
  permission('billing.plans', 'view'),
  validate(planValidator.idParamSchema),
  adminPlanController.getPlan,
);

router.post( // ci:routes-exempt: adminAuth above
  '/',
  permission('billing.plans', 'create'),
  validate(planValidator.createSchema),
  adminPlanController.createPlan,
);

router.patch( // ci:routes-exempt: adminAuth above
  '/:id',
  permission('billing.plans', 'update'),
  validate({ ...planValidator.updateSchema, params: planValidator.updateSchema.params }),
  adminPlanController.updatePlan,
);

router.post( // ci:routes-exempt: adminAuth above
  '/:id/archive',
  permission('billing.plans', 'archive'),
  validate(planValidator.idParamSchema),
  adminPlanController.archivePlan,
);

router.post( // ci:routes-exempt: adminAuth above
  '/:id/disable',
  permission('billing.plans', 'update'),
  validate(planValidator.idParamSchema),
  adminPlanController.disablePlan,
);

router.post( // ci:routes-exempt: adminAuth above
  '/:id/enable',
  permission('billing.plans', 'update'),
  validate(planValidator.idParamSchema),
  adminPlanController.enablePlan,
);

router.post( // ci:routes-exempt: adminAuth above
  '/ensure-defaults',
  permission('billing.plans', 'create'),
  adminPlanController.ensureDefaults,
);

export default router;
