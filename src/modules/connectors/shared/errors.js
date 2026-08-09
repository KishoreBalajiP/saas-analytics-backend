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
 *
 * CODING GUIDELINES
 *   - Errors never carry secrets. `details` is for field-level errors and
 *     sync metrics, never raw credential material.
 */

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

/** Webhook signature / timestamp verification failed (fail closed). */
export class WebhookSignatureError extends ConnectorError {
  constructor(message = 'Invalid webhook signature') {
    super('WEBHOOK_SIGNATURE_INVALID', message, { statusCode: 401 });
    this.name = 'WebhookSignatureError';
  }
}

export default {
  ConnectorError,
  ConnectorConfigError,
  ConnectorValidationError,
  WebhookSignatureError,
};
