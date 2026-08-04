/**
 * rbac.middleware.js (architecture placeholder).
 *
 * PURPOSE
 *   Coarse-grained role-based access control. Verifies that the caller
 *   has AT LEAST ONE role assigned. Must run AFTER `adminAuth` (or
 *   tenant `auth`) - it relies on `req.actor = { id, type }`.
 *
 * RESPONSIBILITY (planned, NO implementation yet)
 *   - Load the actor's roles from cache (`iam:rbac:<scope>`).
 *   - On miss, resolve via `services/permission.service#resolveActorPermissions`.
 *   - Refuse with 403 if the actor has zero roles.
 *
 * PHASE 1.2 BEHAVIOUR
 *   Fails closed with 501 when invoked. Routes do not mount this yet.
 *
 * USAGE (Phase 2 sketch)
 *   router.use(adminAuth, rbac.requireRole());
 *   router.get('/admin/admins', rbac.requireRole('super', 'platform'),
 *     controller.listAdmins);
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

/** Require the actor to have ANY role (optionally a specific role name). */
export const requireRole = notImplementedStub('middleware.rbac.requireRole');

/** Require a specific admin type (`super` | `platform` | `support`). */
export const requireAdminType = notImplementedStub('middleware.rbac.requireAdminType');

export default {
  requireRole,
  requireAdminType,
  _meta: {
    phase: '1.2 - fail-closed placeholder',
    runOrder: 'after adminAuth / auth, before permission / modulePermission',
  },
};
