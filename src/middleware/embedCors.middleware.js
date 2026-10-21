/**
 * Embed CORS (embedding package, roadmap 3.2).
 *
 * Mounted in app.js on `<prefix>/embed/public` BEFORE the global CORS
 * middleware. There is no allow-all: an Origin gets CORS headers only when
 * it is Analivo's own frontend or is bound to a live embed token / tenant
 * embed config. The per-token origin check happens in the handler; this
 * layer only decides what the browser may call at all.
 *
 * Preflight (OPTIONS) is answered here: 204 with CORS headers for a known
 * origin, 204 without them otherwise (the browser then blocks the call).
 * No credentials: embeds never use cookies.
 */

import embedService from '../services/embed.service.js';

const ALLOW_METHODS = 'GET, POST, OPTIONS';
const ALLOW_HEADERS = 'Content-Type, Authorization, X-Request-Id';

export function embedCors() {
  return async (req, res, next) => {
    const origin = req.headers.origin;
    res.vary('Origin');
    let allowed = false;
    if (origin) {
      try { allowed = await embedService.isOriginKnown(origin); } catch { allowed = false; }
    }
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    }
    if (req.method === 'OPTIONS') {
      if (allowed) {
        res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
        res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
        res.setHeader('Access-Control-Max-Age', '600');
      }
      return res.status(204).end();
    }
    // Skip the global (credentialed) CORS policy for this surface.
    req.embedCorsHandled = true;
    return next();
  };
}

export default embedCors;
