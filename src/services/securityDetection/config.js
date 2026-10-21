/**
 * Effective configuration of the security detection rules and of the
 * on-call notification targets (roadmap 2.6).
 *
 * PRECEDENCE (per rule, per parameter)
 *   code defaults (rules/*.js)
 *     < SECURITY_DETECTION_RULES_JSON           (deploy-time, env)
 *     < platform setting `security.detection.rules` (json, admin settings)
 * Invalid overrides are ignored and reported (see params.js).
 *
 * NOTIFICATION TARGETS
 *   On-call emails: platform setting `security.alerts.emails` (array or
 *   comma-separated string), else SECURITY_ALERT_EMAILS.
 *   Generic webhook: platform setting `security.alerts.webhookUrl` (store it
 *   as a secret setting), else SECURITY_ALERT_WEBHOOK_URL. Only https URLs
 *   are accepted (http only outside production); the delivery pipeline
 *   applies the egress policy before anything is sent.
 */

import env from '../../config/env.js';
import logger from '../../utils/logger.js';
import settingService from '../setting.service.js';
import { applyOverrides } from './params.js';

export const RULES_SETTING_KEY = 'security.detection.rules';
export const EMAILS_SETTING_KEY = 'security.alerts.emails';
export const WEBHOOK_SETTING_KEY = 'security.alerts.webhookUrl';
export const MAX_NOTIFY_EMAILS = 20;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readSetting(key) {
  try {
    return await settingService.resolveEffective(key);
  } catch (err) {
    logger.warn({ err: { message: err?.message }, key }, '[security-detection] could not read setting');
    return null;
  }
}

function asObject(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Effective config of every rule.
 *
 * @param {Array} rules
 * @param {Object} [options]
 * @param {Object} [options.envOverrides] - defaults to SECURITY_DETECTION_RULES_JSON.
 * @param {Object|null} [options.settingOverrides] - defaults to the platform setting.
 * @returns {Promise<Map<string, { config: Object, ignored: Array }>>}
 */
export async function resolveRuleConfigs(rules, {
  envOverrides = env.securityDetection.rules ?? {},
  settingOverrides,
} = {}) {
  const fromSetting = settingOverrides === undefined ? asObject(await readSetting(RULES_SETTING_KEY)) : asObject(settingOverrides);
  const result = new Map();
  for (const rule of rules) {
    const fromEnv = applyOverrides(rule, { ...rule.defaults }, envOverrides?.[rule.id], 'env');
    const merged = applyOverrides(rule, fromEnv.config, fromSetting?.[rule.id], 'setting');
    const ignored = [...fromEnv.ignored, ...merged.ignored];
    if (ignored.length > 0) {
      logger.warn({ rule: rule.id, ignored }, '[security-detection] ignored invalid rule overrides');
    }
    result.set(rule.id, { config: merged.config, ignored });
  }
  return result;
}

function parseEmails(value) {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list
    .map((item) => String(item).trim().toLowerCase())
    .filter((item) => EMAIL_RE.test(item))
    .slice(0, MAX_NOTIFY_EMAILS);
}

/** Accept only absolute https URLs (http outside production); never log the URL. */
export function validWebhookUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    const allowed = url.protocol === 'https:' || (url.protocol === 'http:' && !env.app.isProduction);
    if (!allowed || !url.hostname || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The webhook URL's origin only (safe to store and show). */
export function webhookOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * On-call targets for alert notifications.
 *
 * @returns {Promise<{ emails: string[], webhookUrl: string|null }>}
 */
export async function resolveNotificationTargets() {
  const settingEmails = parseEmails(await readSetting(EMAILS_SETTING_KEY));
  const emails = settingEmails && settingEmails.length > 0
    ? settingEmails
    : parseEmails(env.securityDetection.notifyEmails) ?? [];
  const settingWebhook = await readSetting(WEBHOOK_SETTING_KEY);
  const webhookUrl = validWebhookUrl(settingWebhook) ?? validWebhookUrl(env.securityDetection.webhookUrl);
  return { emails, webhookUrl };
}

export default {
  RULES_SETTING_KEY,
  EMAILS_SETTING_KEY,
  WEBHOOK_SETTING_KEY,
  resolveRuleConfigs,
  resolveNotificationTargets,
  validWebhookUrl,
  webhookOrigin,
};
