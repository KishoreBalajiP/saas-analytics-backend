# Backend Requirements and Test Traceability

This matrix maps requirements to repository evidence. “Partial” means implementation exists but the audit did not prove the complete property.

| Requirement/behavior | Source of truth | Implementation evidence | Tests/evidence | Status |
|---|---|---|---|---|
| User/admin authentication and sessions | `src/docs`, auth validators/tests | `src/modules/iam/auth`, auth/admin-auth routes, session model | Auth integration and session lifecycle tests; 561-suite pass | Implemented; production config unverified |
| Refresh rotation/replay revocation | Auth service/tests | Session family handling in auth service | Replay and logout tests observed passing | Implemented |
| MFA for admin lifecycle | Security docs/tests | MFA service and admin-auth routes | MFA integration tests | Implemented |
| Tenant lifecycle and membership | Tenant docs/tests | Tenant services, middleware, models, routes | Tenant and invitation integration tests | Implemented |
| Default-deny RBAC | Architecture docs/validators | Permission middleware, roles, permissions, admin middleware | RBAC validator/integration tests | Implemented |
| Tenant isolation | Architecture docs | `resolveTenant`, tenant plugins/repositories, analytics match injection | Multiple tenant tests; complete matrix still needed | Partial verification |
| Connector lifecycle and ingestion | Sprint 4 docs | Connector routes/services/providers/queues/models | Connector, webhook, storage tests | Implemented; live provider/network behavior unverified |
| Analytics query correctness | Sprint 5 docs | Analytics engine and query routes/services | Analytics tests and dashboard execution tests | Implemented; resource/performance limits need focused review |
| Dashboards/widgets | Sprint 6 docs | Dashboard/widget routes/services/models | Dashboard/widget integration tests | Implemented |
| Reports/alerts/notifications | Sprint 7 docs | Report, alert, notification modules/jobs | Alert/report/scheduler tests | Implemented; multi-process behavior unverified |
| Governance/monitoring/support | Sprint 8 docs | Access-log, compliance, audit, monitoring, support routes | Corresponding integration tests | Implemented; deployment semantics unverified |
| External API keys/embed | Sprint 9 docs | API-key middleware/routes, embed token routes/services | Sprint 9 tests and route evidence | Implemented; complete negative matrix needed |
| API contract authority | README/docs/frontend contracts | Distributed route/validator/controller/frontend files | No single OpenAPI artifact identified | Gap |
| Dependency/security baseline | `package.json`, npm audit | Current lockfile/dependency tree | `npm audit --omit=dev`: 2 moderate transitive findings | Risk remains |
| Static quality gates | package scripts/CI | Five custom CI guards | `npm run ci:guards`: pass | Type/lint gates absent |

