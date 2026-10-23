/**
 * Support Access Validators (roadmap 2.3).
 *
 * PURPOSE
 *   Request shapes for the workspace side of support access
 *   (`/api/v1/workspace/support-access`) and for the support session itself
 *   (`/api/v1/support-session`), consumed by `validate(schema)`.
 *
 * NOTES
 *   - `durationHours` is bounded here only loosely; the service enforces the
 *     configured ceiling (`SUPPORT_CONSENT_MAX_HOURS`) with a field error.
 */

const PAGE_RULES = {
  page: { type: 'integer', min: 1, max: 10000 },
  limit: { type: 'integer', min: 1, max: 100 },
};

/** Body for granting support access from workspace settings. */
export const grantConsentSchema = {
  body: {
    durationHours: { type: 'integer', required: true, min: 1, max: 24 * 31 },
    note: { type: 'string', maxLength: 500 },
  },
  params: {},
  query: {},
};

/** Revoke one of the workspace's grants. */
export const revokeConsentSchema = {
  body: {
    reason: { type: 'string', maxLength: 500 },
  },
  params: {
    id: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  },
  query: {},
};

/** End one support session from workspace settings. */
export const endSessionSchema = {
  body: {
    reason: { type: 'string', maxLength: 500 },
  },
  params: {
    id: { type: 'string', required: true, minLength: 1, maxLength: 64 },
  },
  query: {},
};

/** Paginated support activity (audit history) of the workspace. */
export const activitySchema = {
  body: {},
  params: {},
  query: { ...PAGE_RULES },
};

/** Paginated workspace support-access history. */
export const workspaceSchema = {
  body: {},
  params: {},
  query: { ...PAGE_RULES },
};

/** A support session ends itself. */
export const endCurrentSchema = {
  body: {
    reason: { type: 'string', maxLength: 500 },
  },
  params: {},
  query: {},
};

export default {
  grantConsentSchema,
  revokeConsentSchema,
  endSessionSchema,
  activitySchema,
  workspaceSchema,
  endCurrentSchema,
};
