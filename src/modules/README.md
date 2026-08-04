# Feature Modules

This folder is the **Domain Layer**. Business features group here, even when
their HTTP/Service/Repository live in the shared technical-layer folders
(`src/controllers/`, `src/services/`, `src/repositories/`, `src/models/`).
Every module folder has a README that lays out *why*, *what*, *how*.

```
src/modules/<feature>/
├── README.md                          # purpose / responsibilities / extension
└── <feature>/...                      # per-submodule READMEs where applicable
```

The technical layer (controllers / services / repositories / models /
validators / middleware) is shared by domain modules and follows the
convention already documented in each of those folders' README files.

## Top-level umbrellas (Phase 1.2+)

| Umbrella    | Scope                                                                              |
| ----------- | ---------------------------------------------------------------------------------- |
| `iam/`      | Identity & access: admins, users, tenants, roles, permissions, sessions, auth     |
| `platform/` | Cross-cutting config + ops: master-data, settings, feature-flags, monitoring, ... |
| `governance/` | Audit logs, access logs, compliance requests and evidence                       |
| `analytics/`  | Dashboards, reports                                                              |
| `connectors/` | CSV, Google Sheets, webhooks, MongoDB, SQL, etc. (Phase 1.1)                     |

The Admin Portal and Tenant Portal share this single backend; the same HTTP
routes serve both, with **dynamic RBAC** (admin vs tenant scopes enforced by
`permission.middleware.js` and `tenantIsolation.middleware.js`) deciding what
each caller sees.

## Submodules by umbrella

### `iam/` - Identity & Access Management
| Submodule      | Responsibility                                           |
| -------------- | -------------------------------------------------------- |
| `auth`         | Login / refresh / logout, MFA, password reset            |
| `admins`       | Platform Admins (super / platform / support)             |
| `users`        | Tenant end-users (per-tenant scoping)                    |
| `tenants`      | Organisations, plans, statuses, lifecycle               |
| `roles`        | Dynamic roles (collections of permissions)              |
| `permissions`  | Dynamic modules, actions, permissions                   |
| `sessions`     | Refresh tokens, device binding, revocation              |

### `platform/` - Configuration & Operations
| Submodule          | Responsibility                                       |
| ------------------ | ---------------------------------------------------- |
| `master-data`      | Countries, currencies, plans, themes, languages     |
| `settings`         | Hot-reloadable, scoped, typed settings              |
| `feature-flags`    | Runtime gating for behaviour                         |
| `monitoring`       | System / DB / websocket / queue / scheduler / ...    |
| `notifications`    | In-app / email / push / webhook dispatch            |
| `email-templates`  | MJML / HTML / text templates + variable contracts    |
| `support`          | Admin impersonation, account recovery, lookups      |

### `governance/` - Traceability
| Submodule       | Responsibility                                           |
| --------------- | -------------------------------------------------------- |
| `audit-logs`    | `who / what / when / which resource / why` + tamper-evidence |
| `access-logs`   | Per-request HTTP trace (high cardinality)               |
| `compliance`    | GDPR / CCPA-style data-subject requests + evidence      |

### `analytics/`
| Submodule     | Responsibility                                       |
| ------------- | ---------------------------------------------------- |
| `dashboards`  | Authoring + viewing dashboards, layout, sharing     |
| `reports`     | Scheduled + ad-hoc reports, exports, deliveries     |

### `connectors/` (Phase 1.1)
| Submodule        | Responsibility                                  |
| ---------------- | ----------------------------------------------- |
| `csv/`           | CSV upload + mapping                            |
| `google-sheets/` | Google Sheets pull                              |
| `webhook/`       | Inbound / outbound webhooks                     |
| `mongodb/`       | MongoDB source (encrypted connection string)   |
| `shared/`        | Shared sync engine + shared utilities           |

### Other (kept from earlier phases)
| Folder       | Scope                                                        |
| ------------ | ------------------------------------------------------------ |
| `alerts/`    | Anomaly detection, notifications, webhooks (planned)         |
| `embed/`     | Public signed widgets for external sites (Phase 1)          |

See each `modules/<umbrella>/<submodule>/README.md` for its specific plan.
