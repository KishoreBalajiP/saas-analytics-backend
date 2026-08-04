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
 *   - Register connection/event handlers (websocket/events.js).
 *   - Expose `getIO()` for broadcasting outside request context.
 *
 * HOW TO EXTEND
 *   Future features register their socket event handlers via
 *   `registerHandler(name, fn)` from `events.js` - no changes needed here.
 */

import { Server as SocketIOServer } from 'socket.io';
import socketConfig from '../config/socket.js';
import logger from '../utils/logger.js';
import { registerHandlers } from './events.js';

let io = null;

/**
 * Initialise Socket.IO on top of the HTTP server.
 * @returns {SocketIOServer} the io instance.
 */
export function initSocket(httpServer) {
  if (io) return io;

  io = new SocketIOServer(httpServer, socketConfig);
  registerHandlers(io);

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
