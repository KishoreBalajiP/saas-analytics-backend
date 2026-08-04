/**
 * Socket.IO room + client helpers.
 *
 * WHY IT EXISTS
 *   Realtime features (dashboard updates, embed widgets, notifications) all
 *   follow the same pattern: join a room, broadcast to it, know who is in it.
 *   This module owns that pattern so features don't duplicate room logic.
 *
 * RESPONSIBILITY
 *   - Maintain an in-memory registry of connected clients (socketId -> meta).
 *   - Provide join/leave/broadcast helpers built on Socket.IO rooms.
 *
 * HOW TO EXTEND
 *   Future features should broadcast with the named emit helpers here and use
 *   the room naming conventions from `config/constants.js`:
 *   - `tenant:<id>`            -> everything for one tenant
 *   - `dashboard:<id>`         -> a specific dashboard's viewers
 *   - `embed:<embedTokenHash>` -> a specific embedded widget
 */

import logger from '../utils/logger.js';
import { SOCKET } from '../config/constants.js';

/** In-memory client registry: socketId -> { joinedAt, ...meta } */
const clientRegistry = new Map();

export function addClient(socket, meta = {}) {
  clientRegistry.set(socket.id, { ...meta, joinedAt: new Date().toISOString() });
}

export function removeClient(socket) {
  clientRegistry.delete(socket.id);
}

export function getClient(socketId) {
  return clientRegistry.get(socketId) ?? null;
}

export function getClientCount() {
  return clientRegistry.size;
}

export function joinRoom(socket, room) {
  socket.join(room);
}

export function leaveRoom(socket, room) {
  socket.leave(room);
}

/** List the socket ids currently in a room (resolves async). */
export async function getRoomSocketIds(io, room) {
  const sockets = await io.in(room).fetchSockets();
  return sockets.map((s) => s.id);
}

/** Count of sockets in a room. */
export async function roomSize(io, room) {
  return getRoomSocketIds(io, room).then((ids) => ids.length);
}

/** Broadcast to a room (skips the sender when `senderSocketId` is given). */
export function emitToRoom(io, room, event, data, senderSocketId = null) {
  const target = senderSocketId ? io.to(room).except(senderSocketId) : io.to(room);
  target.emit(event, data);
}

/** Safe wrapper for broadcasting to a named room with logging. */
export function broadcast(io, room, event, data, senderSocketId = null) {
  try {
    emitToRoom(io, room, event, data, senderSocketId);
    logger.debug({ room, event }, 'Broadcast sent');
  } catch (err) {
    logger.error({ err: { message: err.message }, room, event }, 'Broadcast failed');
  }
}

/** Build the canonical room names for the future features. */
export const roomNames = {
  tenant: (tenantId) => `${SOCKET.ROOMS.TENANT_PREFIX}${tenantId}`,
  dashboard: (dashboardId) => `${SOCKET.ROOMS.DASHBOARD_PREFIX}${dashboardId}`,
  all: () => SOCKET.ROOMS.ALL,
};
