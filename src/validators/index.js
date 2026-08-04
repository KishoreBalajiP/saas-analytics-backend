/**
 * Dependency-free request validation engine.
 *
 * WHY IT EXISTS
 *   Every future feature needs to validate `body / params / query`. This
 *   small schema engine gives consistent 422 errors without pulling in a
 *   framework dependency, and is trivially swappable if the team later
 *   standardises on zod / joi.
 *
 * RESPONSIBILITY
 *   Export `validate(schema)` - a middleware factory that checks input
 *   against a declarative schema, sanitises/coerces values, and attaches
 *   the cleaned result at `req.validated`.
 *
 * HOW TO EXTEND
 *   Add a new type to the `checkValue` switch. Schemas are declared next to
 *   their feature, e.g. `src/modules/auth/auth.validator.js`, and passed to
 *   `validate()` in the route file.
 */

import ApiError from '../utils/ApiError.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const VALID_SOURCES = new Set(['body', 'params', 'query']);

/** Accept either a shorthand string (`'string|required'`) or a rules object. */
function parseRules(rules) {
  if (typeof rules === 'string') {
    const parts = rules.split('|').filter(Boolean);
    return { type: parts[0] || 'string', required: parts.includes('required') };
  }
  return rules ?? {};
}

function addError(errors, field, message) {
  errors.push({ field, message });
}

/**
 * Validate a single value against its rules.
 * @returns the coerced value, or `undefined` when the field should be dropped.
 */
function checkValue(field, raw, rules, errors) {
  const { type = 'string', required = false, message } = rules;
  const isEmpty = raw === undefined || raw === null || raw === '';

  if (isEmpty) {
    if (required) addError(errors, field, message || `${field} is required`);
    return undefined;
  }

  const fail = (msg) => addError(errors, field, message || msg || `${field} is invalid`);

  let value = raw;

  switch (type) {
    case 'string': {
      value = String(raw).trim();
      if (rules.minLength && value.length < rules.minLength) fail(`${field} must be at least ${rules.minLength} characters`);
      if (rules.maxLength && value.length > rules.maxLength) fail(`${field} must be at most ${rules.maxLength} characters`);
      if (rules.pattern && !new RegExp(rules.pattern).test(value)) fail(`${field} does not match the required pattern`);
      break;
    }
    case 'number': {
      value = Number(raw);
      if (!Number.isFinite(value)) return fail(`${field} must be a number`);
      if (rules.min !== undefined && value < rules.min) fail(`${field} must be >= ${rules.min}`);
      if (rules.max !== undefined && value > rules.max) fail(`${field} must be <= ${rules.max}`);
      break;
    }
    case 'integer': {
      value = Number(raw);
      if (!Number.isInteger(value)) return fail(`${field} must be an integer`);
      if (rules.min !== undefined && value < rules.min) fail(`${field} must be >= ${rules.min}`);
      if (rules.max !== undefined && value > rules.max) fail(`${field} must be <= ${rules.max}`);
      break;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') value = raw;
      else if (raw === 'true' || raw === '1') value = true;
      else if (raw === 'false' || raw === '0') value = false;
      else return fail(`${field} must be a boolean`);
      break;
    }
    case 'email': {
      value = String(raw).trim().toLowerCase();
      if (!EMAIL_RE.test(value)) return fail(`${field} must be a valid email`);
      break;
    }
    case 'url': {
      value = String(raw).trim();
      try {
        new URL(value); // eslint-disable-line no-new
      } catch {
        return fail(`${field} must be a valid URL`);
      }
      break;
    }
    case 'uuid': {
      value = String(raw);
      if (!UUID_RE.test(value)) return fail(`${field} must be a valid UUID`);
      break;
    }
    case 'objectId': {
      value = String(raw);
      if (!OBJECT_ID_RE.test(value)) return fail(`${field} must be a valid ObjectId`);
      break;
    }
    case 'date': {
      value = new Date(raw);
      if (Number.isNaN(value.getTime())) return fail(`${field} must be a valid date`);
      break;
    }
    case 'array':
      if (!Array.isArray(raw)) return fail(`${field} must be an array`);
      value = raw;
      break;
    case 'object':
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return fail(`${field} must be an object`);
      }
      value = raw;
      break;
    case 'any':
      value = raw;
      break;
    default:
      return addError(errors, field, `Unknown validation type "${type}" for ${field}`);
  }

  if (rules.oneOf && !rules.oneOf.includes(value)) {
    return fail(`${field} must be one of: ${rules.oneOf.join(', ')}`);
  }
  if (typeof rules.custom === 'function') {
    const result = rules.custom(value);
    if (result !== true) return fail(typeof result === 'string' ? result : `${field} failed custom validation`);
  }

  return value;
}

/**
 * Middleware factory.
 *
 * @param {Object} schema - `{ body?, params?, query? }`, each an object of
 *   `field -> rules`. Validated values are exposed as `req.validated`.
 */
export function validate(schema = {}) {
  return (req, _res, next) => {
    const errors = [];
    const validated = {};

    for (const [source, fieldRules] of Object.entries(schema)) {
      if (!VALID_SOURCES.has(source)) continue;
      const input = req[source] || {};
      const result = {};
      for (const [field, rules] of Object.entries(fieldRules)) {
        const parsed = checkValue(field, input[field], parseRules(rules), errors);
        if (parsed !== undefined) result[field] = parsed;
      }
      validated[source] = result;
    }

    if (errors.length > 0) {
      return next(ApiError.validation('Validation failed', errors));
    }

    req.validated = validated;
    return next();
  };
}
