/**
 * Tenant data export validators (roadmap 2.9).
 *
 * Workspace routes take no body (the tenant comes from the session).
 * Platform routes name the tenant in the path and may carry a support
 * reason. Export ids are `tex_` + 26 lowercase ULID characters. The public
 * download route is not validated here: a malformed link answers 401
 * DOWNLOAD_LINK_INVALID from the service, like a forged one.
 */

const EXPORT_ID = { type: 'string', required: true, pattern: '^tex_[0-9a-z]{26}$', message: 'exportId is invalid' };
const PAGING = {
  page: { type: 'integer', min: 1, max: 10000 },
  limit: { type: 'integer', min: 1, max: 100 },
};

export const workspaceListSchema = { query: PAGING };
export const workspaceExportParamsSchema = { params: { exportId: EXPORT_ID } };

export const platformListSchema = {
  params: { id: { type: 'objectId', required: true } },
  query: PAGING,
};
export const platformRequestSchema = {
  params: { id: { type: 'objectId', required: true } },
  body: { reason: { type: 'string', required: true, minLength: 3, maxLength: 500 } },
};
export const platformExportParamsSchema = {
  params: { id: { type: 'objectId', required: true }, exportId: EXPORT_ID },
};

export default {
  workspaceListSchema,
  workspaceExportParamsSchema,
  platformListSchema,
  platformRequestSchema,
  platformExportParamsSchema,
};
