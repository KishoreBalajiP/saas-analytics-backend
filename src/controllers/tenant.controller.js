/**
 * Tenant Controller (Sprint 3 - implemented).
 *
 * PURPOSE
 *   HTTP-layer entry for the `/api/v1/tenants` surface: platform-admin
 *   management of the tenancy unit - CRUD, lifecycle, onboarding, members,
 *   billing, statistics and settings.
 *
 * RESPONSIBILITY
 *   - Thin: extract validated input, call the service, shape the response.
 *   - `by` attribution always comes from the authenticated admin token,
 *     never from the request body.
 *
 * CODING GUIDELINES
 *   - All async handlers MUST be wrapped in `asyncHandler`.
 *   - Never call `res.json` directly; use `ApiResponse.<verb>(res, ...)`.
 *   - Handlers never touch repositories; the service layer does that.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import tenantService from '../services/tenant.service.js';

const actor = (req) => req.admin?.id ?? null;

/** POST /tenants - create a tenant (optionally run onboarding in one call). */
export const createTenant = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const result = await tenantService.create({
    tenant: body,
    owner: body.owner,
    initialize: body.initialize === true,
    by: actor(req),
  });
  return ApiResponse.created(res, result.tenant, 'Tenant created');
});

/** GET /tenants - paginated tenant list (platform admin surface). */
export const listTenants = asyncHandler(async (req, res) => {
  const { status, search, page, limit } = req.validated?.query ?? {};
  const result = await tenantService.list({
    filter: { status },
    search,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Tenants fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** GET /tenants/:id - tenant detail. */
export const getTenant = asyncHandler(async (req, res) => {
  const tenant = await tenantService.getById({ id: req.params.id });
  return ApiResponse.ok(res, tenant, 'Tenant fetched');
});

/** PATCH /tenants/:id - update tenant profile fields. */
export const updateTenant = asyncHandler(async (req, res) => {
  const tenant = await tenantService.update({
    id: req.params.id,
    patch: req.validated?.body ?? {},
    by: actor(req),
  });
  return ApiResponse.ok(res, tenant, 'Tenant updated');
});

/** POST /tenants/:id/suspend - block logins + sessions. */
export const suspendTenant = asyncHandler(async (req, res) => {
  const tenant = await tenantService.lifecycle.suspend({
    tenantId: req.params.id,
    reason: req.validated?.body?.reason,
    by: actor(req),
  });
  return ApiResponse.ok(res, tenant, 'Tenant suspended');
});

/** POST /tenants/:id/restore - re-open a suspended/disabled tenant. */
export const restoreTenant = asyncHandler(async (req, res) => {
  const tenant = await tenantService.lifecycle.restore({
    tenantId: req.params.id,
    reason: req.validated?.body?.reason,
    by: actor(req),
  });
  return ApiResponse.ok(res, tenant, 'Tenant restored');
});

/** POST /tenants/:id/disable - longer-term block. */
export const disableTenant = asyncHandler(async (req, res) => {
  const tenant = await tenantService.lifecycle.disable({
    tenantId: req.params.id,
    reason: req.validated?.body?.reason,
    by: actor(req),
  });
  return ApiResponse.ok(res, tenant, 'Tenant disabled');
});

/** POST /tenants/:id/archive - terminal read-only state. */
export const archiveTenant = asyncHandler(async (req, res) => {
  const tenant = await tenantService.lifecycle.archive({
    tenantId: req.params.id,
    reason: req.validated?.body?.reason,
    by: actor(req),
  });
  return ApiResponse.ok(res, tenant, 'Tenant archived');
});

/** POST /tenants/:id/init - run the onboarding sequence. */
export const initializeTenant = asyncHandler(async (req, res) => {
  const result = await tenantService.initialize({
    tenantId: req.params.id,
    owner: req.validated?.body?.owner,
    by: actor(req),
  });
  return ApiResponse.ok(
    res,
    result.tenant,
    result.alreadyInitialized ? 'Tenant already initialized' : 'Tenant initialized',
  );
});

/** GET /tenants/:id/members - paginated users with their roles. */
export const getTenantMembers = asyncHandler(async (req, res) => {
  const { search, page, limit } = req.validated?.query ?? {};
  const result = await tenantService.members({
    tenantId: req.params.id,
    search,
    page: page ?? 1,
    limit: limit ?? 20,
  });
  return ApiResponse.ok(res, result.docs, 'Members fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** GET /tenants/:id/stats - per-tenant activity statistics. */
export const getTenantStats = asyncHandler(async (req, res) => {
  const stats = await tenantService.statistics({ tenantId: req.params.id });
  return ApiResponse.ok(res, stats, 'Tenant statistics fetched');
});

/** GET /tenants/:id/billing - billing facts for the tenant. */
export const getTenantBilling = asyncHandler(async (req, res) => {
  const billing = await tenantService.billing({ tenantId: req.params.id });
  return ApiResponse.ok(res, billing, 'Tenant billing fetched');
});

/** GET /tenants/:id/settings - effective settings (grouped or all). */
export const getTenantSettings = asyncHandler(async (req, res) => {
  const { group, includeSecrets } = req.validated?.query ?? {};
  const settings = await tenantService.settings.getGroup({
    tenantId: req.params.id,
    group,
    includeSecrets: includeSecrets === true,
  });
  return ApiResponse.ok(res, settings, 'Tenant settings fetched');
});

/** PATCH /tenants/:id/settings - upsert tenant settings overrides. */
export const updateTenantSettings = asyncHandler(async (req, res) => {
  const { group, values } = req.validated?.body ?? {};
  const settings = await tenantService.settings.updateGroup({
    tenantId: req.params.id,
    group,
    values,
    by: actor(req),
  });
  return ApiResponse.ok(res, settings, 'Tenant settings updated');
});

/** POST /tenants/:id/owner - reassign the tenant owner. */
export const changeTenantOwner = asyncHandler(async (req, res) => {
  const tenant = await tenantService.changeOwner({
    tenantId: req.params.id,
    userId: req.validated?.body?.userId,
    by: actor(req),
  });
  return ApiResponse.ok(res, tenant, 'Tenant owner changed');
});

export default {
  createTenant,
  listTenants,
  getTenant,
  updateTenant,
  suspendTenant,
  restoreTenant,
  disableTenant,
  archiveTenant,
  initializeTenant,
  getTenantMembers,
  getTenantStats,
  getTenantBilling,
  getTenantSettings,
  updateTenantSettings,
  changeTenantOwner,
};
