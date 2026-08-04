/**
 * Socket.IO server configuration.
 *
 * WHY IT EXISTS
 *   Keeps every realtime tuning knob in one place so `websocket/index.js`
 *   stays declarative and the transport settings are auditable.
 *
 * RESPONSIBILITY
 *   Provide the complete options object passed to the Socket.IO `Server`
 *   constructor (origin allow-list, heartbeat, transports, buffer limits).
 *
 * HOW TO EXTEND
 *   - Add a namespace or room convention in `websocket/` (not here).
 *   - Tune heartbeats / buffer sizes via `.env` variables.
 */

import env from './env.js';

export default {
  path: '/socket.io',
  serveClient: false, // do not ship the client bundle from the server
  cors: {
    origin: env.socket.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST'],
  },
  pingInterval: env.socket.pingIntervalMs,
  pingTimeout: env.socket.pingTimeoutMs,
  maxHttpBufferSize: env.socket.maxHttpBufferSize,
  transports: env.socket.transports,
  allowEIO3: false, // only Engine.IO v4
  connectTimeout: 20000,
  perMessageDeflate: {
    threshold: 1024,
  },
};
