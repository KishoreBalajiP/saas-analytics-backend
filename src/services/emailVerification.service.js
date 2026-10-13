import { createHash, randomBytes } from 'node:crypto';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { createChildLogger } from '../utils/logger.js';
import emailService from './email.service.js';
import cacheService from './cache.service.js';
import emailVerificationTokenRepository from '../repositories/emailVerificationToken.repository.js';
import userRepository from '../repositories/user.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import tenantInitializationService from './tenantInitialization.service.js';

const logger = createChildLogger({ module: 'services/email_verification' });
const TTL = env.security.auth.verificationTokenTtlMs ?? env.security.auth.passwordResetTokenTtlMs;
const RESEND_COOLDOWN_MS = env.security.auth.verificationResendCooldownMs;
const INVALID = 'Verification link is invalid, expired, or already used';

function digest(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
}

/**
 * Attempt delivery and report the true outcome. A message is only reported
 * as `sent` when a capture sink recorded it (tests) or a configured SMTP
 * transport accepted the recipient. When no transport is configured the
 * token is created but delivery is truthfully marked `unconfigured` so the
 * caller never claims an email was sent when none was.
 *
 * @returns {Promise<{ status: 'sent'|'failed'|'unconfigured', error: string|null, sentAt: Date|null }>}
 */
async function deliver({ to, name, verificationUrl }) {
  if (!emailService.isCapturing() && !emailService.isDeliveryConfigured()) {
    logger.warn(
      { reason: 'mail_unconfigured' },
      'verification email not delivered: no mail transport configured',
    );
    return { status: 'unconfigured', error: 'Mail transport is not configured', sentAt: null };
  }

  const message = {
    to,
    subject: 'Verify your Analivo workspace email',
    text: [
      `Hi ${name || 'there'},`,
      '',
      'Welcome to Analivo. Verify your email address to finish creating your workspace.',
      '',
      verificationUrl,
      '',
      'This link expires in 15 minutes and can only be used once.',
    ].join('\n'),
  };

  try {
    const info = await emailService.send(message);
    const accepted = info?.accepted ?? [];
    const rejected = info?.rejected ?? [];
    if (rejected.length > 0 && accepted.length === 0) {
      return { status: 'failed', error: 'Recipient was rejected by the mail server', sentAt: new Date() };
    }
    return { status: 'sent', error: null, sentAt: new Date() };
  } catch (error) {
    logger.error({ reason: 'send_failed' }, 'verification email delivery failed');
    return { status: 'failed', error: error?.message ?? 'Email delivery failed', sentAt: null };
  }
}

export async function create({ tenantId, userId, email, name = '' }) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) throw ApiError.badRequest('Email is required');

  await emailVerificationTokenRepository.revokePending({ tenantId, userId, email: normalized });

  const rawToken = randomBytes(32).toString('base64url');
  const record = await emailVerificationTokenRepository.create({
    tenantId,
    userId,
    email: normalized,
    tokenHash: digest(rawToken),
    status: 'pending',
    expiresAt: new Date(Date.now() + TTL),
  });

  const verificationUrl = `${env.cors.clientUrl}/register?token=${encodeURIComponent(rawToken)}`;
  const delivery = await deliver({ to: normalized, name, verificationUrl });

  // Persist the outcome, but never let an observability write break signup.
  try {
    await emailVerificationTokenRepository.markDelivery(record._id, delivery);
  } catch {
    logger.warn({ reason: 'delivery_persist_failed' }, 'could not persist verification delivery status');
  }

  return {
    record,
    token: rawToken,
    verificationUrl,
    delivered: delivery.status === 'sent',
    deliveryStatus: delivery.status,
  };
}

/**
 * Re-issue a verification email for an unverified workspace owner.
 *
 * Enumeration-safe: the caller always receives a generic success, and the
 * cooldown is keyed by the requested tenant + email hash regardless of
 * whether an account exists, so a 429 does not reveal account existence.
 * Only users still `unverified` get a new link; active accounts are ignored.
 *
 * @param {Object} params
 * @param {string} params.tenantIdentifier - tenant id or public slug.
 * @param {string} params.email
 * @returns {Promise<{ ok: true, verificationSent?: boolean }>}
 */
export async function resend({ tenantIdentifier, email }) {
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized) throw ApiError.badRequest('Email is required');

  const tenant = tenantIdentifier
    ? await tenantRepository.findByIdOrSlug(tenantIdentifier)
    : null;
  const scope = tenant ? String(tenant._id) : 'unknown';

  const cooldownKey = `verification-resend:${scope}:${digest(normalized)}`;
  if (await cacheService.get(cooldownKey)) {
    throw ApiError.tooManyRequests(
      'A verification email was requested recently. Please wait a moment before trying again.',
    );
  }
  await cacheService.set(cooldownKey, 1, Math.ceil(RESEND_COOLDOWN_MS / 1000));

  if (!tenant) return { ok: true };

  const user = await userRepository.findByEmail(String(tenant._id), normalized);
  if (!user || user.status !== 'unverified') return { ok: true };

  // The delivery outcome is logged server-side for operators; the HTTP
  // response stays generic so it cannot be used as an account oracle.
  await create({
    tenantId: String(tenant._id),
    userId: String(user._id),
    email: normalized,
    name: user.profile?.name ?? '',
  });

  return { ok: true };
}

export async function verify({ token }) {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw ApiError.badRequest('Verification token is required');
  }

  const row = await emailVerificationTokenRepository.findLiveByHash(digest(token));
  if (!row) throw ApiError.badRequest(INVALID);

  const tenant = await tenantRepository.findById(row.tenantId);
  const user = await userRepository.findById(row.userId);
  if (!tenant || !user || String(user.tenantId) !== String(row.tenantId) || user.email !== row.email) {
    throw ApiError.badRequest(INVALID);
  }
  if (!['unverified', 'active'].includes(user.status)) throw ApiError.badRequest(INVALID);
  if (tenant.status === 'active' && tenant.onboardingStatus === 'ready' && String(tenant.ownerId) === String(user._id)) {
    // A prior request may have completed provisioning before an infrastructure error.
  } else if (tenant.status === 'pending') {
    await tenantInitializationService.initialize({
      tenantId: String(tenant._id),
      owner: { email: user.email, name: user.profile?.name ?? '' },
    });
  } else {
    throw ApiError.forbidden('Workspace is not eligible for email verification');
  }

  const updatedUser = await userRepository.update(user._id, {
    status: 'active',
    failedAttempts: 0,
    lockedUntil: null,
    'profile.name': user.profile?.name ?? '',
  });
  if (!updatedUser) throw ApiError.badRequest(INVALID);

  const consumed = await emailVerificationTokenRepository.consume(row._id);
  if (!consumed) throw ApiError.badRequest(INVALID);

  const updatedTenant = await tenantRepository.findById(tenant._id);
  if (!updatedTenant || updatedTenant.status !== 'active' || String(updatedTenant.ownerId) !== String(user._id)) {
    throw ApiError.forbidden('Workspace is not eligible for email verification');
  }

  return {
    ok: true,
    verified: true,
    email: user.email,
    tenant: {
      id: String(updatedTenant._id),
      name: updatedTenant.name,
      slug: updatedTenant.slug,
      status: updatedTenant.status,
      onboardingStatus: updatedTenant.onboardingStatus,
    },
    user: {
      id: String(updatedUser._id),
      email: updatedUser.email,
      name: updatedUser.profile?.name ?? '',
      status: updatedUser.status,
    },
  };
}

export default {
  create,
  resend,
  verify,
  _meta: { token: 'opaque-single-use-sha256', delivery: 'email-only', resend: 'throttled-generic' },
};
