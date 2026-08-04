/**
 * Dashboard Service (architecture placeholder).
 *
 * PURPOSE
 *   Business logic for dashboard authoring + sharing + caching.
 *
 * RESPONSIBILITY (planned, NOT implemented)
 *   - listDashboards, createDashboard, getDashboard
 *   - updateDashboard (creates a new version)
 *   - publish, share, revokeShare, deleteDashboard
 *
 * CODING GUIDELINES
 *   - Versioning is append-only; never mutate a published version.
 *   - Reads cache by `(tenantId, dashboardId, version)` with TTL 60s.
 *   - Cache invalidated on share/revoke (separate key per visibility).
 */

import ApiError from '../utils/ApiError.js';
import { notImplementedStub } from '../utils/stubs.js';

export const list = notImplementedStub('dashboard.service', 'list');
export const create = notImplementedStub('dashboard.service', 'create');
export const getById = notImplementedStub('dashboard.service', 'getById');
export const update = notImplementedStub('dashboard.service', 'update');
export const publish = notImplementedStub('dashboard.service', 'publish');
export const share = notImplementedStub('dashboard.service', 'share');
export const revokeShare = notImplementedStub('dashboard.service', 'revokeShare');
export const remove = notImplementedStub('dashboard.service', 'remove');

export default {
  list, create, getById, update, publish, share, revokeShare, remove,
  _meta: { appendOnlyVersions: true },
};
