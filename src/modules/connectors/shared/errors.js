/**
 * Shared connector error types.
 *
 * WHY IT EXISTS
 *   The sync engine, providers and the connector service must agree on a
 *   stable error vocabulary so callers can branch on machine-readable
 *   `code`s (e.g. the queue consumer maps `CONFIG_INVALID` to a permanent
 *   failure and `UPSTREAM_UNAVAILABLE` to a retry).
 *
 * RESPONSIBILITY
 *   - `ConnectorError` - base operational error for the whole feature.
 *   - `ConnectorConfigError` - a connector's stored config is invalid.
 *   - `ConnectorValidationError` - a payload/row failed validation.
 *   - `WebhookSignatureError` - signature/timestamp verification failed
 *     (always maps to a fail-closed HTTP 401 at the edge).
 *   - `RowLimitError` - a source produced more rows than one sync may ingest.
 *   - `EgressBlockedError` - a network connector targets a host the egress
 *     policy refuses (loopback, private, metadata, platform-internal...).
 *   - `toPublicSyncError` - turns ANY error into a message that is safe to
 *     persist on the connector and show to the tenant.
 *
 * CODING GUIDELINES
 *   - Errors never carry secrets. `details` is for field-level errors and
 *     sync metrics, never raw credential material.
 *   - Messages of these classes are written by us and are safe to show to
 *     the tenant. Driver / library messages are NOT: they can contain hosts,
 *     ports, user names or connection strings, so they never leave the
 *     server (see `toPublicSyncError`).
 */

/** Stable machine-readable codes used across the connector feature. */
export const CONNECTOR_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'CONNECTOR_NOT_FOUND',
  CONFIG_INVALID: 'CONFIG_INVALID',
  PAYLOAD_INVALID: 'PAYLOAD_INVALID',
  CONNECTOR_PAUSED: 'CONNECTOR_PAUSED',
  TENANT_NOT_ACTIVE: 'TENANT_NOT_ACTIVE',
  EGRESS_BLOCKED: 'CONNECTOR_EGRESS_BLOCKED',
  SOURCE_UNAVAILABLE: 'CONNECTOR_SOURCE_UNAVAILABLE',
  SYNC_FAILED: 'CONNECTOR_SYNC_FAILED',
  SYNC_TIMEOUT: 'CONNECTOR_SYNC_TIMEOUT',
  ROW_LIMIT_EXCEEDED: 'ROW_LIMIT_EXCEEDED',
  FILE_PARSE_FAILED: 'FILE_PARSE_FAILED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
  FILE_TYPE_MISMATCH: 'FILE_TYPE_MISMATCH',
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  WEBHOOK_SIGNATURE_MISSING: 'WEBHOOK_SIGNATURE_MISSING',
  WEBHOOK_SIGNATURE_MALFORMED: 'WEBHOOK_SIGNATURE_MALFORMED',
  WEBHOOK_LEGACY_SIGNATURE_REJECTED: 'WEBHOOK_LEGACY_SIGNATURE_REJECTED',
  WEBHOOK_TIMESTAMP_MISSING: 'WEBHOOK_TIMESTAMP_MISSING',
  WEBHOOK_TIMESTAMP_INVALID: 'WEBHOOK_TIMESTAMP_INVALID',
  WEBHOOK_TIMESTAMP_OUT_OF_WINDOW: 'WEBHOOK_TIMESTAMP_OUT_OF_WINDOW',
  WEBHOOK_REPLAYED: 'WEBHOOK_REPLAYED',
  WEBHOOK_REPLAY_CHECK_UNAVAILABLE: 'WEBHOOK_REPLAY_CHECK_UNAVAILABLE',
  WEBHOOK_UNSUPPORTED_MEDIA_TYPE: 'WEBHOOK_UNSUPPORTED_MEDIA_TYPE',
  WEBHOOK_PAYLOAD_TOO_LARGE: 'WEBHOOK_PAYLOAD_TOO_LARGE',
  WEBHOOK_TOO_MANY_RECORDS: 'WEBHOOK_TOO_MANY_RECORDS',
});

/** Base connector error. Carries an HTTP-ish status and a stable code. */
export class ConnectorError extends Error {
  constructor(code, message, { statusCode = 500, details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ConnectorError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
  }
}

/** The persisted connector config is malformed or fails validation. */
export class ConnectorConfigError extends ConnectorError {
  constructor(message = 'Connector configuration is invalid', details = null) {
    super('CONFIG_INVALID', message, { statusCode: 400, details });
    this.name = 'ConnectorConfigError';
  }
}

/** A payload or row failed field-mapping / schema validation. */
export class ConnectorValidationError extends ConnectorError {
  constructor(message = 'Connector payload validation failed', details = null) {
    super('PAYLOAD_INVALID', message, { statusCode: 422, details });
    this.name = 'ConnectorValidationError';
  }
}

/**
 * Webhook signature / timestamp verification failed (fail closed).
 * `code` narrows the reason (missing header, stale timestamp...) so the
 * sender can fix its integration; the status is always 401.
 */
export class WebhookSignatureError extends ConnectorError {
  constructor(message = 'Invalid webhook signature', code = CONNECTOR_ERROR_CODES.WEBHOOK_SIGNATURE_INVALID) {
    super(code, message, { statusCode: 401 });
    this.name = 'WebhookSignatureError';
  }
}

/** A source produced more rows than a single sync may ingest. */
export class RowLimitError extends ConnectorError {
  constructor(limit, message) {
    super(
      CONNECTOR_ERROR_CODES.ROW_LIMIT_EXCEEDED,
      message ?? `The source has more than ${limit} rows, the maximum one sync can ingest. Split the data or filter the source.`,
      { statusCode: 413, details: { limit } },
    );
    this.name = 'RowLimitError';
  }
}

/** The egress policy refuses the connector's target host. */
export class EgressBlockedError extends ConnectorError {
  constructor(message = 'The connection target is not allowed. Use a publicly reachable host.') {
    super(CONNECTOR_ERROR_CODES.EGRESS_BLOCKED, message, { statusCode: 400 });
    this.name = 'EgressBlockedError';
  }
}

/** Generic, tenant-safe messages per failure family (no hosts, no driver text). */
const GENERIC_SYNC_MESSAGES = Object.freeze({
  mongodb: 'Could not read from the MongoDB source. Check the connection string, credentials, network access and collection.',
  csv: 'The CSV file could not be processed.',
  xlsx: 'The XLSX file could not be processed.',
  webhook: 'The webhook payload could not be processed.',
  default: 'The sync failed.',
});

/**
 * Convert any error into `{ code, message }` that is safe to persist in
 * `connector.lastError` and to return to the tenant.
 *
 * Only messages we wrote ourselves (`ConnectorError` family) and csv-parse
 * record errors (they describe the tenant's own file, never infrastructure)
 * pass through. Everything else - driver errors, DNS errors, socket errors,
 * zip/XML library errors - is replaced by a generic message, because those
 * strings can contain hosts, ports, user names or connection strings.
 *
 * @param {Error} error
 * @param {string} [connectorType]
 * @returns {{ code: string, message: string }}
 */
export function toPublicSyncError(error, connectorType) {
  if (error instanceof ConnectorError) {
    return { code: error.code ?? CONNECTOR_ERROR_CODES.SYNC_FAILED, message: String(error.message).slice(0, 500) };
  }
  if (connectorType === 'csv' && typeof error?.code === 'string' && error.code.startsWith('CSV_')) {
    return { code: CONNECTOR_ERROR_CODES.FILE_PARSE_FAILED, message: `${GENERIC_SYNC_MESSAGES.csv} ${String(error.message).slice(0, 300)}` };
  }
  return {
    code: connectorType === 'mongodb' ? CONNECTOR_ERROR_CODES.SOURCE_UNAVAILABLE : CONNECTOR_ERROR_CODES.SYNC_FAILED,
    message: GENERIC_SYNC_MESSAGES[connectorType] ?? GENERIC_SYNC_MESSAGES.default,
  };
}

export default {
  CONNECTOR_ERROR_CODES,
  ConnectorError,
  ConnectorConfigError,
  ConnectorValidationError,
  WebhookSignatureError,
  RowLimitError,
  EgressBlockedError,
  toPublicSyncError,
};
