/**
 * Permission Repository (architecture placeholder).
 *
 * PURPOSE
 *   Stable data-access surface for the dynamic RBAC primitives: modules,
 *   actions, permissions, and the actor-permission resolution.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listModules, createModule, findModuleByKey
 *   - listActions, registerAction
 *   - listPermissions({ module, action }), createPermission,
 *     bulkCreatePermissions, deletePermission
 *   - resolvePermissionsForActor(actorId, scope)
 *     -> Set<`module.action`> used by permission.middleware.js
 *
 * CODING GUIDELINES
 *   - Lean returns; Sets are serialised to plain arrays before persistence.
 *   - Permission key MUST be `${moduleKey}.${action}`. Enforced here and
 *     at the validator layer.
 *   - The resolver is hot-path; Phase 3 will back it with a Mongo
 *     aggregation + cache projection.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const listModules = notImplementedStub('permission.repository', 'listModules');
export const createModule = notImplementedStub('permission.repository', 'createModule');
export const findModuleByKey = notImplementedStub('permission.repository', 'findModuleByKey');
export const listActions = notImplementedStub('permission.repository', 'listActions');
export const registerAction = notImplementedStub('permission.repository', 'registerAction');
export const listPermissions = notImplementedStub('permission.repository', 'listPermissions');
export const createPermission = notImplementedStub('permission.repository', 'createPermission');
export const bulkCreatePermissions = notImplementedStub('permission.repository', 'bulkCreatePermissions');
export const deletePermission = notImplementedStub('permission.repository', 'deletePermission');
export const resolvePermissionsForActor = notImplementedStub('permission.repository', 'resolvePermissionsForActor');

export default {
  listModules, createModule, findModuleByKey,
  listActions, registerAction,
  listPermissions, createPermission, bulkCreatePermissions,
  deletePermission, resolvePermissionsForActor,
  _meta: { hotPath: ['resolvePermissionsForActor'] },
};
