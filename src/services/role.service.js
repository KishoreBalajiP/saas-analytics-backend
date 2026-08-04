/**
 * Role Service (architecture placeholder).
 *
 * PURPOSE
 *   Business logic for dynamic role management. Composes roles from
 *   permissions, validates assignments, and invalidates the rbac cache.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listRoles(scope), createRole, getRole, updateRole, deleteRole
 *   - addPermission, removePermission
 *
 * CODING GUIDELINES
 *   - System-defined roles are immutable; throws 409 on edit/delete.
 *   - Deleting a role checks live assignments; throws 409 if used.
 *   - Mutations must invalidate `iam:rbac:<scope>` via `src/cache/`.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const list = notImplementedStub('role.service', 'list');
export const create = notImplementedStub('role.service', 'create');
export const getById = notImplementedStub('role.service', 'getById');
export const update = notImplementedStub('role.service', 'update');
export const remove = notImplementedStub('role.service', 'remove');
export const addPermission = notImplementedStub('role.service', 'addPermission');
export const removePermission = notImplementedStub('role.service', 'removePermission');

export default {
  list, create, getById, update, remove,
  addPermission, removePermission,
  _meta: { invalidatesCache: 'iam:rbac:<scope>' },
};
