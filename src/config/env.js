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
    origins: list('CORS_ORIGINS', []).length
      ? list('CORS_ORIGINS', [])
      : [str('CLIENT_URL', 'http://localhost:3000')],
    clientUrl: str('CLIENT_URL', 'http://localhost:3000'),
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
      cookieSameSite: str('AUTH_COOKIE_SAMESITE', 'Lax'),
      loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 5),
      loginLockoutMs: num('LOGIN_LOCKOUT_MS', 15 * 60 * 1000),
      passwordResetTokenTtlMs: num('PASSWORD_RESET_TTL_MS', 15 * 60 * 1000),
      passwordResetTokenLength: num('PASSWORD_RESET_TOKEN_LENGTH', 32),
      mfaIssuer: str('MFA_ISSUER', 'saas-analytics'),
    },
    rateLimit: {
      windowMs: num('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
      max: num('RATE_LIMIT_MAX', 300),
      strictMax: num('RATE_LIMIT_STRICT_MAX', 20),
    },
  },

  socket: {
    corsOrigins: list('SOCKET_CORS_ORIGIN', ['http://localhost:3000']),
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
    password: mailPassword,
    from: str('MAIL_FROM', 'SaaS Analytics Platform <noreply@localhost>'),
  },

  scheduler: {
    enabled: bool('SCHEDULER_ENABLED', true),
    timezone: str('SCHEDULER_TIMEZONE', 'UTC'),
  },

  connectors: {
    // Max CSV upload size in bytes (multer memory storage caps this).
    csvMaxUploadBytes: num('CONNECTOR_CSV_MAX_UPLOAD_MB', 10) * 1024 * 1024,
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

export default config;
