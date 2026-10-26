/**
 * Environment configuration loader.
 *
 * WHY IT EXISTS
 *   Centralises every environment-derived setting in a single validated
 *   module. Application code should never read `process.env` directly;
 *   it imports this config instead. This keeps configuration predictable,
 *   auditable and easy to test as the team grows.
 *
 * RESPONSIBILITY
 *   - Loads the `.env` file from the project root via dotenv.
 *   - Validates variables and fails fast in production when a required
 *     variable is missing.
 *   - Normalises raw strings into numbers, booleans and arrays.
 *   - Exports a deeply frozen, dependency-free configuration object.
 *
 * HOW TO EXTEND
 *   To add a setting:
 *     1. Document it in `.env.example`.
 *     2. Read it here with one of the `str() / num() / bool() / list()`
 *        helpers.
 *     3. Expose it under the matching `config.<section>` group.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// Load variables from `<project root>/.env` when present. Already-defined
// process.env values always win, which is what deploy platforms rely on.
dotenv.config({ path: path.join(projectRoot, '.env') });

// The project version falls back to the version declared in package.json so
// there is a single source of truth for the running build.
const pkg = require('../../package.json');

/* ----------------------------- helpers ---------------------------------- */

const read = (key) => process.env[key];

/** Read a string variable with a fallback default. */
const str = (key, fallback = '') => {
  const value = read(key);
  return value === undefined || value === '' ? fallback : value;
};

/** Read a numeric variable, falling back when absent or invalid. */
const num = (key, fallback) => {
  const value = Number(read(key));
  return Number.isFinite(value) && read(key) !== undefined ? value : fallback;
};

/** Read a boolean variable (accepts true/1/yes, case-insensitive). */
const bool = (key, fallback = false) => {
  const value = read(key);
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
};

/** Read a comma-separated list variable into a trimmed string array. */
const list = (key, fallback = []) => {
  const value = read(key);
  if (value === undefined || value === '') return fallback;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
};

/**
 * Read an identifier-like string (provider / model names): trimmed, with one
 * pair of surrounding quotes removed. Deploy dashboards often keep the quotes
 * or a trailing space pasted from a `.env` file, which would otherwise turn
 * `"gemini"` into an unknown provider.
 */
const ident = (key, fallback = '') => {
  const raw = str(key, '');
  const value = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  return value === '' ? fallback : value;
};

/** Gemini model ids, e.g. `gemini-2.5-flash` (an optional `models/` prefix is accepted). */
export const GEMINI_MODEL_PATTERN = /^(models\/)?gemini-[a-z0-9][a-z0-9.-]*$/i;

/** Fail-fast helper for variables that are mandatory in a given mode. */
const required = (key, value) => {
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable "${key}"`);
  }
  return value;
};

/* --------------------------- environment mode ---------------------------- */

const env = str('NODE_ENV', 'development');
const isProduction = env === 'production';
const isDevelopment = env === 'development';
const isTest = env === 'test';

if (!isProduction && !isDevelopment && !isTest) {
  throw new Error(
    `Invalid NODE_ENV "${env}". Expected "development", "production" or "test".`,
  );
}

/* ------------------------------ validation ------------------------------- */

// Secrets must exist in production. A dev-only default keeps local boot simple,
// but the app refuses to run in production with the known-insecure default.
const jwtSecret = str('JWT_SECRET', 'dev-only-insecure-jwt-secret');
if (isProduction) required('JWT_SECRET', jwtSecret === 'dev-only-insecure-jwt-secret' ? undefined : jwtSecret);

const mailPassword = str('MAIL_PASSWORD');
if (isProduction && str('MAIL_PROVIDER', 'smtp') !== 'none' && str('SMTP_HOST') && !mailPassword) {
  throw new Error('Missing required environment variable "MAIL_PASSWORD"');
}

// Password KDF: `argon2` (OWASP default, production) or `scrypt` (Node
// built-in fallback used by the test suite so hashing works on machines
// without a working Argon2 native binary). Fail fast on anything else so an
// unknown value can never silently weaken credential hashing.
const kdf = str('PASSWORD_KDF', 'argon2');
if (!['argon2', 'scrypt'].includes(kdf)) {
  throw new Error(`Invalid PASSWORD_KDF "${kdf}". Expected "argon2" or "scrypt".`);
}

// Process role (roadmap 1.4): which background work this process runs.
//   web    - HTTP + Socket.IO only; enqueues jobs but runs no consumers/cron.
//   worker - queue consumers + scheduler; no HTTP (see `src/worker.js`).
//   all    - everything in one process (development default).
const processRole = str('PROCESS_ROLE', 'all').toLowerCase();
if (!['web', 'worker', 'all'].includes(processRole)) {
  throw new Error(`Invalid PROCESS_ROLE "${processRole}". Expected "web", "worker" or "all".`);
}

/* --------------------------- configuration object ------------------------ */

const clientUrl = str('CLIENT_URL', 'http://localhost:3000');
const corsOrigins = list('CORS_ORIGINS', []).length ? list('CORS_ORIGINS', []) : [clientUrl];
const socketCorsOrigins = list('SOCKET_CORS_ORIGIN', []).length
  ? list('SOCKET_CORS_ORIGIN', [])
  : corsOrigins;

const config = Object.freeze({
  app: {
    name: str('APP_NAME', 'SaaS Analytics Platform'),
    version: str('APP_VERSION', pkg.version || '0.0.0'),
    env,
    isProduction,
    isDevelopment,
    isTest,
    port: num('PORT', 8080),
    apiPrefix: str('API_PREFIX', '/api/v1'),
    bodyLimit: str('REQUEST_BODY_LIMIT', '1mb'),
  },

  server: {
    trustProxy: num('TRUST_PROXY', 1),
    shutdownTimeoutMs: num('SHUTDOWN_TIMEOUT_MS', 10000),
    // How long shutdown waits for in-flight scheduler ticks and queue jobs
    // before closing their transports. Must stay below SHUTDOWN_TIMEOUT_MS.
    drainTimeoutMs: num('SHUTDOWN_DRAIN_TIMEOUT_MS', Math.max(1000, num('SHUTDOWN_TIMEOUT_MS', 10000) - 3000)),
  },

  // Process topology (roadmap 1.4). `instanceId` identifies this process in
  // job-run records and lock owners; Render exposes RENDER_INSTANCE_ID.
  runtime: {
    role: processRole,
    instanceId: str('INSTANCE_ID', str('RENDER_INSTANCE_ID', '')),
  },

  database: {
    uri: str('MONGODB_URI', 'mongodb://127.0.0.1:27017/saas_analytics'),
    connectAttempts: num('MONGODB_CONNECT_ATTEMPTS', 3),
    retryDelayMs: num('MONGODB_RETRY_DELAY_MS', 2000),
    maxPoolSize: num('MONGODB_MAX_POOL_SIZE', 50),
    minPoolSize: num('MONGODB_MIN_POOL_SIZE', 5),
    serverSelectionTimeoutMs: num('MONGODB_SERVER_SELECTION_TIMEOUT_MS', 10000),
    connectTimeoutMs: num('MONGODB_CONNECT_TIMEOUT_MS', 15000),
  },

  cors: {
    origins: corsOrigins,
    clientUrl,
  },

  security: {
    kdf,
    jwtSecret,
    jwtExpiresIn: str('JWT_EXPIRES_IN', '1d'),
    cookieSecure: bool('COOKIE_SECURE', isProduction),
    auth: {
      accessTokenTtl: str('JWT_ACCESS_TTL', '15m'),
      refreshTokenTtl: str('JWT_REFRESH_TTL', '30d'),
      cookieName: str('AUTH_COOKIE_NAME', 'saas_session'),
      // A deployed SPA and API almost always live on different sites (e.g.
      // vercel.app + onrender.com). A `Lax` cookie is NOT sent on those
      // cross-site refreshes, silently logging users out on reload, so the
      // production default is `None` (which requires `COOKIE_SECURE=true`).
      // Development keeps `Lax` because localhost is same-site over http.
      cookieSameSite: str('AUTH_COOKIE_SAMESITE', isProduction ? 'None' : 'Lax'),
      loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
      loginLockoutMs: num('LOGIN_LOCKOUT_MS', 15 * 60 * 1000),
      // adminauth: reset links live 1 hour by default (was 15 minutes).
      passwordResetTokenTtlMs: num('PASSWORD_RESET_TTL_MS', 60 * 60 * 1000),
      passwordResetTokenLength: num('PASSWORD_RESET_TOKEN_LENGTH', 32),
      // Email-verification link lifetime and the minimum gap between two
      // resend requests for the same account (anti-spam + anti-abuse).
      // adminauth: verification links live 24 hours by default (was 15 minutes).
      verificationTokenTtlMs: num('EMAIL_VERIFICATION_TTL_MS', 24 * 60 * 60 * 1000),
      verificationResendCooldownMs: num('EMAIL_VERIFICATION_RESEND_COOLDOWN_MS', 60 * 1000),
      mfaIssuer: str('MFA_ISSUER', 'saas-analytics'),
      // Each portal has its own refresh cookie, scoped to its own auth path,
      // so signing in to one portal never overwrites the other's session.
      // `cookieName` above is the tenant portal's cookie.
      adminCookieName: str('AUTH_ADMIN_COOKIE_NAME', 'saas_admin_session'),
      // Optional parent domain for a first-party deployment (API and SPA on
      // subdomains of one site, e.g. `.example.com`), which lets the cookie
      // use SameSite=Lax and survive third-party-cookie blocking. Empty keeps
      // a host-only cookie.
      cookieDomain: str('AUTH_COOKIE_DOMAIN', ''),
      // Hard ceiling on one sign-in, measured from the original login and
      // enforced at refresh no matter how often the token was rotated.
      sessionAbsoluteTtl: str('AUTH_SESSION_ABSOLUTE_TTL', '30d'),
      // How long one process reuses an account/tenant status lookup on the
      // authenticated request path. Status changes made through the app
      // invalidate the entry at once; other instances see them within this.
      statusCacheTtlMs: num('AUTH_STATUS_CACHE_TTL_MS', 5000),
      // A refresh token rotated less than this long ago, whose successor is
      // still live, is a lagging duplicate (two tabs, a retry that left
      // before the rotation's response arrived), not a replay: it gets an
      // access token for the successor and no new cookie. Later reuse still
      // revokes the whole family. 0 disables the grace.
      refreshReuseGraceMs: Math.max(0, num('AUTH_REFRESH_REUSE_GRACE_MS', 10000)),
      // adminauth: admin authentication completeness (roadmap 2.2).
      // Admin types that must use MFA. An admin of one of these types (or
      // holding a platform role of that name) who signs in without MFA gets
      // a session restricted to MFA enrolment. `none` turns the policy off.
      adminMfaRequiredTypes: (() => {
        const types = list('ADMIN_MFA_REQUIRED_TYPES', ['super', 'platform']).map((t) => t.toLowerCase());
        return types.includes('none') ? [] : types;
      })(),
      // How long a step-up (password + current code) authorises sensitive
      // admin actions on that session (granting super, credential resets,
      // reading secret settings, regenerating recovery codes).
      adminStepUpTtlMs: Math.min(60 * 60 * 1000, Math.max(30 * 1000, num('ADMIN_STEP_UP_TTL_MS', 5 * 60 * 1000))),
      // Lifetime of an emailed admin invitation link, and the minimum gap
      // between two resends for the same pending admin.
      adminInvitationTtlMs: num('ADMIN_INVITATION_TTL_MS', 72 * 60 * 60 * 1000),
      adminInvitationResendCooldownMs: num('ADMIN_INVITATION_RESEND_COOLDOWN_MS', 60 * 1000),
      // One-time MFA recovery codes issued at enrolment and regeneration.
      mfaRecoveryCodeCount: Math.min(20, Math.max(5, num('MFA_RECOVERY_CODE_COUNT', 10))),
      // mfa-tenant: how long a tenant user's step-up (password + current
      // code) authorises sensitive workspace actions on that session
      // (Owner-assisted MFA reset, regenerating recovery codes).
      userStepUpTtlMs: Math.min(60 * 60 * 1000, Math.max(30 * 1000, num('USER_STEP_UP_TTL_MS', 5 * 60 * 1000))),
    },
    rateLimit: {
      windowMs: num('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
      max: num('RATE_LIMIT_MAX', 300),
      strictMax: num('RATE_LIMIT_STRICT_MAX', 20),
      // External/public surfaces get their own tighter limits so a page
      // of embeds or a busy API consumer cannot exhaust the global budget.
      external: {
        windowMs: num('EXTERNAL_API_RATE_LIMIT_WINDOW_MS', 60 * 1000),
        max: num('EXTERNAL_API_RATE_LIMIT_MAX', 60),
      },
      embed: {
        windowMs: num('EMBED_RATE_LIMIT_WINDOW_MS', 60 * 1000),
        max: num('EMBED_RATE_LIMIT_MAX', 120),
      },
    },
    // External API keys (Sprint 9).
    apiKeys: {
      // Default lifetime in days when the caller does not set an expiry.
      defaultTtlDays: num('API_KEY_TTL_DAYS', 90),
      // Per-tenant cap on active keys (abuse guard).
      maxActivePerTenant: num('API_KEY_MAX_PER_TENANT', 100),
      // devapi: lifecycle and per-key limits (roadmap 3.3).
      // Longest lifetime a key may be given (days); requests beyond it are 400.
      maxTtlDays: num('API_KEY_MAX_TTL_DAYS', 365),
      // After a rotation the old key keeps working for this many minutes.
      rotationOverlapMinutes: num('API_KEY_ROTATION_OVERLAP_MINUTES', 60),
      // Requests per key per window on the external API (Redis when REDIS_URL).
      rateLimitWindowMs: num('API_KEY_RATE_LIMIT_WINDOW_MS', 60 * 1000),
      rateLimitMax: num('API_KEY_RATE_LIMIT_MAX', 120),
    },
    // Public embed surface (Sprint 9).
    embed: {
      // Default token lifetime when the caller does not set one.
      defaultTtlSec: num('EMBED_TOKEN_DEFAULT_TTL_SEC', 24 * 60 * 60),
      // Hard ceiling for any embed token TTL.
      maxTtlSec: num('EMBED_TOKEN_MAX_TTL_SEC', 7 * 24 * 60 * 60),
      // Cap on concurrent active tokens per dashboard.
      maxActivePerDashboard: num('EMBED_MAX_PER_DASHBOARD', 50),
      // Cross-origin reads of the public embed endpoint from any site are
      // opt-in. By default only CORS_ORIGINS may call it; embed tokens are
      // bearer credentials and should not be usable from arbitrary pages.
      corsAllowAllOrigins: bool('EMBED_CORS_ALLOW_ALL', false),
      // embedding: lifetime of the embed session minted by the iframe
      // handshake (POST /embed/public/session) and of public share links.
      sessionTtlSec: num('EMBED_SESSION_TTL_SEC', 15 * 60),
      shareMaxTtlSec: num('EMBED_SHARE_MAX_TTL_SEC', 90 * 24 * 60 * 60),
    },
    // Per-route limits for the auth surface. Every route class has its own
    // bucket (Redis-backed when REDIS_URL is set), so refreshes can never
    // exhaust the login or password-reset budget.
    authRateLimit: {
      windowMs: num('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
      loginMax: num('AUTH_RATE_LIMIT_LOGIN_MAX', 10), // per IP + account
      loginIpMax: num('AUTH_RATE_LIMIT_LOGIN_IP_MAX', 50), // per IP, all accounts
      refreshMax: num('AUTH_RATE_LIMIT_REFRESH_MAX', 120), // per IP + session cookie
      passwordMax: num('AUTH_RATE_LIMIT_PASSWORD_MAX', 5), // forgot/reset per IP + account
      invitationMax: num('AUTH_RATE_LIMIT_INVITATION_MAX', 20), // accept/preview per IP
      mfaMax: num('AUTH_RATE_LIMIT_MFA_MAX', 10), // MFA per admin
      verificationMax: num('AUTH_RATE_LIMIT_VERIFICATION_MAX', 5), // verify/resend per IP
      registerMax: num('AUTH_RATE_LIMIT_REGISTER_MAX', 10), // per IP
    },
  },

  socket: {
    corsOrigins: socketCorsOrigins,
    pingIntervalMs: num('SOCKET_PING_INTERVAL_MS', 25000),
    pingTimeoutMs: num('SOCKET_PING_TIMEOUT_MS', 20000),
    maxHttpBufferSize: num('SOCKET_MAX_HTTP_BUFFER_SIZE', 1000000),
    transports: list('SOCKET_TRANSPORTS', ['polling', 'websocket']),
    // Open sockets one signed-in identity may hold on one instance (tabs,
    // devices). Further handshakes are refused; 0 disables the cap.
    maxConnectionsPerIdentity: Math.max(0, num('SOCKET_MAX_CONNECTIONS_PER_IDENTITY', 20)),
  },

  redis: {
    url: str('REDIS_URL', ''),
    enabled: Boolean(str('REDIS_URL', '')),
  },

  queue: {
    // Producers (HTTP handlers, scheduler) give up after this long and return
    // a typed 503 instead of hanging while Redis is unreachable.
    producerTimeoutMs: num('QUEUE_PRODUCER_TIMEOUT_MS', 5000),
  },

  storage: {
    provider: str('STORAGE_PROVIDER', 'local'),
    baseDir: str('STORAGE_BASE_DIR', 'uploads'),
    bucket: str('S3_BUCKET', ''),
    region: str('S3_REGION', 'us-east-1'),
    endpoint: str('S3_ENDPOINT', ''),
    accessKeyId: str('S3_ACCESS_KEY_ID', ''),
    secretAccessKey: str('S3_SECRET_ACCESS_KEY', ''),
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
  },

  encryption: {
    key: str('ENCRYPTION_KEY', ''),
    algorithm: str('ENCRYPTION_ALGORITHM', 'aes-256-gcm'),
    keyVersion: num('ENCRYPTION_KEY_VERSION', 1),
  },

  mail: {
    provider: str('MAIL_PROVIDER', 'smtp'),
    host: str('SMTP_HOST', ''),
    port: num('SMTP_PORT', 587),
    secure: bool('MAIL_SECURE', num('SMTP_PORT', 587) === 465),
    user: str('MAIL_USER', ''),
    password: str('MAIL_PASSWORD', ''),
    from: str('MAIL_FROM', 'SaaS Analytics Platform <noreply@localhost>'),
    // retention: bounded SMTP timeouts (finding ops2.12). Without them the
    // library defaults (minutes) let a blocked or slow SMTP egress hang the
    // caller; the outbox retries anything that times out.
    connectionTimeoutMs: Math.max(1000, num('SMTP_CONNECTION_TIMEOUT_MS', 10000)),
    greetingTimeoutMs: Math.max(1000, num('SMTP_GREETING_TIMEOUT_MS', 10000)),
    socketTimeoutMs: Math.max(1000, num('SMTP_SOCKET_TIMEOUT_MS', 20000)),
    // retention: how long a transport verify (health probe) may take.
    verifyTimeoutMs: Math.max(500, num('SMTP_VERIFY_TIMEOUT_MS', 5000)),
  },

  // delivery: scheduled report / alert delivery pipeline (roadmap 3.4).
  delivery: {
    // Attempts per delivery before it is dead-lettered (webhook/Slack/Teams).
    maxAttempts: Math.max(1, num('DELIVERY_MAX_ATTEMPTS', 5)),
    // Recipients (members + external emails) per report schedule.
    maxRecipients: Math.max(1, num('DELIVERY_MAX_RECIPIENTS', 25)),
    // Artefacts up to this size are attached; larger ones are sent as a signed link.
    attachMaxBytes: Math.max(0, num('DELIVERY_ATTACH_MAX_BYTES', 5 * 1024 * 1024)),
    // Absolute origin prefixed to signed download links in emails (empty = relative).
    publicApiUrl: str('DELIVERY_PUBLIC_API_URL', ''),
    // Outbound HTTP timeout for webhook/Slack/Teams.
    timeoutMs: Math.max(1000, num('DELIVERY_TIMEOUT_MS', 10000)),
    // Tenant-supplied URLs never reach private networks unless explicitly allowed.
    allowPrivateNetworks: bool('DELIVERY_ALLOW_PRIVATE_NETWORKS', false),
  },

  // retention: durable email outbox (OutboundEmail) drained by the email job.
  outbox: {
    // Attempts before a message is dead-lettered.
    maxAttempts: Math.max(1, num('OUTBOX_MAX_ATTEMPTS', 6)),
    // Exponential backoff: base * 2^(attempt-1), capped at max.
    backoffBaseMs: Math.max(1000, num('OUTBOX_BACKOFF_BASE_MS', 30 * 1000)),
    backoffMaxMs: Math.max(1000, num('OUTBOX_BACKOFF_MAX_MS', 60 * 60 * 1000)),
    // Messages one drain tick may claim.
    batchSize: Math.max(1, num('OUTBOX_BATCH_SIZE', 50)),
    // Lease on a claimed message; an expired lease makes it claimable again.
    leaseMs: Math.max(5000, num('OUTBOX_LEASE_MS', 2 * 60 * 1000)),
    // Try to send a new message right after it is enqueued (the job is the
    // safety net that retries anything this misses).
    dispatchOnEnqueue: bool('OUTBOX_DISPATCH_ON_ENQUEUE', true),
  },

  scheduler: {
    enabled: bool('SCHEDULER_ENABLED', true),
    timezone: str('SCHEDULER_TIMEZONE', 'UTC'),
    // Lease on the per-job distributed lock (renewed while the job runs).
    lockLeaseMs: num('SCHEDULER_LOCK_LEASE_MS', 5 * 60 * 1000),
    // Lease taken on a due report/alert while one instance acts on it.
    claimLeaseMs: num('SCHEDULER_CLAIM_LEASE_MS', 5 * 60 * 1000),
  },

  razorpay: {
    enabled: bool('RAZORPAY_ENABLED', false),
    keyId: str('RAZORPAY_KEY_ID', ''),
    keySecret: str('RAZORPAY_KEY_SECRET', ''),
    webhookSecret: str('RAZORPAY_WEBHOOK_SECRET', ''),
    environment: String(str('RAZORPAY_ENVIRONMENT', 'test')).toLowerCase(),
    planMapping: (() => {
      const raw = str('RAZORPAY_PLAN_MAPPING_JSON', '');
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
        return {};
      } catch {
        return {};
      }
    })(),
  },

  analytics: {
    // Hard server-side time limit for one analytics aggregation (maxTimeMS).
    queryTimeoutMs: num('ANALYTICS_QUERY_TIMEOUT_MS', 15000),
    // Per-tenant, per-process bound on concurrent analytics aggregations.
    maxConcurrentPerTenant: num('ANALYTICS_MAX_CONCURRENT_QUERIES_PER_TENANT', 4),
    // Queries that may wait for a slot before the tenant gets 429.
    maxQueuedPerTenant: num('ANALYTICS_MAX_QUEUED_QUERIES_PER_TENANT', 16),
    // How long a queued query waits for a slot (milliseconds).
    queueTimeoutMs: num('ANALYTICS_QUERY_QUEUE_TIMEOUT_MS', 10000),
  },

  // reports: report artefacts and analytics exports (roadmap 1.5).
  artifacts: {
    // Hard safety cap on rows written into one artefact. Hitting it marks
    // the run `truncated`; below it the artefact holds the whole result.
    maxRows: Math.max(1, num('ARTIFACT_MAX_ROWS', 1000000)),
    // Server-side time limit for the cursor that streams one artefact.
    queryTimeoutMs: Math.max(1000, num('ARTIFACT_QUERY_TIMEOUT_MS', 10 * 60 * 1000)),
    // Lifetime of a signed artefact download link (seconds).
    downloadUrlTtlSec: Math.min(3600, Math.max(30, num('ARTIFACT_DOWNLOAD_URL_TTL_SECONDS', 300))),
  },

  connectors: {
    // Max CSV upload size in bytes (multer memory storage caps this).
    csvMaxUploadBytes: num('CONNECTOR_CSV_MAX_UPLOAD_MB', 10) * 1024 * 1024,
    // Max XLSX upload size in bytes (multer memory storage caps this).
    xlsxMaxUploadBytes: num('CONNECTOR_XLSX_MAX_UPLOAD_MB', 10) * 1024 * 1024,
    // External MongoDB source connect trail-safety defaults. Credentials
    // are never logged; these bound connect latency and result volume.
    // SSRF guard: allow connector hosts on loopback/private networks. Off in
    // production; on by default elsewhere so local development can point a
    // connector at a local database.
    allowPrivateNetworks: bool('CONNECTOR_ALLOW_PRIVATE_NETWORKS', !isProduction),
    mongodb: {
      maxDocsPerSync: num('MONGODB_CONNECTOR_MAX_DOCS_PER_SYNC', 100000),
      connectTimeoutMs: num('MONGODB_CONNECTOR_CONNECT_TIMEOUT_MS', 10000),
      serverSelectionTimeoutMs: num('MONGODB_CONNECTOR_SERVER_SELECTION_TIMEOUT_MS', 5000),
    },
    // A queued/running sync holds this lease (renewed while it runs). Once it
    // expires the connector can be re-queued and the reaper recovers it.
    syncLeaseMs: num('CONNECTOR_SYNC_LEASE_MS', 15 * 60 * 1000),
    // How many times the reaper re-queues an interrupted pull sync.
    syncMaxRecoveries: num('CONNECTOR_SYNC_MAX_RECOVERIES', 1),
    // Connector sync queue sizing.
    queue: {
      concurrency: num('CONNECTOR_QUEUE_CONCURRENCY', 5),
      attempts: num('CONNECTOR_QUEUE_ATTEMPTS', 5),
      backoffMs: num('CONNECTOR_QUEUE_BACKOFF_MS', 2000),
    },
    // Default webhook signature tolerance (seconds) when a connector does
    // not set `toleranceSeconds` in its own config.
    webhookToleranceSeconds: num('WEBHOOK_TOLERANCE_SECONDS', 300),
    // Encryption context scoping secrets per tenant + purpose.
    encryptionPurpose: str('CONNECTOR_ENCRYPTION_PURPOSE', 'connector'),
    // Egress policy for network connectors: optional allow-list of host
    // names or `.suffix` entries. Empty = any public host is allowed.
    egressAllowedHosts: list('CONNECTOR_EGRESS_ALLOWED_HOSTS', []),
    // Hard cap on rows one CSV/XLSX/webhook sync job may ingest.
    maxRowsPerSync: num('CONNECTOR_MAX_ROWS_PER_SYNC', 100000),
    // Wall-clock budget for one sync job (also bounds a stalled source).
    syncTimeoutMs: num('CONNECTOR_SYNC_TIMEOUT_MS', 10 * 60 * 1000),
    // XLSX zip-bomb guard: total inflated size of the workbook parts.
    xlsxMaxUncompressedBytes: num('CONNECTOR_XLSX_MAX_UNCOMPRESSED_MB', 100) * 1024 * 1024,
    // XLSX: widest row accepted (columns).
    xlsxMaxColumns: num('CONNECTOR_XLSX_MAX_COLUMNS', 1000),
    mongodbLimits: {
      socketTimeoutMs: num('MONGODB_CONNECTOR_SOCKET_TIMEOUT_MS', 30000),
      queryTimeoutMs: num('MONGODB_CONNECTOR_QUERY_TIMEOUT_MS', 60000),
    },
    webhook: {
      // Largest accepted webhook body (also the raw parser limit).
      maxBodyBytes: num('WEBHOOK_MAX_BODY_KB', 256) * 1024,
      // Most records one webhook delivery may carry.
      maxRecords: num('WEBHOOK_MAX_RECORDS', 1000),
      // How long a connector's decrypted signing key stays cached in memory.
      keyCacheTtlSeconds: num('WEBHOOK_KEY_CACHE_TTL_SECONDS', 300),
      // Transition switch: accept the legacy body-only `sha256=` signature
      // from connectors created before timestamp-bound signing. Turn off
      // once every sender has moved to `v2`.
      legacySignaturesEnabled: bool('WEBHOOK_LEGACY_SIGNATURES_ENABLED', true),
    },
  },

  jobs: {
    sheetSync: {
      cron: str('JOB_SHEET_SYNC_CRON', '0 */6 * * *'),
      enabled: bool('JOB_SHEET_SYNC_ENABLED', false),
    },
    // delivery: retries webhook / Slack / Teams deliveries (roadmap 3.4).
    deliveryRetry: {
      enabled: bool('JOB_DELIVERY_RETRY_ENABLED', true),
    },
    email: {
      // retention: drains the email outbox, so it runs by default.
      cron: str('JOB_EMAIL_CRON', '* * * * *'),
      enabled: bool('JOB_EMAIL_ENABLED', true),
    },
    cleanup: {
      cron: str('JOB_CLEANUP_CRON', '0 3 * * *'),
      enabled: bool('JOB_CLEANUP_ENABLED', false),
    },
    anomaly: {
      cron: str('JOB_ANOMALY_CRON', '0 * * * *'),
      enabled: bool('JOB_ANOMALY_ENABLED', false),
    },
    billingReconcile: {
      cron: str('JOB_BILLING_RECONCILE_CRON', '*/15 * * * *'),
      enabled: bool('JOB_BILLING_RECONCILE_ENABLED', false),
    },
    staleJobRecovery: {
      cron: str('JOB_STALE_RECOVERY_CRON', '*/5 * * * *'),
      enabled: bool('JOB_STALE_RECOVERY_ENABLED', true),
    },
    // Daily recount of usage counters from the real resources (roadmap 1.3).
    usageReconcile: {
      cron: str('JOB_USAGE_RECONCILE_CRON', '30 2 * * *'),
      enabled: bool('JOB_USAGE_RECONCILE_ENABLED', false),
    },
    // billing: prepaid-term lifecycle (expiry, grace, restriction, renewal
    // reminders). Access is enforced at read time regardless; the job
    // persists the state and sends reminders, so it runs by default.
    billingLifecycle: {
      cron: str('JOB_BILLING_LIFECYCLE_CRON', '5 * * * *'),
      enabled: bool('JOB_BILLING_LIFECYCLE_ENABLED', true),
    },
  },

  // billing: prepaid-term billing model (roadmap 3.1).
  billing: {
    // Grace days after an unrenewed term when the plan defines none.
    defaultGraceDays: Math.max(0, num('BILLING_DEFAULT_GRACE_DAYS', 7)),
    // Renewal reminders: days before the term ends (one email per offset).
    renewalReminderDays: list('BILLING_RENEWAL_REMINDER_DAYS', ['7', '1'])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0 && value <= 60)
      .sort((a, b) => b - a),
    // An unpaid checkout older than this is expired by reconciliation.
    pendingExpireHours: Math.max(1, num('BILLING_PENDING_EXPIRE_HOURS', 48)),
    // Reconcile backoff per open transaction (doubles per attempt).
    reconcileBackoffBaseMs: Math.max(1000, num('BILLING_RECONCILE_BACKOFF_BASE_MS', 60 * 1000)),
    reconcileBackoffMaxMs: Math.max(1000, num('BILLING_RECONCILE_BACKOFF_MAX_MS', 6 * 60 * 60 * 1000)),
    // Stored webhook events are retried with backoff up to this many times.
    webhookMaxAttempts: Math.max(1, num('BILLING_WEBHOOK_MAX_ATTEMPTS', 8)),
    // Seed the default plan catalogue at startup (idempotent; never
    // overwrites edited prices).
    seedPlansOnStartup: bool('BILLING_SEED_PLANS_ON_STARTUP', true),
  },

  usage: {
    // Usage at or above this share of a limit is flagged as a warning in the
    // usage API (soft-limit warning threshold), in percent.
    warningThresholdPercent: Math.min(100, Math.max(1, num('USAGE_WARNING_THRESHOLD_PERCENT', 80))),
    // Reconciliation leaves a counter alone when it changed this recently, so
    // an in-flight create (counter bumped, document not yet written) is not
    // mistaken for drift.
    reconcileSettleMs: Math.max(0, num('USAGE_RECONCILE_SETTLE_MS', 120000)),
    // How long per-day metered counters (API calls) are kept.
    meteredRetentionDays: Math.max(1, num('USAGE_METERED_RETENTION_DAYS', 90)),
    // A request-time reservation (a webhook delivery's storedRows) still
    // open after this many hours is presumed lost with its queue message:
    // reconciliation stops counting it and voids it.
    reservationTtlHours: Math.max(1, num('USAGE_RESERVATION_TTL_HOURS', 24)),
  },

  // members: tenant membership lifecycle (roadmap 2.10).
  members: {
    // How long a member invitation link stays valid (days). Expired invitations
    // are kept as history (status `expired`) by the invitation-expiry sweep.
    invitationTtlDays: Math.min(90, Math.max(1, num('INVITATION_TTL_DAYS', 7))),
    // How long a workspace waits between a deletion request and the purge.
    deletionGraceDays: Math.max(1, num('TENANT_DELETION_GRACE_DAYS', 30)),
    // Archived tenants are scheduled for purge this many days after archiving,
    // only when `purgeArchivedEnabled` is on (review before enabling).
    archivedRetentionDays: Math.max(1, num('TENANT_ARCHIVED_RETENTION_DAYS', 30)),
    purgeArchivedEnabled: bool('TENANT_PURGE_ARCHIVED_ENABLED', false),
    // Audit rows of a purged tenant follow the audit retention policy
    // (RETENTION_AUDIT_LOG_DAYS) instead of being deleted with the tenant.
    purgeRetainAuditLogs: bool('TENANT_PURGE_RETAIN_AUDIT_LOGS', true),
    // Payment, subscription-history and billing-webhook records of a purged
    // tenant are kept as financial records (legal review decides how long).
    purgeRetainBillingRecords: bool('TENANT_PURGE_RETAIN_BILLING_RECORDS', true),
    // Tenants purged per job run, and attempts before a purge stays failed.
    purgeBatchSize: Math.max(1, num('TENANT_PURGE_BATCH_SIZE', 5)),
    purgeMaxAttempts: Math.max(1, num('TENANT_PURGE_MAX_ATTEMPTS', 5)),
    // How long one purge may hold its claim before another run may retake it.
    purgeLeaseMs: Math.max(60000, num('TENANT_PURGE_LEASE_MS', 30 * 60 * 1000)),
    jobs: {
      tenantPurge: {
        cron: str('JOB_TENANT_PURGE_CRON', '15 * * * *'),
        enabled: bool('JOB_TENANT_PURGE_ENABLED', false),
      },
      invitationExpiry: {
        cron: str('JOB_INVITATION_EXPIRY_CRON', '*/30 * * * *'),
        enabled: bool('JOB_INVITATION_EXPIRY_ENABLED', true),
      },
    },
  },

  support: {
    // Per-admin daily cap on impersonation sessions (Sprint 8).
    impersonationBudgetDailyCap: num('SUPPORT_IMPERSONATION_DAILY_CAP', 20),
    impersonationTokenTtl: str('SUPPORT_IMPERSONATION_TOKEN_TTL', '15m'),
    // support: consented access windows (roadmap 2.3). The longest window a
    // workspace Owner/Admin may grant, and how long an approved break-glass
    // grant stays usable.
    consentMaxHours: Math.max(1, num('SUPPORT_CONSENT_MAX_HOURS', 72)),
    breakGlassTtl: str('SUPPORT_BREAK_GLASS_TTL', '1h'),
  },

  // detection: platform security detection rules (roadmap 2.6). Rule
  // thresholds have code defaults (services/securityDetection/rules) that
  // SECURITY_DETECTION_RULES_JSON and the platform setting
  // `security.detection.rules` override per rule id.
  securityDetection: {
    // Detector job (runs under the scheduler lock and records a JobRun).
    enabled: bool('JOB_SECURITY_DETECTION_ENABLED', true),
    cron: str('JOB_SECURITY_DETECTION_CRON', '*/5 * * * *'),
    // Events younger than this are left for the next tick so buffered
    // writers (access log, request signals) have flushed.
    settleSec: Math.max(0, num('SECURITY_DETECTION_SETTLE_SEC', 60)),
    // First evaluation of a rule looks back this far; after downtime the
    // detector never catches up further than maxCatchUpHours.
    initialLookbackMinutes: Math.max(1, num('SECURITY_DETECTION_INITIAL_LOOKBACK_MINUTES', 60)),
    maxCatchUpHours: Math.max(1, num('SECURITY_DETECTION_MAX_CATCHUP_HOURS', 24)),
    rules: (() => {
      const raw = str('SECURITY_DETECTION_RULES_JSON', '');
      if (!raw) return {};
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('Invalid SECURITY_DETECTION_RULES_JSON (must be a JSON object keyed by rule id)');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid SECURITY_DETECTION_RULES_JSON (must be a JSON object keyed by rule id)');
      }
      return parsed;
    })(),
    // On-call notification for new alerts at or above this severity
    // (low | medium | high | critical). Platform settings
    // `security.alerts.emails` / `security.alerts.webhookUrl` override these.
    notifyMinSeverity: (() => {
      const value = str('SECURITY_ALERT_NOTIFY_MIN_SEVERITY', 'high').toLowerCase();
      if (!['low', 'medium', 'high', 'critical'].includes(value)) {
        throw new Error(`Invalid SECURITY_ALERT_NOTIFY_MIN_SEVERITY "${value}". Expected low, medium, high or critical.`);
      }
      return value;
    })(),
    notifyEmails: list('SECURITY_ALERT_EMAILS', []),
    webhookUrl: str('SECURITY_ALERT_WEBHOOK_URL', ''),
    // A detection whose last alert was closed as a false positive this
    // recently is suppressed instead of reopened (0 disables).
    falsePositiveSuppressHours: Math.max(0, num('SECURITY_ALERT_FALSE_POSITIVE_SUPPRESS_HOURS', 24)),
    // Per-minute request signals (API-key use, rate-limit hits, request
    // volume, webhook signature failures) aggregated in memory and flushed.
    signals: {
      enabled: bool('SECURITY_SIGNALS_ENABLED', true),
      flushIntervalMs: Math.max(1000, num('SECURITY_SIGNALS_FLUSH_MS', 10000)),
      maxBufferedKeys: Math.max(100, num('SECURITY_SIGNALS_MAX_KEYS', 10000)),
      retentionDays: Math.max(1, num('RETENTION_SECURITY_SIGNAL_DAYS', 35)),
    },
  },

  audit: {
    // Optional HMAC key for the audit hash chain (roadmap 2.5). With a key,
    // someone holding only database credentials cannot rebuild a valid
    // chain after editing rows. Previous keys (comma-separated) are used
    // for verification only, after a rotation.
    chainKey: str('AUDIT_CHAIN_KEY', ''),
    chainPreviousKeys: list('AUDIT_CHAIN_PREVIOUS_KEYS', []),
    // Denied-request audit: one row per (actor or ip, tenant, route, reason)
    // per window, and at most this many rows per process per window.
    deniedWindowSec: num('AUDIT_DENIED_WINDOW_SEC', 60),
    deniedMaxPerWindow: num('AUDIT_DENIED_MAX_PER_WINDOW', 300),
    // Failed logins for one (email, ip, reason) are written to the audit
    // trail at most once per window (every attempt stays in LoginAttempt).
    loginFailureWindowSec: num('AUDIT_LOGIN_FAILURE_WINDOW_SEC', 60),
  },

  retention: {
    // How long append-only/volatile records are kept before the cleanup job
    // hard-deletes them. Audit trails are the longest; transient idempotency
    // keys are the shortest.
    auditLogDays: num('RETENTION_AUDIT_LOG_DAYS', 90),
    accessLogDays: num('RETENTION_ACCESS_LOG_DAYS', 30),
    loginAttemptDays: num('RETENTION_LOGIN_ATTEMPT_DAYS', 30),
    sessionDays: num('RETENTION_SESSION_DAYS', 90),
    idempotencyDays: num('RETENTION_IDEMPOTENCY_DAYS', 1),
    exportDays: num('RETENTION_EXPORT_DAYS', 1),
    jobRunDays: num('RETENTION_JOB_RUN_DAYS', 30),
    syncRunDays: num('RETENTION_SYNC_RUN_DAYS', 90),
    // retention: further windows enforced by the cleanup job (roadmap 2.7).
    // A value of 0 disables that policy. Security events are audit-trail
    // rows and follow auditLogDays.
    expiredTokenDays: num('RETENTION_EXPIRED_TOKEN_DAYS', 1),
    notificationDays: num('RETENTION_NOTIFICATION_DAYS', 90),
    alertEventDays: num('RETENTION_ALERT_EVENT_DAYS', 180),
    analyticsQueryDays: num('RETENTION_ANALYTICS_QUERY_DAYS', 90),
    // Export rows (status, filters, who asked) outlive their artefact so a
    // late poll still gets 410 instead of 404; then they are deleted too.
    exportRecordDays: num('RETENTION_EXPORT_RECORD_DAYS', 30),
    reportArtifactDays: num('RETENTION_REPORT_ARTIFACT_DAYS', 30),
    outboxDays: num('RETENTION_OUTBOX_DAYS', 30),
    // Soft-deleted rows are hard-deleted (users: anonymised) after this.
    softDeleteDays: num('RETENTION_SOFT_DELETE_DAYS', 30),
    deletedUserDays: num('RETENTION_DELETED_USER_DAYS', 30),
    // Archived tenants have all their data purged after this many days.
    // 0 (default) disables the purge until an operator sets the window.
    archivedTenantDays: num('RETENTION_ARCHIVED_TENANT_DAYS', 0),
    // Bounded batches: rows per delete and batches per collection per run.
    batchSize: Math.max(1, num('RETENTION_BATCH_SIZE', 500)),
    maxBatchesPerRun: Math.max(1, num('RETENTION_MAX_BATCHES_PER_RUN', 200)),
    // When true the scheduled cleanup only reports what it would delete.
    dryRun: bool('RETENTION_DRY_RUN', false),
    // Tenants under legal hold: the cleanup job never deletes their data.
    legalHoldTenantIds: list('RETENTION_LEGAL_HOLD_TENANT_IDS', []),
    // Every RETENTION_<NAME>_DAYS value set in the environment, so policies
    // declared by other modules (src/constants/retention.<key>.js) can read
    // their own window without touching process.env.
    byEnvKey: Object.freeze(Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => /^RETENTION_[A-Z0-9_]+_DAYS$/.test(key) && Number.isFinite(Number(process.env[key])) && process.env[key] !== '')
        .map((key) => [key, Number(process.env[key])]),
    )),
  },

  // backups: tenant data export (roadmap 2.9).
  tenantExport: {
    // How long a finished export archive stays downloadable before the
    // expiry job deletes it from storage.
    ttlHours: Math.max(1, num('TENANT_EXPORT_TTL_HOURS', 72)),
    // Lifetime of one signed download URL (capped by the archive expiry).
    downloadUrlTtlSeconds: Math.min(3600, Math.max(30, num('TENANT_EXPORT_DOWNLOAD_URL_TTL_SECONDS', 300))),
    // Exports a workspace may request itself per rolling 24 hours.
    dailyLimit: Math.max(1, num('TENANT_EXPORT_DAILY_LIMIT', 3)),
    // Processing lease, renewed while the export runs; a crashed worker's
    // export is retried or failed once it lapses.
    leaseMs: Math.max(60 * 1000, num('TENANT_EXPORT_LEASE_MS', 15 * 60 * 1000)),
    // A queued export never picked up within this window is failed so the
    // workspace can request another one.
    queuedTimeoutMs: Math.max(60 * 1000, num('TENANT_EXPORT_QUEUED_TIMEOUT_MINUTES', 360) * 60 * 1000),
    maxAttempts: Math.max(1, num('TENANT_EXPORT_MAX_ATTEMPTS', 3)),
    // Widest dataset CSV (columns beyond this stay in the JSONL copy only).
    maxCsvColumns: Math.max(1, num('TENANT_EXPORT_MAX_CSV_COLUMNS', 1000)),
    // Scratch directory for building archives (defaults to the OS temp dir).
    workDir: str('TENANT_EXPORT_WORK_DIR', ''),
    expiryJob: {
      cron: str('JOB_TENANT_EXPORT_EXPIRY_CRON', '20 * * * *'),
      enabled: bool('JOB_TENANT_EXPORT_EXPIRY_ENABLED', true),
    },
  },

  // ai-ask: AI provider adapter (roadmap 4.A2). `noop` answers 501 AI_NOT_CONFIGURED.
  // Provider and model are chosen separately: AI_PROVIDER picks the adapter,
  // AI_MODEL the model id it calls (validated against GEMINI_MODEL_PATTERN).
  ai: {
    provider: ident('AI_PROVIDER', 'noop').toLowerCase(),
    model: ident('AI_MODEL', 'gemini-2.5-flash'),
    apiKey: str('AI_API_KEY', '').trim(),
    timeoutMs: Math.max(1000, num('AI_TIMEOUT_MS', 30000)),
    maxOutputTokens: Math.max(256, num('AI_MAX_OUTPUT_TOKENS', 4096)),
    maxQuestionLength: Math.max(20, num('AI_MAX_QUESTION_LENGTH', 500)),
  },

  logging: {
    level: str('LOG_LEVEL', isProduction ? 'info' : 'debug'),
    redact: list('LOG_REDACT', [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'authorization',
      'jwt',
      'token',
      'apiKey',
    ]),
  },

  // observability: metrics, error reporting, readiness and provider
  // failure signals (roadmap 2.8).
  observability: {
    // Bearer token Prometheus presents on GET /api/v1/metrics. Unset = the
    // endpoint answers 404 (disabled); it is never public.
    metricsToken: str('METRICS_TOKEN', ''),
    errorReporter: {
      // `none` (default), `log` (one structured log line per event) or `http`
      // (POST JSON to ERROR_REPORTER_URL). `http` is implied when a URL is set.
      sink: str('ERROR_REPORTER', str('ERROR_REPORTER_URL', '') ? 'http' : 'none').toLowerCase(),
      url: str('ERROR_REPORTER_URL', ''),
      token: str('ERROR_REPORTER_TOKEN', ''),
      timeoutMs: num('ERROR_REPORTER_TIMEOUT_MS', 3000),
      // Events delivered per minute per process; the same error repeats at
      // most once per dedupe window (later repeats are counted).
      maxEventsPerMinute: num('ERROR_REPORTER_MAX_EVENTS_PER_MINUTE', 60),
      dedupeWindowMs: num('ERROR_REPORTER_DEDUPE_WINDOW_MS', 60000),
    },
    // Frontend error reports accepted per client IP per minute.
    clientErrorRateLimitMax: num('CLIENT_ERROR_RATE_LIMIT_MAX', 20),
    // Readiness: budget for each dependency check, and how long the slower
    // non-critical checks (storage, scheduler, SMTP) are reused.
    readinessCheckTimeoutMs: num('READINESS_CHECK_TIMEOUT_MS', 1500),
    readinessCacheTtlMs: num('READINESS_CACHE_TTL_MS', 30000),
    smtpCheckTtlMs: num('READINESS_SMTP_TTL_MS', 120000),
    // Public status endpoint response cache.
    statusCacheTtlMs: num('STATUS_CACHE_TTL_MS', 15000),
    // SMTP transport timeouts live in `mail` (SMTP_*_TIMEOUT_MS).
    // After the bounded boot attempts, the web process keeps reconnecting to
    // MongoDB with exponential backoff capped at this delay (finding ops.05).
    dbReconnectMaxDelayMs: num('MONGODB_RECONNECT_MAX_DELAY_MS', 30000),
  },
});

// observability: refuse configurations that would leak or silently drop data.
{
  const { metricsToken, errorReporter } = config.observability;
  if (metricsToken && metricsToken.length < 16) {
    throw new Error('METRICS_TOKEN must be at least 16 characters');
  }
  if (!['none', 'log', 'http'].includes(errorReporter.sink)) {
    throw new Error(`Invalid ERROR_REPORTER "${errorReporter.sink}". Expected "none", "log" or "http".`);
  }
  if (errorReporter.sink === 'http') {
    let parsed = null;
    try {
      parsed = new URL(errorReporter.url);
    } catch {
      parsed = null;
    }
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('ERROR_REPORTER=http requires ERROR_REPORTER_URL to be an http(s) URL');
    }
    if (isProduction && parsed.protocol !== 'https:') {
      throw new Error('ERROR_REPORTER_URL must use https in production');
    }
  }
}

/* ------------------------- session lifetime checks ------------------------ */

// Session lifetimes are durations like `15m` / `30d` (see utils/jwt.js
// parseExpiresIn). A malformed value would otherwise surface as a 500 on
// every login, so refuse to start instead.
for (const [name, value] of [
  ['JWT_REFRESH_TTL', config.security.auth.refreshTokenTtl],
  ['AUTH_SESSION_ABSOLUTE_TTL', config.security.auth.sessionAbsoluteTtl],
]) {
  if (!/^[1-9]\d*\s*[smhdw]$/i.test(String(value).trim())) {
    throw new Error(`Invalid ${name} "${value}". Use a positive duration such as "30d" or "12h".`);
  }
}

/* ----------------------- production safety gates ------------------------ */

if (isProduction) {
  const invalid = [];
  const isPlaceholder = (value) => !value || /^(change-me|dev-only|localhost|127\.0\.0\.1)/i.test(value);

  if (isPlaceholder(config.security.jwtSecret) || config.security.jwtSecret.length < 32) {
    invalid.push('JWT_SECRET (32+ characters, not a placeholder)');
  }
  // The URI starts with mongodb://, so check the host part anywhere in it.
  if (!config.database.uri || /localhost|127\.0\.0\.1/i.test(config.database.uri)) invalid.push('MONGODB_URI');
  if (!config.redis.url) invalid.push('REDIS_URL');
  if (!config.encryption.key || config.encryption.key.length < 32) invalid.push('ENCRYPTION_KEY (32+ characters)');
  if (config.storage.provider !== 's3' || !config.storage.bucket) invalid.push('STORAGE_PROVIDER=s3 and S3_BUCKET');
  if (config.mail.provider !== 'smtp' || !config.mail.host || !config.mail.password) {
    invalid.push('MAIL_PROVIDER=smtp, SMTP_HOST, and MAIL_PASSWORD');
  }
  if (!config.security.cookieSecure) invalid.push('COOKIE_SECURE=true');
  if (config.security.auth.cookieSameSite.toLowerCase() === 'none' && !config.security.cookieSecure) {
    invalid.push('COOKIE_SECURE=true (required when AUTH_COOKIE_SAMESITE=None)');
  }
  if (!config.cors.clientUrl || /localhost|127\.0\.0\.1/i.test(config.cors.clientUrl)) invalid.push('CLIENT_URL');
  if (config.cors.origins.includes('*') || config.cors.origins.some((origin) => /localhost|127\.0\.0\.1/i.test(origin))) {
    invalid.push('CORS_ORIGINS must be a real origin (no localhost or wildcard)');
  }
  if (config.socket.corsOrigins.includes('*') || config.socket.corsOrigins.some((origin) => /localhost|127\.0\.0\.1/i.test(origin))) {
    invalid.push('SOCKET_CORS_ORIGIN must be a real origin (no localhost or wildcard)');
  }
  // Razorpay: when enabled in production, all credentials must be present
  // and the environment must be explicit. The plan mapping must contain at
  // least one entry — an empty mapping means no plan is purchasable and
  // production checkout would be effectively dead.
  if (config.razorpay.enabled) {
    if (!config.razorpay.keyId) invalid.push('RAZORPAY_KEY_ID');
    if (!config.razorpay.keySecret) invalid.push('RAZORPAY_KEY_SECRET');
    if (!config.razorpay.webhookSecret) invalid.push('RAZORPAY_WEBHOOK_SECRET');
    if (!['test', 'live'].includes(config.razorpay.environment)) {
      invalid.push('RAZORPAY_ENVIRONMENT (must be test or live)');
    }
    if (!config.razorpay.planMapping || Object.keys(config.razorpay.planMapping).length === 0) {
      invalid.push('RAZORPAY_PLAN_MAPPING_JSON (at least one plan entry)');
    }
  }
  // ai-ask: a real provider in production needs a key and a known provider name.
  if (config.ai.provider !== 'noop') {
    if (!['noop', 'gemini'].includes(config.ai.provider)) invalid.push('AI_PROVIDER (noop or gemini)');
    if (!config.ai.apiKey) invalid.push('AI_API_KEY');
  }
  if (invalid.length) {
    throw new Error(`Invalid production configuration: ${invalid.join(', ')}`);
  }
}

// A split web/worker topology hands work between processes through the
// queue, which only BullMQ (Redis) can do. The in-memory transport would
// silently drop every job a web process enqueues.
if (config.runtime.role === 'web' && !config.redis.enabled) {
  throw new Error('PROCESS_ROLE=web requires REDIS_URL (the in-memory queue cannot hand jobs to a worker process)');
}

// Frontend-dependent URLs are intentionally kept as placeholders until the
// frontend is deployed. In production a leftover placeholder (or the
// localhost default) would silently reject browser CORS preflights and
// Socket.IO connections for every tenant, so flag it loudly at startup.
if (isProduction) {
  const unconfigured = [
    ['CORS_ORIGINS / CLIENT_URL', config.cors.origins.join(',')],
    ['CLIENT_URL', config.cors.clientUrl],
    ['SOCKET_CORS_ORIGIN', config.socket.corsOrigins.join(',')],
  ].filter(([, value]) => /YOUR-FRONTEND-DOMAIN|localhost/i.test(value));

  if (unconfigured.length > 0) {
    /* eslint-disable-next-line no-console */
    console.warn(
      `[config] WARNING: production startup detected unconfigured frontend URL(s): ${unconfigured
        .map(([name]) => name)
        .join(', ')}. ` +
        'Replace these with the deployed frontend domain before the final Render deployment, ' +
        'otherwise browser CORS and Socket.IO connections will be rejected.',
    );
  }

  // A mistyped AI_MODEL must not stop the whole API from starting: Ask
  // reports AI_MODEL_INVALID in /ai/status instead. Say so at startup too.
  if (config.ai.provider === 'gemini' && !GEMINI_MODEL_PATTERN.test(config.ai.model)) {
    /* eslint-disable-next-line no-console */
    console.warn(
      `[config] WARNING: AI_MODEL=${JSON.stringify(config.ai.model)} is not a Gemini model id ` +
        '(expected e.g. gemini-2.5-flash). Ask stays unavailable until it is corrected.',
    );
  }

  // Cross-site refresh symptom: when the SPA and API are on different
  // registrable domains, a SameSite=Lax/Strict cookie is dropped on the
  // /auth/refresh XHR, so users are logged out on every reload. Flag the
  // misconfiguration loudly rather than letting it fail silently.
  const sameSite = config.security.auth.cookieSameSite.toLowerCase();
  // A configured AUTH_COOKIE_DOMAIN means a first-party deployment, where
  // Lax is the intended setting.
  if (sameSite !== 'none' && !config.security.auth.cookieDomain) {
    /* eslint-disable-next-line no-console */
    console.warn(
      `[config] WARNING: AUTH_COOKIE_SAMESITE=${config.security.auth.cookieSameSite} in production. ` +
        'If the frontend and API are on different sites, the refresh cookie will not be sent ' +
        'cross-site and users will be signed out on reload. Set AUTH_COOKIE_SAMESITE=None ' +
        '(with COOKIE_SECURE=true) for cross-site deployments.',
    );
  }
}

export default config;
