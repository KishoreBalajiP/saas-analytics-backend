/**
 * Service-level helpers for the backups tests: build a real export archive
 * for a tenant without going through HTTP, and copy it to a local file.
 */

import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import mongoose from 'mongoose';
import { shortToken, ulid } from '../../src/utils/id.js';
import * as tenantService from '../../src/services/tenant.service.js';
import * as storageService from '../../src/services/storage.service.js';
import tenantExportService from '../../src/services/tenantExport.service.js';
import tenantExportRepository from '../../src/repositories/tenantExport.repository.js';
import { TenantExport } from '../../src/models/TenantExport.js';
import { seedTenantData, PASSWORD } from './fixtures.js';

/** A fresh, valid export id (`tex_` + 26 lowercase ULID characters). */
export function nextExportId() {
  return `tex_${ulid().toLowerCase()}`;
}

/** Create + initialise a tenant (no HTTP) and seed every exported collection. */
export async function seededTenant(tag) {
  const { tenant, owner } = await tenantService.create({
    tenant: { name: `Restore ${tag} ${shortToken(8)}` },
    owner: { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD },
    initialize: true,
    by: 'root',
  });
  const tenantId = tenant._id.toString();
  const ids = await seedTenantData(tenantId, { ownerId: String(owner._id), tag });
  return { tenantId, ownerId: String(owner._id), ids };
}

/** Build an export archive for a tenant and copy it to `dir`. */
export async function exportToFile(tenantId, dir) {
  const exportId = nextExportId();
  await tenantExportRepository.create({
    exportId,
    tenantId,
    origin: 'platform',
    requestedBy: { type: 'admin', id: 'test-admin' },
    leaseUntil: new Date(Date.now() + 60000),
  });
  const result = await tenantExportService.processExport({ exportId });
  if (result.status !== 'completed') throw new Error(`export failed: ${JSON.stringify(result.error)}`);
  const row = await TenantExport.findOne({ exportId }).lean();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, row.fileName);
  await pipeline(await storageService.createReadStream(row.storageKey), fs.createWriteStream(file));
  return { file, row };
}

/** Count every document carrying `tenantId` across the exported collections. */
export async function countTenantDocuments(tenantId, models) {
  const out = {};
  for (const model of models) {
    const collection = mongoose.model(model).collection;
    out[model] = model === 'Tenant'
      ? await collection.countDocuments({ _id: new mongoose.Types.ObjectId(tenantId) })
      : await collection.countDocuments({ tenantId });
  }
  return out;
}

export default { nextExportId, seededTenant, exportToFile, countTenantDocuments };
