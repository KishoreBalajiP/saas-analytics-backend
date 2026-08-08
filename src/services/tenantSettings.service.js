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
 *
 * CODING GUIDELINES
 *   - Effective resolution NEVER materialises a tenant row unless an
 *     admin overrides something: the default (built-in) and platform rows
 *     are the fallbacks, so a fresh tenant has zero settings rows.
 *   - `isSecret` values are redacted unless `includeSecrets` (platform
 *     admins); redaction is delegated to `setting.service.redactSetting`.
 *   - Read-only keys are hard-rejected on tenant overrides (forbid), so a
 *     tenant can never clobber a platform-policed value.
 */

import ApiError from '../utils/ApiError.js';
import * as settingRepository from '../repositories/setting.repository.js';
import * as settingService from './setting.service.js';
import { redactSetting } from './setting.service.js';
import * as featureFlagService from './featureFlag.service.js';

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
  return [...byKey.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((setting) => redactSetting(setting, includeSecrets));
}

/* ------------------------------ public API ------------------------------ */

/** Idempotently seed the platform defaults (called once at onboarding). */
export const initialize = async ({ by = 'system' } = {}) => {
  for (const setting of DEFAULT_SETTINGS) {
    await settingRepository.upsertByKey({
      key: setting.key,
      scope: 'platform',
      type: setting.type,
      value: setting.value,
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
    out[name] = await effectiveGroup({ tenantId, name, includeSecrets });
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
  for (const [key, value] of Object.entries(values)) {
    const definition = defaults.get(key);
    if (!definition) throw ApiError.badRequest(`Unknown setting "${key}" in group "${group}"`);
    if (definition.isReadonly) throw ApiError.forbidden(`Setting "${key}" is read-only`);
    await settingRepository.upsertByKey({
      key,
      scope: 'tenant',
      tenantId,
      type: definition.type,
      value,
      description: definition.description,
      isSecret: definition.isSecret ?? false,
      isReadonly: definition.isReadonly ?? false,
      group,
      updatedBy: by,
    });
    await settingService.invalidateEffective('tenant', tenantId, key);
  }
  return effectiveGroup({ tenantId, group, includeSecrets: true });
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
  return updated.map((flag) => ({ key: flag.key, group: 'feature_flags', type: 'boolean', value: flag.enabled, isSecret: false, isReadonly: false }));
}

export default {
  initialize,
  listGroups,
  getGroup,
  updateGroup,
  SETTINGS_GROUPS,
  DEFAULT_SETTINGS,
  _meta: { tenancy: 'tenant', inheritance: 'tenant > platform > default' },
};
