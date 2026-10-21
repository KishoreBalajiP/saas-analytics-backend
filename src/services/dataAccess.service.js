/**
 * Data Access Service (roadmap 4.E4, rls): dataset grants and row-level
 * security.
 *
 * PURPOSE
 *   Decides, server-side and from the ACTOR'S IDENTITY ONLY, which datasets
 *   a query may read and which rows of them. The analytics engine calls
 *   `resolveAccessScope` from `prepareQuery`, so every engine consumer
 *   (GET /analytics, exports, dashboards/widgets, embeds, reports, alerts,
 *   the external API) is covered; the two raw row listings
 *   (`GET /connectors/:id/rows`, external `/datasets/:id/rows`) call
 *   `rowListMatch`.
 *
 * WHO IS THE ACTOR
 *   - Explicit data actor (`runAsDataActor(actor, fn)`), set by paths that
 *     run on behalf of someone other than the HTTP caller: embeds and API
 *     keys (their creator), reports (the run requester, else the owner),
 *     alerts (the creator), queued exports (the requester).
 *   - Otherwise the request actor (`utils/actorContext`), set by
 *     `authenticate` for tenant users.
 *   - Platform admins bypass (operators). Members holding
 *     `data_access.configure` bypass (they administer the rules).
 *   - Anyone else (no identity, system, a creator who is no longer an
 *     active member) gets the MOST restrictive scope: no restricted dataset,
 *     and no row of a dataset that has a row rule (fail closed).
 *
 * SCOPE (branded, frozen; only objects made here are honoured by the engine)
 *   { bypass, denied: [connectorId], hidden: [connectorId],
 *     rowScopes: [{ connectorId, none?: true, filters?: [{ field, op, value }] }] }
 *   `denied` = not queryable, `hidden` = not listed either. Rules are AND-ed
 *   with the query's own filters, so client filters can only narrow.
 *
 * MANAGEMENT (routes: `/api/v1/data-access`, `data_access.view|configure`)
 *   getDatasetAccess / setDatasetAccess / addRowPolicy / removeRowPolicy /
 *   getUserAttributes / setUserAttributes / previewAsUser.
 *
 * DEPENDS: billing requireFeature(row_level_security) is NOT applied here
 *   (contract: never shim it); integration gates the routes.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import ApiError from '../utils/ApiError.js';
import { getCurrentActor } from '../utils/actorContext.js';
import { DatasetAccess, GRANT_LEVELS, GRANT_SUBJECTS } from '../models/DatasetAccess.js';
import { RowPolicy, ROW_POLICY_OPS } from '../models/RowPolicy.js';
import { User } from '../models/User.js';
import { UserRole } from '../models/UserRole.js';
import { Role } from '../models/Role.js';
import connectorRepository from '../repositories/connector.repository.js';
import permissionService from './permission.service.js';
import { emit as auditEmit } from './auditLog.service.js';

const BRAND = Symbol('rls.accessScope');
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const SAFE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const ATTRIBUTE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const RESERVED_FIELDS = new Set(['tenantId', 'connectorId', 'sourceRowId', 'ingestedAt']);
const QUERY_LEVELS = new Set(['query', 'manage']);
export const CONFIGURE_PERMISSION = 'data_access.configure';
const MAX_ATTRIBUTES = 50;
const MAX_ATTRIBUTE_VALUES = 200;

const dataActorStore = new AsyncLocalStorage();

/* ------------------------------- scope -------------------------------- */

function makeScope({ bypass = false, denied = [], hidden = [], rowScopes = [] }) {
  const scope = {
    bypass,
    denied: Object.freeze([...denied]),
    hidden: Object.freeze([...hidden]),
    rowScopes: Object.freeze(rowScopes.map((s) => Object.freeze(s))),
  };
  Object.defineProperty(scope, BRAND, { value: true });
  return Object.freeze(scope);
}

/** True only for a scope produced by this service (never request input). */
export function isAccessScope(value) {
  return Boolean(value && typeof value === 'object' && value[BRAND] === true);
}

/** JSON-safe view of a scope for cache keys (same scope -> same key). */
export function accessCacheView(scope) {
  if (!isAccessScope(scope)) return undefined;
  if (scope.bypass) return { b: 1 };
  if (!scope.denied.length && !scope.rowScopes.length) return undefined;
  return { d: [...scope.denied].sort(), r: scope.rowScopes };
}

/**
 * Run `fn` with an explicit data actor (embed/API-key creator, report owner,
 * alert creator). `actor` null means "no identity" (most restrictive).
 */
export function runAsDataActor(actor, fn) {
  return dataActorStore.run({ actor: actor ?? null }, fn);
}

/** A user data actor for a stored owner id (or null when there is none). */
export function userDataActor(userId, tenantId) {
  return userId && OBJECT_ID_RE.test(String(userId)) ? { type: 'user', id: String(userId), tenantId: String(tenantId) } : null;
}

function currentDataActor() {
  const store = dataActorStore.getStore();
  return store ? store.actor : getCurrentActor();
}

/** Attribute values as a clean string list. */
function attributeValues(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * The access scope of an actor in a tenant.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {Object|null} [params.actor] - defaults to the data/request actor.
 * @returns {Promise<Object>} branded scope.
 */
export async function resolveAccessScope({ tenantId, actor } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  const who = actor !== undefined ? actor : currentDataActor();
  if (who?.type === 'admin') return makeScope({ bypass: true });

  const [restricted, policies] = await Promise.all([
    DatasetAccess.find({ tenantId: String(tenantId), restricted: true }).lean(),
    RowPolicy.find({ tenantId: String(tenantId), enabled: true }).lean(),
  ]);
  // Fast path: nothing is restricted in this workspace.
  if (!restricted.length && !policies.length) return makeScope({});

  let user = null;
  if (who?.type === 'user' && who.id && OBJECT_ID_RE.test(String(who.id))) {
    user = await User.findOne({ _id: who.id, tenantId: String(tenantId), status: 'active' })
      .select('attributes tenantId status')
      .lean();
  }
  let roleIds = new Set();
  if (user) {
    const permissions = await permissionService.resolveActorPermissions({
      actorType: 'user', actorId: String(user._id), tenantId: String(tenantId),
    });
    if (permissions.includes(CONFIGURE_PERMISSION)) return makeScope({ bypass: true });
    const grants = await UserRole.find({ tenantId: String(tenantId), userId: String(user._id) }).select('roleId expiresAt').lean();
    const now = Date.now();
    roleIds = new Set(grants.filter((g) => !g.expiresAt || new Date(g.expiresAt).getTime() > now).map((g) => String(g.roleId)));
  }

  const denied = [];
  const hidden = [];
  for (const access of restricted) {
    const matching = user
      ? (access.grants ?? []).filter((g) => (g.subjectType === 'user' && g.subjectId === String(user._id))
        || (g.subjectType === 'role' && roleIds.has(g.subjectId)))
      : [];
    if (!matching.some((g) => QUERY_LEVELS.has(g.level))) denied.push(access.connectorId);
    if (!matching.length) hidden.push(access.connectorId);
  }

  const deniedSet = new Set(denied);
  const attributes = user?.attributes && typeof user.attributes === 'object' ? user.attributes : {};
  const byConnector = new Map();
  for (const policy of policies) {
    if (deniedSet.has(policy.connectorId)) continue;
    const entry = byConnector.get(policy.connectorId) ?? { connectorId: policy.connectorId, filters: [], none: false };
    const values = attributeValues(attributes[policy.attribute]);
    if (!values.length) entry.none = true;
    else if (policy.op === 'in' || values.length > 1) entry.filters.push({ field: policy.field, op: 'in', value: values });
    else entry.filters.push({ field: policy.field, op: 'eq', value: values[0] });
    byConnector.set(policy.connectorId, entry);
  }
  const rowScopes = [...byConnector.values()]
    .sort((a, b) => a.connectorId.localeCompare(b.connectorId))
    .map((e) => (e.none ? { connectorId: e.connectorId, none: true } : { connectorId: e.connectorId, filters: e.filters }));
  return makeScope({ denied, hidden, rowScopes });
}

/**
 * Throw 404 when the scope may not query one of `connectorIds`.
 *
 * @param {Object} scope
 * @param {string[]} connectorIds
 */
export function assertQueryable(scope, connectorIds = []) {
  if (!isAccessScope(scope) || scope.bypass || !scope.denied.length) return;
  if (connectorIds.some((id) => scope.denied.includes(String(id)))) throw ApiError.notFound('Dataset not found');
}

/** Connector ids the current actor may not even see listed. */
export async function hiddenConnectorIds(tenantId) {
  const scope = await resolveAccessScope({ tenantId });
  return scope.bypass ? [] : [...scope.hidden];
}

/**
 * Raw row listings: 404 when the dataset is not queryable for the current
 * actor, otherwise the extra Mongo match the row rules require (or null).
 *
 * @returns {Promise<Object|null>}
 */
export async function rowListMatch({ tenantId, connectorId }) {
  const scope = await resolveAccessScope({ tenantId });
  assertQueryable(scope, [connectorId]);
  if (scope.bypass) return null;
  const rule = scope.rowScopes.find((s) => s.connectorId === String(connectorId));
  if (!rule) return null;
  if (rule.none) return { _id: { $in: [] } };
  return {
    $and: rule.filters.map((f) => ({ [`data.${f.field}`]: f.op === 'in' ? { $in: f.value } : { $eq: f.value } })),
  };
}

/* ----------------------------- management ----------------------------- */

async function assertConnector(tenantId, connectorId) {
  if (!OBJECT_ID_RE.test(String(connectorId ?? ''))) throw ApiError.notFound('Dataset not found');
  const connector = await connectorRepository.findById(connectorId, { tenantId });
  if (!connector) throw ApiError.notFound('Dataset not found');
  return connector;
}

function presentPolicy(p) {
  return { id: String(p._id), connectorId: p.connectorId, field: p.field, op: p.op, attribute: p.attribute, enabled: p.enabled };
}

async function audit({ tenantId, actorId, action, resourceType, resourceId, after }) {
  try {
    await auditEmit({
      actor: actorId ? { type: 'user', id: String(actorId) } : { type: 'system', id: 'system' },
      action,
      module: 'data_access',
      resource: { type: resourceType, id: String(resourceId) },
      after,
      tenantId: String(tenantId),
    });
  } catch {
    // best effort; the change is stored.
  }
}

/** Access settings and row rules of one dataset. */
export async function getDatasetAccess({ tenantId, connectorId }) {
  await assertConnector(tenantId, connectorId);
  const [access, policies] = await Promise.all([
    DatasetAccess.findOne({ tenantId: String(tenantId), connectorId: String(connectorId) }).lean(),
    RowPolicy.find({ tenantId: String(tenantId), connectorId: String(connectorId) }).sort({ createdAt: 1 }).lean(),
  ]);
  return {
    connectorId: String(connectorId),
    restricted: Boolean(access?.restricted),
    grants: access?.grants ?? [],
    policies: policies.map(presentPolicy),
  };
}

/** Replace a dataset's restriction flag and grants. */
export async function setDatasetAccess({ tenantId, connectorId, restricted, grants = [], actorId = null }) {
  await assertConnector(tenantId, connectorId);
  if (typeof restricted !== 'boolean') throw ApiError.badRequest('Invalid access', [{ field: 'restricted', message: 'must be true or false' }]);
  if (!Array.isArray(grants) || grants.length > 500) throw ApiError.badRequest('Invalid access', [{ field: 'grants', message: 'must be an array (at most 500)' }]);
  const errors = [];
  const clean = [];
  for (const [i, g] of grants.entries()) {
    if (!g || !GRANT_SUBJECTS.includes(g.subjectType) || !GRANT_LEVELS.includes(g.level) || !OBJECT_ID_RE.test(String(g.subjectId ?? ''))) {
      errors.push({ field: `grants[${i}]`, message: 'must be { subjectType: user|role, subjectId, level: view|query|manage }' });
      continue;
    }
    clean.push({ subjectType: g.subjectType, subjectId: String(g.subjectId), level: g.level });
  }
  if (errors.length) throw ApiError.badRequest('Invalid access', errors);
  // Subjects must belong to this workspace.
  const userIds = clean.filter((g) => g.subjectType === 'user').map((g) => g.subjectId);
  const roleIds = clean.filter((g) => g.subjectType === 'role').map((g) => g.subjectId);
  const [users, roles] = await Promise.all([
    userIds.length ? User.countDocuments({ _id: { $in: userIds }, tenantId: String(tenantId) }) : 0,
    roleIds.length ? Role.countDocuments({ _id: { $in: roleIds }, tenantId: String(tenantId) }) : 0,
  ]);
  if (users !== new Set(userIds).size || roles !== new Set(roleIds).size) {
    throw ApiError.badRequest('Invalid access', [{ field: 'grants', message: 'every subject must be a user or role of this workspace' }]);
  }
  await DatasetAccess.findOneAndUpdate(
    { tenantId: String(tenantId), connectorId: String(connectorId) },
    { $set: { restricted, grants: clean, updatedBy: actorId } },
    { upsert: true, new: true, runValidators: true },
  );
  await audit({ tenantId, actorId, action: 'data_access.dataset_updated', resourceType: 'connector', resourceId: connectorId, after: { restricted, grants: clean.length } });
  return getDatasetAccess({ tenantId, connectorId });
}

/** Add a row rule to a dataset. */
export async function addRowPolicy({ tenantId, connectorId, field, op = 'eq', attribute, actorId = null }) {
  await assertConnector(tenantId, connectorId);
  const errors = [];
  if (typeof field !== 'string' || !SAFE_NAME_RE.test(field) || RESERVED_FIELDS.has(field)) errors.push({ field: 'field', message: 'must be a data field name' });
  if (!ROW_POLICY_OPS.includes(op)) errors.push({ field: 'op', message: 'must be "eq" or "in"' });
  if (typeof attribute !== 'string' || !ATTRIBUTE_RE.test(attribute)) errors.push({ field: 'attribute', message: 'must be an attribute name' });
  if (errors.length) throw ApiError.badRequest('Invalid row policy', errors);
  const created = await new RowPolicy({ tenantId: String(tenantId), connectorId: String(connectorId), field, op, attribute, createdBy: actorId }).save();
  await audit({ tenantId, actorId, action: 'data_access.row_policy_created', resourceType: 'row_policy', resourceId: created._id, after: { connectorId, field, op, attribute } });
  return presentPolicy(created.toObject());
}

/** Delete a row rule (tenant-scoped). */
export async function removeRowPolicy({ tenantId, policyId, actorId = null }) {
  if (!OBJECT_ID_RE.test(String(policyId ?? ''))) throw ApiError.notFound('Row policy not found');
  const removed = await RowPolicy.findOneAndDelete({ _id: policyId, tenantId: String(tenantId) }).lean();
  if (!removed) throw ApiError.notFound('Row policy not found');
  await audit({ tenantId, actorId, action: 'data_access.row_policy_deleted', resourceType: 'row_policy', resourceId: policyId, after: { connectorId: removed.connectorId } });
  return { id: String(policyId), deleted: true };
}

async function findMember(tenantId, userId) {
  if (!OBJECT_ID_RE.test(String(userId ?? ''))) throw ApiError.notFound('User not found');
  const user = await User.findOne({ _id: userId, tenantId: String(tenantId) }).select('email attributes').lean();
  if (!user) throw ApiError.notFound('User not found');
  return user;
}

/** A member's attributes. */
export async function getUserAttributes({ tenantId, userId }) {
  const user = await findMember(tenantId, userId);
  return { userId: String(user._id), attributes: user.attributes ?? {} };
}

/** Replace a member's attributes (strings or string arrays). */
export async function setUserAttributes({ tenantId, userId, attributes, actorId = null }) {
  await findMember(tenantId, userId);
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    throw ApiError.badRequest('Invalid attributes', [{ field: 'attributes', message: 'must be an object' }]);
  }
  const entries = Object.entries(attributes);
  const errors = [];
  if (entries.length > MAX_ATTRIBUTES) errors.push({ field: 'attributes', message: `at most ${MAX_ATTRIBUTES} attributes` });
  const clean = {};
  for (const [key, value] of entries) {
    const list = Array.isArray(value) ? value : [value];
    const ok = ATTRIBUTE_RE.test(key) && list.length <= MAX_ATTRIBUTE_VALUES
      && list.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 256);
    if (!ok) { errors.push({ field: `attributes.${key}`, message: 'must be a string or an array of strings' }); continue; }
    clean[key] = Array.isArray(value) ? [...value] : value;
  }
  if (errors.length) throw ApiError.badRequest('Invalid attributes', errors);
  await User.updateOne({ _id: userId, tenantId: String(tenantId) }, { $set: { attributes: clean } });
  await audit({ tenantId, actorId, action: 'data_access.attributes_updated', resourceType: 'user', resourceId: userId, after: { keys: Object.keys(clean) } });
  return { userId: String(userId), attributes: clean };
}

/**
 * Run a query exactly as a member would (their grants and row rules).
 *
 * @returns {Promise<Object>} engine result plus `scope` summary.
 */
export async function previewAsUser({ tenantId, userId, query = {} }) {
  await findMember(tenantId, userId);
  const engine = (await import('./analytics.engine.js')).default;
  const validated = engine.validateQuery(query);
  const result = await runAsDataActor(userDataActor(userId, tenantId), () => engine.queryRows({ ...validated, tenantId: String(tenantId) }));
  const scope = await resolveAccessScope({ tenantId, actor: userDataActor(userId, tenantId) });
  return { ...result, scope: { bypass: scope.bypass, deniedDatasets: [...scope.denied], rowRules: scope.rowScopes.length } };
}

export default {
  resolveAccessScope,
  isAccessScope,
  accessCacheView,
  assertQueryable,
  hiddenConnectorIds,
  rowListMatch,
  runAsDataActor,
  userDataActor,
  getDatasetAccess,
  setDatasetAccess,
  addRowPolicy,
  removeRowPolicy,
  getUserAttributes,
  setUserAttributes,
  previewAsUser,
  CONFIGURE_PERMISSION,
};
