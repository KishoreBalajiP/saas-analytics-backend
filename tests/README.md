# Tests

Test strategy for the backend. Unit tests sit next to source; integration
tests live in `tests/` and run real HTTP round-trips against
`mongodb-memory-server`.

## Runner

Node's built-in test runner (`node --test`) - no extra dependency.

```bash
npm test
```

`npm test` runs the suite in **scrypt** KDF mode (`PASSWORD_KDF=scrypt`) so
it is portable on any machine (the `argon2` native binary is not required).
To exercise the real Argon2id KDF, run:

```bash
npm run test:argon2
```

To run a single file:

```bash
node --test tests/auth-flow.integration.test.js
```

## Current tests

### Unit / utility
- `utils/password.test.js` - hash / verify / needsRehash for the active KDF
  (scrypt by default; Argon2id under `test:argon2`).

### Integration (real HTTP + `mongodb-memory-server`)
- `auth-flow.integration.test.js` - tenant-portal flow: login, generic error
  (no enumeration), tenant-header fail-closed, suspended user, lockout after
  N failures, `/me` lifecycle, refresh rotation + replay family revocation,
  logout.
- `admin-auth-mfa.integration.test.js` - admin-portal flow: login, `/me`
  without secret leak, MFA two-step enrolment + real TOTP code, login
  enforcing the code, refresh cookie rotation.
- `password-reset-session.integration.test.js` - forgot (no enumeration),
  reset-token mint/consume with purpose + audience + TTL, session family
  revoked on reset.
- `session-lifecycle.integration.test.js` - service + repository level:
  deterministic refresh-token lookup by hash, rotation, idempotent revoke,
  revoke-all, mark-expired.

### Smoke
- `health.test.js` - boots the Express app (without a DB) and asserts the
  envelope shape. Proves the `app.js` / `server.js` split.

## Conventions

- Unit tests: `src/modules/<feature>/<feature>.test.js`
- Integration tests: `tests/` (real HTTP round-trips, memory db via
  `mongodb-memory-server`)
- Never require a real MongoDB connection for unit tests.
- Auth integration tests set the tenant via `X-Tenant-Id` (see
  `tests/helpers/http.js`).
