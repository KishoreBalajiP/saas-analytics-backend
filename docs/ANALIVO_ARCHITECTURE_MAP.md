# Analivo Architecture Map

## Components

```text
Browser (React 19 + TanStack Router + TanStack Query)
        |
        | frontend/src/lib/api/client.ts, cookies/bearer tokens
        v
Express 5 /api/v1 (backend/src/app.js)
  request ID -> access log -> helmet/CORS -> rate limits -> JSON/raw webhook parsing
        |
        +--> auth/admin-auth -> sessions/JWT -> User/Admin + tenant/RBAC/permissions
        +--> tenants/users/invitations/access requests/settings/billing
        +--> connectors/uploads/webhooks -> connector registry -> rows/queues/workers
        +--> analytics -> query engine/cache -> widgets/dashboards/reports/exports
        +--> API keys/external API/embed tokens
        +--> audit/access/compliance/monitoring
        |
        +--> MongoDB/Mongoose models and repositories
        +--> local/S3 storage, SMTP, Razorpay, optional Redis/BullMQ, Socket.IO
        +--> node-cron scheduler and worker jobs
```

## Key locations

- Startup: `backend/src/server.js`, `backend/src/app.js`.
- Route composition: `backend/src/routes/index.js` and `backend/src/routes/*.routes.js`.
- Middleware: `backend/src/middleware/*.middleware.js`.
- Business logic: `backend/src/services`, `backend/src/modules`, `backend/src/controllers`.
- Persistence: `backend/src/models`, `backend/src/repositories`, Mongoose plugins under `models/plugins`.
- Frontend router/pages: `frontend/src/router.tsx`, `frontend/src/routes`.
- Frontend feature contracts: `frontend/src/features/*/api` and components.
- Configuration: `backend/src/config`, `backend/.env.example`, `frontend/.env.example`.

## Important boundaries

Authentication, tenant isolation and permission checks are backend responsibilities; frontend route guards are presentation/navigation controls. Connector credentials and MFA secrets are intended to be encrypted at rest. API key secrets are intended to be displayed once and persisted only as hashes. Several provider/job boundaries remain explicit stubs and must be treated as unavailable until staged verification proves otherwise.
