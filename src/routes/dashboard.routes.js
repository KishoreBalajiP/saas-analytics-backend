/**
 * /api/v1/dashboards routes (Sprint 6 - implemented).
 *
 * WHY IT EXISTS
 *   Tenant-scoped dashboard + widget authoring and widget analytics
 *   execution over ingested connector rows. Backed by
 *   `services/dashboard.service.js` which delegates aggregation to the
 *   analytics engine.
 *
 * ENDPOINTS
 *   - GET    /                           list            dashboards.view
 *   - POST   /                           create          dashboards.create
 *   - GET    /:id                        detail+widgets  dashboards.view
 *   - PATCH  /:id                        update          dashboards.update
 *   - POST   /:id/publish                publish         dashboards.update
 *   - POST   /:id/duplicate              duplicate       dashboards.update
 *   - POST   /:id/share                  grant share     dashboards.update
 *   - DELETE /:id/share/:entryId         revoke share    dashboards.update
 *   - DELETE /:id                        soft-delete     dashboards.delete
 *   - GET    /:id/widgets                list widgets    dashboards.view
 *   - POST   /:id/widgets                create widget   dashboards.update
 *   - GET    /:id/widgets/:widgetId      get widget      dashboards.view
 *   - PATCH  /:id/widgets/:widgetId      update widget   dashboards.update
 *   - DELETE /:id/widgets/:widgetId      delete widget   dashboards.update
 *   - GET    /:id/execute                run dashboard   dashboards.view + analytics.view
 *   - GET    /:id/widgets/:widgetId/execute  run widget  dashboards.view + analytics.view
 *
 * RBAC
 *   Widget reads and execution sit under the `dashboards` module. Running a
 *   widget also requires `analytics.view` because execution hits the
 *   analytics engine - so a role cannot view data through a dashboard
 *   unless it can view analytics too (both default roles carry both).
 *
 * MIDDLEWARE ORDER
 *   authenticate -> resolveTenant -> permission(...) -> [validate] -> handler
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import dashboardValidator from '../validators/dashboard.validator.js';
import dashboardController from '../controllers/dashboard.controller.js';

const router = Router();

const guarded = (action, ...mw) => [authenticate, resolveTenant, permission('dashboards', action), ...mw];

router.get('/', guarded('view', validate(dashboardValidator.dashboardListSchema)), dashboardController.listDashboards);
router.post('/', guarded('create', validate(dashboardValidator.dashboardCreateSchema)), dashboardController.createDashboard);
router.get('/:id', guarded('view'), dashboardController.getDashboard);
router.patch('/:id', guarded('update', validate(dashboardValidator.dashboardUpdateSchema)), dashboardController.updateDashboard);
router.post('/:id/publish', guarded('update'), dashboardController.publishDashboard);
router.post('/:id/duplicate', guarded('update'), dashboardController.duplicateDashboard);
router.post('/:id/share', guarded('update', validate(dashboardValidator.shareSchema)), dashboardController.shareDashboard);
router.delete('/:id/share/:entryId', guarded('update'), dashboardController.revokeShare);
router.delete('/:id', guarded('delete'), dashboardController.deleteDashboard);

router.get('/:id/widgets', guarded('view', validate(dashboardValidator.widgetListSchema)), dashboardController.listWidgets);
router.post('/:id/widgets', guarded('update', validate(dashboardValidator.widgetCreateSchema)), dashboardController.createWidget);
router.get('/:id/widgets/:widgetId', guarded('view'), dashboardController.getWidget);
router.patch('/:id/widgets/:widgetId', guarded('update', validate(dashboardValidator.widgetUpdateSchema)), dashboardController.updateWidget);
router.delete('/:id/widgets/:widgetId', guarded('update'), dashboardController.removeWidget);

router.get('/:id/execute', [authenticate, resolveTenant, permission('dashboards', 'view'), permission('analytics', 'view')], dashboardController.executeDashboard);
router.get(
  '/:id/widgets/:widgetId/execute',
  [authenticate, resolveTenant, permission('dashboards', 'view'), permission('analytics', 'view'), validate(dashboardValidator.widgetExecuteSchema)],
  dashboardController.executeWidget,
);

export default router;
