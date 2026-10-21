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
 *   health                    /health                  (Phase 1, liveness/readiness)
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

// Phase 5 - analytics
import analyticsRoutes from './analytics.routes.js';

// Sprint 9 - External API + API Keys + Embed
import apiKeyRoutes from './api-key.routes.js';
import externalApiRoutes from './externalApi.routes.js';

// Phase 1.2 - platform management surface
import adminAuthRoutes from './admin-auth.routes.js';
import platformDashboardRoutes from './platform-dashboard.routes.js';
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
import alertRoutes from './alert.routes.js';
import supportRoutes from './support.routes.js';
import invitationRoutes from './invitation.routes.js';
import accessRequestRoutes from './access-request.routes.js';

// Phase 6 - Workspace subscription / entitlement self-service
// (workspace auth, not the platform-admin /tenants surface).
import subscriptionRoutes from './subscription.routes.js';

// Phase 6 - Platform Admin plan / subscription / entitlement surface.
import adminPlanRoutes from './admin-plan.routes.js';
import adminSubscriptionRoutes from './admin-subscription.routes.js';
import adminEntitlementRoutes from './admin-entitlement.routes.js';
import billingWebhookRoutes from './billing-webhook.routes.js';

// Phase 1 roadmap 1.2 - workspace self-service settings (time zone).
import workspaceSettingsRoutes from './workspace-settings.routes.js';
// rls: dataset grants, row-level security rules, user attributes.
import dataAccessRoutes from './data-access.routes.js';
// mfa-tenant: workspace security policy and Owner-assisted MFA reset.
import workspaceSecurityRoutes from './workspace-security.routes.js';

// reports: roadmap 1.5 - signed artefact downloads (report runs, analytics exports).
import fileRoutes from './file.routes.js';

// members: workspace members, roles, ownership and deletion (roadmap 2.10).
import workspaceMembersRoutes from './workspace-members.routes.js';
import adminTenantDeletionRoutes from './admin-tenant-deletion.routes.js';

// support: workspace consent for support access + the support session itself (roadmap 2.3).
import workspaceSupportRoutes from './workspace-support.routes.js';
import supportSessionRoutes from './support-session.routes.js';

// detection: platform security alerts (roadmap 2.6).
import securityAlertRoutes from './security-alert.routes.js';

// ai-catalogue: metric definitions (roadmap 4.A1).
import metricRoutes from './metric.routes.js';

// ai-ask: natural-language analytics (roadmap 4.A2).
import aiRoutes from './ai.routes.js';

// ai-insights: deterministic insights feed (roadmap 4.A3).
import insightRoutes from './insight.routes.js';

// observability: /metrics, /status, /client-errors (roadmap 2.8).
import observabilityRoutes from './observability.routes.js';

// backups: tenant data export (roadmap 2.9).
import workspaceDataExportRoutes from './workspace-data-export.routes.js';
import tenantDataExportRoutes from './tenant-data-export.routes.js';
import dataExportDownloadRoutes from './data-export-download.routes.js';

// delivery: roadmap 3.4 - destinations, delivery history, unsubscribe.
import deliveryRoutes from './delivery.routes.js';

const router = Router();

// Phase 1 - retained mounts (kept first for stability)
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/connectors', connectorRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/embed', embedRoutes);
router.use('/webhooks', webhookRoutes);

// Sprint 9 - External API + API Keys
router.use('/api-keys', apiKeyRoutes);
// devapi: versioned mount (documented); `/external` stays as the legacy alias.
router.use('/external/v1', externalApiRoutes);
router.use('/external', externalApiRoutes);

// Phase 1.2 - Platform Management surface (admin + tenant portals share
// the same backend; RBAC differentiates the two).
router.use('/admin-auth', adminAuthRoutes);
router.use('/admin/dashboard', platformDashboardRoutes);
router.use('/admin', adminRoutes);
router.use('/tenants', tenantRoutes);
// backups: platform tenant export routes must precede the `/tenants/:id`
// workspace subscription router (its router-level authenticate rejects
// admin tokens).
router.use('/tenants/:id/data-exports', tenantDataExportRoutes);
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
router.use('/alerts', alertRoutes);
router.use('/support', supportRoutes);
router.use('/invitations', invitationRoutes);
router.use('/access-requests', accessRequestRoutes);

// Phase 6 - Workspace subscription / entitlement self-service
// (workspace auth, not the platform-admin /tenants surface).
router.use('/tenants/:id', subscriptionRoutes);

// Phase 6 - Platform Admin plan / subscription / entitlement surface.
router.use('/admin/plans', adminPlanRoutes);
router.use('/admin/subscriptions', adminSubscriptionRoutes);
router.use('/admin/entitlements', adminEntitlementRoutes);
router.use('/billing/webhook', billingWebhookRoutes);

// Phase 1 roadmap 1.2 - workspace self-service settings (time zone).
router.use('/workspace/settings', workspaceSettingsRoutes);
// rls: dataset access and row-level security administration.
router.use('/data-access', dataAccessRoutes);
// mfa-tenant: workspace security (MFA policy, member MFA status and reset).
router.use('/workspace/security', workspaceSecurityRoutes);

// detection: platform security alerts (roadmap 2.6).
router.use('/admin/security-alerts', securityAlertRoutes);

// support: workspace consent for support access + the support session itself (roadmap 2.3).
router.use('/workspace/support-access', workspaceSupportRoutes);
router.use('/support-session', supportSessionRoutes);

// members: workspace members, roles, ownership and deletion (roadmap 2.10).
router.use('/workspace', workspaceMembersRoutes);
router.use('/admin/tenant-deletions', adminTenantDeletionRoutes);

// reports: roadmap 1.5 - signed artefact downloads (token-gated, no session).
router.use('/files', fileRoutes);

// delivery: roadmap 3.4
router.use('/delivery', deliveryRoutes);

// backups: tenant data export (roadmap 2.9).
router.use('/workspace/data-exports', workspaceDataExportRoutes);
router.use('/data-exports', dataExportDownloadRoutes);

// observability: /metrics (token), /status (public), /client-errors (public).
router.use('/', observabilityRoutes);

// ai-insights: deterministic insights feed (roadmap 4.A3).
router.use('/insights', insightRoutes);

// ai-ask: natural-language analytics (roadmap 4.A2).
router.use('/ai', aiRoutes);

// ai-catalogue: metric definitions (roadmap 4.A1).
router.use('/metrics', metricRoutes);

export default router;
