/**
 * Auth Service (Sprint 1 - implemented).
 *
 * PURPOSE
 *   Login / refresh / logout for BOTH portals on a single engine:
 *   - Tenant users  -> `repositories/user.repository.js` (tenant-scoped).
 *   - Platform admins -> `repositories/admin.repository.js` (+ optional TOTP).
 *
 * RESPONSIBILITY (business rules ONLY - no raw database access)
 *   - login(...)      -> account lookup, Argon2id verify, persisted lockout,
 *                        LoginAttempt trail, session + JWT issuance, optional
 *                        MFA challenge for admins.
 *   - refresh(...)    -> refresh-token rotation with replay family revocation.
 *   - logout(...) / logoutAll(...) -> session revocation.
 *
 * SECURITY RULES
 *   - Generic "invalid credentials" for unknown email AND wrong password (no
 *     enumeration). A dummy KDF verify runs for unknown emails to keep the
 *     response time constant. Volumetric attacks on unknown emails are the
 *     rate-limiter's job (no DB counter exists without an account).
 *   - Lockout is persisted (`failedAttempts` + `lockedUntil`), so it
 *     survives restarts and replicates across instances.
 *   - Every attempt is appended to `LoginAttempt` (append-only trail).
 *   - Refresh-token replay revokes the ENTIRE family, not just the leaked
 *     token (threat model: a reused rotated/revoked token is an attack).
 *   - Access tokens are short-lived (15 min); only the session can extend
 *     the actor past that via `refresh`.
 */

import env from '../../../config/env.js';
import ApiError from '../../../utils/ApiError.js';
import { ERROR_CODES } from '../../../config/constants.js';
import { createChildLogger } from '../../../utils/logger.js';
import { hash as hashPassword, verify as verifyPassword } from '../../../utils/password.js';
import { sign as signJwt, parseExpiresIn, JWT_AUDIENCES } from '../../../utils/jwt.js';
import userRepository from '../../../repositories/user.repository.js';
import adminRepository from '../../../repositories/admin.repository.js';
import tenantRepository from '../../../repositories/tenant.repository.js';
import sessionRepository from '../../../repositories/session.repository.js';
import loginAttemptRepository from '../../../repositories/loginAttempt.repository.js';
import sessionService from './session.service.js';
import mfaService from './mfa.service.js';
import emailVerificationService from '../../../services/emailVerification.service.js';
import emailVerificationTokenRepository from '../../../repositories/emailVerificationToken.repository.js';
import tenantInitializationService from '../../../services/tenantInitialization.service.js';

const logger = createChildLogger({ module: 'services/auth' });
const AUTH = env.security.auth;
const INVALID_CREDENTIALS = 'Invalid email or password';
const ACCESS_TTL_SECONDS = parseExpiresIn(AUTH.accessTokenTtl);

/**
 * Spend the same KDF work on an unknown email as on a real one, so response
 * timing does not reveal whether an account exists. The dummy hash is
 * generated lazily with the ACTIVE KDF (`argon2` in production, `scrypt`
 * under the portable test env), so it can never be a format the runtime
 * cannot verify. Failures are swallowed - this is a defence-in-depth
 * nicety, not a gate.
 */
let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) {
    // Fixed plaintext, never persisted - it exists only to burn comparable
    // verification time when no account matches the login email.
    dummyHashPromise = hashPassword('dummy-timing-equalizer').catch(() => null);
  }
  return dummyHashPromise;
}

async function dummyVerify(password) {
  try {
    const dummy = await getDummyHash();
    if (dummy) await verifyPassword(password, dummy);
  } catch {
    /* intentionally ignored */
  }
}

/** Portal -> repo + JWT audience. */
const PORTAL = Object.freeze({
  user: {
    repo: userRepository,
    audience: JWT_AUDIENCES.USER,
    findForAuth: (email, tenantId) => userRepository.findByEmailForAuth(tenantId, email),
    findById: (id) => userRepository.findById(id),
    resetFailedAttempts: (id) => userRepository.resetFailedAttempts(id),
    touchLastLogin: (id) => userRepository.touchLastLogin(id),
    incrementFailedAttempts: (id) => userRepository.incrementFailedAttempts(id),
    setLockedUntil: (id, until) => userRepository.setLockedUntil(id, until),
  },
  admin: {
    repo: adminRepository,
    audience: JWT_AUDIENCES.ADMIN,
    findForAuth: (email) => adminRepository.findByEmailForAuth(email),
    findById: (id) => adminRepository.findById(id),
    resetFailedAttempts: (id) => adminRepository.resetFailedAttempts(id),
    touchLastLogin: (id) => adminRepository.touchLastLogin(id),
    incrementFailedAttempts: (id) => adminRepository.incrementFailedAttempts(id),
    setLockedUntil: (id, until) => adminRepository.setLockedUntil(id, until),
  },
});

/* ------------------------------- login ---------------------------------- */

/**
 * Authenticate a user or admin. On success issues a session + access token
 * + raw refresh token. For admins with MFA enabled, `mfaCode` is required
 * and challenged against the stored (encrypted) TOTP secret.
 *
 * @param {Object} params
 * @param {'user'|'admin'} params.portal
 * @param {string} params.email
 * @param {string} params.password
 * @param {string} [params.mfaCode] - required when the admin has MFA enabled.
 * @param {string|null} [params.tenantId] - required for the user portal.
 * @param {Object} [params.device]
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @returns {Promise<Object>} `{ accessToken, expiresIn, refreshToken, sessionId, actor }`.
 */
export async function login({
  portal,
  email,
  password,
  mfaCode,
  tenantId = null,
  device = {},
  ip = '',
  userAgent = '',
}) {
  const cfg = PORTAL[portal];
  if (!cfg) throw ApiError.badRequest('Unknown portal');
  if (portal === 'user' && !tenantId) throw ApiError.badRequest('Tenant id is required');

  // The public tenant contract accepts a workspace slug. Resolve it before
  // any user lookup so login and password recovery use the same tenant
  // identity and cannot accidentally query by an untrusted raw selector.
  const resolvedTenantId = portal === 'user' ? await resolveTenantId(tenantId) : tenantId;

  const normalized = String(email ?? '').toLowerCase().trim();
  if (!normalized || typeof password !== 'string' || password.length === 0) {
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  const account = await cfg.findForAuth(normalized, resolvedTenantId);
  const attemptMeta = { portal, email: normalized, tenantId: resolvedTenantId, ip, userAgent };

  if (!account) {
    await dummyVerify(password);
    await recordAttempt({ ...attemptMeta, actorId: null, success: false, reason: 'unknown_email' });
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  const actorId = String(account._id);

  if (account.status === 'suspended') {
    await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'suspended' });
    const err = ApiError.forbidden('Account is suspended');
    err.code = ERROR_CODES.ACCOUNT_SUSPENDED;
    throw err;
  }
  if (account.status === 'unverified') {
    await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'email_unverified' });
    const err = ApiError.forbidden('Email verification required');
    err.code = ERROR_CODES.EMAIL_NOT_VERIFIED;
    throw err;
  }

  // Tenant gate: only `active` tenants may authenticate. A missing tenant
  // stays generic (no enumeration); a blocked tenant is explicit (the
  // user already knows which tenant they are logging into).
  if (portal === 'user') {
    const tenant = await findTenantOrNull(resolvedTenantId);
    if (!tenant) {
      await dummyVerify(password);
      await recordAttempt({ ...attemptMeta, actorId: null, success: false, reason: 'unknown_tenant' });
      throw ApiError.unauthorized(INVALID_CREDENTIALS);
    }
    if (tenant.status !== 'active') {
      await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'tenant_not_active' });
      const err = ApiError.forbidden('Tenant is not active');
      err.code = ERROR_CODES.TENANT_NOT_ACTIVE;
      throw err;
    }
  }
  if (account.status === 'locked' || isLockedOut(account)) {
    await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'account_locked' });
    throw ApiError.tooManyRequests('Too many failed attempts. Try again later.');
  }

  const passwordOk = await verifyPassword(password, account.passwordHash);
  if (!passwordOk) {
    await handleFailedLogin({ ...attemptMeta, actorId, account, reason: 'invalid_credentials' });
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  if (portal === 'admin' && account.mfaEnabled) {
    if (!mfaCode) {
      await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'mfa_required' });
      const err = ApiError.unauthorized('MFA verification code is required');
      err.mfaRequired = true;
      throw err;
    }
    const mfaOk = await mfaService.verifyCode({ admin: account, code: mfaCode });
    if (!mfaOk) {
      await handleFailedLogin({ ...attemptMeta, actorId, account, reason: 'mfa_failed' });
      throw ApiError.unauthorized(INVALID_CREDENTIALS);
    }
  }

  await cfg.resetFailedAttempts(actorId);
  await cfg.touchLastLogin(actorId);

  const refreshToken = sessionService.generateRefreshToken();
  const { session } = await sessionService.create({
    actorId,
    actorType: portal,
    tenantId: portal === 'user' ? resolvedTenantId : null,
    refreshToken,
    device,
    ip,
    userAgent,
  });

  const accessToken = await signAccessToken({
    portal,
    actor: account,
    sessionId: session.sessionId,
    tenantId: portal === 'user' ? resolvedTenantId : account.tenantScope ?? null,
  });

  await recordAttempt({ ...attemptMeta, actorId, success: true, reason: 'success' });
  logger.info({ portal, actorId }, 'login succeeded');

  return {
    accessToken,
    expiresIn: ACCESS_TTL_SECONDS,
    refreshToken,
    sessionId: session.sessionId,
    actor: buildActorSummary(account),
  };
}

/* ------------------------------- refresh -------------------------------- */

/**
 * Rotate a session using the opaque refresh token. Derives the actor type
 * from the stored session (never trusts the caller) and revokes the entire
 * family when a non-active token is replayed.
 *
 * @param {Object} params
 * @param {string} params.refreshToken - raw opaque token from the cookie.
 * @param {Object} [params.device]
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @returns {Promise<Object>} `{ accessToken, expiresIn, refreshToken, sessionId, actor }`.
 */
export async function refresh({ refreshToken, device, ip, userAgent }) {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw ApiError.unauthorized('Session expired');
  }

  const refreshTokenHash = await sessionService.hashRefreshToken(refreshToken);
  const session = await sessionRepository.findByRefreshTokenHash(refreshTokenHash);

  if (!session) throw ApiError.unauthorized('Session expired');

  // Replay detection: a rotated/revoked/expired token is being reused.
  if (session.status !== 'active') {
    await sessionRepository.revokeAllForActor(session.actorId, 'replay_detected');
    logger.warn({ actorId: session.actorId }, 'refresh-token replay detected; family revoked');
    throw ApiError.unauthorized('Session revoked');
  }

  if (!session.expiresAt || new Date(session.expiresAt).getTime() <= Date.now()) {
    await sessionRepository.markExpired(session.sessionId);
    throw ApiError.unauthorized('Session expired');
  }

  const portal = session.actorType === 'admin' ? 'admin' : 'user';
  const cfg = PORTAL[portal];
  const account = await cfg.findById(session.actorId);

  // Actor no longer exists or is suspended -> kill the whole family.
  if (!account || account.status === 'suspended') {
    await sessionRepository.revokeAllForActor(session.actorId, 'actor_invalid');
    throw ApiError.unauthorized('Session revoked');
  }

  // Tenant gate on refresh: a suspended/disabled/archived tenant must not
  // be able to keep sessions alive, even if the account is still active.
  if (portal === 'user' && session.tenantId) {
    const tenant = await findTenantOrNull(session.tenantId);
    if (!tenant || tenant.status !== 'active') {
      await sessionRepository.revokeAllForActor(session.actorId, 'tenant_inactive');
      throw ApiError.unauthorized('Session revoked');
    }
  }

  const newRefreshToken = sessionService.generateRefreshToken();
  const next = await sessionService.rotate({
    session,
    refreshToken: newRefreshToken,
    device,
    ip,
    userAgent,
  });

  const accessToken = await signAccessToken({
    portal,
    actor: account,
    sessionId: next.session.sessionId,
    tenantId: portal === 'user' ? session.tenantId : account.tenantScope ?? null,
  });

  logger.debug({ actorId: session.actorId }, 'session refreshed');
  return {
    accessToken,
    expiresIn: ACCESS_TTL_SECONDS,
    refreshToken: newRefreshToken,
    sessionId: next.session.sessionId,
    actor: buildActorSummary(account),
  };
}

/* ------------------------------- logout --------------------------------- */

/**
 * Revoke the current session. Idempotent: a session that is already
 * revoked/expired still resolves to success (the caller is logged out).
 *
 * @param {Object} params
 * @param {string} params.sessionId
 * @param {string} [params.reason='logout']
 * @returns {Promise<{ ok: boolean }>}
 */
export async function logout({ sessionId, reason = 'logout' }) {
  if (!sessionId) throw ApiError.badRequest('Session id is required');
  await sessionService.revoke({ sessionId, reason });
  return { ok: true };
}

/**
 * Revoke every active session for an actor (logout everywhere).
 *
 * @param {Object} params
 * @param {string} params.actorId
 * @param {string} [params.reason='logout_all']
 * @returns {Promise<{ revoked: number }>}
 */
export async function logoutAll({ actorId, reason = 'logout_all' }) {
  if (!actorId) throw ApiError.badRequest('Actor id is required');
  const revoked = await sessionService.revokeAllForActor({ actorId, reason });
  return { revoked };
}

/* --------------------------- profile / logout --------------------------- */

/**
 * Resolve the current actor's profile for the `/me` endpoints. Always loads
 * a fresh document from the repository - token claims alone are never
 * trusted for profile data, so a status change is reflected immediately.
 *
 * @param {Object} params
 * @param {'user'|'admin'} params.portal
 * @param {string} params.actorId
 * @returns {Promise<Object>} profile summary plus portal-specific fields.
 */
export async function getProfile({ portal, actorId }) {
  const cfg = PORTAL[portal];
  if (!cfg) throw ApiError.badRequest('Unknown portal');
  const account = await cfg.findById(actorId);
  if (!account) throw ApiError.notFound('Account not found');
  return {
    ...buildActorSummary(account),
    ...(portal === 'admin'
      ? { type: account.adminType, mfaEnabled: Boolean(account.mfaEnabled), tenantScope: account.tenantScope ?? null }
      : { tenantId: account.tenantId ?? null }),
  };
}

/**
 * Revoke the session bound to a raw refresh token (cookie-based logout).
 * Falls back to `sessionId` when the caller already resolved it from the
 * access token. Idempotent, exactly like `logout`.
 *
 * @param {Object} params
 * @param {string} [params.refreshToken] - raw opaque token from the cookie.
 * @param {string} [params.sessionId] - optional pre-resolved session id.
 * @param {string} [params.reason='logout']
 * @returns {Promise<{ ok: boolean }>}
 */
export async function logoutByRefreshToken({ refreshToken, sessionId = null, reason = 'logout' }) {
  if (!sessionId && typeof refreshToken === 'string' && refreshToken.length > 0) {
    const refreshTokenHash = await sessionService.hashRefreshToken(refreshToken);
    const session = await sessionRepository.findByRefreshTokenHash(refreshTokenHash);
    sessionId = session?.sessionId ?? null;
  }
  if (sessionId) await sessionService.revoke({ sessionId, reason });
  return { ok: true };
}

/* ------------------------------ internals ------------------------------- */

/**
 * Sign a short-lived access JWT for the actor. `sessionId` is embedded so
 * the authenticate middleware can enforce session liveness on every request.
 */
async function signAccessToken({ portal, actor, sessionId, tenantId }) {
  const cfg = PORTAL[portal];
  const payload = {
    sessionId,
    email: actor.email,
  };
  if (tenantId) payload.tenantId = tenantId;
  return signJwt({
    payload,
    subject: String(actor._id),
    audience: cfg.audience,
    expiresIn: AUTH.accessTokenTtl,
  });
}

/** Build the non-secret actor summary returned to the client. */
function buildActorSummary(account) {
  return {
    id: String(account._id),
    email: account.email,
    name: account.profile?.name ?? '',
    status: account.status,
  };
}

/** True when the account is inside the persisted lockout window. */
function isLockedOut(account) {
  const until = account.lockedUntil ? new Date(account.lockedUntil).getTime() : 0;
  return until > Date.now();
}

/**
 * Look up a tenant for the auth gates. A malformed tenant id (not a valid
 * ObjectId) must be treated as "tenant unknown" - the user-facing failure
 * stays generic - never crash into a CastError 500.
 */
async function findTenantOrNull(tenantId) {
  try {
    return await tenantRepository.findById(tenantId);
  } catch (err) {
    if (err?.name === 'CastError') return null;
    throw err;
  }
}

async function resolveTenantId(identifier) {
  const tenant = await tenantRepository.findByIdOrSlug(identifier);
  if (!tenant) throw ApiError.unauthorized(INVALID_CREDENTIALS);
  return String(tenant._id);
}

/**
 * Persist a failed login: bump the atomic counter, and when it reaches the
 * threshold set the lockout deadline. Records the reason that caused the
 * failure (`invalid_credentials` | `mfa_failed`), switching to
 * `account_locked` for the attempt that actually trips the lockout.
 */
async function handleFailedLogin({ portal, email, tenantId, actorId, ip, userAgent, account, reason }) {
  const cfg = PORTAL[portal];
  const updated = await cfg.incrementFailedAttempts(actorId);
  const attempts = updated?.failedAttempts ?? (account.failedAttempts ?? 0) + 1;
  if (attempts >= AUTH.loginMaxAttempts) {
    await cfg.setLockedUntil(actorId, new Date(Date.now() + AUTH.loginLockoutMs));
    await recordAttempt({ portal, email, tenantId, actorId, ip, userAgent, success: false, reason: 'account_locked' });
    logger.warn({ portal, actorId }, 'account locked after repeated failures');
  } else {
    await recordAttempt({ portal, email, tenantId, actorId, ip, userAgent, success: false, reason });
  }
}

/**
 * Append an attempt to the LoginAttempt trail. Recording is best-effort: a
 * failure to persist the trail must never break the auth flow itself.
 */
async function recordAttempt({ portal, email, tenantId, actorId = null, ip = '', userAgent = '', success, reason }) {
  try {
    await loginAttemptRepository.record({
      actorId,
      actorType: portal,
      email,
      tenantId: portal === 'user' ? tenantId : null,
      ip,
      userAgent,
      success,
      reason,
    });
  } catch (err) {
    logger.error({ err: { message: err?.message } }, 'failed to record login attempt');
  }
}

function slugify(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'workspace';
}

/**
 * A workspace URL collision. Carries a machine code so the client can guide
 * the user to sign in / resend verification instead of showing a dead end.
 */
function slugTakenError() {
  const err = ApiError.conflict('This workspace URL is already taken');
  err.code = ERROR_CODES.WORKSPACE_SLUG_TAKEN;
  return err;
}

export async function register({ fullName, email, password, workspaceName, workspaceSlug }) {
  const normalizedName = String(fullName ?? '').trim();
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const normalizedPassword = typeof password === 'string' ? password : '';
  const normalizedWorkspaceName = String(workspaceName ?? '').trim();

  if (!normalizedName || normalizedName.length < 2) {
    throw ApiError.badRequest('Full name is required');
  }
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw ApiError.badRequest('A valid email is required');
  }
  if (normalizedPassword.length < 8) {
    throw ApiError.badRequest('Password must be at least 8 characters');
  }
  if (!normalizedWorkspaceName || normalizedWorkspaceName.length < 2) {
    throw ApiError.badRequest('Workspace name is required');
  }

  const slug = slugify(workspaceSlug || normalizedWorkspaceName);
  const existingTenant = await tenantRepository.findBySlug(slug);
  if (existingTenant) {
    throw slugTakenError();
  }

  const passwordHash = await hashPassword(normalizedPassword);

  let tenant;
  try {
    tenant = await tenantRepository.create({
      name: normalizedWorkspaceName,
      slug,
      status: 'pending',
      onboardingStatus: 'not_started',
      createdBy: 'public-signup',
    });
  } catch (error) {
    if (error?.code === 11000) throw slugTakenError();
    throw error;
  }

  let user;
  try {
    user = await userRepository.create({
      tenantId: String(tenant._id),
      email: normalizedEmail,
      passwordHash,
      status: 'unverified',
      profile: { name: normalizedName, locale: 'en', timezone: 'UTC' },
      invitedBy: null,
    });
  } catch (error) {
    await tenantRepository.deleteUninitialized(tenant._id);
    if (error?.code === 11000) throw slugTakenError();
    throw error;
  }

  // Issuing the verification token is the last provisioning step. If it
  // fails we must roll the workspace back to a clean state, otherwise the
  // owner is stranded: the tenant + user exist but no link was created, and
  // a retry hits a 409 because the slug is now taken.
  let verification;
  try {
    verification = await emailVerificationService.create({
      tenantId: String(tenant._id),
      userId: String(user._id),
      email: normalizedEmail,
      name: normalizedName,
    });
  } catch (error) {
    try {
      await emailVerificationTokenRepository.deleteByUser({
        tenantId: String(tenant._id),
        userId: String(user._id),
      });
      await userRepository.hardDelete(user._id);
      await tenantRepository.deleteUninitialized(tenant._id);
    } catch (cleanupError) {
      logger.error(
        { err: { message: cleanupError?.message } },
        'registration rollback failed; orphaned workspace may remain',
      );
    }
    throw error;
  }

  return {
    ok: true,
    email: normalizedEmail,
    verificationSent: verification.delivered,
    tenant: {
      id: String(tenant._id),
      name: tenant.name,
      slug: tenant.slug,
      status: tenant.status,
      onboardingStatus: tenant.onboardingStatus,
    },
    owner: {
      id: String(user._id),
      name: normalizedName,
    },
  };
}

/**
 * Re-send a verification email to an unverified workspace owner.
 *
 * `tenantIdentifier` may be a workspace slug (from `X-Tenant-Id`) or a
 * tenant id. The response is always generic so it cannot be used to probe
 * which emails have accounts.
 *
 * @param {Object} params
 * @param {string} params.tenantIdentifier
 * @param {string} params.email
 * @returns {Promise<{ ok: true }>}
 */
export async function resendVerification({ tenantIdentifier, email }) {
  return emailVerificationService.resend({ tenantIdentifier, email });
}

export async function verifyEmail({ token }) {
  const result = await emailVerificationService.verify({ token });
  return {
    ok: true,
    verified: true,
    email: result.email,
    tenant: {
      id: result.tenant.id,
      name: result.tenant.name,
      slug: result.tenant.slug,
      status: result.tenant.status,
      onboardingStatus: result.tenant.onboardingStatus,
    },
  };
}

export default {
  login,
  register,
  resendVerification,
  verifyEmail,
  refresh,
  logout,
  logoutAll,
  getProfile,
  logoutByRefreshToken,
  _meta: { portals: ['user', 'admin'], accessTokenTtlSec: ACCESS_TTL_SECONDS },
};
