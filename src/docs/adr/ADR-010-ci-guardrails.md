# ADR-010: Five CI Guardrails

**Status:** Accepted
**Date:** 2026-08-05

## Context

Architectural rules drift when the team grows. CI must fail when
a rule is broken.

## Decision

Five Node-based guards under `scripts/ci/`, wired to
`npm run ci:guards`:

- `check-stubs` — no orphan `notImplementedStub` (allowlist
  enforced).
- `check-routes` — every real route has auth (or explicit
  exemption).
- `check-models` — every Mongoose model uses a shared plugin.
- `check-config` — `process.env` only in `src/config/`, `tests/`,
  `scripts/ci/`.
- `check-readme-sync` — root docs exist + per-module `STATUS.md`.

## Consequences

**Easier:**

- Guardrails are zero-dependency (Node-only) so they run in any
  CI.
- New stubs are explicit (`stubs-allowlist.js`); removing a stub
  happens alongside its real implementation.
- Structural drift becomes a CI failure, not a taste argument.

**Harder:**

- Adding a new guard requires updating `run-all.js` and the
  `scripts` allowlist in `package.json`.
- Regex-based checks can produce false positives; mitigated by
  stripping comments + strings before matching.

## Implementation

- `scripts/ci/check-stubs.js` + `stubs-allowlist.js`.
- `scripts/ci/check-routes.js`.
- `scripts/ci/check-models.js`.
- `scripts/ci/check-config.js`.
- `scripts/ci/check-readme-sync.js`.
- `scripts/ci/run-all.js` — single entry point.

## Related

- [`definition-of-done.md`](../development/definition-of-done.md)