/**
 * Workspace members validators (roadmap 2.10).
 *
 * Schemas for `/api/v1/workspace/{members,invitations,roles,ownership,deletion}`.
 * The tenant is never accepted from the request: it comes from the token.
 */

import { USER_STATUSES } from '../models/User.js';
import { INVITATION_STATUSES } from '../models/TenantInvitation.js';

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const PERMISSION_KEY_RE = /^[a-z_]+(\.[a-z_]+)+$/;

const page = { type: 'integer', min: 1 };
const limit = { type: 'integer', min: 1, max: 100 };

export const listMembersSchema = {
  body: {},
  params: {},
  query: {
    search: { type: 'string', maxLength: 128 },
    status: { type: 'string', oneOf: [...USER_STATUSES] },
    page,
    limit,
  },
};

export const memberParamSchema = {
  body: {},
  params: { userId: 'objectId|required' },
  query: {},
};

export const setRolesSchema = {
  body: {
    roleIds: {
      type: 'array',
      required: true,
      custom: (value) => {
        if (value.length === 0) return 'Choose at least one role';
        if (value.length > 20) return 'At most 20 roles';
        return value.every((id) => typeof id === 'string' && OBJECT_ID_RE.test(id)) || 'roleIds must be role ids';
      },
    },
  },
  params: { userId: 'objectId|required' },
  query: {},
};

export const statusChangeSchema = {
  body: { reason: { type: 'string', maxLength: 500 } },
  params: { userId: 'objectId|required' },
  query: {},
};

export const listInvitationsSchema = {
  body: {},
  params: {},
  query: {
    status: { type: 'string', oneOf: [...INVITATION_STATUSES] },
    page,
    limit,
  },
};

export const invitationParamSchema = {
  body: {},
  params: { invitationId: 'objectId|required' },
  query: {},
};

const permissionsRule = {
  type: 'array',
  custom: (value) => {
    if (value.length > 200) return 'At most 200 permissions';
    return value.every((key) => typeof key === 'string' && key.length <= 80 && PERMISSION_KEY_RE.test(key))
      || 'permissions must be permission keys such as "dashboards.view"';
  },
};

export const createRoleSchema = {
  body: {
    name: { type: 'string', required: true, minLength: 1, maxLength: 60 },
    description: { type: 'string', maxLength: 300 },
    permissions: { ...permissionsRule, required: true },
  },
  params: {},
  query: {},
};

export const updateRoleSchema = {
  body: {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    description: { type: 'string', maxLength: 300 },
    permissions: permissionsRule,
  },
  params: { roleId: 'objectId|required' },
  query: {},
};

export const roleParamSchema = {
  body: {},
  params: { roleId: 'objectId|required' },
  query: {},
};

export const transferOwnershipSchema = {
  body: {
    userId: 'objectId|required',
    password: { type: 'string', required: true, maxLength: 256 },
  },
  params: {},
  query: {},
};

export const requestDeletionSchema = {
  body: {
    confirm: { type: 'string', required: true, maxLength: 120 },
    password: { type: 'string', required: true, maxLength: 256 },
    reason: { type: 'string', maxLength: 500 },
  },
  params: {},
  query: {},
};

export default {
  listMembersSchema,
  memberParamSchema,
  setRolesSchema,
  statusChangeSchema,
  listInvitationsSchema,
  invitationParamSchema,
  createRoleSchema,
  updateRoleSchema,
  roleParamSchema,
  transferOwnershipSchema,
  requestDeletionSchema,
};

/* ------------------------- platform admin (deletions) ------------------------- */

export const adminListDeletionsSchema = {
  body: {},
  params: {},
  query: {
    status: { type: 'string', oneOf: ['scheduled', 'purging', 'purged', 'failed', 'cancelled'] },
    tenantId: 'objectId',
    page,
    limit,
  },
};

export const adminTenantDeletionSchema = {
  body: {},
  params: { id: 'objectId|required' },
  query: {},
};

export const adminCancelDeletionSchema = {
  body: { reason: { type: 'string', required: true, minLength: 3, maxLength: 500 } },
  params: { id: 'objectId|required' },
  query: {},
};
