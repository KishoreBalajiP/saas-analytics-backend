import { createHash, randomBytes } from 'node:crypto';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import emailService from './email.service.js';
import emailVerificationTokenRepository from '../repositories/emailVerificationToken.repository.js';
import userRepository from '../repositories/user.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import tenantInitializationService from './tenantInitialization.service.js';

const TTL = env.security.auth.passwordResetTokenTtlMs;
const INVALID = 'Verification link is invalid, expired, or already used';

function digest(token) {
  return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
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
  let delivered = true;

  try {
    await emailService.send({
      to: normalized,
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
    });
  } catch (error) {
    delivered = false;
    record.deliveryError = error?.message ?? 'Email delivery failed';
  }

  return { record, token: rawToken, verificationUrl, delivered };
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
  verify,
  _meta: { token: 'opaque-single-use-sha256', delivery: 'email-only' },
};
