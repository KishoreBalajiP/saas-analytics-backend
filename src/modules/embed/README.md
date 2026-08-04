# Module: Embed

Planned scope - NOT implemented in Phase 1.

- Public, signed embed tokens (short-lived, scoped to one dashboard)
- `/embed/<token>` widget endpoint for external sites
- Dedicated Socket.IO channel `embed:<tokenHash>` for live updates

Hook points already prepared:
- `src/routes/embed.routes.js` - empty router ready for endpoints
- `src/websocket/rooms.js` - room helpers
- `src/utils/crypto.js` - token generation / hashing for tokens

Security notes
- Embed tokens must be signed, expiring, and revocable.
- Review CORS/CSP (helmet) for widget contexts together with security.
