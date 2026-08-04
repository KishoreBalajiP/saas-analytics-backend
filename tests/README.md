# Tests

Test strategy for the backend. Phase 1 ships one smoke test to prove the
request lifecycle; framework tests grow with features.

## Runner

Node's built-in test runner (`node --test`) - no extra dependency.

```bash
npm test
```

## Current tests

- `health.test.js` - boots the Express app (without a DB), hits
  `/api/v1/health`, and asserts the envelope shape. This also proves the
  `app.js` / `server.js` split works: tests import `app` directly.

## Conventions

- Unit tests: `src/modules/<feature>/<feature>.test.js`
- Integration tests: `tests/` (real HTTP round-trips, memory db via
  `mongodb-memory-server`)
- Never require a real MongoDB connection for unit tests.
