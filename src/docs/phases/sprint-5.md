# Sprint 5 — Platform: Settings, Feature Flags, Notifications

> **WHAT this is:** the plan for Sprint 5 — platform-wide and
> per-tenant configuration (settings, feature flags, notifications).
> **WHY it exists:** every later sprint reads settings and emits
> notifications; Sprint 5 ships the engine.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-5.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 5 — Settings, Feature Flags,
> Notifications.
> **WHY it exists:** every later sprint reads settings and emits
> notifications; Sprint 5 ships the engine.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-5.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 5 implementer** | Has the full plan. |
| **Tech lead** | Has the rollout strategy. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 5.
> **Owner:** Engineering team.

## Business Perspective

Customers want to configure their tenant (settings), flip features
on / off (feature flags), and receive in-app + email notifications
when something important happens. Sprint 5 ships all three.

## Technical Perspective

`Setting` (typed, secret-aware), `FeatureFlag` (4 rollout strategies),
`Notification` (channels: `in_app`, `email`; `push` and `webhook`
deferred). Cache keys `settings:<scope>:<tenantId|platform>:<key>`
and `feature-flag:<key>`.

## Scope

### Settings
- Platform scope + tenant scope.
- Type-bound (`string`, `number`, `boolean`, `json`, `duration`).
- `isSecret` values never returned in plaintext.
- Optimistic concurrency via `version`.

### Feature flags
- 4 rollout strategies: `all`, `tenantId`, `percentage` (hashed),
  `attribute`.
- Per-tenant cache invalidation.

### Notifications
- Channels in MVP: `in_app`, `email`. `push` and `webhook`
  deferred to Phase 3.
- Transactional emails bypass user preferences; everything else
  respects opt-outs.
- Failed sends retry with backoff (max 3).
- WS emit on `user:<id>` room for in-app.

## Deliverables

### Models
- `src/models/Setting.js`
- `src/models/FeatureFlag.js`
- `src/models/Notification.js`

### Services
- `src/modules/platform/settings/setting.service.js`
- `src/modules/platform/feature-flags/feature-flag.service.js`
- `src/modules/platform/notifications/notification.service.js`
- `src/modules/platform/notifications/dispatcher.service.js`

### Routes
- `src/routes/settings.routes.js`
- `src/routes/feature-flag.routes.js`
- `src/routes/notification.routes.js`

### Job (real)
- `src/jobs/email.job.js` — drains the email queue (Sprint 1 stub
  becomes real).

## Dependencies

- Sprint 3 (RBAC) + Sprint 0 (email service).

## Testing

- Unit: setting type coercion; feature-flag percentage hashing;
  notification channel dispatch.
- Integration: a `tenant_admin` flips a flag for their tenant; the
  tenant's `/feature-flags/resolve` returns the new value.

## Risks

1. **Secret redaction** must be enforced on every read path.
2. **Feature flag cache poisoning** — invalidate on every write.
3. **Notification spam** — rate-limit per user per channel.

## Definition of Done

- [ ] All deliverables merged.
- [ ] Setting CRUD with type binding + secret redaction.
- [ ] Feature-flag CRUD with 4 rollout strategies.
- [ ] Notification inbox + admin broadcast + preferences.
- [ ] `jobs/email.job.js` drains the email queue.
- [ ] WS emit on `user:<id>` for in-app notifications.
- [ ] 90 %+ test coverage.
- [ ] `STATUS.md` updated.

## Expected Outcome

Customers can configure their tenant; tenants can flip features;
notifications work in-app and by email.

## Best Practices

| Do | Why |
| --- | --- |
| **Redact secrets on every read.** | The setting cache leaks secrets if you forget. |
| **Invalidate feature-flag cache on every write.** | Stale flag = wrong rollout. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Returning `isSecret: true` values in plaintext.** | Logs and SDKs leak secrets. |

---

## Summary

Sprint 5 ships settings, feature flags and notifications. After
Sprint 5 the platform is configurable.

## Key Takeaways

- **Settings are typed and secret-aware.**
- **Feature flags have 4 rollout strategies.**
- **Notifications: in-app + email in MVP.**

## Interview Preparation

### Common Questions

- "How do you implement feature flags?"
- "Why type-bound settings?"

### Sample Answers

- **"Feature flags?"** — Four strategies: `all` (everyone), `tenantId`
  (specific tenants), `percentage` (hashed, deterministic per
  tenant), `attribute` (per-user property). Cache invalidated on
  every write.

- **"Type-bound?"** — Because settings are consumed by code; an
  untyped string is a bug magnet. The type system catches it at
  read time.

### Real-World Examples

- A Platform Admin sets `feature.compliance.eu-mode` to `true` for a
  single EU tenant. The tenant's `/feature-flags/resolve` returns
  `true`; everyone else's returns `false`.

### Common Mistakes

- Returning `isSecret: true` values in plaintext.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-4.md`](./sprint-4.md) — previous
- [`sprint-6.md`](./sprint-6.md) — next

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 5
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)