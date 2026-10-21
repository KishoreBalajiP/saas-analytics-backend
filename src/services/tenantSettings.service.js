/**
 * Tenant Settings Service (Sprint 3 - implemented).
 *
 * PURPOSE
 *   The tenant-scoped settings surface: grouped, typed, secret-aware.
 *   Onboarding seeds platform defaults once; tenants inherit them and
 *   override specific keys. The `feature_flags` group is served by the
 *   feature-flag catalogue, keeping a single source of truth.
 *
 * RESPONSIBILITY
 *   - initialize        - idempotently seed platform defaults
 *   - listGroups        - every group name
 *   - getGroup          - effective values for a group
 *                        (tenant override > platform > built-in default)
 *   - updateGroup       - upsert tenant overrides for a group
 *   - getTimezone / setTimezone - the workspace IANA time zone
 *                        (`localization.timezone`, validated, default UTC).
 *                        Changing it re-projects the next run of report and
 *                        alert schedules that follow the workspace zone,
 *                        whichever surface (admin or workspace) changed it.
 *
 * CODING GUIDELINES
 *   - Effective resolution NEVER materialises a tenant row unless an
 *     admin overrides something: the default (built-in) and platform rows
 *     are the fallbacks, so a fresh tenant has zero settings rows.
 *   - `isSecret` values are encrypted at rest and redacted unless
 *     `includeSecrets` (platform admins holding `settings.secrets.view`);
 *     presentation is delegated to `setting.service.presentSetting`.
 *   - Every override is validated per key (`settingRules.js`) before it is
 *     stored. Platform rows are only created when missing: onboarding never
 *     overwrites a value a platform admin changed.
 *   - Read-only keys are hard-rejected on tenant overrides (forbid), so a
 *     tenant can never clobber a platform-policed value.
 */

import ApiError from '../utils/ApiError.js';
import * as settingRepository from '../repositories/setting.repository.js';
import * as settingService from './setting.service.js';
import { presentSetting } from './setting.service.js';
import { validateSettingValue } from './settingRules.js';
import * as featureFlagService from './featureFlag.service.js';
import { DEFAULT_TIMEZONE, isValidTimeZone, normalizeTimeZone } from '../utils/timezone.js';

/** Setting key holding the workspace's IANA time zone. */
export const TIMEZONE_SETTING_KEY = 'localization.timezone';

export const SETTINGS_GROUPS = Object.freeze([
  'general', 'localization', 'branding', 'security',
  'notification', 'email', 'billing', 'storage', 'feature_flags',
]);

/** Built-in platform defaults, seeded idempotently on first onboarding. */
export const DEFAULT_SETTINGS = Object.freeze([
  { key: 'general.contact_email', group: 'general', type: 'string', value: '', description: 'Support contact email shown on tenant pages.' },
  { key: 'general.maintenance_notice', group: 'general', type: 'string', value: '', description: 'Optional banner text shown to tenant users.' },

  { key: 'localization.timezone', group: 'localization', type: 'string', value: 'UTC', description: 'Default IANA timezone for the tenant.' },
  { key: 'localization.locale', group: 'localization', type: 'string', value: 'en', description: 'Default BCP-47 locale.' },
  { key: 'localization.currency', group: 'localization', type: 'string', value: 'USD', description: 'Default ISO-4217 currency.' },
  { key: 'localization.date_format', group: 'localization', type: 'string', value: 'YYYY-MM-DD', description: 'Default date format.' },

  { key: 'branding.primary_color', group: 'branding', type: 'string', value: '#2563eb', description: 'Primary brand colour.' },
  { key: 'branding.accent_color', group: 'branding', type: 'string', value: '#0ea5e9', description: 'Accent brand colour.' },
  { key: 'branding.logo_url', group: 'branding', type: 'string', value: '', description: 'Public logo URL for the tenant.' },

  { key: 'security.password_min_length', group: 'security', type: 'number', value: 8, description: 'Minimum password length.', isReadonly: true },
  { key: 'security.mfa_required', group: 'security', type: 'boolean', value: false, description: 'Require MFA for all tenant users.' },
  { key: 'security.session_ttl', group: 'security', type: 'duration', value: 43200000, description: 'Session lifetime in milliseconds (12h).' },
  { key: 'security.lockout_threshold', group: 'security', type: 'number', value: 5, description: 'Failed logins before lockout.', isReadonly: true },

  { key: 'notification.email_enabled', group: 'notification', type: 'boolean', value: true, description: 'Allow outbound email to tenant users.' },
  { key: 'notification.in_app_enabled', group: 'notification', type: 'boolean', value: true, description: 'Allow in-app notifications.' },

  { key: 'email.from_name', group: 'email', type: 'string', value: 'Saas Analytics', description: 'Outbound email sender name.' },
  { key: 'email.from_address', group: 'email', type: 'string', value: 'no-reply@saas-analytics.local', description: 'Outbound email sender address.' },
  { key: 'email.smtp_host', group: 'email', type: 'string', value: '', description: 'SMTP relay host.' },
  { key: 'email.smtp_port', group: 'email', type: 'number', value: 587, description: 'SMTP relay port.' },
  { key: 'email.smtp_user', group: 'email', type: 'string', value: '', description: 'SMTP username.' },
  { key: 'email.smtp_password', group: 'email', type: 'string', value: '', description: 'SMTP password.', isSecret: true },

  { key: 'billing.trial_days', group: 'billing', type: 'number', value: 14, description: 'Trial period length in days.', isReadonly: true },
  { key: 'billing.auto_renew', group: 'billing', type: 'boolean', value: true, description: 'Auto-renew the subscription.' },

  { key: 'storage.max_bytes_per_tenant', group: 'storage', type: 'number', value: 5368709120, description: 'Storage cap in bytes (5GB).', isReadonly: true },
  { key: 'storage.retention_days', group: 'storage', type: 'number', value: 30, description: 'Retention window in days before purge.', isReadonly: true },
]);

/* ------------------------------ internals ------------------------------ */

function defaultsForGroup(group) {
  return DEFAULT_SETTINGS.filter((setting) => setting.group === group);
}

function assertGroup(group) {
  if (!SETTINGS_GROUPS.includes(group)) throw ApiError.badRequest(`Invalid settings group "${group}"`);
}

/**
 * Per-key value rules applied before a tenant override is stored. Returns
 * the value to persist (normalised) or throws a 400 with a field error.
 */
const VALUE_RULES = Object.freeze({
  [TIMEZONE_SETTING_KEY]: (value) => {
    if (!isValidTimeZone(value)) {
      throw ApiError.badRequest('Invalid time zone', [
        { field: TIMEZONE_SETTING_KEY, message: 'must be an IANA time zone name such as "Europe/Berlin" or "UTC"' },
      ]);
    }
    return normalizeTimeZone(value);
  },
});

/** Effective view: tenant override > platform row > built-in default. */
async function effectiveGroup({ tenantId, group, includeSecrets }) {
  const defaults = defaultsForGroup(group);
  const [tenantRows, platformRows] = await Promise.all([
    settingRepository.list({ scope: 'tenant', tenantId, group, page: 1, limit: 500 }),
    settingRepository.list({ scope: 'platform', group, page: 1, limit: 500 }),
  ]);
  const byKey = new Map();
  for (const setting of defaults) byKey.set(setting.key, { ...setting, source: 'default' });
  for (const setting of platformRows.docs) byKey.set(setting.key, { ...setting, source: 'platform' });
  for (const setting of tenantRows.docs) byKey.set(setting.key, { ...setting, source: 'tenant' });
  const sorted = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  return Promise.all(sorted.map((setting) => presentSetting(setting, { includeSecrets })));
}

/** Keys in `values` that are secret settings of `group` (need `settings.secrets.update`). */
export function secretKeysIn(group, values) {
  if (!values || typeof values !== 'object') return [];
  const secrets = new Set(defaultsForGroup(group).filter((s) => s.isSecret).map((s) => s.key));
  return Object.keys(values).filter((key) => secrets.has(key));
}

/* ------------------------------ public API ------------------------------ */

/**
 * Idempotently seed the platform defaults (called at every onboarding).
 * Only missing rows are created: a platform value changed by an admin
 * through `/api/v1/settings` is never reset by a later onboarding.
 */
export const initialize = async ({ by = 'system' } = {}) => {
  for (const setting of DEFAULT_SETTINGS) {
    await settingRepository.insertIfAbsent({
      key: setting.key,
      scope: 'platform',
      tenantId: null,
      type: setting.type,
      value: setting.isSecret ? '' : setting.value,
      description: setting.description,
      isSecret: setting.isSecret ?? false,
      isReadonly: setting.isReadonly ?? false,
      group: setting.group,
      updatedBy: by,
    });
  }
  return { seeded: true };
};

/** Every group name (the tenant settings navigation). */
export const listGroups = async () => SETTINGS_GROUPS;

/** Effective settings for one group, or all groups when `group` is omitted. */
export const getGroup = async ({ tenantId, group, includeSecrets = false }) => {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (group === 'feature_flags') {
    const flags = await featureFlagService.resolveForTenant(tenantId);
    return Object.entries(flags).map(([key, value]) => ({
      key, group: 'feature_flags', type: 'boolean', value, description: '', isSecret: false, isReadonly: false, source: 'flag',
    }));
  }
  if (group) {
    assertGroup(group);
    return effectiveGroup({ tenantId, group, includeSecrets });
  }
  const out = {};
  for (const name of SETTINGS_GROUPS) {
    if (name === 'feature_flags') {
      const flags = await featureFlagService.resolveForTenant(tenantId);
      out[name] = Object.entries(flags).map(([key, value]) => ({
        key, group: name, type: 'boolean', value, description: '', isSecret: false, isReadonly: false, source: 'flag',
      }));
      continue;
    }
    out[name] = await effectiveGroup({ tenantId, group: name, includeSecrets });
  }
  return out;
};

/**
 * Upsert tenant overrides for a group. `values` is `{ [key]: value }`.
 * Unknown keys and read-only keys are rejected.
 */
export const updateGroup = async ({ tenantId, group, values, by = null }) => {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  assertGroup(group);
  if (group === 'feature_flags') {
    return updateFeatureFlags({ tenantId, values, by });
  }
  const defaults = new Map(defaultsForGroup(group).map((setting) => [setting.key, setting]));
  const touchesTimezone = Object.prototype.hasOwnProperty.call(values, TIMEZONE_SETTING_KEY);
  const timezoneBefore = touchesTimezone ? await getTimezone(tenantId) : null;
  for (const [key, value] of Object.entries(values)) {
    const definition = defaults.get(key);
    if (!definition) throw ApiError.badRequest(`Unknown setting "${key}" in group "${group}"`);
    if (definition.isReadonly) throw ApiError.forbidden(`Setting "${key}" is read-only`);
    const ruled = VALUE_RULES[key] ? VALUE_RULES[key](value) : value;
    const stored = validateSettingValue(definition, ruled);
    const secret = definition.isSecret
      ? await settingService.sealSecretValue({ scope: 'tenant', tenantId, key, value: stored })
      : undefined;
    await settingRepository.upsertByKey({
      key,
      scope: 'tenant',
      tenantId,
      type: definition.type,
      value: definition.isSecret ? '' : stored,
      ...(definition.isSecret ? { secret } : {}),
      description: definition.description,
      isSecret: definition.isSecret ?? false,
      isReadonly: definition.isReadonly ?? false,
      group,
      updatedBy: by,
    });
    await settingService.invalidateEffective('tenant', tenantId, key);
  }
  if (touchesTimezone && (await getTimezone(tenantId)) !== timezoneBefore) {
    await reprojectSchedules(tenantId);
  }
  // Secrets are never echoed back in plaintext after a write.
  return effectiveGroup({ tenantId, group, includeSecrets: false });
};

/**
 * Re-project report and alert schedules that follow the workspace time
 * zone. Best-effort: the setting is already stored, and every schedule is
 * re-projected in the effective zone at its next run anyway. Imported lazily
 * because both services read the time zone from this module.
 */
async function reprojectSchedules(tenantId) {
  try {
    const [reportService, alertService] = await Promise.all([
      import('./report.service.js'),
      import('./alert.service.js'),
    ]);
    await Promise.allSettled([
      reportService.reprojectSchedules({ tenantId: String(tenantId) }),
      alertService.reprojectSchedules({ tenantId: String(tenantId) }),
    ]);
  } catch {
    // best-effort; see above.
  }
}

/**
 * The workspace's effective IANA time zone (tenant override > platform >
 * `UTC`). Never throws: an unreadable or invalid stored value falls back to
 * UTC so analytics keep working. Cached for 60s by `resolveEffective`.
 */
export const getTimezone = async (tenantId) => {
  if (!tenantId) return DEFAULT_TIMEZONE;
  try {
    const value = await settingService.resolveEffective(TIMEZONE_SETTING_KEY, { tenantId: String(tenantId) });
    return normalizeTimeZone(value, DEFAULT_TIMEZONE);
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

/** Validate and store the workspace time zone. Returns the stored name. */
export const setTimezone = async ({ tenantId, timezone, by = null }) => {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  await updateGroup({ tenantId, group: 'localization', values: { [TIMEZONE_SETTING_KEY]: timezone }, by });
  return getTimezone(tenantId);
};

// mfa-tenant: the workspace "MFA required" policy (`security.mfa_required`).
/** Setting key holding the workspace MFA policy. */
export const MFA_REQUIRED_SETTING_KEY = 'security.mfa_required';

/**
 * Whether the workspace requires MFA for every member (tenant override >
 * platform > `false`). Unlike the time zone this FAILS CLOSED: a lookup
 * error propagates, so a login that cannot read the policy fails.
 */
export const getMfaRequired = async (tenantId) => {
  if (!tenantId) return false;
  const value = await settingService.resolveEffective(MFA_REQUIRED_SETTING_KEY, { tenantId: String(tenantId) });
  return value === true || value === 'true';
};

/** Store the workspace MFA policy. Returns the effective value. */
export const setMfaRequired = async ({ tenantId, required, by = null }) => {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  await updateGroup({ tenantId, group: 'security', values: { [MFA_REQUIRED_SETTING_KEY]: Boolean(required) }, by });
  return getMfaRequired(tenantId);
};

/* ------------------------------ internals ------------------------------ */

/** Grant/revoke a feature flag for a single tenant. */
async function updateFeatureFlags({ tenantId, values, by }) {
  const updated = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'boolean') throw ApiError.badRequest(`Flag "${key}" expects a boolean`);
    const flag = await featureFlagService.getByKey(key);
    const rollout = { ...flag.rollout, tenantIds: [...(flag.rollout.tenantIds ?? [])] };
    if (value) {
      if (flag.rollout.strategy === 'all') continue; // already on for everyone
      if (rollout.strategy !== 'tenantId') {
        throw ApiError.badRequest(
          `Flag "${key}" uses strategy "${flag.rollout.strategy}"; per-tenant grant requires "tenantId"`,
        );
      }
      if (!rollout.tenantIds.includes(tenantId)) rollout.tenantIds.push(tenantId);
    } else {
      rollout.tenantIds = rollout.tenantIds.filter((id) => id !== tenantId);
      if (flag.rollout.strategy === 'all') {
        throw ApiError.badRequest(
          `Flag "${key}" is on for all tenants; revoking a single tenant is not supported`,
        );
      }
    }
    updated.push(await featureFlagService.update(flag._id, { rollout }, by));
  }
  // The value is what THIS tenant now gets, not the flag's master switch.
  return updated.map((flag) => ({ key: flag.key, group: 'feature_flags', type: 'boolean', value: featureFlagService.evaluateFlag(flag, tenantId), isSecret: false, isReadonly: false }));
}

export default {
  initialize,
  listGroups,
  getGroup,
  updateGroup,
  secretKeysIn,
  getTimezone,
  setTimezone,
  // mfa-tenant
  getMfaRequired,
  setMfaRequired,
  MFA_REQUIRED_SETTING_KEY,
  TIMEZONE_SETTING_KEY,
  SETTINGS_GROUPS,
  DEFAULT_SETTINGS,
  _meta: { tenancy: 'tenant', inheritance: 'tenant > platform > default' },
};
