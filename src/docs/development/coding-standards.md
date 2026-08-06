# Development — Coding Standards

> **WHAT this is:** the coding standards every contributor follows.
> **WHY it exists:** consistency is the difference between a codebase
> that scales and one that collapses.
> **HOW to use it:** read before opening your first PR.
> **WHEN to update it:** when a rule changes.
> **WHERE it lives:** `src/docs/development/coding-standards.md`.

---

## Purpose

> **WHAT this is:** the coding standards.
> **WHY it exists:** consistency scales; inconsistency collapses.
> **HOW to use it:** read before opening your first PR.
> **WHEN to update it:** when a rule changes.
> **WHERE it lives:** `src/docs/development/coding-standards.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Every contributor** | Has the standards to follow. |
| **Reviewer** | Has the checklist. |

## Current Status

> **Status:** `Maintained`.
> **Sprint:** Always.
> **Owner:** Founding architect + Engineering team.

---

## Language & Runtime

- **Node.js 20 LTS**, ES modules (`"type": "module"` in
  `package.json`).
- No CommonJS; no `require()`; no `__dirname`; no `module.exports`.
- Use `import` / `export`.
- Use `node:fs`, `node:path`, etc., for built-ins.

## File Layout

- One concept per file.
- Tests live next to the source as `<name>.test.js`.
- `index.js` re-exports the public surface of a folder.
- `README.md` documents the folder's contract.

## Naming

| Thing | Convention | Example |
| --- | --- | --- |
| File | `kebab-case.js` | `auth.middleware.js` |
| Class | `PascalCase` | `ApiError` |
| Function / variable | `camelCase` | `parseExpiresIn` |
| Constant | `SCREAMING_SNAKE_CASE` | `JWT_AUDIENCES` |
| Mongo collection | `snake_case` (Mongoose pluralises) | `users`, `audit_logs` |
| Env var | `SCREAMING_SNAKE_CASE` | `JWT_SECRET` |
| Test file | `<source>.test.js` | `auth.test.js` |

## Imports

- Use the **public facade** of a layer; never reach into another
  layer's internals.
- Prefer named imports.
- Group imports: standard library → external packages → internal
  modules, separated by blank lines.

```js
import fs from 'node:fs/promises';

import express from 'express';
import helmet from 'helmet';

import env from './config/env.js';
import { sign } from './utils/jwt.js';
```

## Errors

- Throw `ApiError` factories.
- Never `throw new Error('something went wrong')`.
- Never return raw errors to clients; the global `errorHandler`
  formats them.

```js
import ApiError from '../utils/ApiError.js';

if (!user) throw ApiError.notFound('User not found');
if (!isOwner) throw ApiError.forbidden();
throw ApiError.validation('Invalid input', [{ field: 'email', message: 'required' }]);
```

## Async

- `async/await` everywhere.
- Wrap Express handlers with `asyncHandler`.
- Never mix callbacks with promises.

## Logging

- Use `req.log` (the Pino child attached by `requestIdMiddleware`).
- Never `console.log`.
- Never log secrets, tokens or passwords; the redaction paths in
  `config/env.js` cover common cases.

```js
req.log.info({ userId, action }, 'user updated');
```

## Configuration

- Read config from `config/env.js`; never from `process.env`.
- The CI guard `check-config` enforces this.

## Tests

- Use `node --test`.
- Tests live next to the source.
- Integration tests use `mongodb-memory-server`.

## Comments

- Comment the *why*, not the *what*.
- No `// increment i` over `i++`.
- No comments that paraphrase the code.

## JSDoc

- Every exported function gets a JSDoc block with `@param`,
  `@returns`, `@throws`.
- Every exported constant gets a JSDoc block explaining intent.

```js
/**
 * Sign a JWT.
 * @param {Object} params
 * @param {Object} params.payload
 * @returns {Promise<string>}
 */
export async function sign(params) { ... }
```

## Architecture Rules

The architecture rules in [`../README.md`](../README.md) are
non-negotiable. The CI guards enforce them.

## Best Practices

| Do | Why |
| --- | --- |
| **Read the matching doc** before touching a layer. | The layer has rules; the rules are documented. |
| **Run `npm run ci:guards` locally** before pushing. | The CI is the same check; no surprises. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Reading `process.env`** outside `src/config/`. | The CI guard blocks it. |
| **Returning raw errors.** | The global handler is the source of truth. |
| **Logging secrets.** | Pino redaction catches common fields; do not log new ones. |

---

## Summary

The coding standards are the discipline that keeps the codebase
coherent. CI enforces the load-bearing rules; reviewers check the
rest.

## Key Takeaways

- **ES modules only.**
- **One concept per file.**
- **Throw `ApiError` factories.**
- **CI enforces the load-bearing rules.**

## Interview Preparation

### Common Questions

- "How do you keep a codebase consistent?"

### Sample Answers

- **"Consistency?"** — Coding standards doc; one concept per file;
  ES modules only; `ApiError` factories only; CI guard enforces
  `process.env` discipline, fail-closed stubs, model plugin
  application, route auth middleware.

## Related Documents

- [`api-standards.md`](./api-standards.md) — wire format
- [`testing-strategy.md`](./testing-strategy.md) — how we test
- [`definition-of-done.md`](./definition-of-done.md) — what done means

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)