/**
 * Threshold parameter types for the security detection rules (roadmap 2.6).
 *
 * Every rule declares `params` (name -> type) next to its `defaults`.
 * Overrides from `SECURITY_DETECTION_RULES_JSON` and the platform setting
 * `security.detection.rules` are checked against these declarations: an
 * unknown parameter, a wrong type or an out-of-range value is IGNORED (and
 * reported by the rules catalogue), never applied, so a typo cannot switch
 * a rule off or make it fire on everything.
 */

export const int = (min, max) => ({ type: 'int', min, max });
export const number = (min, max) => ({ type: 'number', min, max });
export const bool = () => ({ type: 'bool' });
export const strings = ({ maxItems = 20, maxLength = 100, pattern = null } = {}) => ({
  type: 'strings', maxItems, maxLength, pattern,
});
export const ints = (min, max, { maxItems = 20 } = {}) => ({ type: 'ints', min, max, maxItems });
export const timeZone = () => ({ type: 'timeZone' });

/** Parameters every rule accepts. */
export const COMMON_PARAMS = Object.freeze({ enabled: bool() });

function isValidTimeZone(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

/**
 * Check one value against a parameter declaration.
 *
 * @returns {{ ok: true, value: unknown } | { ok: false, reason: string }}
 */
export function checkParam(spec, value) {
  switch (spec.type) {
    case 'bool':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, reason: 'must be true or false' };
    case 'int':
    case 'number': {
      const ok = typeof value === 'number' && Number.isFinite(value) && (spec.type === 'number' || Number.isInteger(value));
      if (!ok) return { ok: false, reason: `must be ${spec.type === 'int' ? 'an integer' : 'a number'}` };
      if (spec.min !== undefined && value < spec.min) return { ok: false, reason: `must be >= ${spec.min}` };
      if (spec.max !== undefined && value > spec.max) return { ok: false, reason: `must be <= ${spec.max}` };
      return { ok: true, value };
    }
    case 'strings': {
      if (!Array.isArray(value) || value.length > spec.maxItems) {
        return { ok: false, reason: `must be a list of at most ${spec.maxItems} strings` };
      }
      const pattern = spec.pattern ? new RegExp(spec.pattern) : null;
      for (const item of value) {
        if (typeof item !== 'string' || item.length === 0 || item.length > spec.maxLength) {
          return { ok: false, reason: `items must be strings of 1-${spec.maxLength} characters` };
        }
        if (pattern && !pattern.test(item)) return { ok: false, reason: 'items do not match the required pattern' };
      }
      return { ok: true, value: [...value] };
    }
    case 'ints': {
      if (!Array.isArray(value) || value.length > spec.maxItems) {
        return { ok: false, reason: `must be a list of at most ${spec.maxItems} integers` };
      }
      for (const item of value) {
        if (!Number.isInteger(item) || item < spec.min || item > spec.max) {
          return { ok: false, reason: `items must be integers between ${spec.min} and ${spec.max}` };
        }
      }
      return { ok: true, value: [...value] };
    }
    case 'timeZone':
      return isValidTimeZone(value) ? { ok: true, value } : { ok: false, reason: 'must be an IANA time zone' };
    default:
      return { ok: false, reason: 'unsupported parameter type' };
  }
}

/**
 * Apply `overrides` (one rule's object) on top of `base`.
 *
 * @param {{ params: Object }} rule
 * @param {Object} base
 * @param {unknown} overrides
 * @param {string} origin - `env` | `setting` (for the ignored report).
 * @returns {{ config: Object, ignored: Array<{ origin: string, param: string, reason: string }> }}
 */
export function applyOverrides(rule, base, overrides, origin) {
  const config = { ...base };
  const ignored = [];
  if (overrides === undefined || overrides === null) return { config, ignored };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    ignored.push({ origin, param: '*', reason: 'overrides must be an object' });
    return { config, ignored };
  }
  const specs = { ...COMMON_PARAMS, ...(rule.params ?? {}) };
  for (const [param, value] of Object.entries(overrides)) {
    const spec = specs[param];
    if (!spec) {
      ignored.push({ origin, param, reason: 'unknown parameter' });
      continue;
    }
    const checked = checkParam(spec, value);
    if (!checked.ok) {
      ignored.push({ origin, param, reason: checked.reason });
      continue;
    }
    config[param] = checked.value;
  }
  return { config, ignored };
}

export default { int, number, bool, strings, ints, timeZone, COMMON_PARAMS, checkParam, applyOverrides };
