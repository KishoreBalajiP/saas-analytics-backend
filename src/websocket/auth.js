/**
 * Socket.IO handshake authentication + room authorisation.
 *
 * WHY IT EXISTS
 *   Every realtime connection must be tied to a verified identity, and a
 *   socket may only ever receive events for its own tenant. Without this,
 *   anyone could open a socket and ask to join `tenant:<someone-else>`.
 *
 * RESPONSIBILITY
 *   - `authenticateSocket` (an `io.use()` middleware): reads the access
 *     token from `handshake.auth.token` (or an `Authorization: Bearer`
 *     header) and runs the same checks as the HTTP guard
 *     (`verifyAccessToken`: signature, audience, live session, active
 *     account and tenant). `handshake.auth.audience: 'admin'` selects the
 *     admin audience; anything else is a tenant user. Failures reject the
 *     connection with `connect_error` (`err.data.code`).
 *   - Caps the sockets one identity may hold open on this instance
 *     (`SOCKET_MAX_CONNECTIONS_PER_IDENTITY`); further handshakes are refused
 *     with `RATE_LIMITED`.
 *   - `authorizeRoomJoin`: the only rooms a client may ask for are its own
 *     tenant room and dashboard rooms of dashboards in its own tenant, the
 *     latter only with `dashboards.view` (the same permission the REST API
 *     requires to read a dashboard). Personal and tenant rooms are joined by
 *     the server at connect time.
 *
 * SECURITY RULES
 *   - Tokens are never read from the query string (it ends up in logs).
 *   - The tenant comes from the verified token, never from the client.
 *   - A socket is disconnected when its access token expires, so a revoked
 *     session cannot keep listening beyond the token's lifetime.
 */

import env from '../config/env.js';
import { verifyAccessToken } from '../middleware/auth.middleware.js';
import { JWT_AUDIENCES } from '../utils/jwt.js';
import { ERROR_CODES } from '../config/constants.js';
import dashboardRepository from '../repositories/dashboard.repository.js';
import permissionService from '../services/permission.service.js';
import { roomNames, countClientsFor } from './rooms.js';

const MAX_CONNECTIONS_PER_IDENTITY = env.socket.maxConnectionsPerIdentity;

const BEARER_RE = /^Bearer\s+([^\s]+)$/i;

/** Error shape Socket.IO forwards to the client as `connect_error`. */
function socketError(message, code) {
  const err = new Error(message);
  err.data = { code };
  return err;
}

/** Access token from the handshake auth payload or Authorization header. */
export function readHandshakeToken(handshake) {
  const fromAuth = handshake?.auth?.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) {
    const match = BEARER_RE.exec(fromAuth);
    return match ? match[1] : fromAuth;
  }
  const header = handshake?.headers?.authorization;
  if (typeof header === 'string') {
    const match = BEARER_RE.exec(header);
    if (match) return match[1];
  }
  return null;
}

/**
 * `io.use()` middleware: verify the handshake token and bind the identity
 * to `socket.data.identity`.
 */
export async function authenticateSocket(socket, next) {
  const token = readHandshakeToken(socket.handshake);
  if (!token) return next(socketError('Authentication required', ERROR_CODES.UNAUTHORIZED));
  const isAdmin = socket.handshake?.auth?.audience === 'admin';
  try {
    const identity = await verifyAccessToken({
      token,
      audience: isAdmin ? JWT_AUDIENCES.ADMIN : JWT_AUDIENCES.USER,
    });
    socket.data.identity = {
      type: isAdmin ? 'admin' : 'user',
      id: String(identity.id),
      tenantId: isAdmin ? null : identity.tenantId ? String(identity.tenantId) : null,
      sessionId: identity.sessionId,
      expiresAt: identity.expiresAt,
    };
    if (!isAdmin && !socket.data.identity.tenantId) {
      return next(socketError('Tenant is required', ERROR_CODES.UNAUTHORIZED));
    }
    const open = countClientsFor({ actorType: socket.data.identity.type, actorId: socket.data.identity.id });
    if (MAX_CONNECTIONS_PER_IDENTITY > 0 && open >= MAX_CONNECTIONS_PER_IDENTITY) {
      return next(socketError('Too many open connections', ERROR_CODES.RATE_LIMITED));
    }
    return next();
  } catch (err) {
    const status = err?.statusCode;
    if (status === 401 || status === 403) {
      return next(socketError(err.message, err.code ?? ERROR_CODES.UNAUTHORIZED));
    }
    return next(socketError('Authentication failed', ERROR_CODES.UNAUTHORIZED));
  }
}

/** Rooms the server joins for a verified identity at connect time. */
export function defaultRoomsFor(identity) {
  const rooms = [identity.type === 'admin' ? roomNames.admin(identity.id) : roomNames.user(identity.id)];
  if (identity.type === 'user' && identity.tenantId) rooms.push(roomNames.tenant(identity.tenantId));
  return rooms;
}

/**
 * Decide whether `identity` may join `room`.
 *
 * @param {Object} identity - `socket.data.identity`.
 * @param {string} room
 * @returns {Promise<boolean>}
 */
export async function authorizeRoomJoin(identity, room) {
  if (!identity || typeof room !== 'string' || room.length === 0 || room.length > 200) return false;
  if (identity.type !== 'user' || !identity.tenantId) return false;

  if (room === roomNames.tenant(identity.tenantId)) return true;

  const dashboardPrefix = roomNames.dashboard('');
  if (room.startsWith(dashboardPrefix)) {
    const dashboardId = room.slice(dashboardPrefix.length);
    if (!dashboardId) return false;
    let dashboard = null;
    try {
      dashboard = await dashboardRepository.findById(dashboardId, { tenantId: identity.tenantId });
    } catch {
      return false; // malformed id
    }
    if (!dashboard || String(dashboard.tenantId) !== identity.tenantId) return false;
    // Same gate as `GET /dashboards/:id`: a member who may not view
    // dashboards must not receive their realtime events either.
    const permissions = await permissionService.resolveActorPermissions({
      actorType: 'user',
      actorId: identity.id,
      tenantId: identity.tenantId,
    });
    return permissions.includes('dashboards.view');
  }
  return false;
}

export default { authenticateSocket, authorizeRoomJoin, defaultRoomsFor, readHandshakeToken };
