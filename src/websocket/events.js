/**
 * Socket.IO event registry.
 *
 * WHY IT EXISTS
 *   Centralises the connection lifecycle and gives features a declarative way
 *   to add realtime events without touching bootstrap code.
 *
 * RESPONSIBILITY
 *   - Register global handlers (`connection`, `disconnect`, heartbeat).
 *   - Let features add domain events through `registerHandler(name, fn)`.
 *   - Guarantee ack-based error reporting for every registered event.
 *
 * HOW TO EXTEND
 *   From a feature module, call once at startup:
 *   ```
 *   registerHandler('dashboard:open', ({ socket, payload, ack }) => { ... });
 *   ```
 *   Handlers receive `{ io, socket, payload, ack }`. Return or throw;
 *   exceptions are logged and acked as `{ ok: false, error }`.
 */

import logger from '../utils/logger.js';
import { SOCKET } from '../config/constants.js';
import { addClient, removeClient } from './rooms.js';

/** Registry of domain event handlers: name -> ({ io, socket, payload, ack }) => void */
const handlers = new Map();

/** Register a domain socket event handler. Call before/after initSocket. */
export function registerHandler(eventName, handler) {
  if (handlers.has(eventName)) {
    logger.warn({ eventName }, 'Overwriting existing socket event handler');
  }
  handlers.set(eventName, handler);
}

/** Wire up connection lifecycle and every registered event on the server. */
export function registerHandlers(io) {
  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id, address: socket.handshake.address }, 'Socket connected');

    // Track the client so rooms can resolve members later.
    addClient(socket);

    // Heartbeat helper the client may call to verify liveness.
    socket.on(SOCKET.EVENTS.PING, (cb) => {
      if (typeof cb === 'function') cb({ ok: true, ts: Date.now() });
    });

    // Attach all registered domain handlers.
    for (const [eventName, handler] of handlers) {
      socket.on(eventName, async (payload, ack) => {
        try {
          const result = await handler({ io, socket, payload, ack });
          if (typeof ack === 'function') ack({ ok: true, data: result ?? null });
        } catch (err) {
          logger.error(
            { err: { message: err.message, stack: err.stack }, socketId: socket.id, eventName },
            'Socket event handler failed',
          );
          if (typeof ack === 'function') {
            ack({ ok: false, error: { message: err.message } });
          }
        }
      });
    }

    socket.on('disconnect', (reason) => {
      removeClient(socket);
      logger.info({ socketId: socket.id, reason }, 'Socket disconnected');
    });

    socket.on('error', (err) => {
      logger.error({ err: { message: err.message }, socketId: socket.id }, 'Socket error');
    });
  });
}
