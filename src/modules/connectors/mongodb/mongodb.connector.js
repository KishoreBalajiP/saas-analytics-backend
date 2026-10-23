/**
 * MongoDB Connector - external MongoDB source (Sprint 9).
 *
 * WHY IT EXISTS
 *   Allows tenants to sync data from an external MongoDB collection
 *   without custom code. Credentials stay encrypted; the worker opens a
 *   short-lived connection, pulls documents, and yields them one by one.
 *
 * CONFIG (plain, encrypted at rest):
 *   { uri: string, database: string, collection: string, filter?: object }
 *
 * SAFETY (egress policy + bounded work)
 *   - Every host is checked by `utils/netGuard.js` before connecting, and
 *     the driver dials through `createGuardedLookup`, so the address actually
 *     connected to is checked too (DNS rebinding).
 *   - Only allow-listed URI options are accepted (validator); everything
 *     the driver needs for safety is set here and cannot be overridden.
 *   - Bounded connection: one pooled socket, connect / server-selection /
 *     socket timeouts, a server-side `maxTimeMS` on the query, and a
 *     document cap (`MONGODB_CONNECTOR_MAX_DOCS_PER_SYNC`).
 *   - Driver errors are never echoed: they can contain hosts, ports and
 *     user names. Callers only ever see generic `ConnectorError`s.
 */

import { MongoClient } from 'mongodb';
import BaseConnector from '../../../connectors/BaseConnector.js';
import { validateConfig } from '../shared/validators.js';
import { ConnectorError, CONNECTOR_ERROR_CODES } from '../shared/errors.js';
import env from '../../../config/env.js';
import { parseMongoUri, assertPublicMongoHosts, createGuardedLookup } from '../../../utils/netGuard.js';

const CONNECT_FAILED_MESSAGE = 'Could not connect to the MongoDB source. Check the connection string, credentials and network access.';
const READ_FAILED_MESSAGE = "Could not read from the MongoDB source. Check the database, collection, filter and the user's permissions.";

/**
 * Map a driver error to a tenant-safe message with a recovery hint. Only the
 * error's name/code are inspected; the driver's text (hosts, users) is never
 * returned.
 */
export function describeMongoError(error, fallback = CONNECT_FAILED_MESSAGE) {
  const code = error?.code;
  const name = String(error?.name ?? '');
  const codeName = String(error?.codeName ?? '');
  const text = String(error?.message ?? '');
  if (code === 18 || code === 8000 || codeName === 'AuthenticationFailed' || /auth(entication)? failed|bad auth/i.test(text)) {
    return 'Authentication failed. Check the username and password in the connection string and the authSource / database the user is defined in.';
  }
  if (code === 13 || codeName === 'Unauthorized' || /not authorized/i.test(text)) {
    return 'The MongoDB user is not authorized for this operation. Grant it read access to the database and collection.';
  }
  if (/ENOTFOUND|EAI_AGAIN|querySrv/i.test(text)) {
    return 'The MongoDB host could not be resolved. Check the host name in the connection string.';
  }
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(text)) {
    return 'The MongoDB host is unreachable. Check the host/port and that the server allows connections from this platform (IP allow-list / firewall).';
  }
  if (name === 'MongoServerSelectionError' || /timed? ?out|ETIMEDOUT/i.test(text)) {
    return "Timed out connecting to MongoDB. Check that the server is running and reachable, and that this platform's IP is on its allow-list.";
  }
  return fallback;
}

/** Driver options the tenant cannot influence (bounded, guarded connection). */
export function buildClientOptions() {
  const { connectTimeoutMs, serverSelectionTimeoutMs } = env.connectors.mongodb;
  const { socketTimeoutMs } = env.connectors.mongodbLimits;
  return {
    connectTimeoutMS: connectTimeoutMs,
    serverSelectionTimeoutMS: serverSelectionTimeoutMs,
    socketTimeoutMS: socketTimeoutMs,
    maxPoolSize: 1,
    minPoolSize: 0,
    maxIdleTimeMS: 10000,
    waitQueueTimeoutMS: connectTimeoutMs,
    retryReads: false,
    retryWrites: false,
    // Applied to every socket the driver opens (net.connect / tls.connect).
    lookup: createGuardedLookup(),
  };
}

export class MongoDBConnector extends BaseConnector {
  static type = 'mongodb';
  static displayName = 'External MongoDB';
  static description = 'Pull documents from an external MongoDB collection.';
  static capabilities = ['validate', 'ingest', 'discover'];

  #client = null;

  async connect() {
    if (this.#client) return;
    // Egress policy: every host the driver may contact must be allowed
    // (public unless private networks are explicitly enabled, never the
    // platform's own data stores, on the allow-list when one is set).
    await assertPublicMongoHosts(parseMongoUri(this.config.uri));
    this.#client = new MongoClient(this.config.uri, buildClientOptions());
    try {
      await this.#client.connect();
    } catch (error) {
      await this.#client.close().catch(() => {});
      this.#client = null;
      // Never echo driver errors to the tenant: they describe internal
      // network behaviour (refused, timed out, TLS) for arbitrary hosts.
      throw new ConnectorError(CONNECTOR_ERROR_CODES.SOURCE_UNAVAILABLE, describeMongoError(error), { statusCode: 502, cause: error });
    }
    this.connected = true;
  }

  async validate() {
    const { valid, errors } = validateConfig('mongodb', this.config);
    return { valid, errors };
  }

  // No preview — external MongoDB sources don't expose a file preview API.
  // If a preview is needed in future, add a `preview` method here.

  /**
   * List databases and collections/views the stored credentials can see so
   * the tenant can pick a source instead of typing names. Read-only; system
   * databases and `system.*` collections are hidden.
   *
   * @param {{ database?: string }} [options] - list collections of this DB
   *   (defaults to the configured database).
   */
  async discover({ database } = {}) {
    if (!this.#client) await this.connect();
    try {
      let databases = [];
      let databasesListed = true;
      try {
        const res = await this.#client.db('admin').admin().listDatabases({ nameOnly: true, authorizedDatabases: true });
        databases = (res.databases ?? []).map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
      } catch {
        // Users without listDatabases privilege: fall back to the configured DB.
        databasesListed = false;
      }
      const target = database || this.config.database;
      if (target && !databases.includes(target)) databases.push(target);
      databases.sort();
      let collections = [];
      if (target) {
        const items = await this.#client.db(target).listCollections({}, { nameOnly: true, authorizedCollections: true }).toArray();
        collections = items
          .filter((c) => !String(c.name).startsWith('system.'))
          .map((c) => ({
            name: c.name,
            type: c.type === 'view' ? 'view' : 'collection',
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      return {
        databases,
        databasesListed,
        database: target ?? null,
        collections,
      };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(CONNECTOR_ERROR_CODES.SOURCE_UNAVAILABLE, describeMongoError(error, READ_FAILED_MESSAGE), { statusCode: 502, cause: error });
    } finally {
      await this.disconnect().catch(() => {});
    }
  }

  async *ingest() {
    if (!this.#client) await this.connect();
    const maxDocs = env.connectors.mongodb.maxDocsPerSync;
    let cursor;
    try {
      const coll = this.#client.db(this.config.database).collection(this.config.collection);
      cursor = coll
        .find(this.config.filter ?? {})
        .limit(maxDocs)
        .batchSize(Math.min(1000, maxDocs))
        .maxTimeMS(env.connectors.mongodbLimits.queryTimeoutMs);
      let count = 0;
      for await (const doc of cursor) {
        yield doc;
        if (++count >= maxDocs) break;
      }
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(CONNECTOR_ERROR_CODES.SOURCE_UNAVAILABLE, describeMongoError(error, READ_FAILED_MESSAGE), { statusCode: 502, cause: error });
    } finally {
      await cursor?.close().catch(() => {});
      await this.disconnect().catch(() => {});
    }
  }

  async disconnect() {
    if (this.#client) {
      const client = this.#client;
      this.#client = null;
      this.connected = false;
      await client.close();
    }
  }
}

export default MongoDBConnector;
