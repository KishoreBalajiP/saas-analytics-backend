/**
 * Role Repository (architecture placeholder).
 *
 * PURPOSE
 *   Stable data-access surface for dynamic roles. Lives behind services
 *   so the storage backend can change without ripple.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - findById, list({ scope }), create, update, softDelete
 *   - attachPermission, detachPermission
 *   - countAssignments(roleId)    (used to refuse delete)
 *
 * CODING GUIDELINES
 *   - Lean returns.
 *   - `isSystem: true` rows must NOT be deleted (enforced here).
 *   - All permission-related writes are atomic per role.
 *
 * FUTURE EXTENSION
 *   - Hierarchical roles: child rows reference `parentId`.
 *   - Effective permission resolver delegates here + permission.repo.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const findById = notImplementedStub('role.repository', 'findById');
export const list = notImplementedStub('role.repository', 'list');
export const create = notImplementedStub('role.repository', 'create');
export const update = notImplementedStub('role.repository', 'update');
export const softDelete = notImplementedStub('role.repository', 'softDelete');
export const attachPermission = notImplementedStub('role.repository', 'attachPermission');
export const detachPermission = notImplementedStub('role.repository', 'detachPermission');
export const countAssignments = notImplementedStub('role.repository', 'countAssignments');

export default {
  findById, list, create, update, softDelete,
  attachPermission, detachPermission, countAssignments,
  _meta: { leanReturns: true, systemRolesProtected: true },
};
