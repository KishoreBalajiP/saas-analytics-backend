import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMongo, stopMongo, resetMongo } from './helpers/mongo.js';
import adminBootstrapService from '../src/services/adminBootstrap.service.js';
import adminRepository from '../src/repositories/admin.repository.js';
import { verify } from '../src/utils/password.js';
import { AdminRole } from '../src/models/AdminRole.js';
import { RolePermission } from '../src/models/RolePermission.js';

before(async () => startMongo());
beforeEach(async () => resetMongo());
after(async () => stopMongo());

test('bootstrap hashes the password and assigns the platform role', async () => {
  const result = await adminBootstrapService.bootstrapAdmin({
    email: 'root@example.com',
    password: 'BootstrapPassword123!',
    adminType: 'super',
  });
  assert.equal(result.created, true);
  assert.equal(result.admin.adminType, 'super');
  assert.equal(result.admin.passwordHash, undefined);

  const admin = await adminRepository.findByEmail('root@example.com');
  assert.equal(await verify('BootstrapPassword123!', admin.passwordHash), true);
  const grant = await AdminRole.findOne({ adminId: admin._id.toString(), tenantId: null }).lean();
  assert.ok(grant);
  assert.equal(result.role.name, 'super');
  assert.ok(await RolePermission.countDocuments({ roleId: grant.roleId }) > 0);
});

test('bootstrap is idempotent and never overwrites an existing administrator', async () => {
  const first = await adminBootstrapService.bootstrapAdmin({
    email: 'root@example.com',
    password: 'BootstrapPassword123!',
    adminType: 'super',
  });
  const second = await adminBootstrapService.bootstrapAdmin({
    email: 'ROOT@example.com',
    password: 'DifferentPassword456!',
    adminType: 'platform',
  });
  assert.equal(second.created, false);
  assert.equal(second.admin._id.toString(), first.admin._id.toString());
  const admin = await adminRepository.findByEmail('root@example.com');
  assert.equal(await verify('BootstrapPassword123!', admin.passwordHash), true);
  assert.equal(await verify('DifferentPassword456!', admin.passwordHash), false);
  assert.equal(await AdminRole.countDocuments({ adminId: admin._id.toString() }), 1);
});

test('bootstrap validates the documented admin types', async () => {
  await assert.rejects(
    () => adminBootstrapService.bootstrapAdmin({ email: 'x@example.com', password: 'Password123!', adminType: 'super_admin' }),
    /adminType must be one of super, platform, support/,
  );
});
