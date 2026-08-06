/**
 * Allowlist of files where `notImplementedStub` is permitted.
 *
 * Sprint 0 keeps the fail-closed discipline: every unimplemented surface
 * returns `501` rather than silently passing. As features land, files are
 * removed from this allowlist. The CI guard fails when a new file
 * references `notImplementedStub` without being listed here.
 */

export default [
  // Helper that builds the stubs themselves - exempt.
  'src/utils/stubs.js',

  // Phase 2 middleware stubs (replaced in subsequent sprints)
  'src/middleware/accessLog.middleware.js',
  'src/middleware/audit.middleware.js',
  'src/middleware/compliance.middleware.js',
  'src/middleware/modulePermission.middleware.js',
  'src/middleware/permission.middleware.js',
  'src/middleware/rbac.middleware.js',
  'src/middleware/tenantIsolation.middleware.js',

  // Phase 2 repositories
  'src/repositories/accessLog.repository.js',
  'src/repositories/admin.repository.js',
  'src/repositories/auditLog.repository.js',
  'src/repositories/compliance.repository.js',
  'src/repositories/masterData.repository.js',
  'src/repositories/permission.repository.js',
  'src/repositories/role.repository.js',
  'src/repositories/setting.repository.js',

  // Phase 2 services
  'src/services/accessLog.service.js',
  'src/services/admin.service.js',
  'src/services/auditLog.service.js',
  'src/services/compliance.service.js',
  'src/services/dashboard.service.js',
  'src/services/masterData.service.js',
  'src/services/monitoring.service.js',
  'src/services/notification.service.js',
  'src/services/permission.service.js',
  'src/services/report.service.js',
  'src/services/role.service.js',
  'src/services/setting.service.js',
  'src/services/support.service.js',

  // Phase 2 controllers
  'src/controllers/accessLog.controller.js',
  'src/controllers/auditLog.controller.js',
  'src/controllers/compliance.controller.js',
  'src/controllers/dashboard.controller.js',
  'src/controllers/masterData.controller.js',
  'src/controllers/monitoring.controller.js',
  'src/controllers/notification.controller.js',
  'src/controllers/permission.controller.js',
  'src/controllers/report.controller.js',
  'src/controllers/role.controller.js',
  'src/controllers/setting.controller.js',
  'src/controllers/support.controller.js',
];
