# Sprint 9 — Analytics + Embed

> **WHAT this is:** the plan for Sprint 9 — dashboards, CSV reports,
> signed embed widgets.
> **WHY it exists:** Sprint 9 closes Phase 2 with the user-visible
> *output* of every other sprint.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-9.md`.

---

## Purpose

> **WHAT this is:** the plan for Sprint 9 — Analytics + Embed.
> **WHY it exists:** Sprint 9 closes Phase 2 with the user-visible
> *output* of every other sprint.
> **HOW to use it:** read *Scope* and *Deliverables*.
> **WHEN to update it:** as the sprint closes.
> **WHERE it lives:** `src/docs/phases/sprint-9.md`.

## Intended Audience

| Reader | What they get |
| --- | --- |
| **Sprint 9 implementer** | Has the full plan. |
| **PM** | Has the user-visible surface to validate. |

## Current Status

> **Status:** `Planned`.
> **Sprint:** Sprint 9.
> **Owner:** Engineering team.

## Business Perspective

Sprint 9 is the *output* of every other sprint. Customers build
dashboards, run reports, and embed widgets externally. After Sprint 9
the MVP is end-to-end demoable.

## Technical Perspective

`Dashboard`, `Report`, `ReportRun`, `EmbedToken` models. Reports
queued via `services/queue.service.js`. Artefacts persisted via
`services/storage.service.js`. WebSocket emit on
`dashboard:updated`.

## Scope

### Dashboards
- CRUD with optimistic concurrency.
- Single current version per dashboard; soft-delete 30 d.
- WS emit on `dashboard:<id>` (event `dashboard:updated`).

### Reports
- CRUD + run + download.
- CSV output only (Phase 3 adds PDF + XLSX).
- Parameters persisted per run.
- Queued via `queues/analytics.queue.js`.

### Embed
- Sign short-lived tokens.
- `/embed/<token>` validates the token + returns the dashboard data
  scoped to the token's dashboard id.
- Tokens are revocable.

## Deliverables

### Models
- `src/models/Dashboard.js`
- `src/models/Report.js`
- `src/models/ReportRun.js`
- `src/models/EmbedToken.js`

### Services
- `src/modules/analytics/dashboards/dashboard.service.js`
- `src/modules/analytics/reports/report.service.js`
- `src/modules/embed/embed.service.js`

### Routes (real)
- `src/routes/dashboard.routes.js`
- `src/routes/report.routes.js`
- `src/routes/embed.routes.js`

### Consumer
- `src/queues/analytics.queue.js#registerConsumer` — Sprint 9 stub
  becomes a real consumer that runs the report and stores the
  artefact.

## Dependencies

- Sprint 0 (queue + storage) + Sprint 6 (connectors).

## Testing

- Unit: dashboard layout diff; report run produces CSV; embed token
  signs + verifies.
- Integration: a manager saves a dashboard → WS emit on
  `dashboard:<id>`; another tab re-renders. A manager runs a report
  → CSV artefact in storage. A manager signs an embed token → an
  unauthenticated client loads `/embed/<token>`.

## Risks

1. **Report memory pressure** on large datasets. Stream to storage;
   never build the full CSV in memory.
2. **Embed token leakage.** Short TTL (default 5 min) + scoped to
   one dashboard + revocable.
3. **Dashboard version drift.** Sprint 9 ships a single current
   version; history via soft-delete; full versioning is Phase 3.

## Definition of Done

- [ ] All deliverables merged.
- [ ] `POST /dashboards` creates a dashboard; save emits WS
      `dashboard:updated`.
- [ ] `POST /reports/:id/run` enqueues; consumer produces a CSV in
      storage.
- [ ] `GET /reports/:id/runs/:runId/download` returns the CSV.
- [ ] `POST /embed/sign` returns a short-lived token.
- [ ] `GET /embed/<token>` returns the dashboard data without
      authentication.
- [ ] 90 %+ test coverage.
- [ ] `STATUS.md` updated.

## Expected Outcome

The MVP is end-to-end. A customer can ingest data → build a
dashboard → run a report → embed externally.

## Best Practices

| Do | Why |
| --- | --- |
| **Stream report artefacts to storage.** | A 10 GB report must not OOM. |
| **Sign embed tokens short-lived.** | Tokens in URLs are easier to leak. |

## Common Mistakes

| Don't | Why |
| --- | --- |
| **Building the full report in memory.** | OOM. |
| **Long-lived embed tokens.** | Tokens in URLs are easy to leak. |

---

## Summary

Sprint 9 closes Phase 2. After Sprint 9 customers can ingest data,
build dashboards, run reports and embed externally.

## Key Takeaways

- **Reports stream to storage; never build in memory.**
- **Embed tokens are short-lived + revocable.**
- **Dashboards emit WS on update.**

## Interview Preparation

### Common Questions

- "How do you sign embed tokens?"
- "How do you handle large reports?"

### Sample Answers

- **"Embed tokens?"** — Short-lived JWT-style signed token scoped to
  one dashboard id; default TTL 5 min; the customer can revoke the
  token by deleting the dashboard or explicitly revoking the embed.

- **"Large reports?"** — Stream-parse the source data; write CSV
  rows to the storage service as they are produced; never build the
  full CSV in memory.

### Real-World Examples

- A regional manager at Acme opens a dashboard, adds a chart, saves;
  another open tab re-renders via WS `dashboard:updated`.

### Common Mistakes

- Building the full report in memory.
- Long-lived embed tokens.

## Related Documents

- [`phase-2.md`](./phase-2.md) — phase
- [`sprint-8.md`](./sprint-8.md) — previous
- [`phase-3.md`](./phase-3.md) — what comes after Phase 2

## Last Updated

- **Sprint:** Sprint 0 close
- **Phase:** Phase 2 — Implementation
- **Sprint planned:** Sprint 9
- **Date:** 2026-08-05
- **Author:** Documentation (Sprint 0)