# Governance / compliance

Compliance handles **regulatory requests from data subjects**:
export (data portability), delete (right to erasure), restrict processing,
consent withdrawal, and evidence retention.

It is its own module because it crosses tenant boundaries (a single user
may belong to many tenants) and must produce **proof of compliance**.

## Why it exists

GDPR, CCPA, HIPAA-style regulations require demonstrable workflows. A
scattergun approach across business modules breaks both the user's
expectations and the auditor's trust.

## What we handle

| Request type        | SLA (default) | Module path                                                |
| ------------------- | ------------- | ---------------------------------------------------------- |
| `export`            | 30 days       | bundles everything we know about subject -> presigned URL   |
| `delete`            | 30 days       | anonymises + cascades; preserves billing history (legal)   |
| `restrict`          | 7 days        | flips a flag; downstream services read it                  |
| `consent.withdraw`  | 7 days        | opts out of all non-transactional comms                    |
| `consent.grant`     | immediate     | accepts granular preferences (Phase 2)                     |

## Architectural shape

- Service: `src/services/compliance.service.js` - workflow state machine.
- Middleware: `src/middleware/compliance.middleware.js` - applied to
  business routes (read-while-deleted, restricted-mode reads, etc.).
- Routes: `src/routes/compliance.routes.js` mounted at
  `/api/v1/compliance`.
- Job: queued export runs through `src/queues/` to `src/storage/`.

## Data shape (architecture only)

`models/ComplianceLog.js`:

```
_id, requestId (public reference, unique),
type: 'export' | 'delete' | 'restrict' | 'consent.withdraw' | ...,
subjectId, subjectType: 'user' | 'tenant',
requesterId,                           // admin or subject themselves,
tenantScope?: string[],
status: 'received' | 'in_progress' | 'completed' | 'rejected',
evidenceKey?: string,                   // presigned storage URL
dueBy, completedAt?,
rejectionReason?,
createdAt
```

## Planned endpoints (`/api/v1/compliance`)

- `POST   /requests`        - data subject (or admin) files a request
- `GET    /requests`        - list (admin-only)
- `GET    /requests/:id`    - status + evidence link
- `POST   /requests/:id/cancel`  - cancel (only when not yet started)

Public subject-facing endpoints (no admin scope):
- `POST   /public/requests` (with a signed token) and
- `GET    /public/requests/:id` - subject polls status.

## Coding guidelines

- Compliance writes ALWAYS go through `audit.middleware.js`.
- Even "no data found" responses produce an audit entry (proof of search).
- `tenantIsolation.middleware.js` does NOT apply to cross-tenant
  compliance requests - they elevate via `compliance.request` permission.
- Delete is a *soft* operation until the audit retention window passes,
  then a *hard* anonymisation.

## Future extension

- Pre-canned compliance templates per region (EU, US, UK).
- Pseudonymisation service (`crypto.js` + a deterministic pepper).
- A/B test track: do customers prefer "delete vs restrict" UX?
