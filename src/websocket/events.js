/**
 * Socket.IO event registry.
 *
 * WHY IT EXISTS
 *   Centralises the connection lifecycle and gives features a declarative way
 *   to add realtime events without touching bootstrap code.
 *
 * RESPONSIBILITY
 *   - Register global handlers (`connection`, `disconnect`, heartbeat).
 *   - Join every (already authenticated, see `websocket/auth.js`) socket to
 *     its own personal and tenant rooms, and disconnect it when its access
 *     token expires.
 *   - Built-in `room:join` / `room:leave` events: joins are authorised by
 *     `authorizeRoomJoin` (own tenant, own tenant's dashboards only).
 *   - Let features add domain events through `registerHandler(name, fn)`.
 *   - Guarantee ack-based error reporting for every registered event.
 *
 * HOW TO EXTEND
 *   From a feature module, call once at startup:
 *   ```
 *   registerHandler('dashboard:open', ({ socket, payload, ack }) => { ... });
 *   ```
 *   Handlers receive `{ io, socket, payload, ack }` where
 *   `socket.data.identity` is the verified `{ type, id, tenantId }`. Return
 *   or throw; exceptions are logged and acked as `{ ok: false, error }`.
 */

import logger from '../utils/logger.js';
import { SOCKET, ERROR_CODES } from '../config/constants.js';
import { addClient, removeClient } from './rooms.js';
import { authorizeRoomJoin, defaultRoomsFor } from './auth.js';

/** Registry of domain event handlers: name -> ({ io, socket, payload, ack }) => void */
const handlers = new Map();

/** Event names reserved for the built-in room protocol. */
export const ROOM_EVENTS = Object.freeze({ JOIN: 'room:join', LEAVE: 'room:leave' });

/** Upper bound for setTimeout (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Register a domain socket event handler. Call before/after initSocket. */
export function registerHandler(eventName, handler) {
  if (eventName === ROOM_EVENTS.JOIN || eventName === ROOM_EVENTS.LEAVE) {
    throw new Error(`"${eventName}" is reserved for the built-in room protocol`);
  }
  if (handlers.has(eventName)) {
    logger.warn({ eventName }, 'Overwriting existing socket event handler');
  }
  handlers.set(eventName, handler);
}

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

/** Wire up connection lifecycle and every registered event on the server. */
export function registerHandlers(io) {
  io.on('connection', (socket) => {
    const identity = socket.data?.identity ?? null;
    if (!identity) {
      // Defence in depth: the handshake middleware should have refused it.
      socket.disconnect(true);
      return;
    }
    logger.debug(
      { socketId: socket.id, actorType: identity.type, actorId: identity.id },
      'Socket connected',
    );

    // Track the client so rooms can resolve members later.
    addClient(socket, { actorType: identity.type, actorId: identity.id, tenantId: identity.tenantId });
    for (const room of defaultRoomsFor(identity)) socket.join(room);

    // The connection lives no longer than the access token it was opened
    // with; the client reconnects with a fresh token.
    let expiryTimer = null;
    if (Number.isFinite(identity.expiresAt)) {
      const ms = Math.max(0, Math.min(identity.expiresAt - Date.now(), MAX_TIMER_MS));
      expiryTimer = setTimeout(() => socket.disconnect(true), ms);
      expiryTimer.unref?.();
    }

    // Heartbeat helper the client may call to verify liveness.
    socket.on(SOCKET.EVENTS.PING, (cb) => {
      if (typeof cb === 'function') cb({ ok: true, ts: Date.now() });
    });

    socket.on(ROOM_EVENTS.JOIN, async (payload, ack) => {
      const room = typeof payload === 'string' ? payload : payload?.room;
      let allowed = false;
      try {
        allowed = await authorizeRoomJoin(identity, room);
      } catch (err) {
        logger.error({ err: { message: err.message }, socketId: socket.id }, 'Room authorisation failed');
      }
      if (!allowed) {
        reply(ack, { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: 'You cannot join this room' } });
        return;
      }
      socket.join(room);
      reply(ack, { ok: true, data: { room } });
    });

    socket.on(ROOM_EVENTS.LEAVE, (payload, ack) => {
      const room = typeof payload === 'string' ? payload : payload?.room;
      // Personal and tenant rooms are server-managed.
      if (typeof room !== 'string' || defaultRoomsFor(identity).includes(room)) {
        reply(ack, { ok: false, error: { code: ERROR_CODES.FORBIDDEN, message: 'You cannot leave this room' } });
        return;
      }
      socket.leave(room);
      reply(ack, { ok: true, data: { room } });
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
      if (expiryTimer) clearTimeout(expiryTimer);
      removeClient(socket);
      logger.debug({ socketId: socket.id, reason }, 'Socket disconnected');
    });

    socket.on('error', (err) => {
      logger.error({ err: { message: err.message }, socketId: socket.id }, 'Socket error');
    });
  });
}
