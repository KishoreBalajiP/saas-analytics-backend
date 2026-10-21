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
 *   - Every attempt is appended to `LoginAttempt` (append-only trail) and
 *     recorded as a security event on the audit trail
 *     (`auth.login.succeeded` / `auth.login.failed`, `auth.lockout`; failed
 *     logins at most once per email+ip+reason per window), and a refresh
 *     token replay as `auth.session.replay_detected`.
 *   - Refresh-token replay revokes the ENTIRE family, not just the leaked
 *     token (threat model: a reused rotated/revoked token is an attack).
 *     Two refreshes that present the same token while it is still active
 *     (concurrent requests) are not a replay: one rotates, the other gets an
 *     access token for that successor and no new refresh token. The same
 *     applies to a token presented within `AUTH_REFRESH_REUSE_GRACE_MS` of
 *     its rotation while its direct successor is still live (a lagging
 *     duplicate); later reuse is a replay.
 *   - Refresh is bound to the portal that issued the session: a tenant
 *     token presented to the admin endpoint (or vice versa) is refused.
 *   - A login has an absolute lifetime (`AUTH_SESSION_ABSOLUTE_TTL`) that
 *     rotation never extends.
 *   - Lockout decays: once `lockedUntil` has passed, the next failure starts
 *     a fresh count instead of re-locking at once.
 *   - Access tokens are short-lived (15 min); only the session can extend
 *     the actor past that via `refresh`.
 *   - mfa-tenant: tenant users with MFA on must present a TOTP code or a
 *     recovery code (401 `MFA_REQUIRED` without either); a user the
 *     workspace policy (or an Owner-assisted reset) requires to use MFA but
 *     who has none signs in to an enrolment-only session, and a refresh
 *     tightens an existing session the same way.
 */

import env from '../../../config/env.js';
// onboarding: legal document version recorded with consent.
import { LEGAL_DOCUMENT_VERSION } from '../../../constants/legal.js';
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
import permissionService from '../../../services/permission.service.js';
import roleService from '../../../services/role.service.js';
// roles: auditors are read-only (the permission middleware refuses writes).
import { isReadOnlyKey } from '../../../constants/platformRoles.js';
import { securityEvent } from '../../../services/securityEvent.service.js';
// adminauth: privileged-admin MFA policy and enrolment-only sessions.
import adminMfaPolicy from './adminMfaPolicy.js';
import { SESSION_RESTRICTION_MFA_ENROLLMENT } from '../../../models/Session.js';
// mfa-tenant: tenant-user TOTP MFA and the workspace "MFA required" policy.
import tenantMfaService from './tenantMfa.service.js';
import tenantMfaPolicy from './tenantMfaPolicy.js';

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
    clearExpiredLockout: (id) => userRepository.clearExpiredLockout(id),
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
    clearExpiredLockout: (id) => adminRepository.clearExpiredLockout(id),
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
 * @param {string} [params.recoveryCode] - adminauth: a one-time recovery code
 *   accepted instead of `mfaCode`.
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
  recoveryCode,
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

  // Tenant gate, part 1: a missing tenant stays generic (no enumeration).
  const tenant = portal === 'user' ? await findTenantOrNull(resolvedTenantId) : null;
  if (portal === 'user' && !tenant) {
    await dummyVerify(password);
    await recordAttempt({ ...attemptMeta, actorId: null, success: false, reason: 'unknown_tenant' });
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }
  if (account.status === 'locked' || isLockedOut(account)) {
    await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'account_locked' });
    throw ApiError.tooManyRequests('Too many failed attempts. Try again later.');
  }

  // Accounts without a password (invited, never activated) can never pass.
  const passwordOk = account.passwordHash ? await verifyPassword(password, account.passwordHash) : false;
  if (!passwordOk) {
    await handleFailedLogin({ ...attemptMeta, actorId, account, reason: 'invalid_credentials' });
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }

  // Account state is revealed only after the password is proven, and only
  // `active` accounts may sign in (allow-list: invited, unverified, pending,
  // suspended and locked are all refused).
  if (account.status !== 'active') {
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
    await recordAttempt({ ...attemptMeta, actorId, success: false, reason: `status_${account.status}` });
    const err = ApiError.forbidden('Account is not active');
    err.code = ERROR_CODES.ACCOUNT_NOT_ACTIVE;
    throw err;
  }

  // Tenant gate, part 2: only `active` tenants may authenticate. Checked
  // after the account state so a fresh signup (pending tenant, unverified
  // owner) gets EMAIL_NOT_VERIFIED and the UI can offer a resend.
  if (portal === 'user' && tenant.status !== 'active') {
    await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'tenant_not_active' });
    const err = ApiError.forbidden('Tenant is not active');
    err.code = ERROR_CODES.TENANT_NOT_ACTIVE;
    throw err;
  }

  // adminauth: second factor for admins (TOTP or a one-time recovery code)
  // and the privileged-admin MFA policy (enrolment-only session).
  const second = portal === 'admin'
    ? await adminSecondFactor({ attemptMeta, actorId, account, mfaCode, recoveryCode })
    // mfa-tenant: second factor and MFA policy for tenant users.
    : await userSecondFactor({ attemptMeta, actorId, account, mfaCode, recoveryCode });

  await cfg.resetFailedAttempts(actorId);
  await cfg.touchLastLogin(actorId);

  const result = await startSession({
    portal,
    account,
    tenantId: portal === 'user' ? resolvedTenantId : null,
    restriction: second.restriction,
    device,
    ip,
    userAgent,
  });

  await recordAttempt({ ...attemptMeta, actorId, success: true, reason: 'success' });
  logger.info({ portal, actorId }, 'login succeeded');

  return {
    ...result,
    ...(second.recoveryCodesRemaining !== undefined ? { recoveryCodesRemaining: second.recoveryCodesRemaining } : {}),
  };
}

/**
 * Create a session for an already-authenticated account and sign its access
 * token. Shared by login and admin invitation acceptance (adminauth).
 *
 * @param {Object} params
 * @param {'user'|'admin'} params.portal
 * @param {Object} params.account - lean account document.
 * @param {string|null} [params.tenantId] - user portal only.
 * @param {string|null} [params.restriction] - e.g. `mfa_enrollment`.
 * @param {Object} [params.device]
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @returns {Promise<Object>} `{ accessToken, expiresIn, refreshToken, refreshExpiresAt, sessionId, actor, mfaEnrollmentRequired? }`.
 */
export async function startSession({ portal, account, tenantId = null, restriction = null, device = {}, ip = '', userAgent = '' }) {
  const actorId = String(account._id);
  const refreshToken = sessionService.generateRefreshToken();
  const { session } = await sessionService.create({
    actorId,
    actorType: portal,
    tenantId: portal === 'user' ? tenantId : null,
    refreshToken,
    device,
    ip,
    userAgent,
    restriction,
  });

  const accessToken = await signAccessToken({
    portal,
    actor: account,
    sessionId: session.sessionId,
    tenantId: portal === 'user' ? tenantId : account.tenantScope ?? null,
  });

  return {
    accessToken,
    expiresIn: ACCESS_TTL_SECONDS,
    refreshToken,
    refreshExpiresAt: session.expiresAt,
    sessionId: session.sessionId,
    actor: buildActorSummary(account),
    // adminauth: an enrolment-only session (privileged admin without MFA).
    ...(restriction === SESSION_RESTRICTION_MFA_ENROLLMENT ? { mfaEnrollmentRequired: true } : {}),
    // Resolved workspace id (never sent to the client; used for the access log).
    tenantId: portal === 'user' ? tenantId : null,
  };
}

/* ------------------------------- refresh -------------------------------- */

/** A 401 carrying a machine code the client can branch on. */
function sessionError(message, code) {
  const err = ApiError.unauthorized(message);
  err.code = code;
  return err;
}

/** Portal that owns a stored session (`admin` sessions vs everything else). */
function sessionPortal(session) {
  return session.actorType === 'admin' ? 'admin' : 'user';
}

/**
 * Rotate a session using the opaque refresh token. Derives the actor type
 * from the stored session (never trusts the caller) and revokes the entire
 * family when a non-active token is replayed.
 *
 * @param {Object} params
 * @param {string} params.refreshToken - raw opaque token from the cookie.
 * @param {'user'|'admin'} [params.portal] - the portal whose endpoint was
 *   called. When given, a session issued by the other portal is refused.
 * @param {Object} [params.device]
 * @param {string} [params.ip]
 * @param {string} [params.userAgent]
 * @returns {Promise<Object>} `{ accessToken, expiresIn, refreshToken, refreshExpiresAt, sessionId, actor }`.
 *   `refreshToken` is null when this call lost a concurrent rotation race
 *   (the caller must then leave the existing cookie alone).
 */
export async function refresh({ refreshToken, portal: expectedPortal = null, device, ip, userAgent }) {
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    // No cookie reached the server: either the user never signed in in this
    // browser, or the browser blocks the (cross-site) cookie. The client
    // uses the code to explain the second case.
    throw sessionError('Session expired', ERROR_CODES.SESSION_COOKIE_MISSING);
  }

  const refreshTokenHash = await sessionService.hashRefreshToken(refreshToken);
  const session = await sessionRepository.findByRefreshTokenHash(refreshTokenHash);

  if (!session) throw sessionError('Session expired', ERROR_CODES.SESSION_EXPIRED);

  // Portal binding: a token minted for the other portal is never honoured
  // here. It is not a replay either, so nothing is revoked.
  if (expectedPortal && sessionPortal(session) !== expectedPortal) {
    throw sessionError('Session expired', ERROR_CODES.SESSION_EXPIRED);
  }

  // Replay detection: a rotated/revoked/expired token is being reused.
  // Reuse grace: a token rotated moments ago whose successor is still live
  // is a lagging duplicate (another tab or a retry sent the old cookie
  // before the rotation's response arrived), not an attack. It joins that
  // successor below. Anything else revokes the whole family.
  let joined = null;
  if (session.status !== 'active') {
    joined = await liveSuccessorOf(session, { withinMs: AUTH.refreshReuseGraceMs });
    if (!joined) {
      const revoked = await sessionRepository.revokeAllForActor(session.actorId, 'replay_detected');
      await securityEvent('SESSION_REPLAY_DETECTED', {
        actor: { type: sessionPortal(session), id: String(session.actorId) },
        tenantId: session.tenantId ?? null,
        resource: { type: 'session', id: session.sessionId },
        ip,
        userAgent,
        metadata: { familyId: session.familyId ?? null, revokedSessions: revoked, sessionStatus: session.status },
      });
      logger.warn({ actorId: session.actorId }, 'refresh-token replay detected; family revoked');
      throw sessionError('Session revoked', ERROR_CODES.SESSION_REVOKED);
    }
  }
  const current = joined ?? session;

  if (!current.expiresAt || new Date(current.expiresAt).getTime() <= Date.now()) {
    await sessionRepository.markExpired(current.sessionId);
    throw sessionError('Session expired', ERROR_CODES.SESSION_EXPIRED);
  }

  // Absolute lifetime: however often the family was rotated, a login ends
  // `sessionAbsoluteTtl` after the original sign-in.
  if (sessionService.isPastAbsoluteLifetime(current)) {
    await sessionRepository.markExpired(current.sessionId);
    logger.info({ actorId: session.actorId }, 'session reached its absolute lifetime');
    throw sessionError('Session expired', ERROR_CODES.SESSION_EXPIRED);
  }

  const portal = sessionPortal(session);
  const cfg = PORTAL[portal];
  const account = await cfg.findById(session.actorId);

  // Actor no longer exists or is not active (suspended, locked, pending,
  // invited, unverified) -> kill the whole family.
  if (!account || account.status !== 'active') {
    const revoked = await sessionRepository.revokeAllForActor(session.actorId, 'actor_invalid');
    await recordFamilyRevocation({ session, reason: 'actor_invalid', revoked, ip, userAgent });
    throw sessionError('Session revoked', ERROR_CODES.SESSION_REVOKED);
  }

  // Tenant gate on refresh: a suspended/disabled/archived tenant must not
  // be able to keep sessions alive, even if the account is still active.
  if (portal === 'user' && session.tenantId) {
    const tenant = await findTenantOrNull(session.tenantId);
    if (!tenant || tenant.status !== 'active') {
      const revoked = await sessionRepository.revokeAllForActor(session.actorId, 'tenant_inactive');
      await recordFamilyRevocation({ session, reason: 'tenant_inactive', revoked, ip, userAgent });
      throw sessionError('Session revoked', ERROR_CODES.SESSION_REVOKED);
    }
  }

  // Within the reuse grace: no second rotation, just an access token for
  // the live successor (the browser holds its cookie already).
  if (joined) {
    logger.info({ actorId: session.actorId }, 'refresh reused a just-rotated token within the grace window');
    return joinRotation({ portal, account, session, successor: joined });
  }

  // adminauth: a privileged admin without MFA (e.g. a session from before
  // the policy, or after MFA was turned off elsewhere) is restricted to MFA
  // enrolment from this rotation on.
  const tighten = portal === 'admin' && !account.mfaEnabled && !session.restriction
    && (await adminMfaPolicy.isMfaRequired(account))
    ? SESSION_RESTRICTION_MFA_ENROLLMENT
    // mfa-tenant: the same for a tenant user the workspace policy now
    // requires to use MFA (support impersonation sessions are left alone).
    : portal === 'user' && !account.mfaEnabled && !session.restriction && !session.impersonatedBy
      && (await tenantMfaPolicy.isMfaRequired(account))
      ? SESSION_RESTRICTION_MFA_ENROLLMENT
      : undefined;

  const newRefreshToken = sessionService.generateRefreshToken();
  const next = await sessionService.rotate({
    session,
    refreshToken: newRefreshToken,
    device,
    ip,
    userAgent,
    restriction: tighten,
  });

  // A concurrent refresh with the same (then still active) token rotated the
  // session first. This is not a replay: the token was live when this
  // request read it, so no grace bound applies. Answer with an access token
  // for the winner's successor and NO new refresh token; the browser
  // already holds the successor's cookie from the winning response.
  if (!next) {
    const predecessor = await sessionRepository.findById(session.sessionId);
    const successor = await liveSuccessorOf(predecessor);
    if (!successor) throw sessionError('Session expired', ERROR_CODES.SESSION_EXPIRED);
    logger.debug({ actorId: session.actorId }, 'session refresh joined a concurrent rotation');
    return joinRotation({ portal, account, session, successor });
  }

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
    refreshExpiresAt: next.session.expiresAt,
    sessionId: next.session.sessionId,
    actor: buildActorSummary(account),
    // adminauth: a login restricted to MFA enrolment stays restricted.
    ...(next.session.restriction === SESSION_RESTRICTION_MFA_ENROLLMENT ? { mfaEnrollmentRequired: true } : {}),
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
export async function getProfile({ portal, actorId, session = null }) {
  const cfg = PORTAL[portal];
  if (!cfg) throw ApiError.badRequest('Unknown portal');
  const account = await cfg.findById(actorId);
  if (!account) throw ApiError.notFound('Account not found');
  // Admins resolve at their tenantScope (platform grants plus grants for
  // that tenant): exactly the set the permission middleware enforces.
  const adminScope = portal === 'admin' ? account.tenantScope ?? null : null;
  const adminAccess = portal === 'admin'
    ? await Promise.all([
        roleService.resolveActorRoles({ actorType: 'admin', actorId, tenantId: adminScope }),
        permissionService.resolveActorPermissions({ actorType: 'admin', actorId, tenantId: adminScope }),
        adminMfaPolicy.isMfaRequired(account),
        mfaService.recoveryCodeStatus(actorId),
      ])
    : null;
  // Tenant users get their effective roles and permissions in their own
  // tenant so the workspace UI can gate pages and actions.
  const userAccess = portal !== 'admin' && account.tenantId
    ? await Promise.all([
        roleService.resolveActorRoles({ actorType: 'user', actorId: String(account._id), tenantId: String(account.tenantId) }),
        permissionService.resolveActorPermissions({ actorType: 'user', actorId: String(account._id), tenantId: String(account.tenantId) }),
        // mfa-tenant: MFA state and policy (never a secret).
        tenantMfaService.profileStatus({ userId: String(account._id), tenantId: String(account.tenantId), session }),
      ])
    : [[], [], null];

  return {
    ...buildActorSummary(account),
    ...(portal === 'admin'
      ? {
          type: account.adminType,
          adminType: account.adminType,
          roles: adminAccess[0],
          // An auditor-type admin is refused every non-read action by the
          // permission middleware, so /me lists only its read-only keys.
          permissions: account.adminType === 'auditor'
            ? adminAccess[1].filter((key) => isReadOnlyKey(key))
            : adminAccess[1],
          mfaEnabled: Boolean(account.mfaEnabled),
          tenantScope: account.tenantScope ?? null,
          // Effective reach: every tenant, or only the scoped one. The
          // cross-tenant scope `*` reaches every tenant (platform-wide).
          scope: adminScope && String(adminScope) !== '*'
            ? { type: 'tenant', tenantId: String(adminScope) }
            : { type: 'platform', tenantId: null },
          // adminauth: MFA policy, enrolment-only session, recovery codes
          // left (never the codes) and the current step-up window.
          mfaRequired: adminAccess[2],
          mfaEnrollmentRequired: session?.restriction === SESSION_RESTRICTION_MFA_ENROLLMENT,
          recoveryCodesRemaining: adminAccess[3].remaining,
          recoveryCodesGeneratedAt: adminAccess[3].generatedAt,
          stepUpExpiresAt: stepUpExpiry(session?.stepUpAt),
        }
      : {
          tenantId: account.tenantId ?? null,
          roles: userAccess[0],
          permissions: userAccess[1],
          ...(userAccess[2] ? { mfa: userAccess[2] } : {}),
        }),
  };
}

/**
 * Revoke the caller's current session(s): the one bound to the refresh
 * cookie AND the one named by the bearer access token (`sessionId`, already
 * verified by the optional auth middleware). Either credential alone is
 * enough, so logout still works when the cookie is missing. A cookie that
 * was already rotated ends the live session it was rotated into. Idempotent:
 * a session that is already revoked counts as logged out.
 *
 * @param {Object} params
 * @param {string} [params.refreshToken] - raw opaque token from the cookie.
 * @param {string} [params.sessionId] - session id from a verified access token.
 * @param {'user'|'admin'} [params.portal] - when given, a refresh token from
 *   the other portal is ignored (it is not this portal's session).
 * @param {string} [params.reason='logout']
 * @returns {Promise<{ ok: true, revoked: boolean }>} `revoked` is true when
 *   at least one live session was ended by this call.
 */
export async function logoutByRefreshToken({ refreshToken, sessionId = null, portal = null, reason = 'logout' }) {
  const targets = new Set();
  if (sessionId) targets.add(sessionId);
  if (typeof refreshToken === 'string' && refreshToken.length > 0) {
    const refreshTokenHash = await sessionService.hashRefreshToken(refreshToken);
    const session = await sessionRepository.findByRefreshTokenHash(refreshTokenHash);
    if (session && (!portal || sessionPortal(session) === portal)) {
      targets.add(session.sessionId);
      // A cookie that was already rotated (the rotation's response never
      // reached the client, or a client kept an old token) still names its
      // login: end the live session it was rotated into, rather than report
      // nothing to revoke while that session stays usable.
      const live = await liveDescendantOf(session);
      if (live) targets.add(live.sessionId);
    }
  }
  let revoked = false;
  for (const id of targets) {
    if (await sessionService.revoke({ sessionId: id, reason })) revoked = true;
  }
  return { ok: true, revoked };
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

/**
 * adminauth: the admin second factor at login.
 *   - MFA on: a TOTP code or a one-time recovery code is required (401
 *     `MFA_REQUIRED` without either; a wrong one counts as a failed login).
 *   - MFA off and the policy requires it (privileged type or role, or an
 *     admin-assisted reset): the login succeeds with a session restricted to
 *     MFA enrolment.
 *
 * @returns {Promise<{ restriction: string|null, recoveryCodesRemaining?: number }>}
 */
async function adminSecondFactor({ attemptMeta, actorId, account, mfaCode, recoveryCode }) {
  if (account.mfaEnabled) {
    if (!mfaCode && !recoveryCode) {
      await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'mfa_required' });
      const err = ApiError.unauthorized('MFA verification code is required');
      err.code = ERROR_CODES.MFA_REQUIRED;
      err.mfaRequired = true;
      throw err;
    }
    if (mfaCode) {
      const mfaOk = await mfaService.verifyCode({ admin: account, code: mfaCode });
      if (!mfaOk) {
        await handleFailedLogin({ ...attemptMeta, actorId, account, reason: 'mfa_failed' });
        throw ApiError.unauthorized(INVALID_CREDENTIALS);
      }
      return { restriction: null };
    }
    const used = await mfaService.consumeRecoveryCode({ adminId: actorId, code: recoveryCode });
    if (!used.ok) {
      await handleFailedLogin({ ...attemptMeta, actorId, account, reason: 'mfa_recovery_failed' });
      throw ApiError.unauthorized(INVALID_CREDENTIALS);
    }
    return { restriction: null, recoveryCodesRemaining: used.remaining };
  }
  if (await adminMfaPolicy.isMfaRequired(account)) {
    await securityEvent('MFA_ENROLLMENT_ENFORCED', {
      actor: { type: 'admin', id: actorId },
      metadata: { adminType: account.adminType ?? null, ip: attemptMeta.ip || null },
    });
    return { restriction: SESSION_RESTRICTION_MFA_ENROLLMENT };
  }
  return { restriction: null };
}

/**
 * mfa-tenant: the tenant-user second factor at login (see
 * `tenantMfa.service#loginChallenge`).
 *
 * @returns {Promise<{ restriction: string|null, recoveryCodesRemaining?: number }>}
 */
async function userSecondFactor({ attemptMeta, actorId, account, mfaCode, recoveryCode }) {
  const result = await tenantMfaService.loginChallenge({ account, mfaCode, recoveryCode });
  if (result.outcome === 'missing') {
    await recordAttempt({ ...attemptMeta, actorId, success: false, reason: 'mfa_required' });
    const err = ApiError.unauthorized('MFA verification code is required');
    err.code = ERROR_CODES.MFA_REQUIRED;
    err.mfaRequired = true;
    throw err;
  }
  if (result.outcome === 'invalid') {
    await handleFailedLogin({ ...attemptMeta, actorId, account, reason: mfaCode ? 'mfa_failed' : 'mfa_recovery_failed' });
    throw ApiError.unauthorized(INVALID_CREDENTIALS);
  }
  if (result.outcome === 'enroll') return { restriction: SESSION_RESTRICTION_MFA_ENROLLMENT };
  return {
    restriction: null,
    ...(result.recoveryCodesRemaining !== undefined ? { recoveryCodesRemaining: result.recoveryCodesRemaining } : {}),
  };
}

/** adminauth: ISO end of a step-up window still in force, else null. */
function stepUpExpiry(stepUpAt) {
  if (!stepUpAt) return null;
  const end = new Date(stepUpAt).getTime() + AUTH.adminStepUpTtlMs;
  return Number.isFinite(end) && end > Date.now() ? new Date(end).toISOString() : null;
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
 * The live session that directly replaced `predecessor` in a rotation, or
 * null: the predecessor ended for another reason (logout, replay,
 * expiry), its successor has itself ended or been rotated again, or (with
 * `withinMs`) the rotation is older than that grace. Only one hop is
 * followed, so an old token can never chase a chain of rotations.
 *
 * @param {Object|null} predecessor - session document (lean).
 * @param {Object} [opts]
 * @param {number} [opts.withinMs] - when given, the predecessor must have
 *   been rotated at most this many ms ago (0 = never).
 * @returns {Promise<Object|null>}
 */
async function liveSuccessorOf(predecessor, { withinMs } = {}) {
  if (!predecessor || predecessor.revokedReason !== 'rotated' || !predecessor.replacedBy) return null;
  if (withinMs !== undefined) {
    const rotatedAt = predecessor.revokedAt ? new Date(predecessor.revokedAt).getTime() : NaN;
    if (!(withinMs > 0) || !Number.isFinite(rotatedAt) || Date.now() - rotatedAt > withinMs) return null;
  }
  const successor = await sessionRepository.findById(predecessor.replacedBy);
  if (!successor || successor.status !== 'active') return null;
  if (String(successor.actorId) !== String(predecessor.actorId)) return null;
  if (!successor.expiresAt || new Date(successor.expiresAt).getTime() <= Date.now()) return null;
  return successor;
}

/** How far logout follows a rotated cookie to the live session of its login. */
const LOGOUT_MAX_ROTATION_HOPS = 3;

/**
 * The live session a rotated session was (directly or within a few
 * rotations) replaced by, or null. Used by logout only: it can end a
 * session, never grant one.
 *
 * @param {Object} session - session document (lean).
 * @returns {Promise<Object|null>}
 */
async function liveDescendantOf(session) {
  let current = session;
  for (let hop = 0; hop < LOGOUT_MAX_ROTATION_HOPS; hop += 1) {
    if (!current || current.revokedReason !== 'rotated' || !current.replacedBy) return null;
    const next = await sessionRepository.findById(current.replacedBy);
    if (!next || String(next.actorId) !== String(session.actorId)) return null;
    if (next.status === 'active') return next;
    current = next;
  }
  return null;
}

/**
 * Refresh result for a request that joins an existing rotation: an access
 * token bound to the live successor and NO refresh token (the controller
 * then leaves the browser's cookie alone).
 */
async function joinRotation({ portal, account, session, successor }) {
  const accessToken = await signAccessToken({
    portal,
    actor: account,
    sessionId: successor.sessionId,
    tenantId: portal === 'user' ? session.tenantId : account.tenantScope ?? null,
  });
  return {
    accessToken,
    expiresIn: ACCESS_TTL_SECONDS,
    refreshToken: null,
    refreshExpiresAt: successor.expiresAt,
    sessionId: successor.sessionId,
    actor: buildActorSummary(account),
    // adminauth: a login restricted to MFA enrolment stays restricted.
    ...(successor.restriction === SESSION_RESTRICTION_MFA_ENROLLMENT ? { mfaEnrollmentRequired: true } : {}),
  };
}

/** True when a lockout was set and its window has passed. */
function lockoutHasElapsed(account) {
  if (!account?.lockedUntil) return false;
  return new Date(account.lockedUntil).getTime() <= Date.now();
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
  // Lockout decay: a lockout that has already run its course resets the
  // counter, so the first failure afterwards starts a fresh allowance
  // instead of immediately re-locking for another full window. The reset is
  // conditional and atomic (only while the expired deadline is stored), so
  // concurrent failures reset once and a lockout set meanwhile by another
  // request is never cleared from this request's stale read.
  if (lockoutHasElapsed(account)) await cfg.clearExpiredLockout(actorId);
  const updated = await cfg.incrementFailedAttempts(actorId);
  const attempts = updated?.failedAttempts ?? (account.failedAttempts ?? 0) + 1;
  if (attempts >= AUTH.loginMaxAttempts) {
    const lockedUntil = new Date(Date.now() + AUTH.loginLockoutMs);
    await cfg.setLockedUntil(actorId, lockedUntil);
    await recordAttempt({ portal, email, tenantId, actorId, ip, userAgent, success: false, reason: 'account_locked' });
    await securityEvent('LOCKOUT', {
      actor: { type: portal, id: actorId, display: email },
      tenantId: portal === 'user' ? tenantId : null,
      resource: { type: portal, id: actorId },
      reason,
      ip,
      userAgent,
      metadata: { portal, failedAttempts: attempts, lockedUntil, trigger: reason },
    });
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
  // Security event on the audit trail. Failed attempts are de-duplicated per
  // (portal, tenant, email, ip, reason) per window so credential stuffing
  // cannot flood the trail; every attempt stays in LoginAttempt.
  const actor = { type: portal, id: actorId ?? null, display: email };
  const tenant = portal === 'user' ? tenantId : null;
  if (success) {
    await securityEvent('LOGIN_SUCCEEDED', {
      actor, tenantId: tenant, resource: { type: portal, id: actorId }, ip, userAgent, metadata: { portal },
    });
    return;
  }
  await securityEvent('LOGIN_FAILED', {
    actor,
    tenantId: tenant,
    resource: actorId ? { type: portal, id: actorId } : undefined,
    reason,
    errorCode: reason,
    ip,
    userAgent,
    metadata: { portal, reason, knownAccount: Boolean(actorId) },
    dedupeKey: `${portal}|${tenant ?? '-'}|${email}|${ip || '-'}|${reason}`,
    dedupeWindowSec: env.audit?.loginFailureWindowSec ?? 60,
  });
}

/** A refresh refused because the account or tenant is no longer active ended the family. */
async function recordFamilyRevocation({ session, reason, revoked, ip, userAgent }) {
  if (!(revoked > 0)) return;
  await securityEvent('SESSION_REVOKED', {
    actor: { type: 'system', id: null, display: 'auth.refresh' },
    tenantId: session.tenantId ?? null,
    resource: { type: sessionPortal(session), id: String(session.actorId) },
    reason,
    ip,
    userAgent,
    metadata: { reason, scope: 'all', count: revoked, subjectType: sessionPortal(session), subjectId: String(session.actorId) },
  });
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

export async function register({ fullName, email, password, workspaceName, workspaceSlug, acceptTerms, termsVersion, ip = null }) {
  // onboarding: the Terms/Privacy consent is mandatory and versioned.
  if (acceptTerms !== true) {
    throw new ApiError(422, 'You must accept the Terms of Service and Privacy Policy', {
      code: 'VALIDATION_ERROR', errors: [{ field: 'acceptTerms', message: 'must be accepted' }],
    });
  }
  if (termsVersion !== undefined && termsVersion !== null && termsVersion !== LEGAL_DOCUMENT_VERSION) {
    throw new ApiError(409, 'The legal terms changed. Reload the page and review them again.', {
      code: 'TERMS_VERSION_OUTDATED', errors: [{ field: 'termsVersion', message: `current version is ${LEGAL_DOCUMENT_VERSION}` }],
    });
  }
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
      consent: { termsVersion: LEGAL_DOCUMENT_VERSION, acceptedAt: new Date(), ip: ip ? String(ip).slice(0, 64) : null },
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
  startSession,
  _meta: { portals: ['user', 'admin'], accessTokenTtlSec: ACCESS_TTL_SECONDS },
};
