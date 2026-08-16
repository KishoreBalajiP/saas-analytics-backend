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
 */

import crypto from 'node:crypto';
import { generateToken, sha256, safeEqual } from '../utils/crypto.js';
import env from '../config/env.js';
import apiKeyRepository from '../repositories/apiKey.repository.js';
import { ApiKey, API_KEY_SCOPES, API_KEY_STATUSES } from '../models/ApiKey.js';

const PREFIX = 'sak_';

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
    throw new Error(`Invalid scope "${scope}". Allowed: ${API_KEY_SCOPES.join(', ')}`);
  }
}

/** Validate scopes array is non-empty and all allowed. */
function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('At least one scope is required');
  }
  for (const scope of scopes) assertScopeValid(scope);
}

/**
 * Create an API key for a tenant.
 * @returns {Promise<{ key: { id, prefix, name, scopes, expiresAt }, secret: string }>}
 */
export async function createApiKey({ tenantId, name, scopes, expiresAt = null, actorId = null } = {}) {
  validateScopes(scopes);

  const activeCount = await apiKeyRepository.countByStatus({ tenantId, status: 'active' });
  if (activeCount >= env.security.apiKeys.maxActivePerTenant) {
    throw new Error(`Active key limit reached (${env.security.apiKeys.maxActivePerTenant})`);
  }

  const { prefix, secret, secretHash } = generateKeyMaterial();

  const now = new Date();
  const expires = expiresAt ? new Date(expiresAt) : new Date(now.getTime() + env.security.apiKeys.defaultTtlDays * 24 * 60 * 60 * 1000);

  const doc = await apiKeyRepository.create({
    tenantId,
    name,
    prefix,
    secretHash,
    scopes,
    expiresAt: expires,
    status: 'active',
    createdBy: actorId,
  });

  return {
    key: {
      id: doc._id,
      prefix,
      name: doc.name,
      scopes: doc.scopes,
      expiresAt: doc.expiresAt,
      status: doc.status,
      createdAt: doc.createdAt,
    },
    secret,
  };
}

/** List API keys for a tenant (redacted - no secrets). */
export async function listApiKeys({ tenantId, page = 1, limit = 20, status } = {}) {
  const filter = status ? { status } : {};
  const result = await apiKeyRepository.list({ tenantId, filter, page, limit });
  return {
    ...result,
    docs: result.docs.map((k) => ({
      id: k._id,
      prefix: k.prefix,
      name: k.name,
      scopes: k.scopes,
      expiresAt: k.expiresAt,
      status: k.status,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    })),
  };
}

/** Get a single key (redacted). */
export async function getApiKey({ tenantId, keyId }) {
  const doc = await apiKeyRepository.findById(keyId, { tenantId });
  if (!doc) return null;
  return {
    id: doc._id,
    prefix: doc.prefix,
    name: doc.name,
    scopes: doc.scopes,
    expiresAt: doc.expiresAt,
    status: doc.status,
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
  };
}

/** Revoke a key (permanent, status -> revoked). */
export async function revokeApiKey({ tenantId, keyId, actorId = null, reason = '' } = {}) {
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
  return { id: doc._id, revoked: true };
}

/**
 * Authenticate an API key from the X-Api-Key header.
 * Header format: `prefix.secret` (e.g. `sak_ab12.cdef...`)
 * Returns { keyId, tenantId, scopes } on success, throws on failure.
 */
export async function authenticateApiKey(headerValue) {
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

  // Update lastUsedAt (fire-and-forget, best effort)
  apiKeyRepository.update(doc._id, { lastUsedAt: new Date() }).catch(() => {});

  return {
    keyId: doc._id,
    tenantId: doc.tenantId,
    scopes: doc.scopes,
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
    updates.expiresAt = new Date(patch.expiresAt);
  }
  if (Object.keys(updates).length === 0) return null;

  updates.updatedBy = actorId;

  const updated = await apiKeyRepository.update(keyId, updates);
  if (!updated) return null;

  return {
    id: updated._id,
    prefix: updated.prefix,
    name: updated.name,
    scopes: updated.scopes,
    expiresAt: updated.expiresAt,
    status: updated.status,
    lastUsedAt: updated.lastUsedAt,
    createdAt: updated.createdAt,
  };
}

export default {
  createApiKey,
  listApiKeys,
  getApiKey,
  revokeApiKey,
  authenticateApiKey,
  hasScope,
  _meta: { scopes: API_KEY_SCOPES, statuses: API_KEY_STATUSES },
};