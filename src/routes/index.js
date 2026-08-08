/**
 * API route aggregator.
 *
 * WHY IT EXISTS
 *   Single place that mounts every API router under `/api/v1`, so
 *   `app.js` stays tiny and feature teams touch only their own router
 *   file. Adding a new module is a one-line change here.
 *
 * RESPONSIBILITY
 *   Combine feature routers. Phase 1.2 surface:
 *
 *   auth                      /auth                    (Phase 1, tenant login)
 *   admin-auth                /admin-auth              (Phase 1.2)
 *   admin                     /admin                   (Phase 1.2)
 *   tenant                    /tenants                 (Phase 1.2 - overwritten)
 *   user                      /users                   (Phase 1, placeholder)
 *   role                      /roles                   (Phase 1.2)
 *   permission                /permissions             (Phase 1.2)
 *   master-data               /master-data             (Phase 1.2)
 *   settings                  /settings                (Phase 1.2)
 *   feature-flag              /feature-flags           (Phase 1.2)
 *   monitoring                /monitoring              (Phase 1.2)
 *   audit-log                 /audit-logs              (Phase 1.2)
 *   access-log                /access-logs             (Phase 1.2)
 *   compliance                /compliance              (Phase 1.2)
 *   notification              /notifications           (Phase 1.2)
 *   email-template            /email-templates         (Phase 1.2)
 *   dashboard                 /dashboards              (Phase 1.2 - overwritten)
 *   report                    /reports                 (Phase 1.2)
 *   support                   /support                 (Phase 1.2)
 *   connector                 /connectors              (Phase 1.1)
 *   embed                     /embed                   (Phase 1)
 *   webhook                   /webhooks                (Phase 1 - connector webhook)
 *   health                    /health                  (Phase 1)
 *
 * HOW TO EXTEND
 *   New feature? Create `routes/<name>.routes.js`, implement it under
 *   `src/modules/<name>/`, then add one `router.use('/<name>', ...)`
 *   line here.
 *
 * Phase 1.2 note: auth, admin-auth, admin, roles, permissions, audit-logs
 * and users are implemented (Sprint 2). The remaining Phase 1.2 route
 * handlers still return `501` until their matching service/repo is wired
 * up. Existing tests only verify `/health` and unknown-route 404s, so the
 * surface expansion is non-breaking.
 */

import { Router } from 'express';

import healthRoutes from './health.routes.js';

// Phase 1 - retained
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import embedRoutes from './embed.routes.js';
import webhookRoutes from './webhook.routes.js';

// Phase 1.1 - retained
import connectorRoutes from './connector.routes.js';

// Phase 1.2 - platform management surface
import adminAuthRoutes from './admin-auth.routes.js';
import adminRoutes from './admin.routes.js';
import tenantRoutes from './tenant.routes.js';
import roleRoutes from './role.routes.js';
import permissionRoutes from './permission.routes.js';
import masterDataRoutes from './master-data.routes.js';
import settingsRoutes from './settings.routes.js';
import featureFlagRoutes from './feature-flag.routes.js';
import monitoringRoutes from './monitoring.routes.js';
import auditLogRoutes from './audit-log.routes.js';
import accessLogRoutes from './access-log.routes.js';
import complianceRoutes from './compliance.routes.js';
import notificationRoutes from './notification.routes.js';
import emailTemplateRoutes from './email-template.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import reportRoutes from './report.routes.js';
import supportRoutes from './support.routes.js';

const router = Router();

// Phase 1 - retained mounts (kept first for stability)
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/connectors', connectorRoutes);
router.use('/embed', embedRoutes);
router.use('/webhooks', webhookRoutes);

// Phase 1.2 - Platform Management surface (admin + tenant portals share
// the same backend; RBAC differentiates the two).
router.use('/admin-auth', adminAuthRoutes);
router.use('/admin', adminRoutes);
router.use('/tenants', tenantRoutes);
router.use('/roles', roleRoutes);
router.use('/permissions', permissionRoutes);
router.use('/master-data', masterDataRoutes);
router.use('/settings', settingsRoutes);
router.use('/feature-flags', featureFlagRoutes);
router.use('/monitoring', monitoringRoutes);
router.use('/audit-logs', auditLogRoutes);
router.use('/access-logs', accessLogRoutes);
router.use('/compliance', complianceRoutes);
router.use('/notifications', notificationRoutes);
router.use('/email-templates', emailTemplateRoutes);
router.use('/dashboards', dashboardRoutes);
router.use('/reports', reportRoutes);
router.use('/support', supportRoutes);

export default router;
