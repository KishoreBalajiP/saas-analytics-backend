/**
 * Admin Repository (architecture placeholder).
 *
 * PURPOSE
 *   Stable data-access surface for Platform Admins. Phase 2 will swap the
 *   implementation for a real Mongoose-backed module (see `models/Admin.js`)
 *   without changing any of the consumers (services, controllers).
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - findById, findByEmail, list({ filter, page, pageSize })
 *   - create(doc), update(id, patch), suspend(id, reason), restore(id)
 *   - listRolesForAdmin(adminId), assignRole, revokeRole
 *
 * CODING GUIDELINES
 *   - Always return PLAIN objects (`.lean()`) so services handle data, not
 *     Mongoose documents.
 *   - Keep tenancy out of this repo. Admins are platform-scoped; tenants
 *     model the user side.
 *   - Every mutation function MUST be auditable (id, by, at) - the model
 *     carries `createdBy`, `updatedBy` timestamps.
 *
 * FUTURE EXTENSION
 *   - Cascade delete via sessions + AuditLog write (queued).
 *   - Full-text index on `profile.name` (planned).
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const findById = notImplementedStub('admin.repository', 'findById');
export const findByEmail = notImplementedStub('admin.repository', 'findByEmail');
export const list = notImplementedStub('admin.repository', 'list');
export const create = notImplementedStub('admin.repository', 'create');
export const update = notImplementedStub('admin.repository', 'update');
export const suspend = notImplementedStub('admin.repository', 'suspend');
export const restore = notImplementedStub('admin.repository', 'restore');
export const listRolesForAdmin = notImplementedStub('admin.repository', 'listRolesForAdmin');
export const assignRole = notImplementedStub('admin.repository', 'assignRole');
export const revokeRole = notImplementedStub('admin.repository', 'revokeRole');

export default {
  findById, findByEmail, list, create, update,
  suspend, restore, listRolesForAdmin, assignRole, revokeRole,
  _meta: { leanReturns: true, tenancy: 'platform' },
};
