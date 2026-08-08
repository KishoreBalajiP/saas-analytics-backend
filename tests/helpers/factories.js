/**
 * Factory helpers - create model documents with sensible defaults.
 *
 * WHY IT EXISTS
 *   Tests need to spin up fixtures quickly. Centralising the factories in
 *   one module prevents copy-paste drift and makes refactors safe.
 *
 * USAGE
 *   ```js
 *   import { factories } from '../../tests/helpers/factories.js';
 *   const tenant = await factories.tenant.create();
 *   const user = await factories.user.create({ tenantId: tenant._id });
 *   ```
 *
 * DESIGN CONSTRAINTS
 *   - Each factory returns a freshly-saved document unless `save: false` is
 *     passed.
 *   - Override any field by passing it on the input object.
 *
 * HOW TO EXTEND
 *   Add a new factory by calling `defineFactory(modelName, defaults)`.
 */

import mongoose from 'mongoose';
import { hash } from '../../src/utils/password.js';
import { withPrefix, shortToken } from '../../src/utils/id.js';
// Register every model a factory can create. Mongoose throws
// "Schema hasn't been registered" if the schema module was never imported in
// the current process (each `node --test` file runs in its own process).
import '../../src/models/Tenant.js';
import '../../src/models/User.js';
import '../../src/models/Admin.js';
import '../../src/models/Role.js';
import '../../src/models/Permission.js';
import '../../src/models/Module.js';
import '../../src/models/Session.js';
import '../../src/models/Setting.js';
import '../../src/models/FeatureFlag.js';
import '../../src/models/AuditLog.js';

/**
 * Wrap a model with a factory: `factory.create({...})` returns a saved
 * document; `factory.build({...})` returns a plain object.
 *
 * `defaults` may be a plain object or an async function that returns one.
 * Async defaults are awaited on every call so the factory stays pure.
 *
 * @param {string} modelName - registered mongoose model name.
 * @param {Object|Function} defaults - default field values.
 * @returns {{ create: Function, build: Function }}
 */
function defineFactory(modelName, defaults) {
  async function resolveDefaults() {
    if (typeof defaults === 'function') return defaults();
    return defaults ?? {};
  }
  async function build(overrides = {}) {
    const Model = mongoose.model(modelName);
    const base = await resolveDefaults();
    return {
      ...base,
      ...overrides,
      _id: overrides._id ?? new mongoose.Types.ObjectId(),
    };
  }
  async function create(overrides = {}) {
    const Model = mongoose.model(modelName);
    const doc = new Model(await build(overrides));
    await doc.save();
    return doc;
  }
  return { create, build };
}

/**
 * Factories registered by name. Each is lazily bound to its model on first
 * use so the test helper does not force every model to load up-front.
 */
export const factories = Object.freeze({
  tenant: defineFactory('Tenant', () => ({
    name: 'Acme Inc.',
    slug: `acme-${shortToken(8).toLowerCase()}`,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  user: defineFactory('User', async () => ({
    tenantId: withPrefix('t'),
    email: `user-${shortToken(8).toLowerCase()}@example.com`,
    status: 'active',
    passwordHash: await hash('Password123!'),
    profile: { name: 'Test User' },
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  admin: defineFactory('Admin', async () => ({
    email: `admin-${shortToken(8).toLowerCase()}@example.com`,
    adminType: 'platform',
    status: 'active',
    passwordHash: await hash('Password123!'),
    profile: { name: 'Test Admin' },
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  role: defineFactory('Role', () => ({
    name: 'member',
    description: 'Default tenant member',
    isSystem: false,
    permissions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  permission: defineFactory('Permission', () => ({
    key: 'iam.users.view',
    description: 'View users',
    module: 'iam.users',
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  module: defineFactory('Module', () => ({
    key: 'iam.users',
    name: 'Users',
    description: 'Tenant user management',
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  session: defineFactory('Session', () => ({
    sessionId: withPrefix('ses'),
    actorId: new mongoose.Types.ObjectId().toString(),
    actorType: 'user',
    tenantId: null,
    refreshTokenHash: shortToken(32),
    ip: '127.0.0.1',
    userAgent: 'node-test',
    status: 'active',
    issuedAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    revokedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  setting: defineFactory('Setting', () => ({
    key: 'feature.dashboard.enabled',
    value: true,
    scope: 'platform',
    isSecret: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  featureFlag: defineFactory('FeatureFlag', () => ({
    key: `flag-${shortToken(8).toLowerCase()}`,
    name: 'Test flag',
    type: 'boolean',
    defaultValue: false,
    enabled: true,
    rollout: { strategy: 'all', tenantIds: [], percentage: 100, attributeRules: [] },
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
  auditLog: defineFactory('AuditLog', () => ({
    actorType: 'user',
    actorId: new mongoose.Types.ObjectId(),
    tenantId: withPrefix('t'),
    module: 'iam.users',
    action: 'create',
    resource: 'user',
    result: 'success',
    requestId: shortToken(16),
    createdAt: new Date(),
  })),
});

export default factories;
