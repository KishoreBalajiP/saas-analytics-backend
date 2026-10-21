/**
 * Tenant Export Controller (roadmap 2.9).
 *
 * HTTP layer for tenant data exports:
 *   - workspace surface  /api/v1/workspace/data-exports   (tenant from the session)
 *   - platform surface   /api/v1/tenants/:id/data-exports (tenant from the path)
 *   - public download    /api/v1/data-exports/download/:token (signed link)
 *
 * The tenant is never read from the body. Platform admins scoped to one
 * tenant (`tenantScope`) can only act on that tenant.
 */

import { pipeline } from 'node:stream/promises';
import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { getTenantId } from '../middleware/tenant.middleware.js';
import tenantExportService from '../services/tenantExport.service.js';

function workspaceTenant(req) {
  const tenantId = getTenantId(req);
  if (!tenantId) throw ApiError.badRequest('Tenant id is required');
  return String(tenantId);
}

function userActor(req) {
  return { type: 'user', id: req.user?.id, email: req.user?.email ?? null };
}

function adminActor(req) {
  return { type: 'admin', id: req.admin?.id, email: req.admin?.email ?? null };
}

/**
 * Tenant named in a platform route, refused with 403 when the admin is
 * scoped to a different tenant.
 */
function platformTenant(req) {
  const tenantId = String(req.validated?.params?.id ?? req.params.id);
  const scope = req.admin?.tenantId ?? null;
  if (scope && String(scope) !== tenantId) {
    throw ApiError.forbidden('Your administrator access is limited to another tenant');
  }
  return tenantId;
}

function baseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function paging(req) {
  const query = req.validated?.query ?? {};
  return { page: query.page ?? 1, limit: query.limit ?? 20 };
}

/* ------------------------------- workspace ------------------------------- */

/** GET /workspace/data-exports */
export const listWorkspaceExports = asyncHandler(async (req, res) => {
  const { items, meta } = await tenantExportService.listExports({ tenantId: workspaceTenant(req), audience: 'tenant', ...paging(req) });
  return ApiResponse.ok(res, items, 'Data exports', meta);
});

/** POST /workspace/data-exports */
export const requestWorkspaceExport = asyncHandler(async (req, res) => {
  const row = await tenantExportService.requestExport({
    tenantId: workspaceTenant(req),
    origin: 'tenant',
    actor: userActor(req),
    requestId: req.id ?? null,
  });
  return ApiResponse.accepted(res, row, 'Data export requested');
});

/** GET /workspace/data-exports/:exportId */
export const getWorkspaceExport = asyncHandler(async (req, res) => {
  const row = await tenantExportService.getExport({
    tenantId: workspaceTenant(req),
    exportId: req.validated.params.exportId,
    audience: 'tenant',
  });
  return ApiResponse.ok(res, row, 'Data export');
});

/** POST /workspace/data-exports/:exportId/download-url */
export const issueWorkspaceDownloadUrl = asyncHandler(async (req, res) => {
  const link = await tenantExportService.issueDownloadUrl({
    tenantId: workspaceTenant(req),
    exportId: req.validated.params.exportId,
    audience: 'tenant',
    actor: userActor(req),
    baseUrl: baseUrl(req),
    requestId: req.id ?? null,
  });
  res.set('Cache-Control', 'no-store');
  return ApiResponse.ok(res, link, 'Download link issued');
});

/** DELETE /workspace/data-exports/:exportId - delete the archive now. */
export const revokeWorkspaceExport = asyncHandler(async (req, res) => {
  const row = await tenantExportService.revokeExport({
    tenantId: workspaceTenant(req),
    exportId: req.validated.params.exportId,
    audience: 'tenant',
    actor: userActor(req),
    requestId: req.id ?? null,
  });
  return ApiResponse.ok(res, row, 'Data export deleted');
});

/* -------------------------------- platform ------------------------------- */

/** GET /tenants/:id/data-exports */
export const listTenantExports = asyncHandler(async (req, res) => {
  const { items, meta } = await tenantExportService.listExports({ tenantId: platformTenant(req), audience: 'platform', ...paging(req) });
  return ApiResponse.ok(res, items, 'Data exports', meta);
});

/** POST /tenants/:id/data-exports */
export const requestTenantExport = asyncHandler(async (req, res) => {
  const row = await tenantExportService.requestExport({
    tenantId: platformTenant(req),
    origin: 'platform',
    actor: adminActor(req),
    reason: req.validated.body.reason,
    requestId: req.id ?? null,
  });
  return ApiResponse.accepted(res, row, 'Data export requested');
});

/** GET /tenants/:id/data-exports/:exportId */
export const getTenantExport = asyncHandler(async (req, res) => {
  const row = await tenantExportService.getExport({
    tenantId: platformTenant(req),
    exportId: req.validated.params.exportId,
    audience: 'platform',
  });
  return ApiResponse.ok(res, row, 'Data export');
});

/** POST /tenants/:id/data-exports/:exportId/download-url */
export const issueTenantDownloadUrl = asyncHandler(async (req, res) => {
  const link = await tenantExportService.issueDownloadUrl({
    tenantId: platformTenant(req),
    exportId: req.validated.params.exportId,
    audience: 'platform',
    actor: adminActor(req),
    baseUrl: baseUrl(req),
    requestId: req.id ?? null,
  });
  res.set('Cache-Control', 'no-store');
  return ApiResponse.ok(res, link, 'Download link issued');
});

/** DELETE /tenants/:id/data-exports/:exportId - delete the archive now. */
export const revokeTenantExport = asyncHandler(async (req, res) => {
  const row = await tenantExportService.revokeExport({
    tenantId: platformTenant(req),
    exportId: req.validated.params.exportId,
    audience: 'platform',
    actor: adminActor(req),
    requestId: req.id ?? null,
  });
  return ApiResponse.ok(res, row, 'Data export deleted');
});

/* --------------------------------- public -------------------------------- */

/** GET /data-exports/download/:token - streams the archive (signed link). */
export const downloadExport = asyncHandler(async (req, res) => {
  const { stream, fileName, sizeBytes, sha256 } = await tenantExportService.openDownload({
    token: req.params.token,
    ip: req.ip ?? null,
    requestId: req.id ?? null,
  });
  res.status(200);
  res.set({
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (Number.isInteger(sizeBytes)) res.set('Content-Length', String(sizeBytes));
  if (sha256) res.set('X-Archive-Sha256', sha256);
  try {
    await pipeline(stream, res);
  } catch (err) {
    // Headers are already sent: end the response; the client sees a
    // truncated download and the checksum will not match.
    req.log?.warn?.({ err: { message: err?.message } }, 'tenant export download interrupted');
    res.destroy();
  }
  return undefined;
});

export default {
  listWorkspaceExports,
  requestWorkspaceExport,
  getWorkspaceExport,
  issueWorkspaceDownloadUrl,
  revokeWorkspaceExport,
  listTenantExports,
  requestTenantExport,
  getTenantExport,
  issueTenantDownloadUrl,
  revokeTenantExport,
  downloadExport,
};
