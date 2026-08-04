/**
 * BaseConnector - the common contract for every data connector.
 *
 * WHY IT EXISTS
 *   The platform ingests data from many external systems (CSV, Google Sheets,
 *   Webhooks, MongoDB, PostgreSQL, MySQL, REST APIs, GraphQL, Snowflake,
 *   BigQuery). Each of those is a *connector*: a class that knows how to reach
 *   the external system, validate a configuration, preview what is available
 *   and ingest data in a uniform way. This base class defines that contract so
 *   every future connector is implemented, tested and composed identically.
 *
 * RESPONSIBILITY
 *   - Declare the connector lifecycle methods every connector MUST implement:
 *     `connect`, `validate`, `preview`, `ingest`, `disconnect`.
 *   - Carry per-connector identity/metadata (type, display name, capabilities).
 *   - Fail closed: the base methods throw descriptive errors until a concrete
 *     subclass implements them, so no connector can silently do nothing.
 *
 * HOW TO EXTEND
 *   Create a new connector by subclassing this class, implementing the
 *   lifecycle methods and registering the class in `ConnectorRegistry`:
 *
 *   ```js
 *   import BaseConnector from '../connectors/BaseConnector.js';
 *
 *   export default class MongoDbConnector extends BaseConnector {
 *     static type = 'mongodb';
 *     static displayName = 'MongoDB Atlas';
 *     static capabilities = ['connect', 'validate', 'preview', 'ingest'];
 *
 *     async connect() { ... }
 *     async validate() { ... }
 *     async preview(options) { ... }
 *     async ingest(options) { ... }
 *     async disconnect() { ... }
 *   }
 *   ```
 *
 *   Keep connector code inside `src/modules/connectors/<type>/` and register
 *   it at boot so the platform can discover it dynamically.
 */

/** Fails closed with a descriptive error for methods a subclass omits. */
function notImplemented(method) {
  throw new Error(
    `Connector method "${this.constructor.type}.${method}" is not implemented yet`,
  );
}

class BaseConnector {
  /**
   * Machine-readable connector type (e.g. `'csv'`, `'google-sheets'`,
   * `'mongodb'`, `'postgres'`). Subclasses MUST override this.
   */
  static type = 'base';

  /** Human-readable name shown in product UI. Subclasses SHOULD override. */
  static displayName = 'Base Connector';

  /** Optional short description for docs/admin screens. */
  static description = '';

  /**
   * Which lifecycle steps this connector supports. Used by the platform to
   * decide which endpoints/UI are available. Defaults to the full lifecycle.
   */
  static capabilities = ['connect', 'validate', 'preview', 'ingest', 'disconnect'];

  /**
   * @param {Object} context - created by `ConnectorRegistry.create()`.
   * @param {string|null} context.id - persisted connector record id (null for
   *   one-shot validation/preview).
   * @param {Object} context.config - validated connector configuration
   *   (credentials, endpoints, database/collection names, ...).
   * @param {string} context.tenantId - owning tenant for audit + scoping.
   */
  constructor(context = {}) {
    this.id = context.id ?? null;
    this.config = context.config ?? {};
    this.tenantId = context.tenantId ?? null;
    this.connected = false;
  }

  /**
   * Metadata the platform uses for registry listings, UI and routing.
   * @returns {Object} { type, displayName, description, capabilities }
   */
  getMetadata() {
    return {
      type: this.constructor.type,
      displayName: this.constructor.displayName,
      description: this.constructor.description,
      capabilities: [...this.constructor.capabilities],
    };
  }

  /**
   * Establish the connection to the external system (driver, auth handshake,
   * socket pool). Must set `this.connected = true` on success.
   * @param {Object} [options]
   * @returns {Promise<void>}
   */
  async connect(options) {
    notImplemented.call(this, 'connect', options);
  }

  /**
   * Validate that the stored configuration is well-formed AND that the
   * external system accepts it (e.g. test credentials against the provider).
   * @param {Object} [options]
   * @returns {Promise<{valid: boolean, errors?: Array<Object>}>}
   */
  async validate(options) {
    notImplemented.call(this, 'validate', options);
  }

  /**
   * Preview what a connector exposes BEFORE ingesting anything - e.g. list
   * databases/collections, first N rows, available fields. Used by UI wizards
   * and field-mapping screens.
   * @param {Object} [options] - e.g. { database, collection, limit }
   * @returns {Promise<{fields: Array<Object>, sample: Array<Object>, meta: Object}>}
   */
  async preview(options) {
    notImplemented.call(this, 'preview', options);
  }

  /**
   * Read source data and push it into the ingestion pipeline (upsert rows,
   * emit to the connector queue for large payloads, record sync state).
   * @param {Object} [options] - e.g. { syncId, fieldMapping, since }
   * @returns {Promise<{processed: number, skipped: number, error?: Object}>}
   */
  async ingest(options) {
    notImplemented.call(this, 'ingest', options);
  }

  /**
   * Release the connection / resources (close pools, stop cursors).
   * Must set `this.connected = false`.
   * @returns {Promise<void>}
   */
  async disconnect() {
    notImplemented.call(this, 'disconnect');
  }

  /** Convenience: connect -> validate -> disconnect in one shot. */
  async testConnection() {
    await this.connect();
    try {
      return await this.validate();
    } finally {
      await this.disconnect();
    }
  }

  /** Current connection state for status endpoints. */
  getStatus() {
    return {
      type: this.constructor.type,
      id: this.id,
      connected: this.connected,
      tenantId: this.tenantId,
    };
  }
}

export default BaseConnector;
