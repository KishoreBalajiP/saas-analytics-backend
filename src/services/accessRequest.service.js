import { randomBytes } from 'node:crypto';
import AccessRequest from '../models/AccessRequest.js';
import ApiError from '../utils/ApiError.js';
import tenantInvitationService from './tenantInvitation.service.js';
import tenantRepository from '../repositories/tenant.repository.js';
import adminRepository from '../repositories/admin.repository.js';

function safe(row) {
  return {
    id: String(row._id),
    reference: row.reference,
    name: row.name,
    email: row.email,
    workspaceName: row.workspaceName,
    reason: row.reason,
    status: row.status,
    reviewedAt: row.reviewedAt,
    decisionNote: row.decisionNote,
    tenantId: row.tenantId,
    invitationId: row.invitationId,
    createdAt: row.createdAt,
  };
}

export async function submit({ name, email, workspaceName, reason = '' }) {
  const normalized = { name: name.trim(), email: email.trim().toLowerCase(), workspaceName: workspaceName.trim(), reason: reason.trim() };
  const existing = await AccessRequest.findOne({ ...normalized, status: 'pending' }).lean();
  if (existing) return { accepted: true, reference: existing.reference };
  const reference = `AR-${randomBytes(6).toString('hex').toUpperCase()}`;
  const row = await AccessRequest.create({ ...normalized, reference });
  return { accepted: true, reference: row.reference };
}

export async function list({ status = 'pending', page = 1, limit = 20 } = {}) {
  // The controller passes the identity separately for decision endpoints;
  // listing is additionally guarded in the route-facing controller.
  const skip = (page - 1) * limit;
  const filter = status ? { status } : {};
  const [rows, total] = await Promise.all([
    AccessRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    AccessRequest.countDocuments(filter),
  ]);
  return { docs: rows.map(safe), page, limit, total, pages: Math.ceil(total / limit) || 1 };
}

export async function assertPlatformAdmin(admin) {
  const account = admin?.id ? await adminRepository.findById(admin.id) : null;
  if (!account || !['super', 'platform'].includes(account.adminType)) throw ApiError.forbidden('Platform administrator access is required');
}

export async function approve({ id, tenantId, roleName = 'Viewer', note = '', admin }) {
  await assertPlatformAdmin(admin);
  const row = await AccessRequest.findById(id);
  if (!row) throw ApiError.notFound('Access request not found');
  if (row.status !== 'pending') throw ApiError.conflict('Access request has already been decided');
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant || tenant.status !== 'active') throw ApiError.badRequest('An active workspace is required for approval');
  const invitation = await tenantInvitationService.create({ tenantId, email: row.email, name: row.name, roleName, invitedBy: admin.id, actorType: 'admin' });
  row.status = 'approved';
  row.reviewedAt = new Date();
  row.reviewedBy = admin.id;
  row.decisionNote = note;
  row.tenantId = tenantId;
  row.invitationId = String(invitation.invitation._id ?? invitation.invitation.id);
  await row.save();
  return { request: safe(row), delivered: invitation.delivered, invitation: invitation.invitation };
}

export async function reject({ id, note = '', admin }) {
  await assertPlatformAdmin(admin);
  const row = await AccessRequest.findById(id);
  if (!row) throw ApiError.notFound('Access request not found');
  if (row.status !== 'pending') throw ApiError.conflict('Access request has already been decided');
  row.status = 'rejected'; row.reviewedAt = new Date(); row.reviewedBy = admin.id; row.decisionNote = note;
  await row.save();
  return safe(row);
}

export default { submit, list, approve, reject, assertPlatformAdmin };
