import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTenant } from '../../src/middleware/tenant.middleware.js';

function invoke(req) {
  let error;
  resolveTenant(req, {}, (nextError) => {
    error = nextError;
  });
  return error;
}

test('resolveTenant allows an authenticated user selecting their own tenant', () => {
  const req = {
    headers: { 'x-tenant-id': 'tenant-a' },
    user: { tenantId: 'tenant-a' },
  };

  assert.equal(invoke(req), undefined);
  assert.deepEqual(req.tenant, { id: 'tenant-a', source: 'header' });
});

test('resolveTenant rejects an authenticated user selecting another tenant', () => {
  const error = invoke({
    headers: { 'x-tenant-id': 'tenant-b' },
    user: { tenantId: 'tenant-a' },
  });

  assert.equal(error?.statusCode, 403);
});

test('resolveTenant uses the verified user tenant when no header is supplied', () => {
  const req = { headers: {}, user: { tenantId: 'tenant-a' } };

  assert.equal(invoke(req), undefined);
  assert.deepEqual(req.tenant, { id: 'tenant-a', source: 'jwt' });
});

test('resolveTenant still accepts a tenant header for unauthenticated login flows', () => {
  const req = { headers: { 'x-tenant-id': 'tenant-a' } };

  assert.equal(invoke(req), undefined);
  assert.deepEqual(req.tenant, { id: 'tenant-a', source: 'header' });
});
