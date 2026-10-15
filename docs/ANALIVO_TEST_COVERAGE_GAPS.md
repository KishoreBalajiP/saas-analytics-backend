# Analivo Test Coverage Gaps

- Frontend: 27 files/244 tests passed; coverage is strongest at API contracts and component behavior, not real browser/backend integration.
- Backend: extensive isolated MongoDB HTTP/service tests cover auth, MFA, RBAC, tenant isolation, dashboards, connectors, billing, audit and alerts; final command status must be captured before release sign-off.
- Missing/insufficient proof: real SMTP, external DB/Sheets, storage/Redis/BullMQ, live Razorpay sandbox, deployment parity, scheduled job execution, browser E2E, accessibility, SSRF/DNS-rebinding, large-query resource ceilings, backup/restore and retention drills.
