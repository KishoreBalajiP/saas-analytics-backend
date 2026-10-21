/**
 * Platform Settings Service (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   The platform-admin surface behind `/api/v1/settings`: the PLATFORM
 *   value of every catalogue setting (`DEFAULT_SETTINGS`), which tenants
 *   inherit unless they override it. Tenant overrides stay on
 *   `/tenants/:id/settings` and `/workspace/settings`.
 *
 * RESPONSIBILITY
 *   - list / get           catalogue definition + stored platform value
 *   - update               validated per key, optimistic concurrency
 *   - reset                back to the built-in default (a normal change)
 *   - history / rollback   versioned revisions restore the exact value
 *   - revealSecret         decrypted secret for `settings.secrets.view`
 *
 * VERSIONING
 *   `Setting.version` is the resource version. Each change is a
 *   conditional write on the version the caller saw (or the current one),
 *   then one `ConfigRevision` row with the resulting state. The first
 *   change also records a `baseline` revision of the seeded value, so it
 *   can be rolled back.
 *
 * SECURITY RULES
 *   - Secret values are encrypted at rest; reads mask them, history and
 *     audit never contain them (history holds the envelope only so a
 *     rollback restores the exact prior secret).
 *   - Writing a secret needs `settings.secrets.update`; the route passes
 *     the caller's capability in (`canWriteSecrets`).
 *   - Read-only catalogue keys are code-managed and refused (403).
 */

import * as settingRepository from '../repositories/setting.repository.js';
import * as settingService from './setting.service.js';
import { DEFAULT_SETTINGS, SETTINGS_GROUPS } from './tenantSettings.service.js';
import { validateSettingValue } from './settingRules.js';
import {
  CONFIG_ERROR_CODES,
  versionConflict,
  configError,
  ensureBaseline,
  recordRevision,
  listHistory,
  getRevision,
  auditChange,
} from './configHistory.service.js';

const KIND = 'setting';
const AUDIT_MODULE = 'platform.settings';

/* ------------------------------ internals ------------------------------ */

function definitionOf(key) {
  const definition = DEFAULT_SETTINGS.find((setting) => setting.key === key);
  if (!definition) {
    throw configError(404, CONFIG_ERROR_CODES.SETTING_NOT_FOUND, `Unknown platform setting "${key}"`);
  }
  return definition;
}

const resourceKeyOf = (key) => `platform:${key}`;

/** Secret-free state snapshot recorded in history. */
function stateOf(definition, row) {
  if (definition.isSecret) {
    return { value: null, hasValue: settingService.secretHasValue(row) };
  }
  return { value: row ? row.value : definition.value };
}

/** Value as it should appear in an audit entry (secrets never). */
function auditValue(definition, row) {
  if (definition.isSecret) return { value: '[REDACTED]', hasValue: settingService.secretHasValue(row) };
  return { value: row ? row.value : definition.value };
}

/** Public view: catalogue definition merged with the stored platform row. */
async function present(definition, row, { includeSecrets = false } = {}) {
  const base = {
    key: definition.key,
    group: definition.group,
    type: definition.type,
    description: definition.description,
    isSecret: Boolean(definition.isSecret),
    isReadonly: Boolean(definition.isReadonly),
    defaultValue: definition.isSecret ? null : definition.value,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
    source: row ? 'platform' : 'default',
  };
  if (definition.isSecret) {
    const hasValue = settingService.secretHasValue(row);
    if (includeSecrets) {
      return { ...base, value: row ? await settingService.openSecretValue(row) : '', hasValue };
    }
    return { ...base, value: null, redacted: true, hasValue };
  }
  return { ...base, value: row ? row.value : definition.value };
}

async function loadRow(key) {
  return settingRepository.findByKey({ key, scope: 'platform', tenantId: null });
}

/** Create the platform row from the catalogue when it was never seeded. */
async function ensureRow(definition, actorId) {
  const existing = await loadRow(definition.key);
  if (existing) return existing;
  const { setting } = await settingRepository.insertIfAbsent({
    key: definition.key,
    scope: 'platform',
    tenantId: null,
    type: definition.type,
    value: definition.isSecret ? '' : definition.value,
    description: definition.description,
    isSecret: Boolean(definition.isSecret),
    isReadonly: Boolean(definition.isReadonly),
    group: definition.group,
    updatedBy: actorId ?? 'system',
  });
  return setting;
}

function assertWritable(definition, { canWriteSecrets }) {
  if (definition.isReadonly) {
    throw configError(403, CONFIG_ERROR_CODES.SETTING_READ_ONLY, `Setting "${definition.key}" is read-only`);
  }
  if (definition.isSecret && !canWriteSecrets) {
    throw configError(
      403,
      CONFIG_ERROR_CODES.SECRET_PERMISSION_REQUIRED,
      'Changing a secret setting requires the "settings.secrets.update" permission',
    );
  }
}

/**
 * Apply one change: conditional write on the expected version, revision,
 * cache invalidation and audit. `next` is `{ value }` for plain settings or
 * `{ secret }` (an envelope or null) for secrets.
 */
async function applyChange({ definition, row, expectedVersion, next, action, actor, reason, rolledBackFrom = null }) {
  const current = row.version ?? 0;
  if (expectedVersion !== undefined && expectedVersion !== null && expectedVersion !== current) {
    throw versionConflict(current);
  }

  await ensureBaseline({
    kind: KIND,
    resourceKey: resourceKeyOf(definition.key),
    version: current,
    state: stateOf(definition, row),
    isSecret: Boolean(definition.isSecret),
    secret: definition.isSecret ? row.secret ?? null : null,
  });

  const set = definition.isSecret
    ? { secret: next.secret ?? null, value: '', updatedBy: actor?.id ?? null }
    : { value: next.value, updatedBy: actor?.id ?? null };
  const updated = await settingRepository.updateIfVersion(row._id, current, set);
  if (!updated) {
    const latest = await loadRow(definition.key);
    throw versionConflict(latest?.version ?? current);
  }

  await recordRevision({
    kind: KIND,
    resourceKey: resourceKeyOf(definition.key),
    version: updated.version,
    action,
    state: stateOf(definition, updated),
    isSecret: Boolean(definition.isSecret),
    secret: definition.isSecret ? updated.secret ?? null : null,
    rolledBackFrom,
    reason,
    actor,
  });
  await settingService.invalidateEffective('platform', null, definition.key);
  await auditChange({
    actor,
    action: `platform_setting.${action === 'rollback' ? 'rolled_back' : action === 'reset' ? 'reset' : 'updated'}`,
    module: AUDIT_MODULE,
    resource: { type: 'setting', id: definition.key },
    before: { ...auditValue(definition, row), version: current },
    after: { ...auditValue(definition, updated), version: updated.version, ...(rolledBackFrom != null ? { rolledBackFrom } : {}) },
    reason,
  });
  return updated;
}

/* ------------------------------ public API ------------------------------ */

/**
 * Every catalogue setting with its platform value. Secrets are masked.
 *
 * @param {{ group?: string, search?: string }} [opts]
 */
export async function list({ group, search } = {}) {
  const needle = search ? String(search).toLowerCase() : null;
  const definitions = DEFAULT_SETTINGS.filter((definition) => (
    (!group || definition.group === group)
    && (!needle || definition.key.toLowerCase().includes(needle)
      || String(definition.description).toLowerCase().includes(needle))
  ));
  const rows = await settingRepository.findByKeys({
    keys: definitions.map((definition) => definition.key), scope: 'platform', tenantId: null,
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return Promise.all(definitions.map((definition) => present(definition, byKey.get(definition.key) ?? null)));
}

/** Group names that hold platform settings. */
export function groups() {
  return SETTINGS_GROUPS.filter((group) => DEFAULT_SETTINGS.some((definition) => definition.group === group));
}

/** One platform setting (secrets masked). */
export async function get(key) {
  const definition = definitionOf(key);
  return present(definition, await loadRow(key));
}

/**
 * Change the platform value of a setting.
 *
 * @param {Object} opts
 * @param {string} opts.key
 * @param {*} opts.value
 * @param {number} [opts.version] - the version the caller saw (409 when stale).
 * @param {string} [opts.reason]
 * @param {Object} opts.actor - `{ type, id, email }`.
 * @param {boolean} [opts.canWriteSecrets=false]
 */
export async function update({ key, value, version, reason = null, actor, canWriteSecrets = false }) {
  const definition = definitionOf(key);
  assertWritable(definition, { canWriteSecrets });
  const stored = validateSettingValue(definition, value);
  const row = await ensureRow(definition, actor?.id);
  const next = definition.isSecret
    ? { secret: await settingService.sealSecretValue({ scope: 'platform', tenantId: null, key, value: stored }) }
    : { value: stored };
  const updated = await applyChange({ definition, row, expectedVersion: version, next, action: 'update', actor, reason });
  return present(definition, updated);
}

/** Restore the built-in default value (recorded as a normal change). */
export async function reset({ key, version, reason = null, actor, canWriteSecrets = false }) {
  const definition = definitionOf(key);
  assertWritable(definition, { canWriteSecrets });
  const row = await ensureRow(definition, actor?.id);
  const next = definition.isSecret ? { secret: null } : { value: definition.value };
  const updated = await applyChange({ definition, row, expectedVersion: version, next, action: 'reset', actor, reason });
  return present(definition, updated);
}

/** Version history (newest first, secret-free). */
export async function history({ key, page = 1, limit = 20 }) {
  definitionOf(key);
  return listHistory({ kind: KIND, resourceKey: resourceKeyOf(key), page, limit });
}

/**
 * Roll back to the exact state of an earlier version. The rollback itself
 * becomes a new version, so it can be undone the same way.
 */
export async function rollback({ key, toVersion, version, reason = null, actor, canWriteSecrets = false }) {
  const definition = definitionOf(key);
  assertWritable(definition, { canWriteSecrets });
  const target = await getRevision({ kind: KIND, resourceKey: resourceKeyOf(key), version: toVersion });
  const row = await ensureRow(definition, actor?.id);
  const next = definition.isSecret
    ? { secret: target.secret ?? null }
    : { value: validateSettingValue(definition, target.state?.value) };
  const updated = await applyChange({
    definition, row, expectedVersion: version, next, action: 'rollback', actor, reason, rolledBackFrom: toVersion,
  });
  return present(definition, updated);
}

/**
 * Decrypt a secret setting for a caller holding `settings.secrets.view`.
 * Every reveal is audited (without the value).
 */
export async function revealSecret({ key, actor, reason = null }) {
  const definition = definitionOf(key);
  if (!definition.isSecret) {
    throw configError(400, CONFIG_ERROR_CODES.SETTING_NOT_SECRET, `Setting "${key}" is not a secret`);
  }
  const row = await loadRow(key);
  const revealed = await present(definition, row, { includeSecrets: true });
  await auditChange({
    actor,
    action: 'platform_setting.secret_revealed',
    module: AUDIT_MODULE,
    resource: { type: 'setting', id: key },
    after: { hasValue: revealed.hasValue, version: revealed.version },
    reason,
  });
  return revealed;
}

export default { list, groups, get, update, reset, history, rollback, revealSecret };
