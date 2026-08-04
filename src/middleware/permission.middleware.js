/**
 * permission.middleware.js (architecture placeholder).
 *
 * PURPOSE
 *   Fine-grained RBAC. Checks that the actor has the (module, action)
 *   permission that the route declares.
 *
 * STATIC MODE
 *   ```
 *   router.get('/dashboards/:id',
 *     permission('analytics', 'view'),
 *     dashboardController.getById);
 *   ```
 *
 * DYNAMIC MODE
 *   The module/action can also be a function so per-resource checks
 *   (e.g. tenant-scoped permission on the requested tenant) work:
 *   ```
 *   router.get('/tenants/:tenantId/users',
 *     permission(req => ['tenants', 'view']),
 *     userController.list);
 *   ```
 *
 * RESPONSIBILITY (planned, NO implementation yet)
 *   - Read declared (module, action) for the route.
 *   - Look up cached actor permissions.
 *   - Refuse 403 on absence.
 *
 * PHASE 1.2 BEHAVIOUR
 *   Fails closed with 501 when invoked. Routes do not mount this yet.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

/**
 * Permission factory. Accepts either:
 *   - `permission('analytics', 'view')`
 *   - `permission(req => ['analytics', 'view'])`
 * Phase 1.2: always returns a fail-closed middleware.
 */
export const permission = notImplementedStub('middleware.permission');

/** Inverse helper: deny list (returns 403 if actor DOES have permission). */
export const denyIf = notImplementedStub('middleware.denyIf');

export default {
  permission,
  denyIf,
  _meta: {
    phase: '1.2 - fail-closed placeholder',
    runOrder: 'after rbac / modulePermission',
  },
};
