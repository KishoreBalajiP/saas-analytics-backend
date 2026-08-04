/**
 * MongoDB test helper - boot an ephemeral in-memory MongoDB.
 *
 * WHY IT EXISTS
 *   Integration tests need a real MongoDB. Installing one globally is
 *   fragile; `mongodb-memory-server` boots an isolated binary on demand.
 *
 * USAGE
 *   ```js
 *   import { startMongo, stopMongo, resetMongo } from './mongo.js';
 *
 *   before(async () => { await startMongo(); });
 *   after(async () => { await stopMongo(); });
 *   beforeEach(async () => { await resetMongo(); });
 *   ```
 *
 * DESIGN CONSTRAINTS
 *   - The server is started ONCE per process and reused across tests.
 *   - `resetMongo()` drops all collections between tests.
 *
 * HOW TO EXTEND
 *   - Add `withTransaction(fn)` once transactions are needed.
 */

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let server = null;
let uri = null;

/**
 * Start the in-memory MongoDB (idempotent) and connect Mongoose.
 *
 * @returns {Promise<{ uri: string }>}
 */
export async function startMongo() {
  if (server && uri) {
    if (mongoose.connection.readyState === 1) return { uri };
    await mongoose.connect(uri);
    return { uri };
  }
  server = await MongoMemoryServer.create();
  uri = server.getUri();
  await mongoose.connect(uri);
  return { uri };
}

/**
 * Disconnect Mongoose and stop the in-memory server (idempotent).
 *
 * @returns {Promise<void>}
 */
export async function stopMongo() {
  try {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  } finally {
    if (server) {
      await server.stop();
      server = null;
      uri = null;
    }
  }
}

/**
 * Drop every collection so the next test starts from a clean slate.
 *
 * @returns {Promise<void>}
 */
export async function resetMongo() {
  if (!mongoose.connection.db) return;
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

/**
 * Return the current URI (mostly for debugging).
 *
 * @returns {string|null}
 */
export function getMongoUri() {
  return uri;
}

export default { startMongo, stopMongo, resetMongo, getMongoUri };
