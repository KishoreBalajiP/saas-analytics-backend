import { createHash, randomBytes } from 'node:crypto';
import env from '../config/env.js';
import ApiError from '../utils/ApiError.js';
import { hash as hashPassword } from '../utils/password.js';
import emailService from './email.service.js';
import tenantRepository from '../repositories/tenant.repository.js';
import userRepository from '../repositories/user.repository.js';
import roleRepository from '../repositories/role.repository.js';
import invitationRepository from '../repositories/tenantInvitation.repository.js';
import { UserRole } from '../models/UserRole.js';
import { TenantInvitation } from '../models/TenantInvitation.js';
import { emit as auditEmit } from './auditLog.service.js';

const TTL = env.security.auth.passwordResetTokenTtlMs;
const INVALID = 'Invitation is invalid, expired, or no longer available';

function digest(token) { return createHash('sha256').update(token, 'utf8').digest('hex'); }
function safeInvitation(row) {
  if (!row) return row;
  const { tokenHash, ...safe } = row;
  return safe;
}

async function resolveRole(tenantId, roleName = 'Owner') {
  const role = await roleRepository.findByName({ tenantId, name: roleName });
  if (!role) throw ApiError.badRequest('Invitation role is not available for this tenant');
  return role;
}

async function ensureInvitedUser({ tenantId, email, name = '', invitedBy }) {
  let user = await userRepository.findByEmail(tenantId, email);
  if (!user) {
    user = await userRepository.create({
      tenantId, email, passwordHash: null, status: 'invited',
      profile: { name, locale: 'en', timezone: 'UTC' }, invitedBy,
    });
  }
  return user;
}

async function ensureRoleGrant({ tenantId, userId, roleId, by }) {
  try {
    await new UserRole({ tenantId, userId, roleId, grantedBy: by, grantedAt: new Date() }).save();
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
}

export async function create({ tenantId, email, name = '', roleName = 'Owner', invitedBy, actorType = 'admin' }) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw ApiError.notFound('Tenant not found');
  if (!invitedBy) throw ApiError.badRequest('Inviter is required');
  const invitedEmail = String(email ?? '').trim().toLowerCase();
  if (!invitedEmail) throw ApiError.badRequest('Invited email is required');
  const existing = await invitationRepository.findPendingByEmail({ tenantId, invitedEmail });
  if (existing && existing.expiresAt > new Date()) {
    return { invitation: safeInvitation(existing), delivered: false, alreadyPending: true };
  }
  if (existing) await invitationRepository.revokePending({ tenantId, invitedEmail, by: invitedBy });
  const role = await resolveRole(tenantId, roleName);
  const user = await ensureInvitedUser({ tenantId, email: invitedEmail, name, invitedBy });
  if (user.status === 'active' && user.passwordHash) throw ApiError.conflict('A user with this email already belongs to the tenant');
  await ensureRoleGrant({ tenantId, userId: String(user._id), roleId: String(role._id), by: invitedBy });
  const rawToken = randomBytes(32).toString('base64url');
  let invitation;
  try {
    invitation = await invitationRepository.create({
      tenantId, invitedEmail, roleId: String(role._id), roleName: role.name,
      invitedBy: String(invitedBy), tokenHash: digest(rawToken),
      expiresAt: new Date(Date.now() + TTL),
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const pending = await invitationRepository.findPendingByEmail({ tenantId, invitedEmail });
    if (!pending) throw error;
    return { invitation: safeInvitation(pending), delivered: false, alreadyPending: true };
  }
  const url = `${env.cors.clientUrl}/invite/accept?token=${encodeURIComponent(rawToken)}`;
  let delivered = true;
  try {
    await emailService.send({
      to: invitedEmail,
      subject: 'You are invited to Analivo',
      text: `You have been invited to ${tenant.name}. Accept your invitation: ${url}\n\nThis link expires in 15 minutes and can only be used once.`,
    });
  } catch (error) {
    delivered = false;
    // Do not log the token or email body. The pending invitation can be resent.
    invitation.deliveryError = error?.message ?? 'Email delivery failed';
  }
  await auditEmit({ actor: { type: actorType, id: invitedBy }, action: 'tenant.invitation_created', module: 'iam.tenant_invitations', resource: { type: 'invitation', id: invitation._id }, tenantId, after: { invitedEmail, role: role.name, delivered } });
  return { invitation: safeInvitation(invitation), delivered };
}

export async function preview(token) {
  const row = await invitationRepository.findLiveByHash(digest(String(token ?? '')));
  if (!row) throw ApiError.badRequest(INVALID);
  const tenant = await tenantRepository.findById(row.tenantId);
  if (!tenant) throw ApiError.badRequest(INVALID);
  return { tenant: { id: String(tenant._id), name: tenant.name, slug: tenant.slug }, invitedEmail: row.invitedEmail, role: row.roleName, expiresAt: row.expiresAt };
}

export async function accept({ token, name, password }) {
  if (typeof password !== 'string' || password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');
  const tokenHash = digest(String(token ?? ''));
  const pending = await invitationRepository.findLiveByHash(tokenHash);
  if (!pending) throw ApiError.badRequest(INVALID);
  const passwordHash = await hashPassword(password);
  const consumed = await invitationRepository.consume({ id: pending._id, acceptedBy: pending.invitedEmail });
  if (!consumed) throw ApiError.badRequest(INVALID);
  const user = await userRepository.findByEmail(pending.tenantId, pending.invitedEmail);
  if (!user) throw ApiError.badRequest(INVALID);
  const updated = await userRepository.update(user._id, { passwordHash, status: 'active', 'profile.name': String(name ?? '').trim(), acceptedAt: new Date(), failedAttempts: 0, lockedUntil: null });
  if (!updated) throw ApiError.badRequest(INVALID);
  await auditEmit({ actor: { type: 'user', id: String(user._id) }, action: 'tenant.invitation_accepted', module: 'iam.tenant_invitations', resource: { type: 'invitation', id: pending._id }, tenantId: pending.tenantId, after: { userId: String(user._id) } });
  return { ok: true, tenantId: pending.tenantId, email: pending.invitedEmail };
}

export const list = ({ tenantId, status, page, limit }) => invitationRepository.list({ tenantId, status, page, limit });
export const revoke = async ({ id, tenantId, by }) => {
  const existing = await invitationRepository.findById(id);
  if (!existing || String(existing.tenantId) !== String(tenantId)) throw ApiError.notFound('Invitation not found');
  const result = await invitationRepository.revoke(id, by);
  if (!result) throw ApiError.conflict('Invitation is no longer pending');
  return safeInvitation(result);
};
export const resend = async ({ tenantId, invitationId, email, name = '', roleName = 'Owner', invitedBy }) => {
  const existing = invitationId
    ? await invitationRepository.findById(invitationId)
    : null;
  if (!invitationId && email) {
    await invitationRepository.revokePending({ tenantId, invitedEmail: email, by: invitedBy });
    return create({ tenantId, email, name, roleName, invitedBy });
  }
  if (!existing || String(existing.tenantId) !== String(tenantId)) throw ApiError.notFound('Invitation not found');
  if (existing.status !== 'pending') throw ApiError.conflict('Only pending invitations can be resent');
  const user = await userRepository.findByEmail(tenantId, existing.invitedEmail);
  await invitationRepository.revokePending({ tenantId, invitedEmail: existing.invitedEmail, by: invitedBy });
  return create({
    tenantId,
    email: existing.invitedEmail,
    name: user?.profile?.name ?? '',
    roleName: existing.roleName,
    invitedBy,
  });
};

export default { create, preview, accept, list, revoke, resend, _meta: { token: 'opaque-single-use-sha256' } };
