/**
 * Shared connector configuration + field-mapping validators.
 *
 * WHY IT EXISTS
 *   Providers declare what their config must look like; the create/update
 *   service and the providers themselves both call into these validators so
 *   a bad config is rejected at the API boundary AND inside the sync worker
 *   (defence in depth).
 *
 * RESPONSIBILITY
 *   - `validateConfig(type, config)` - per-type required/typed fields.
 *   - `validateFieldMapping(mapping)` - shape check for the mapping forms
 *     documented in `shared/field-mapping.js`.
 *
 * CODING GUIDELINES
 *   - Validation here is structural only - it never touches decrypted
 *     values (secrets stay inside the service/worker).
 *   - Returns `{ valid, errors }` to match the `BaseConnector.validate`
 *     contract.
 */

import { ConnectorConfigError } from './errors.js';
import env from '../../../config/env.js';
import { parseMongoUri, disallowedMongoOptions, hostPolicyViolation } from '../../../utils/netGuard.js';

/** Upper bound for a webhook connector's timestamp tolerance (seconds). */
export const MAX_WEBHOOK_TOLERANCE_SECONDS = 3600;

/**
 * Validate a connector config for the given type.
 *
 * @param {'csv'|'webhook'|string} type
 * @param {Object} [config]
 * @returns {{ valid: boolean, errors: Array<{ field: string, message: string }> }}
 */
export function validateConfig(type, config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: [{ field: 'config', message: 'config must be an object' }] };
  }

  switch (type) {
    case 'csv': {
      const errors = [];
      if (config.delimiter !== undefined && (typeof config.delimiter !== 'string' || config.delimiter.length !== 1)) {
        errors.push({ field: 'config.delimiter', message: 'delimiter must be a single character' });
      }
      if (config.hasHeader !== undefined && typeof config.hasHeader !== 'boolean') {
        errors.push({ field: 'config.hasHeader', message: 'hasHeader must be a boolean' });
      }
      return { valid: errors.length === 0, errors };
    }
    case 'webhook': {
      const errors = [];
      const secret = config.signingSecret;
      if (typeof secret !== 'string' || secret.length === 0) {
        errors.push({ field: 'config.signingSecret', message: 'signingSecret is required for webhook connectors' });
      } else if (secret.length < 16) {
        errors.push({ field: 'config.signingSecret', message: 'signingSecret must be at least 16 characters' });
      }
      if (config.toleranceSeconds !== undefined && (typeof config.toleranceSeconds !== 'number' || !Number.isFinite(config.toleranceSeconds)
        || config.toleranceSeconds <= 0 || config.toleranceSeconds > MAX_WEBHOOK_TOLERANCE_SECONDS)) {
        errors.push({ field: 'config.toleranceSeconds', message: `toleranceSeconds must be a positive number of at most ${MAX_WEBHOOK_TOLERANCE_SECONDS}` });
      }
      if (config.requireTimestamp !== undefined && typeof config.requireTimestamp !== 'boolean') {
        errors.push({ field: 'config.requireTimestamp', message: 'requireTimestamp must be a boolean' });
      }
      return { valid: errors.length === 0, errors };
    }
    // Spreadsheet files share the CSV shape plus a `sheet` selector.
    case 'xlsx': {
      const errors = [];
      if (config.hasHeader !== undefined && typeof config.hasHeader !== 'boolean') {
        errors.push({ field: 'config.hasHeader', message: 'hasHeader must be a boolean' });
      }
      // A sheet NAME (non-empty string) or a zero-based sheet INDEX (integer).
      const sheetOk = config.sheet === undefined
        || (typeof config.sheet === 'string' && config.sheet.length > 0 && config.sheet.length <= 128)
        || (Number.isInteger(config.sheet) && config.sheet >= 0 && config.sheet < 1000);
      if (!sheetOk) {
        errors.push({ field: 'config.sheet', message: 'sheet must be a sheet name or a zero-based sheet index' });
      }
      return { valid: errors.length === 0, errors };
    }
    case 'mongodb': {
      const errors = [];
      if (typeof config.uri !== 'string' || config.uri.length === 0) {
        errors.push({ field: 'config.uri', message: 'uri is required for mongodb connectors' });
      } else {
        const parsed = parseMongoUri(config.uri);
        if (!parsed) {
          errors.push({ field: 'config.uri', message: 'uri must be a mongodb:// or mongodb+srv:// connection string' });
        } else {
          // Strict allow-list: any option not explicitly permitted is refused.
          const rejected = disallowedMongoOptions(parsed);
          if (rejected.length) {
            errors.push({ field: 'config.uri', message: `connection option(s) not allowed or with an unsupported value: ${rejected.join(', ')}` });
          }
          // Egress policy (no DNS here; resolution happens at create/update
          // time in the service and again when the worker connects).
          const violation = parsed.hosts
            .map((h) => hostPolicyViolation(h.host, parsed.srv ? null : (h.port ?? 27017), { allowPrivate: env.connectors.allowPrivateNetworks }))
            .find(Boolean);
          if (violation) errors.push({ field: 'config.uri', message: violation });
        }
      }
      if (typeof config.database !== 'string' || config.database.length === 0) {
        errors.push({ field: 'config.database', message: 'database is required for mongodb connectors' });
      }
      if (typeof config.collection !== 'string' || config.collection.length === 0) {
        errors.push({ field: 'config.collection', message: 'collection is required for mongodb connectors' });
      }
      if (config.filter !== undefined && (typeof config.filter !== 'object' || config.filter === null || Array.isArray(config.filter))) {
        errors.push({ field: 'config.filter', message: 'filter must be a plain object' });
      }
      return { valid: errors.length === 0, errors };
    }
    default: {
      return {
        valid: false,
        errors: [{ field: 'type', message: `No configuration rules exist for connector type "${type}"` }],
      };
    }
  }
}

/**
 * Validate a field mapping (either documented form).
 *
 * @param {*} mapping
 * @returns {{ valid: boolean, errors: Array<{ field: string, message: string }> }}
 */
export function validateFieldMapping(mapping) {
  if (mapping === undefined || mapping === null) return { valid: true, errors: [] };
  if (Array.isArray(mapping)) {
    const errors = [];
    mapping.forEach((rule, i) => {
      if (!rule || typeof rule !== 'object' || typeof rule.target !== 'string' || rule.target.length === 0) {
        errors.push({ field: `fieldMapping[${i}].target`, message: 'each mapping entry needs a string "target"' });
      }
      if (rule.source !== undefined && typeof rule.source !== 'string') {
        errors.push({ field: `fieldMapping[${i}].source`, message: 'source must be a string' });
      }
      if (rule.type !== undefined && !['string', 'number', 'integer', 'boolean', 'date', 'json'].includes(rule.type)) {
        errors.push({ field: `fieldMapping[${i}].type`, message: `unknown type "${rule.type}"` });
      }
    });
    return { valid: errors.length === 0, errors };
  }
  if (typeof mapping === 'object') {
    const errors = [];
    for (const [target, spec] of Object.entries(mapping)) {
      if (typeof spec === 'object' && spec !== null && !Array.isArray(spec)) {
        if (spec.source !== undefined && typeof spec.source !== 'string') {
          errors.push({ field: `fieldMapping.${target}.source`, message: 'source must be a string' });
        }
      } else if (spec !== undefined && typeof spec !== 'string') {
        errors.push({ field: `fieldMapping.${target}`, message: 'simple mapping values must be source field names' });
      }
    }
    return { valid: errors.length === 0, errors };
  }
  return { valid: false, errors: [{ field: 'fieldMapping', message: 'fieldMapping must be an object or array' }] };
}

/** Throw a ConnectorConfigError when the config is invalid (service use). */
export function assertConfigValid(type, config) {
  const { valid, errors } = validateConfig(type, config);
  if (!valid) throw new ConnectorConfigError(`Invalid ${type} connector configuration`, errors);
  return config;
}

export default { validateConfig, validateFieldMapping, assertConfigValid };
