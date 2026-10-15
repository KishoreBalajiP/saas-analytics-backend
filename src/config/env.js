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
      passwordResetTokenTtlMs: num('PASSWORD_RESET_TTL_MS', 15 * 60 * 1000),
      passwordResetTokenLength: num('PASSWORD_RESET_TOKEN_LENGTH', 32),
      // Email-verification link lifetime and the minimum gap between two
      // resend requests for the same account (anti-spam + anti-abuse).
      verificationTokenTtlMs: num('EMAIL_VERIFICATION_TTL_MS', 15 * 60 * 1000),
      verificationResendCooldownMs: num('EMAIL_VERIFICATION_RESEND_COOLDOWN_MS', 60 * 1000),
      mfaIssuer: str('MFA_ISSUER', 'saas-analytics'),
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
    },
    // Public embed surface (Sprint 9).
    embed: {
      // Default token lifetime when the caller does not set one.
      defaultTtlSec: num('EMBED_TOKEN_DEFAULT_TTL_SEC', 24 * 60 * 60),
      // Hard ceiling for any embed token TTL.
      maxTtlSec: num('EMBED_TOKEN_MAX_TTL_SEC', 7 * 24 * 60 * 60),
      // Cap on concurrent active tokens per dashboard.
      maxActivePerDashboard: num('EMBED_MAX_PER_DASHBOARD', 50),
      // Embbed content is loaded cross-origin by the tenant's external
      // site; the public read is token-gated so it may safely reflect any
      // Origin (no credentials are ever attached to embed data requests).
      corsAllowAllOrigins: bool('EMBED_CORS_ALLOW_ALL', true),
    },
  },

  socket: {
    corsOrigins: socketCorsOrigins,
    pingIntervalMs: num('SOCKET_PING_INTERVAL_MS', 25000),
    pingTimeoutMs: num('SOCKET_PING_TIMEOUT_MS', 20000),
    maxHttpBufferSize: num('SOCKET_MAX_HTTP_BUFFER_SIZE', 1000000),
    transports: list('SOCKET_TRANSPORTS', ['polling', 'websocket']),
  },

  redis: {
    url: str('REDIS_URL', ''),
    enabled: Boolean(str('REDIS_URL', '')),
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
  },

  scheduler: {
    enabled: bool('SCHEDULER_ENABLED', true),
    timezone: str('SCHEDULER_TIMEZONE', 'UTC'),
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

  connectors: {
    // Max CSV upload size in bytes (multer memory storage caps this).
    csvMaxUploadBytes: num('CONNECTOR_CSV_MAX_UPLOAD_MB', 10) * 1024 * 1024,
    // Max XLSX upload size in bytes (multer memory storage caps this).
    xlsxMaxUploadBytes: num('CONNECTOR_XLSX_MAX_UPLOAD_MB', 10) * 1024 * 1024,
    // External MongoDB source connect trail-safety defaults. Credentials
    // are never logged; these bound connect latency and result volume.
    mongodb: {
      maxDocsPerSync: num('MONGODB_CONNECTOR_MAX_DOCS_PER_SYNC', 100000),
      connectTimeoutMs: num('MONGODB_CONNECTOR_CONNECT_TIMEOUT_MS', 10000),
      serverSelectionTimeoutMs: num('MONGODB_CONNECTOR_SERVER_SELECTION_TIMEOUT_MS', 5000),
    },
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
  },

  jobs: {
    sheetSync: {
      cron: str('JOB_SHEET_SYNC_CRON', '0 */6 * * *'),
      enabled: bool('JOB_SHEET_SYNC_ENABLED', false),
    },
    email: {
      cron: str('JOB_EMAIL_CRON', '*/5 * * * *'),
      enabled: bool('JOB_EMAIL_ENABLED', false),
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
  },

  support: {
    // Per-admin daily cap on impersonation sessions (Sprint 8).
    impersonationBudgetDailyCap: num('SUPPORT_IMPERSONATION_DAILY_CAP', 20),
    impersonationTokenTtl: str('SUPPORT_IMPERSONATION_TOKEN_TTL', '15m'),
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
});

/* ----------------------- production safety gates ------------------------ */

if (isProduction) {
  const invalid = [];
  const isPlaceholder = (value) => !value || /^(change-me|dev-only|localhost|127\.0\.0\.1)/i.test(value);

  if (isPlaceholder(config.security.jwtSecret)) invalid.push('JWT_SECRET');
  if (isPlaceholder(config.database.uri)) invalid.push('MONGODB_URI');
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
  if (invalid.length) {
    throw new Error(`Invalid production configuration: ${invalid.join(', ')}`);
  }
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

  // Cross-site refresh symptom: when the SPA and API are on different
  // registrable domains, a SameSite=Lax/Strict cookie is dropped on the
  // /auth/refresh XHR, so users are logged out on every reload. Flag the
  // misconfiguration loudly rather than letting it fail silently.
  const sameSite = config.security.auth.cookieSameSite.toLowerCase();
  if (sameSite !== 'none') {
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
