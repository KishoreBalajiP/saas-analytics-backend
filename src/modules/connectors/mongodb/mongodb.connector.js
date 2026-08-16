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
 * CODING GUIDELINES
 *   - Connect options enforce connect/selection timeouts from env.
 *   - The cursor is exhausted row-by-row (streaming, not bulk load).
 *   - `connect` / `disconnect` manage the MongoClient lifecycle.
 *   - Secrets (URI) are never logged; errors are sanitized.
 */

import { MongoClient } from 'mongodb';
import BaseConnector from '../../../connectors/BaseConnector.js';
import { validateConfig } from '../shared/validators.js';
import env from '../../../config/env.js';

export class MongoDBConnector extends BaseConnector {
  static type = 'mongodb';
  static displayName = 'External MongoDB';
  static description = 'Pull documents from an external MongoDB collection.';
  static capabilities = ['validate', 'ingest'];

  #client = null;

  async connect() {
    if (this.#client) return;
    const { connectTimeoutMs, serverSelectionTimeoutMs } = env.connectors.mongodb;
    this.#client = new MongoClient(this.config.uri, {
      connectTimeoutMS: connectTimeoutMs,
      serverSelectionTimeoutMS: serverSelectionTimeoutMs,
    });
    await this.#client.connect();
    this.connected = true;
  }

  async validate() {
    const { valid, errors } = validateConfig('mongodb', this.config);
    return { valid, errors };
  }

  // No preview — external MongoDB sources don't expose a file preview API.
  // If a preview is needed in future, add a `preview` method here.

  async *ingest() {
    if (!this.#client) await this.connect();
    const db = this.#client.db(this.config.database);
    const coll = db.collection(this.config.collection);
    const filter = this.config.filter ?? {};
    const maxDocs = env.connectors.mongodb.maxDocsPerSync;

    const cursor = coll.find(filter).limit(maxDocs);
    let count = 0;
    for await (const doc of cursor) {
      yield doc;
      if (++count >= maxDocs) break;
    }
  }

  async disconnect() {
    if (this.#client) {
      await this.#client.close();
      this.#client = null;
      this.connected = false;
    }
  }
}

export default MongoDBConnector;