/**
 * Admin Service (architecture placeholder).
 *
 * PURPOSE
 *   Business logic for Platform Admin authentication + lifecycle. Backs
 *   the `/admin` and `/admin-auth` HTTP surfaces and orchestrates
 *   `repositories/admin.repository.js`.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - login(email, password, mfaToken?)
 *   - refresh(refreshTokenHash)
 *   - logout(sessionId)
 *   - createAdmin({ email, adminType, ...})
 *   - suspendAdmin, restoreAdmin
 *   - assignRoleToAdmin, revokeRoleFromAdmin
 *
 * CODING GUIDELINES
 *   - Throw `ApiError` factories for all expected failures.
 *   - Never log secrets; redact emails/PII in service logs.
 *   - All state changes emit a domain event the audit middleware records.
 *
 * FUTURE EXTENSION
 *   - SCIM 2.0 provisioning, IP allow-lists, on-call schedules.
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const login = notImplementedStub('admin.service', 'login');
export const refresh = notImplementedStub('admin.service', 'refresh');
export const logout = notImplementedStub('admin.service', 'logout');
export const list = notImplementedStub('admin.service', 'list');
export const create = notImplementedStub('admin.service', 'create');
export const getById = notImplementedStub('admin.service', 'getById');
export const update = notImplementedStub('admin.service', 'update');
export const suspend = notImplementedStub('admin.service', 'suspend');
export const restore = notImplementedStub('admin.service', 'restore');
export const assignRole = notImplementedStub('admin.service', 'assignRole');
export const revokeRole = notImplementedStub('admin.service', 'revokeRole');

export default {
  login, refresh, logout, list, create,
  getById, update, suspend, restore, assignRole, revokeRole,
  _meta: { throwIfNoImplementation: true },
};
