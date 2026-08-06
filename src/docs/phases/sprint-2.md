# Sprint 2 — IAM (Admins, Tenants, Users)

> **WHAT this is:** the plan for Sprint 2 — Identity & Access
> Management lifecycle (admin / tenant / user CRUD, invitations,
> suspend / restore).
> **WHY it exists:** Sprint 1 lets a user log in; Sprint 2 lets the
> platform invite more users, manage the tenant and the admin
> roster.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-2.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 2 — IAM lifecycle.
> **WHY it exists:** Sprint 1 lets a user log in; Sprint 2 lets the
> platform operate on identities.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-2.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 2 implementer** | Has the full plan. |
| **Tech lead** | Has the dependency list to plan around. |
| **Security reviewer** | Has the cascade rules to review. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 2.
> **Owner:** Engineering team.

## Business Perspective

Sprint 2 is what makes the platform *organisational*: a Platform
Admin can create tenants; a Tenant Owner can invite teammates; a
Tenant Admin can configure the tenant. Suspend cascades protect the
business from a churning customer.

## Technical Perspective

The `User`, `Admin`, `Tenant` models from Sprint 1 gain their
lifecycle endpoints. `tenantIsolation` middleware becomes real.
Invitation flow uses the email queue from Sprint 0.

## Scope

- `/admin/admins/*` — CRUD on Platform Admin accounts (Super /
  Platform / Support). Suspend / restore. Roles assignment.
- `/tenants/*` — CRUD on tenants. Suspend / restore cascades to
  sessions. Members listing.
- `/tenants/:tenantId/users/*` — CRUD on tenant users. Invitation
  flow with 7-day expiry. Suspend / restore.
- `tenantIsolation` middleware (real).
- Email invitations via the email queue.

## Deliverables

### Routes (real)
- `src/routes/admin.routes.js`
- `src/routes/tenant.routes.js`
- `src/routes/user.routes.js`

### Services
- `src/modules/iam/admins/admin.service.js`
- `src/modules/iam/tenants/tenant.service.js`
- `src/modules/iam/users/user.service.js`
- `src/modules/iam/tenants/invitation.service.js`

### Middleware (real)
- `src/middleware/tenantIsolation.middleware.js`

### Templates (email)
- `src/templates/emails/invitation.email.html`
- `src/templates/emails/account-suspended.email.html`

### Consumers
- `src/queues/email.queue.js#registerConsumer` — Sprint 1 stub
  becomes a real consumer that renders invitation / suspended
  templates.

## Dependencies

- Sprint 1 (every model + auth middleware).

## Testing

- Unit: invitation token generation + verification; suspend cascade.
- Integration: Platform Admin creates a tenant → invites a Tenant
  Owner → Tenant Owner logs in (Sprint 1) → invites a Tenant Admin →
  Tenant Admin invites a tenant user → user accepts.
- Security: suspended user cannot refresh; suspended tenant's
  sessions are revoked; cross-tenant invitation rejected.

## Risks

1. **Suspend cascade race.** Suspending must atomically revoke all
   sessions; otherwise a churn-customer's data is reachable for the
   refresh window. Mitigation: serial revoke inside the request;
   queue-based async revoke is Phase 3.
2. **Invitation replay.** Tokens are single-use; verification must
   mark them used atomically.
3. **Tenant slug immutability.** Documented; do not allow update.
4. **`super_admin` cannot be demoted** except by another super
   admin with MFA + 24h cool-down. Document the rule in the model.

## Definition of Done

- [ ] All deliverables merged.
- [ ] `POST /admin/admins` works (super_admin only).
- [ ] `POST /tenants` works (admin only); `slug` is immutable.
- [ ] `POST /tenants/:id/suspend` revokes every session for the tenant.
- [ ] `POST /tenants/:id/users` sends an invitation email via the
      queue.
- [ ] Invitation accept flow lands the user on `/auth/me`.
- [ ] `tenantIsolation` middleware rejects cross-tenant reads.
- [ ] 90 %+ test coverage on touched surfaces.
- [ ] `npm run ci:guards` passes.
- [ ] `STATUS.md` updated.

## Expected Outcome

The platform is organisational. A Platform Admin can create tenants;
tenants can grow.

## Real-world Examples

- [`04-business-flow.md`](../04-business-flow.md) steps 1, 2 and 4 use
  this sprint.
- [`05-user-journey.md`](../05-user-journey.md) personas Platform Admin
  and Tenant Owner exercise this sprint daily.

## Best Practices

| Do | Why |
| --- | --- |
| **Serialise suspend cascades inside the request.** | Race-free; observability is easier. |
| **Hash invitation tokens** before persisting. | The DB breach does not leak valid invitations. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Allowing `super_admin` demotion without another super + MFA + cool-down.** | The founder / sole-owner scenario; the rule exists. |
| **Letting suspended users refresh.** | The cascade is the security boundary. |

---

## Summary

Sprint 2 ships IAM lifecycle: admin / tenant / user CRUD,
invitations, suspend / restore cascades, tenant isolation. After
Sprint 2 the platform is organisational.

## Key Takeaways

- **Suspend cascades are security-critical.** They must atomically
  revoke sessions.
- **Invitation tokens are secrets.** Hash them at rest.
- **`super_admin` is protected** by the demotion rule.

## Interview Preparation

### Common Questions

- "How do you implement tenant suspension?"
- "How do you prevent cross-tenant access?"

### Sample Answers

- **"Tenant suspension?"** — Atomic revoke of every active session
  for the tenant inside the suspend request. The async revoke via
  queue is Phase 3; for MVP, in-request serial revoke is sufficient
  and observable.

- **"Cross-tenant access?"** — Three layers (`resolveTenant`,
  `tenantIsolation`, `tenantScope` plugin) — see
  [`02-project-vision.md`](../02-project-vision.md) and
  [`04-business-flow.md`](../04-business-flow.md).

### Real-World Examples

- A churning customer requests suspension. The Platform Admin
  clicks Suspend. Within the same request, every session for that
  tenant is revoked. The customer's refresh tokens stop working
  immediately.

### Common Mistakes

- Allowing cross-tenant reads. The `tenantScope` plugin is the
  guardrail; do not bypass it.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-1.md`](./sprint-1.md) — previous
- [`sprint-3.md`](./sprint-3.md) — next

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 2
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)