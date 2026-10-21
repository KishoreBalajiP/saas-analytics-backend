/**
 * Setting Controller (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   HTTP layer for the platform settings surface (`/api/v1/settings`): the
 *   PLATFORM value of every catalogue setting, which tenants inherit unless
 *   they override it. Business rules live in
 *   `services/platformSettings.service.js`.
 *
 * RESPONSIBILITY
 *   - listSettings, getSetting           (settings.view)
 *   - updateSetting, resetSetting,
 *     rollbackSetting                    (settings.update; secrets also need
 *                                         settings.secrets.update)
 *   - settingHistory                     (settings.view)
 *   - revealSecret                       (settings.secrets.view, audited)
 *
 * CODING GUIDELINES
 *   - The actor comes from the token, never from the body.
 *   - `value` is read from the raw body: the generic validator drops empty
 *     strings, which are legitimate values (clearing an optional setting).
 *   - A revealed secret is sent with `Cache-Control: no-store`.
 */

import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import platformSettingsService from '../services/platformSettings.service.js';
import { actorHasPermission } from '../middleware/configAccess.middleware.js';

const SECRETS_UPDATE = 'settings.secrets.update';

function actorOf(req) {
  return { type: 'admin', id: req.admin?.id ?? null, email: req.admin?.email ?? null };
}

/** GET /settings - every platform setting (secrets masked). */
export const listSettings = asyncHandler(async (req, res) => {
  const { group, search } = req.validated?.query ?? {};
  const settings = await platformSettingsService.list({ group, search });
  return ApiResponse.ok(res, settings, 'Platform settings fetched', {
    total: settings.length,
    groups: platformSettingsService.groups(),
  });
});

/** GET /settings/:key - one platform setting (secret masked). */
export const getSetting = asyncHandler(async (req, res) => {
  const setting = await platformSettingsService.get(req.validated.params.key);
  return ApiResponse.ok(res, setting, 'Platform setting fetched');
});

/** PUT /settings/:key - change the platform value. */
export const updateSetting = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const raw = req.body ?? {};
  if (!Object.prototype.hasOwnProperty.call(raw, 'value')) {
    throw ApiError.badRequest('Invalid value', [{ field: 'value', message: 'value is required' }]);
  }
  const setting = await platformSettingsService.update({
    key: req.validated.params.key,
    value: raw.value,
    version: body.version,
    reason: body.reason ?? null,
    actor: actorOf(req),
    canWriteSecrets: await actorHasPermission(req, SECRETS_UPDATE),
  });
  return ApiResponse.ok(res, setting, 'Platform setting updated');
});

/** POST /settings/:key/reset - back to the built-in default. */
export const resetSetting = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const setting = await platformSettingsService.reset({
    key: req.validated.params.key,
    version: body.version,
    reason: body.reason ?? null,
    actor: actorOf(req),
    canWriteSecrets: await actorHasPermission(req, SECRETS_UPDATE),
  });
  return ApiResponse.ok(res, setting, 'Platform setting reset to its default');
});

/** GET /settings/:key/history - versions, newest first (secret-free). */
export const settingHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.validated?.query ?? {};
  const result = await platformSettingsService.history({ key: req.validated.params.key, page, limit });
  return ApiResponse.ok(res, result.docs, 'Setting history fetched', {
    page: result.page,
    limit: result.limit,
    total: result.total,
    pages: result.pages,
  });
});

/** POST /settings/:key/rollback - restore the exact value of a version. */
export const rollbackSetting = asyncHandler(async (req, res) => {
  const body = req.validated?.body ?? {};
  const setting = await platformSettingsService.rollback({
    key: req.validated.params.key,
    toVersion: body.toVersion,
    version: body.version,
    reason: body.reason ?? null,
    actor: actorOf(req),
    canWriteSecrets: await actorHasPermission(req, SECRETS_UPDATE),
  });
  return ApiResponse.ok(res, setting, `Platform setting rolled back to version ${body.toVersion}`);
});

/** GET /settings/:key/secret - decrypted secret value (audited). */
export const revealSecret = asyncHandler(async (req, res) => {
  const setting = await platformSettingsService.revealSecret({
    key: req.validated.params.key,
    actor: actorOf(req),
  });
  res.set('Cache-Control', 'no-store');
  return ApiResponse.ok(res, setting, 'Secret setting revealed');
});

export default {
  listSettings,
  getSetting,
  updateSetting,
  resetSetting,
  settingHistory,
  rollbackSetting,
  revealSecret,
};
