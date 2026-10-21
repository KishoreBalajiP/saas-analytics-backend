/**
 * /api/v1/workspace membership routes (roadmap 2.10; ten.05, ten.07, ten.12, ten.14).
 *
 * WHY IT EXISTS
 *   Tenant Owners and Admins manage their own workspace: members and their
 *   roles, invitations, custom roles, ownership transfer and deletion. The
 *   platform-admin equivalents stay under `/tenants/:id` (adminAuth).
 *
 * ENDPOINTS (mounted under /workspace)
 *   GET    /members                              users.view
 *   GET    /members/:userId                      users.view
 *   PUT    /members/:userId/roles                roles.assign
 *   POST   /members/:userId/deactivate           users.update
 *   POST   /members/:userId/reactivate           users.update
 *   DELETE /members/:userId                      users.delete
 *   GET    /invitations                          users.create  (history, any status)
 *   POST   /invitations                          users.create
 *   POST   /invitations/:invitationId/resend     users.create
 *   POST   /invitations/:invitationId/revoke     users.update
 *   GET    /roles                                roles.view
 *   GET    /roles/permissions                    roles.view
 *   GET    /roles/:roleId                        roles.view
 *   POST   /roles                                roles.create
 *   PATCH  /roles/:roleId                        roles.update
 *   DELETE /roles/:roleId                        roles.delete
 *   POST   /ownership/transfer                   workspace.transfer (+ Owner, password)
 *   GET    /deletion                             workspace.delete (slug to type, grace period)
 *   POST   /deletion                             workspace.delete (+ Owner, slug, password)
 *
 * MIDDLEWARE ORDER
 *   authenticate -> resolveTenant -> permission(module, action) -> validate -> handler
 *   (the ceiling, last-owner and no-self-modification rules live in the
 *   services, which see the target member and the actor's permissions).
 */

import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { resolveTenant } from '../middleware/tenant.middleware.js';
import { permission } from '../middleware/permission.middleware.js';
import { validate } from '../validators/index.js';
import env from '../config/env.js';
import { createRateLimiter, ipKey } from '../middleware/rateLimiter.middleware.js';
import v from '../validators/workspaceMembers.validator.js';
import invitationValidator from '../validators/invitation.validator.js';
import controller from '../controllers/workspaceMembers.controller.js';
import invitationController from '../controllers/invitation.controller.js';

const router = Router();

// Password re-entry (step-up) on the destructive routes is a password
// oracle; cap guesses per signed-in user (runs after authenticate).
const stepUpLimiter = createRateLimiter({
  name: 'user-step-up',
  windowMs: env.security.authRateLimit.windowMs,
  limit: env.security.authRateLimit.passwordMax,
  keyGenerator: (req) => (req.user?.id ? `user:${req.user.id}` : ipKey(req)),
});

// Members
router.get('/members', authenticate, resolveTenant, permission('users', 'view'), validate(v.listMembersSchema), controller.listMembers);
router.get('/members/:userId', authenticate, resolveTenant, permission('users', 'view'), validate(v.memberParamSchema), controller.getMember);
router.put('/members/:userId/roles', authenticate, resolveTenant, permission('roles', 'assign'), validate(v.setRolesSchema), controller.setMemberRoles);
router.post('/members/:userId/deactivate', authenticate, resolveTenant, permission('users', 'update'), validate(v.statusChangeSchema), controller.deactivateMember);
router.post('/members/:userId/reactivate', authenticate, resolveTenant, permission('users', 'update'), validate(v.statusChangeSchema), controller.reactivateMember);
router.delete('/members/:userId', authenticate, resolveTenant, permission('users', 'delete'), validate(v.memberParamSchema), controller.removeMember);

// Invitations
router.get('/invitations', authenticate, resolveTenant, permission('users', 'create'), validate(v.listInvitationsSchema), controller.listInvitations);
router.post('/invitations', authenticate, resolveTenant, permission('users', 'create'), validate(invitationValidator.tenantCreateSchema), invitationController.createForTenantUser);
router.post('/invitations/:invitationId/resend', authenticate, resolveTenant, permission('users', 'create'), validate(v.invitationParamSchema), controller.resendInvitation);
router.post('/invitations/:invitationId/revoke', authenticate, resolveTenant, permission('users', 'update'), validate(v.invitationParamSchema), controller.revokeInvitation);

// Roles (`/roles/permissions` before `/roles/:roleId`)
router.get('/roles', authenticate, resolveTenant, permission('roles', 'view'), controller.listRoles);
router.get('/roles/permissions', authenticate, resolveTenant, permission('roles', 'view'), controller.listPermissionCatalogue);
router.get('/roles/:roleId', authenticate, resolveTenant, permission('roles', 'view'), validate(v.roleParamSchema), controller.getRole);
router.post('/roles', authenticate, resolveTenant, permission('roles', 'create'), validate(v.createRoleSchema), controller.createRole);
router.patch('/roles/:roleId', authenticate, resolveTenant, permission('roles', 'update'), validate(v.updateRoleSchema), controller.updateRole);
router.delete('/roles/:roleId', authenticate, resolveTenant, permission('roles', 'delete'), validate(v.roleParamSchema), controller.deleteRole);

// Ownership and deletion (Owner only; password re-entry)
router.post('/ownership/transfer', authenticate, resolveTenant, stepUpLimiter, permission('workspace', 'transfer'), validate(v.transferOwnershipSchema), controller.transferWorkspaceOwnership);
router.get('/deletion', authenticate, resolveTenant, permission('workspace', 'delete'), controller.getWorkspaceDeletion);
router.post('/deletion', authenticate, resolveTenant, stepUpLimiter, permission('workspace', 'delete'), validate(v.requestDeletionSchema), controller.requestWorkspaceDeletion);

export default router;
