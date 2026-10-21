/**
 * API Key Service (Sprint 9 - implemented).
 *
 * PURPOSE
 *   Business layer for tenant-scoped API keys. Owns generation, verification,
 *   revocation and the mapping from the public `X-Api-Key` header to the
 *   internal `req.apiKey` + `req.tenant` used by the external API surface.
 *
 * SECURITY CONTRACT
 *   - `generateKey()` produces a high-entropy secret returned ONCE to the
 *     caller. Only `prefix` (lookup key) + `secretHash` (SHA-256) are
 *     persisted. The plaintext secret is never logged or stored.
 *   - `authenticateApiKey(prefix, secret)` performs a constant-time compare
 *     using `crypto.timingSafeEqual` via `safeEqual` and checks
 *     `status === 'active'` + `expiresAt > now` + scope validity.
 *   - Keys are tenant-scoped via the `tenantScope` plugin; service enforces
 *     `tenantId` on every read/write.
 *   - Create, rotate and revoke are security events (`api_key.*`) carrying
 *     the key id, prefix and scopes, never the secret or its hash.
 */

import crypto from 'node:crypto';
import net from 'node:net';
import entitlementService from './entitlement.service.js';
import { generateToken, sha256, safeEqual } from '../utils/crypto.js';
import env from '../config/env.js';
import apiKeyRepository from '../repositories/apiKey.repository.js';
import tenantRepository from '../repositories/tenant.repository.js';
import ApiError from '../utils/ApiError.js';
import { ApiKey, API_KEY_SCOPES, API_KEY_STATUSES } from '../models/ApiKey.js';
import { securityEvent } from './securityEvent.service.js';

const PREFIX = 'sak_';

/* ------------------------- devapi: lifecycle helpers ------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;
const IP_LIST_MAX = 50;

/** Strip the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4`). */
function plainIp(ip) {
  const s = String(ip ?? '');
  return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

/**
 * Validate an IP allow-list: exact IPv4/IPv6 addresses or IPv4/IPv6 CIDR.
 * @returns {string[]} the normalised list
 */
export function normalizeIpAllowList(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > IP_LIST_MAX) {
    throw ApiError.badRequest('Validation failed', [{ field: 'ipAllowList', message: `must be an array of at most ${IP_LIST_MAX} IPs or CIDR ranges` }]);
  }
  return list.map((entry, i) => {
    const [addr, bits, extra] = String(entry).trim().split('/');
    const family = net.isIP(addr);
    const max = family === 4 ? 32 : 128;
    const okBits = bits === undefined || (/^\d{1,3}$/u.test(bits) && Number(bits) <= max);
    if (!family || !okBits || extra !== undefined) {
      throw ApiError.badRequest('Validation failed', [{ field: `ipAllowList[${i}]`, message: 'must be an IP address or CIDR range such as 203.0.113.0/24' }]);
    }
    return bits === undefined ? addr : `${addr}/${Number(bits)}`;
  });
}

/** True when `ip` matches the allow-list (an empty list allows any IP). */
export function ipAllowed(list, ip) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const addr = plainIp(ip);
  const family = net.isIP(addr);
  if (!family) return false;
  const block = new net.BlockList();
  for (const entry of list) {
    const [a, bits] = entry.split('/');
    const type = net.isIP(a) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) block.addAddress(a, type);
    else block.addSubnet(a, Number(bits), type);
  }
  return block.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

/** Enforce the maximum key lifetime; returns the effective expiry date. */
function cappedExpiry(expiresAt) {
  const maxMs = env.security.apiKeys.maxTtlDays * DAY_MS;
  if (expiresAt === undefined || expiresAt === null) {
    return new Date(Date.now() + Math.min(env.security.apiKeys.defaultTtlDays * DAY_MS, maxMs));
  }
  const d = new Date(expiresAt);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
    throw ApiError.badRequest('Validation failed', [{ field: 'expiresAt', message: 'must be a future date' }]);
  }
  if (d.getTime() - Date.now() > maxMs) {
    throw ApiError.badRequest('Validation failed', [{ field: 'expiresAt', message: `must be within ${env.security.apiKeys.maxTtlDays} days` }]);
  }
  return d;
}

/** Redacted key shape returned by every management call. */
function publicKey(k) {
  return {
    id: k._id,
    prefix: k.prefix,
    name: k.name,
    scopes: k.scopes,
    expiresAt: k.expiresAt,
    status: k.status,
    lastUsedAt: k.lastUsedAt ?? null,
    lastUsedIp: k.lastUsedIp ?? null,
    ipAllowList: k.ipAllowList ?? [],
    rotatedTo: k.rotatedTo ?? null,
    rotatedAt: k.rotatedAt ?? null,
    createdAt: k.createdAt,
  };
}

/** Generate a new secret + its lookup prefix. Returns { prefix, secret, secretHash }. */
function generateKeyMaterial() {
  const secret = generateToken(32);
  const prefix = PREFIX + generateToken(16);
  const secretHash = sha256(secret);
  return { prefix, secret, secretHash };
}

/** Check if a scope is valid (allow-listed). */
function assertScopeValid(scope) {
  if (!API_KEY_SCOPES.includes(scope)) {
    throw ApiError.badRequest(`Invalid scope "${scope}". Allowed: ${API_KEY_SCOPES.join(', ')}`);
  }
}

/** Validate scopes array is non-empty and all allowed. */
function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw ApiError.badRequest('At least one scope is required');
  }
  for (const scope of scopes) assertScopeValid(scope);
}

/**
 * Create an API key for a tenant.
 * @returns {Promise<{ key: { id, prefix, name, scopes, expiresAt }, secret: string }>}
 */
export async function createApiKey(input = {}) {
  const created = await createKeyRecord(input);
  await securityEvent('API_KEY_CREATED', {
    tenantId: String(input.tenantId),
    resource: { type: 'api_key', id: String(created.key.id) },
    metadata: {
      keyId: String(created.key.id),
      prefix: created.key.prefix,
      name: created.key.name,
      scopes: created.key.scopes,
      expiresAt: created.key.expiresAt,
    },
  });
  return created;
}

/** Create the key row (no audit event; callers record the right one). */
async function createKeyRecord({ tenantId, name, scopes, expiresAt = null, actorId = null, ipAllowList } = {}) {
  validateScopes(scopes);

  if (!tenantId) throw ApiError.badRequest('tenantId is required');
  // Note: creating a key no longer consumes the `apiCallsPerDay` quota.
  // That metric counts API calls, not keys; charging it here exhausted the
  // daily quota after a few key creations and never reset.

  const activeCount = await apiKeyRepository.countByStatus({ tenantId, status: 'active' });
  if (activeCount >= env.security.apiKeys.maxActivePerTenant) {
    throw ApiError.conflict(`Active key limit reached (${env.security.apiKeys.maxActivePerTenant})`);
  }
  // devapi: expiry is mandatory and capped (API_KEY_MAX_TTL_DAYS).
  const expires = cappedExpiry(expiresAt);
  const ips = normalizeIpAllowList(ipAllowList);

  const { prefix, secret, secretHash } = generateKeyMaterial();


  const doc = await apiKeyRepository.create({
    tenantId,
    name,
    prefix,
    secretHash,
    scopes,
    expiresAt: expires,
    ipAllowList: ips,
    status: 'active',
    createdBy: actorId,
  });

  return {
    key: publicKey(doc),
    // The complete credential the caller sends as `X-Api-Key`
    // (`prefix.secret`). Shown once; only the secret's hash is stored.
    secret: `${prefix}.${secret}`,
  };
}

/** List API keys for a tenant (redacted - no secrets). */
export async function listApiKeys({ tenantId, page = 1, limit = 20, status } = {}) {
  const filter = status ? { status } : {};
  const result = await apiKeyRepository.list({ tenantId, filter, page, limit });
  return {
    ...result,
    docs: result.docs.map(publicKey),
  };
}

/** Get a single key (redacted). */
export async function getApiKey({ tenantId, keyId }) {
  const doc = await apiKeyRepository.findById(keyId, { tenantId });
  if (!doc) return null;
  return publicKey(doc);
}

/** Revoke a key (permanent, status -> revoked). */
export async function revokeApiKey(input = {}) {
  const revoked = await revokeKeyRecord(input);
  if (revoked) {
    await securityEvent('API_KEY_REVOKED', {
      tenantId: String(input.tenantId),
      resource: { type: 'api_key', id: String(revoked.id) },
      reason: input.reason || null,
      metadata: { keyId: String(revoked.id), prefix: revoked.prefix, name: revoked.name },
    });
  }
  return revoked ? { id: revoked.id, revoked: true } : null;
}

/** Revoke the key row (no audit event). Returns the revoked key or null. */
async function revokeKeyRecord({ tenantId, keyId, actorId = null, reason = '' } = {}) {
  const doc = await apiKeyRepository.findById(keyId, { tenantId });
  if (!doc) return null;
  if (doc.status === 'revoked') return null;

  await apiKeyRepository.update(keyId, {
    status: 'revoked',
    revokedAt: new Date(),
    revokedReason: reason,
    revokedBy: actorId,
    updatedBy: actorId,
  });
  return { id: doc._id, prefix: doc.prefix, name: doc.name };
}

/**
 * Authenticate an API key from the X-Api-Key header.
 * Header format: `prefix.secret` (e.g. `sak_ab12.cdef...`)
 * Returns { keyId, tenantId, scopes } on success, throws on failure.
 */
export async function authenticateApiKey(headerValue, { ip = null } = {}) {
  if (!headerValue || typeof headerValue !== 'string') {
    throw new Error('Missing or invalid X-Api-Key header');
  }
  const parts = headerValue.split('.');
  if (parts.length !== 2 || !parts[0].startsWith(PREFIX) || parts[1].length < 16) {
    throw new Error('Invalid API key format');
  }
  const [prefix, secret] = parts;

  const doc = await apiKeyRepository.findByPrefix(prefix);
  if (!doc) throw new Error('Invalid API key');

  if (doc.status !== 'active') throw new Error('API key is not active');
  if (doc.expiresAt && doc.expiresAt <= new Date()) throw new Error('API key has expired');
  if (doc.deletedAt) throw new Error('API key has been deleted');

  // Constant-time compare
  const secretHash = sha256(secret);
  if (!safeEqual(doc.secretHash, secretHash)) {
    throw new Error('Invalid API key');
  }

  // A suspended, disabled or archived tenant must lose external access
  // immediately, not only its interactive sessions.
  const tenant = await tenantRepository.findById(doc.tenantId).catch(() => null);
  if (!tenant || tenant.status !== 'active') throw new Error('Tenant is not active');

  // devapi: optional per-key client IP allow-list.
  if (!ipAllowed(doc.ipAllowList, ip)) throw new Error('Client IP is not allowed for this API key');

  // Update lastUsedAt / lastUsedIp (fire-and-forget, best effort; not audited)
  apiKeyRepository.update(doc._id, { lastUsedAt: new Date(), ...(ip ? { lastUsedIp: plainIp(ip) } : {}) }).catch(() => {});

  return {
    keyId: doc._id,
    tenantId: doc.tenantId,
    scopes: doc.scopes,
    // rls: queries run with the creator's data access (row rules, grants).
    createdBy: doc.createdBy ?? null,
  };
}

/** Check if a key has a specific scope. */
export function hasScope(key, scope) {
  return key.scopes?.includes(scope);
}

/**
 * Update an API key (name, scopes, expiresAt).
 * Returns the updated key or null if not found.
 */
export async function updateApiKey({ tenantId, keyId, actorId = null, patch = {} } = {}) {
  const doc = await apiKeyRepository.findById(keyId, { tenantId });
  if (!doc) return null;

  const updates = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.scopes !== undefined) {
    validateScopes(patch.scopes);
    updates.scopes = patch.scopes;
  }
  if (patch.expiresAt !== undefined && patch.expiresAt !== null) {
    updates.expiresAt = cappedExpiry(patch.expiresAt);
  }
  if (patch.ipAllowList !== undefined) updates.ipAllowList = normalizeIpAllowList(patch.ipAllowList);
  if (Object.keys(updates).length === 0) return null;

  updates.updatedBy = actorId;

  const updated = await apiKeyRepository.update(keyId, updates);
  if (!updated) return null;
  return publicKey(updated);
}

/** Rotate an API key: create a new key and revoke the existing one.
 *  Returns the new key's secret (display once) and the old key's revocation status.
 *
 *  @param {Object} input
 *  @param {string} input.tenantId
 *  @param {string} input.keyId - the existing key to rotate
 *  @param {string} [input.actorId] - who is performing the rotation
 *  @param {string} [input.reason] - reason for rotation (audit)
 *  @returns {Promise<{ newKey: { id, prefix, name, scopes, expiresAt }, oldKeyRevoked: boolean, secret: string }>}
 */
export async function rotateApiKey({ tenantId, keyId, actorId = null, reason = '' } = {}) {
  // Create the replacement first so a failure (cap, validation) never
  // leaves the integration without a working key, then revoke the old one.
  const existing = await getApiKey({ tenantId, keyId });
  if (!existing) throw ApiError.notFound('API key not found');
  if (existing.status !== 'active' || existing.rotatedTo) throw ApiError.conflict('Only an active, not yet rotated key can be rotated');

  const newKey = await createKeyRecord({
    tenantId,
    name: existing.name,
    scopes: existing.scopes,
    // Default (capped) TTL; the IP allow-list carries over.
    expiresAt: null,
    ipAllowList: existing.ipAllowList,
    actorId,
  });
  // devapi: overlap window - the old key keeps working until it ends.
  const overlapEndsAt = new Date(Date.now() + env.security.apiKeys.rotationOverlapMinutes * 60 * 1000);
  const oldExpiry = existing.expiresAt ? new Date(existing.expiresAt) : null;
  await apiKeyRepository.update(keyId, {
    expiresAt: oldExpiry && oldExpiry < overlapEndsAt ? oldExpiry : overlapEndsAt,
    rotatedTo: newKey.key.id,
    rotatedAt: new Date(),
    updatedBy: actorId,
  });
  await securityEvent('API_KEY_ROTATED', {
    tenantId: String(tenantId),
    resource: { type: 'api_key', id: String(keyId) },
    reason: reason || 'rotated',
    metadata: {
      oldKeyId: String(keyId),
      oldPrefix: existing.prefix,
      newKeyId: String(newKey.key.id),
      newPrefix: newKey.key.prefix,
      name: existing.name,
      scopes: existing.scopes,
      overlapEndsAt,
    },
  });

  return {
    newKey: {
      id: newKey.key.id,
      prefix: newKey.key.prefix,
      name: newKey.key.name,
      scopes: newKey.key.scopes,
      expiresAt: newKey.key.expiresAt,
    },
    // The old key is NOT revoked: it expires at the end of the overlap window.
    oldKeyRevoked: false,
    overlapEndsAt,
    secret: newKey.secret,
  };
}

/** devapi: a caller revokes the key it authenticated with (leaked-key kill switch). */
export async function revokeSelf({ tenantId, keyId, reason = 'self-revoked' } = {}) {
  return revokeApiKey({ tenantId, keyId, actorId: `api_key:${keyId}`, reason });
}

export default {
  createApiKey,
  listApiKeys,
  getApiKey,
  revokeApiKey,
  authenticateApiKey,
  hasScope,
  // devapi: was missing, so PATCH /api-keys/:id answered 500.
  updateApiKey,
  rotateApiKey,
  revokeSelf,
  normalizeIpAllowList,
  ipAllowed,
  _meta: { scopes: API_KEY_SCOPES, statuses: API_KEY_STATUSES },
};