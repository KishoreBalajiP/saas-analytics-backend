# IAM / sessions

Sessions represent **the live state of an authenticated actor**: refresh
tokens, device bindings, IP allow/deny lists, and revocation records.

Sessions are deliberately NOT cookies. The HTTP transport issues opaque,
hashed refresh tokens that are looked up in this collection. An expired or
revoked session is the **single source of truth** for "is this identity
allowed right now".

## Why it exists

The JWT access token alone cannot:
- be revoked before its short TTL expires,
- detect token theft across devices/IPs,
- support "log out everywhere",
- support compliance "revoke all tokens for subject X".

Sessions fill that gap.

## Data shape (architecture only)

`models/Session.js`:

```
_id, actorId, actorType: 'user'|'admin'|'service',
tenantId | null,                          // platform sessions have null
refreshTokenHash (Argon2id),              // hashed; raw only at creation
device: {
  id, name, os, browser, fingerprint?,
},
ip, userAgent,
issuedAt, lastUsedAt, expiresAt,
status: 'active' | 'revoked' | 'expired',
revokedAt?, revokedReason?,
```

Indexes:
- `{ actorId: 1, status: 1 }`
- `{ refreshTokenHash: 1 }` (unique)
- TTL on `expiresAt` (drives auto-purge).

## Planned operations

- `auth.service.js#createSession({ actor, device, ip, ua })`
- `auth.service.js#rotateSession({ oldSession, newRefresh })`
- `auth.service.js#revokeSession({ sessionId, reason })`
- `auth.service.js#revokeAllForActor({ actorId, reason })`
- `auth.service.js#detectAnomalies({ session, currentContext })`

Each of these writes to `governance/audit-logs/` as a `session.*` event.

## Architectural shape

- Service: `src/services/admin.service.js` (Phase 1.2 reference shape);
  Phase 2 introduces `services/auth.service.js` + `services/session.service.js`.
- Repository: `src/repositories/admin.repository.js` (Phase 1.2 reference
  shape); Phase 2 introduces `repositories/session.repository.js`.
- Middleware: `auth.middleware.js` (existing) reads the bearer JWT and
  resolves the actor; a future `session.middleware.js` would inspect a
  long-lived session cookie for the Embed widget.

## Coding guidelines

- Refresh tokens are random 256-bit (`crypto.randomBytes(32)`), hashed at
  rest with Argon2id via `utils/crypto.js`.
- Access tokens (JWT) carry `sessionId` so revocation is instant - the
  middleware rejects when `session.status !== 'active'`.
- Rate-limit `/refresh` aggressively via `rateLimiter.middleware.js`.
- All session mutations emit an audit event.

## Future extension

- Device binding: tie a session to the original device fingerprint and
  challenge on change.
- Concurrent-session caps per actor.
- Realtime revocation via Socket.IO (`account.revoked` event).
