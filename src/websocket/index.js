/**
 * WebSocket bootstrap.
 *
 * WHY IT EXISTS
 *   Wires Socket.IO to the HTTP server and hands out a single `io` instance
 *   so dashboard/embed/notification modules can broadcast from anywhere in
 *   the process.
 *
 * RESPONSIBILITY
 *   - Create the Socket.IO server with production options (config/socket.js).
 *   - Require a valid access token at the handshake (websocket/auth.js);
 *     unauthenticated sockets are refused with `connect_error`.
 *   - Register connection/event handlers (websocket/events.js).
 *   - Expose `getIO()` for broadcasting outside request context.
 *
 * MULTI-INSTANCE (roadmap 1.4, finding ops.10)
 *   With REDIS_URL set, rooms and broadcasts go through the Redis adapter so
 *   an event emitted on one web instance reaches clients connected to any
 *   instance. Without sticky sessions, run multiple instances with
 *   SOCKET_TRANSPORTS=websocket (long-polling needs session affinity).
 *
 * HOW TO EXTEND
 *   Future features register their socket event handlers via
 *   `registerHandler(name, fn)` from `events.js` - no changes needed here.
 */

import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis from 'ioredis';
import env from '../config/env.js';
import socketConfig from '../config/socket.js';
import logger from '../utils/logger.js';
import { registerHandlers } from './events.js';
import { authenticateSocket } from './auth.js';

let io = null;
let adapterClients = [];

/**
 * Attach the Redis adapter (pub + sub connections) to an io server.
 *
 * @param {SocketIOServer} server
 * @param {Object} [options]
 * @param {string} [options.url] - Redis URL (defaults to REDIS_URL).
 * @param {Function} [options.Redis] - ioredis constructor (injectable for tests).
 * @param {Function} [options.adapterFactory] - createAdapter (injectable for tests).
 * @returns {boolean} whether the adapter was attached.
 */
export function attachRedisAdapter(server, { url = env.redis.url, Redis = IORedis, adapterFactory = createAdapter } = {}) {
  if (!url) return false;
  const pubClient = new Redis(url, { maxRetriesPerRequest: 2 });
  const subClient = typeof pubClient.duplicate === 'function' ? pubClient.duplicate() : new Redis(url, { maxRetriesPerRequest: 2 });
  for (const client of [pubClient, subClient]) {
    // ioredis throws on an 'error' event without a listener.
    client.on?.('error', (err) => logger.warn({ err: { message: err?.message } }, 'Socket.IO Redis adapter connection error'));
  }
  server.adapter(adapterFactory(pubClient, subClient));
  adapterClients = [pubClient, subClient];
  logger.info('Socket.IO Redis adapter attached');
  return true;
}

/** Close the adapter's Redis connections (graceful shutdown, after io.close()). */
export async function closeSocketAdapter() {
  const clients = adapterClients;
  adapterClients = [];
  await Promise.all(clients.map(async (client) => {
    if (client.status && client.status !== 'ready') {
      client.disconnect?.();
      return;
    }
    try { await client.quit(); } catch { client.disconnect?.(); }
  }));
}

/**
 * Initialise Socket.IO on top of the HTTP server.
 * @returns {SocketIOServer} the io instance.
 */
export function initSocket(httpServer) {
  if (io) return io;

  io = new SocketIOServer(httpServer, socketConfig);
  if (env.redis.enabled) {
    try {
      attachRedisAdapter(io);
    } catch (err) {
      logger.error({ err: { message: err?.message } }, 'Socket.IO Redis adapter failed; using the in-process adapter');
    }
  }
  registerHandlers(io);
  // Every connection must present a valid access token (no anonymous
  // sockets). Middleware runs at the handshake, before any `connection`
  // handler, whatever the registration order.
  io.use(authenticateSocket);

  logger.info('Socket.IO initialised');
  return io;
}

/** Access the io instance from anywhere (null before init). */
export function getIO() {
  return io;
}

export function isSocketInitialized() {
  return io !== null;
}
