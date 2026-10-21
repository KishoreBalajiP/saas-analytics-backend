/**
 * Setting value rules (roadmap 2.4 - implemented).
 *
 * PURPOSE
 *   Per-key schema validation for typed settings. Every write - the
 *   platform-admin settings surface (`/api/v1/settings`) and tenant
 *   overrides (`/tenants/:id/settings`, workspace settings) - runs the value
 *   through `validateSettingValue` before it is stored, so a bad value is
 *   rejected with a 400 and a field error instead of being persisted.
 *
 * SHAPE
 *   `validateSettingValue(definition, value)` takes the setting definition
 *   (`{ key, type, ... }` from the catalogue) and returns the normalised
 *   value to store, or throws `ApiError` 400 with
 *   `errors: [{ field: <setting key>, message }]`.
 *
 * HOW TO EXTEND
 *   Add a rule to `SETTING_RULES` when a key is added to the catalogue.
 *   Keys without a rule are still checked against their declared `type`.
 *   This module has no service imports so any settings service can use it.
 */

import ApiError from '../utils/ApiError.js';
import { isValidTimeZone, normalizeTimeZone } from '../utils/timezone.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_FORMAT_RE = /^(?:YYYY|MM|DD)(?:[-/. ](?:YYYY|MM|DD)){2}$/;
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MAX_JSON_BYTES = 10_000;

/** Per-key rules. `format` adds a semantic check on top of the type. */
export const SETTING_RULES = Object.freeze({
  'general.contact_email': { format: 'email', allowEmpty: true, maxLength: 254 },
  'general.maintenance_notice': { maxLength: 500 },

  'localization.timezone': { format: 'timezone' },
  'localization.locale': { format: 'locale' },
  'localization.currency': { format: 'currency' },
  'localization.date_format': { format: 'dateFormat' },

  'branding.primary_color': { format: 'hexColor' },
  'branding.accent_color': { format: 'hexColor' },
  'branding.logo_url': { format: 'httpsUrl', allowEmpty: true, maxLength: 2048 },

  'security.password_min_length': { integer: true, min: 8, max: 128 },
  'security.session_ttl': { integer: true, min: 300_000, max: 2_592_000_000 },
  'security.lockout_threshold': { integer: true, min: 3, max: 20 },

  'email.from_name': { minLength: 1, maxLength: 100, singleLine: true },
  'email.from_address': { format: 'email', maxLength: 254 },
  'email.smtp_host': { format: 'hostname', allowEmpty: true },
  'email.smtp_port': { integer: true, min: 1, max: 65535 },
  'email.smtp_user': { maxLength: 254, singleLine: true },
  'email.smtp_password': { maxLength: 512, singleLine: true, noTrim: true },

  'billing.trial_days': { integer: true, min: 0, max: 365 },

  'storage.max_bytes_per_tenant': { integer: true, min: 0 },
  'storage.retention_days': { integer: true, min: 1, max: 3650 },
});

function invalid(key, message) {
  return ApiError.badRequest(`Invalid value for setting "${key}"`, [{ field: key, message }]);
}

function checkLocale(value) {
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function checkCurrency(value) {
  if (!CURRENCY_RE.test(value)) return false;
  try {
    const known = Intl.supportedValuesOf?.('currency');
    return Array.isArray(known) && known.length > 0 ? known.includes(value) : true;
  } catch {
    return true;
  }
}

function checkHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Apply a `format` rule to a string. Returns the normalised value. */
function applyFormat(key, format, value) {
  switch (format) {
    case 'email': {
      const v = value.toLowerCase();
      if (!EMAIL_RE.test(v)) throw invalid(key, 'must be a valid email address');
      return v;
    }
    case 'timezone':
      if (!isValidTimeZone(value)) {
        throw invalid(key, 'must be an IANA time zone name such as "Europe/Berlin" or "UTC"');
      }
      return normalizeTimeZone(value);
    case 'locale':
      if (!checkLocale(value)) throw invalid(key, 'must be a BCP-47 locale such as "en" or "en-GB"');
      return Intl.getCanonicalLocales(value)[0];
    case 'currency': {
      const v = value.toUpperCase();
      if (!checkCurrency(v)) throw invalid(key, 'must be an ISO-4217 currency code such as "USD"');
      return v;
    }
    case 'dateFormat': {
      const tokens = value.split(/[-/. ]/);
      if (!DATE_FORMAT_RE.test(value) || new Set(tokens).size !== 3) {
        throw invalid(key, 'must combine YYYY, MM and DD once each, separated by "-", "/", "." or a space');
      }
      return value;
    }
    case 'hexColor':
      if (!HEX_COLOR_RE.test(value)) throw invalid(key, 'must be a hex colour such as "#2563eb"');
      return value.toLowerCase();
    case 'httpsUrl':
      if (!checkHttpsUrl(value)) throw invalid(key, 'must be an https:// URL without credentials');
      return value;
    case 'hostname':
      if (!HOSTNAME_RE.test(value)) throw invalid(key, 'must be a host name such as "smtp.example.com"');
      return value.toLowerCase();
    default:
      return value;
  }
}

function validateString(key, value, rule) {
  if (typeof value !== 'string') throw invalid(key, 'must be a string');
  // Secrets keep their exact characters; everything else is trimmed.
  const v = rule.noTrim ? value : value.trim();
  if (v === '' && rule.allowEmpty) return '';
  if (CONTROL_RE.test(v)) throw invalid(key, 'must not contain control characters');
  if (rule.singleLine && /[\r\n]/.test(v)) throw invalid(key, 'must be a single line');
  if (rule.minLength !== undefined && v.length < rule.minLength) {
    throw invalid(key, `must be at least ${rule.minLength} characters`);
  }
  if (rule.maxLength !== undefined && v.length > rule.maxLength) {
    throw invalid(key, `must be at most ${rule.maxLength} characters`);
  }
  if (v === '' && rule.format && !rule.allowEmpty) throw invalid(key, 'is required');
  return rule.format ? applyFormat(key, rule.format, v) : v;
}

function toNumber(key, value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(key, 'must be a finite number');
    return value;
  }
  if (typeof value === 'string' && NUMERIC_RE.test(value.trim())) return Number(value.trim());
  throw invalid(key, 'must be a number');
}

function validateNumber(key, value, rule, { duration = false } = {}) {
  const n = toNumber(key, value);
  if ((rule.integer || duration) && !Number.isInteger(n)) throw invalid(key, 'must be a whole number');
  if (duration && n < 0) throw invalid(key, 'must be a non-negative number of milliseconds');
  if (rule.min !== undefined && n < rule.min) throw invalid(key, `must be at least ${rule.min}`);
  if (rule.max !== undefined && n > rule.max) throw invalid(key, `must be at most ${rule.max}`);
  return n;
}

function validateBoolean(key, value) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw invalid(key, 'must be true or false');
}

function validateJson(key, value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw invalid(key, 'must be valid JSON');
    }
  }
  if (parsed === undefined) throw invalid(key, 'is required');
  let size;
  try {
    size = Buffer.byteLength(JSON.stringify(parsed));
  } catch {
    throw invalid(key, 'must be JSON-serialisable');
  }
  if (size > MAX_JSON_BYTES) throw invalid(key, `must be at most ${MAX_JSON_BYTES} bytes of JSON`);
  return parsed;
}

/**
 * Validate and normalise a value for a catalogue setting.
 *
 * @param {{ key: string, type: string }} definition
 * @param {*} value
 * @returns {*} the value to store.
 * @throws {ApiError} 400 with `errors: [{ field: key, message }]`.
 */
export function validateSettingValue(definition, value) {
  const { key, type } = definition;
  const rule = SETTING_RULES[key] ?? {};
  if (value === undefined || value === null) throw invalid(key, 'is required');
  switch (type) {
    case 'string':
      return validateString(key, value, rule);
    case 'number':
      return validateNumber(key, value, rule);
    case 'duration':
      return validateNumber(key, value, rule, { duration: true });
    case 'boolean':
      return validateBoolean(key, value);
    case 'json':
      return validateJson(key, value);
    default:
      throw invalid(key, `has an unsupported type "${type}"`);
  }
}

export default { SETTING_RULES, validateSettingValue };
