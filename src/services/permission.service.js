/**
 * Permission Service (architecture placeholder).
 *
 * PURPOSE
 *   Business logic for dynamic RBAC primitives: modules, actions,
 *   permissions, and the lookup `actorHasPermission(actor, moduleKey,
 *   action)`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listModules, createModule, getModuleActions
 *   - listPermissions, createPermission, bulkCreatePermissions,
 *     deletePermission
 *   - resolveActorPermissions(actorId, scope)
 *
 * CODING GUIDELINES
 *   - Permission keys MUST be `<module_key>.<action>`. Service enforces
 *     the shape even though validators do too.
 *   - `resolveActorPermissions` is the HOT path; cache result per actor
 *     for 60s.
 *   - Module registration fan-out invalidates every `iam:rbac:*` key.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const listModules = notImplementedStub('permission.service', 'listModules');
export const createModule = notImplementedStub('permission.service', 'createModule');
export const getModuleActions = notImplementedStub('permission.service', 'getModuleActions');
export const listPermissions = notImplementedStub('permission.service', 'listPermissions');
export const createPermission = notImplementedStub('permission.service', 'createPermission');
export const bulkCreatePermissions = notImplementedStub('permission.service', 'bulkCreatePermissions');
export const deletePermission = notImplementedStub('permission.service', 'deletePermission');
export const resolveActorPermissions = notImplementedStub('permission.service', 'resolveActorPermissions');

export default {
  listModules, createModule, getModuleActions,
  listPermissions, createPermission, bulkCreatePermissions,
  deletePermission, resolveActorPermissions,
  _meta: { invalidatesCache: 'iam:rbac:*' },
};
