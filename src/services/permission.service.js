/**
 * Permission Service (Sprint 2 - implemented).
 *
 * PURPOSE
 *   Business logic for dynamic RBAC primitives: modules, actions,
 *   permissions, and the actor-permission resolution used by the
 *   `permission.middleware.js` hot path.
 *
 * RESPONSIBILITY
 *   - listModules, createModule, getModuleActions
 *   - listPermissions, createPermission, bulkCreatePermissions,
 *     deletePermission
 *   - resolveActorPermissions({ actorType, actorId, tenantId })
 *     -> string[] of `<module>.<action>` keys
 *
 * CODING GUIDELINES
 *   - Permission keys MUST be `<module_key>.<action>`; enforced here (and
 *     again in the validators) - never trust callers.
 *   - `moduleId` and the denormalised `module` key are kept in sync at
 *     creation; the model guarantees uniqueness on both.
 *   - `isSystem` permissions cannot be deleted while a role references
 *     them; deletion is soft-delete only.
 *   - `resolveActorPermissions` is the HOT path; cached per actor for 60s.
 *   - Module/permission registration invalidates EVERY `iam:rbac:*` key
 *     (a new permission key may be relevant to any scope).
 */

import ApiError from '../utils/ApiError.js';
import permissionRepository from '../repositories/permission.repository.js';
import { CANONICAL_ACTIONS } from '../models/Permission.js';
import { resolve, invalidateAll } from './rbac.cache.service.js';

/**
 * List modules, optionally filtered by name/key search.
 *
 * @param {Object} [opts]
 * @param {string} [opts.search]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated module list.
 */
export async function listModules({ search, page = 1, limit = 20 } = {}) {
  const filter = {};
  if (search) filter.key = { $regex: escapeRegExp(search), $options: 'i' };
  return permissionRepository.listModules({ filter, page, limit });
}

/**
 * Register a module. Dotted keys (e.g. `iam.users`) require an existing
 * parent module (the prefix before the first dot).
 *
 * @param {Object} opts
 * @param {string} opts.key - dotted module key (e.g. `iam`, `iam.users`).
 * @param {string} opts.name
 * @param {string} [opts.description='']
 * @param {string|null} [opts.by=null]
 * @returns {Promise<Object>} saved module (plain).
 */
export async function createModule({ key, name, description = '', by = null } = {}) {
  const moduleKey = String(key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/.test(moduleKey)) {
    throw ApiError.badRequest('Module key must be lowercase, dot-separated (e.g. "iam" or "iam.users")');
  }
  const existing = await permissionRepository.findModuleByKey(moduleKey);
  if (existing) throw ApiError.conflict(`Module "${moduleKey}" already exists`);

  let parentKey = null;
  if (moduleKey.includes('.')) {
    parentKey = moduleKey.slice(0, moduleKey.indexOf('.'));
    const parent = await permissionRepository.findModuleByKey(parentKey);
    if (!parent) throw ApiError.badRequest(`Parent module "${parentKey}" does not exist`);
  }

  const module = await permissionRepository.createModule({
    key: moduleKey,
    name: String(name ?? '').trim(),
    description,
    parentKey,
    isSystem: false,
    createdBy: by,
  });
  await invalidateAll();
  return module;
}

/**
 * List the actions currently registered on a module.
 *
 * @param {Object} opts
 * @param {string} opts.moduleKey
 * @returns {Promise<string[]>} sorted, distinct action names.
 */
export async function getModuleActions({ moduleKey } = {}) {
  const key = String(moduleKey ?? '').trim().toLowerCase();
  const module = await permissionRepository.findModuleByKey(key);
  if (!module) throw ApiError.notFound(`Module "${key}" not found`);
  return permissionRepository.listActions(key);
}

/**
 * List permissions, optionally filtered by module and/or action.
 *
 * @param {Object} [opts]
 * @param {string} [opts.module]
 * @param {string} [opts.action]
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {Promise<Object>} paginated permission list.
 */
export async function listPermissions({ module, action, page = 1, limit = 20 } = {}) {
  return permissionRepository.listPermissions({ module, action, page, limit });
}

/**
 * Register a single `<module>.<action>` permission. The module must exist;
 * the pair must be unique (409).
 *
 * @param {Object} opts
 * @param {string} opts.module - module key (dotted).
 * @param {string} opts.action - must be in `CANONICAL_ACTIONS`.
 * @param {string} [opts.description='']
 * @param {string|null} [opts.by=null]
 * @returns {Promise<Object>} saved permission (plain).
 */
export async function createPermission({ module, action, description = '', by = null } = {}) {
  const { moduleKey, actionKey } = validateKey(module, action);
  const mod = await permissionRepository.findModuleByKey(moduleKey);
  if (!mod) throw ApiError.notFound(`Module "${moduleKey}" not found`);

  const existing = await permissionRepository.findPermissionByKey(`${moduleKey}.${actionKey}`);
  if (existing) throw ApiError.conflict(`Permission "${moduleKey}.${actionKey}" already exists`);

  const permission = await permissionRepository.createPermission({
    moduleId: mod._id,
    module: moduleKey,
    action: actionKey,
    key: `${moduleKey}.${actionKey}`,
    description,
    isSystem: false,
    createdBy: by,
  });
  await invalidateAll();
  return permission;
}

/**
 * Bulk-register permissions, skipping keys that already exist (idempotent).
 * Every referenced module must exist.
 *
 * @param {Object} opts
 * @param {Array<{ module: string, action: string, description?: string }>} opts.items
 * @param {string|null} [opts.by=null]
 * @returns {Promise<{ created: number, skipped: number }>}
 */
export async function bulkCreatePermissions({ items = [], by = null } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw ApiError.badRequest('items must be a non-empty array');
  }

  const moduleIds = new Map();
  const rows = [];
  const seenKeys = new Set();

  for (const item of items) {
    const { moduleKey, actionKey } = validateKey(item.module, item.action);
    const key = `${moduleKey}.${actionKey}`;
    if (seenKeys.has(key)) continue; // dedupe within the batch
    seenKeys.add(key);

    if (!moduleIds.has(moduleKey)) {
      const mod = await permissionRepository.findModuleByKey(moduleKey);
      if (!mod) throw ApiError.notFound(`Module "${moduleKey}" not found`);
      moduleIds.set(moduleKey, mod._id);
    }
    rows.push({
      moduleId: moduleIds.get(moduleKey),
      module: moduleKey,
      action: actionKey,
      key,
      description: item.description ?? '',
      isSystem: false,
      createdBy: by,
    });
  }

  const created = await permissionRepository.bulkCreatePermissions(rows);
  await invalidateAll();
  return { created, skipped: rows.length - created };
}

/**
 * Soft-delete a permission. `isSystem` permissions are immutable (409).
 *
 * @param {Object} opts
 * @param {string} opts.key - `<module>.<action>`.
 * @param {string|null} [opts.by=null]
 * @returns {Promise<{ ok: true }>}
 */
export async function deletePermission({ key, by = null } = {}) {
  const permission = await permissionRepository.findPermissionByKey(key);
  if (!permission) throw ApiError.notFound(`Permission "${key}" not found`);
  if (permission.isSystem) throw ApiError.conflict('System permissions cannot be deleted');

  await permissionRepository.deletePermission(permission._id, by);
  await invalidateAll();
  return { ok: true };
}

/**
 * Resolve the effective permission keys for an actor. THE hot path -
 * cached per actor for 60s (see `rbac.cache.service.js`); a cache failure
 * degrades to a live repository resolution.
 *
 * @param {Object} opts
 * @param {'admin'|'user'} opts.actorType
 * @param {string} opts.actorId
 * @param {string|null} [opts.tenantId=null] - user actors require a tenant.
 * @returns {Promise<string[]>} sorted `<module>.<action>` keys.
 */
export async function resolveActorPermissions({ actorType, actorId, tenantId = null } = {}) {
  if (!actorType || !actorId) throw ApiError.badRequest('actorType and actorId are required');
  if (actorType === 'user' && !tenantId) throw ApiError.badRequest('tenantId is required for user actors');

  const live = async () => {
    const set = await permissionRepository.resolvePermissionsForActor({ actorType, actorId, tenantId });
    return [...set].sort();
  };
  return resolve({ tenantId, actorType, actorId, fn: live });
}

/** Validate + normalise a module/action pair; enforces the canonical action set. */
function validateKey(module, action) {
  const moduleKey = String(module ?? '').trim().toLowerCase();
  const actionKey = String(action ?? '').trim().toLowerCase();
  if (!moduleKey || !actionKey) throw ApiError.badRequest('module and action are required');
  if (!CANONICAL_ACTIONS.includes(actionKey)) {
    throw ApiError.badRequest(
      `Unknown action "${actionKey}"; expected one of ${CANONICAL_ACTIONS.join(', ')}`,
    );
  }
  return { moduleKey, actionKey };
}

/** Escape regex metacharacters so user input can be a safe `$regex`. */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  listModules,
  createModule,
  getModuleActions,
  listPermissions,
  createPermission,
  bulkCreatePermissions,
  deletePermission,
  resolveActorPermissions,
  _meta: { invalidatesCache: 'iam:rbac:*' },
};
