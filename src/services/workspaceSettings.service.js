/**
 * Workspace Settings Service (tenant self-service).
 *
 * PURPOSE
 *   The tenant-facing slice of tenant settings that workspace members manage
 *   themselves (the platform-admin surface stays at /tenants/:id/settings).
 *   Today this is the workspace time zone (`localization.timezone`), which
 *   decides what "today", "last month" and "every Monday at 08:00" mean for
 *   analytics presets, report schedules and alert schedules.
 *
 * RESPONSIBILITY
 *   - get({ tenantId })                      -> { timezone }
 *   - update({ tenantId, actorId, patch })   -> { timezone }
 *     Validates the IANA name, stores the override (tenantSettings, which
 *     also re-projects the next run of every report/alert schedule that
 *     follows the workspace zone), and writes an audit event.
 */

import ApiError from '../utils/ApiError.js';
import * as tenantSettings from './tenantSettings.service.js';
import * as auditLogService from './auditLog.service.js';

/** Fields a workspace may change here. */
export const WORKSPACE_SETTING_FIELDS = Object.freeze(['timezone']);

/** Effective workspace settings. */
export async function get({ tenantId } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  return { timezone: await tenantSettings.getTimezone(tenantId) };
}

/** Update workspace settings (strict: unknown fields are rejected). */
export async function update({ tenantId, actorId = null, patch = {} } = {}) {
  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw ApiError.badRequest('Invalid workspace settings', [{ field: 'body', message: 'must be an object' }]);
  }
  const unknown = Object.keys(patch).filter((key) => !WORKSPACE_SETTING_FIELDS.includes(key));
  if (unknown.length) {
    throw ApiError.badRequest('Invalid workspace settings', unknown.map((field) => ({ field, message: 'is not a recognised setting' })));
  }
  const before = await get({ tenantId });
  if (patch.timezone === undefined) return before;
  if (typeof patch.timezone !== 'string') {
    throw ApiError.badRequest('Invalid workspace settings', [{ field: 'timezone', message: 'must be an IANA time zone name' }]);
  }

  let timezone;
  try {
    timezone = await tenantSettings.setTimezone({ tenantId, timezone: patch.timezone, by: actorId });
  } catch (err) {
    // Re-key the settings-level field error onto this API's field name.
    if (err instanceof ApiError && err.statusCode === 400) {
      throw ApiError.badRequest('Invalid workspace settings', [{ field: 'timezone', message: 'must be an IANA time zone name such as "Europe/Berlin" or "UTC"' }]);
    }
    throw err;
  }

  if (timezone !== before.timezone) {
    try {
      await auditLogService.emit({
        actor: actorId ? { type: 'user', id: String(actorId) } : { type: 'system', id: 'system' },
        action: 'settings.updated',
        module: 'settings',
        resource: { type: 'tenant_setting', id: tenantSettings.TIMEZONE_SETTING_KEY },
        before: { timezone: before.timezone },
        after: { timezone },
        tenantId: String(tenantId),
      });
    } catch {
      // best-effort trail write; the setting is already stored.
    }
  }
  return { timezone };
}

export default { get, update, WORKSPACE_SETTING_FIELDS };
