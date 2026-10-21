/**
 * Member index migration (roadmap 2.10; findings db.07, ten.12).
 *
 * WHY IT EXISTS
 *   Unique indexes used to include soft-deleted rows, so a removed member's
 *   email, a deleted role's name or a deleted catalogue key could never be
 *   used again. They are now PARTIAL on live rows (`deletedAt: null`). An
 *   existing deployment still has the old indexes under the same names, and
 *   `npm run db:indexes` never drops anything, so creating the new ones
 *   fails with IndexOptionsConflict. Likewise the old TTL index on
 *   `TenantInvitation.expiresAt` keeps deleting invitation history until it
 *   is dropped.
 *
 * WHAT IT DOES
 *   For each target index: compare what the database has with what the
 *   model declares, and report `ok`, `create`, `rebuild` (drop the old index
 *   of the same key, create the declared one) or `drop` (the TTL index).
 *   With `dryRun: false` it applies the plan. Rebuilding a unique index
 *   leaves a short window without the constraint; run it in a quiet period.
 *
 * SAFETY
 *   Dry run by default. Only the listed keys are touched. A unique build
 *   that fails on duplicates is reported per index and stops nothing else.
 */

import { User } from '../models/User.js';
import { Role } from '../models/Role.js';
import { UserRole } from '../models/UserRole.js';
import { Setting } from '../models/Setting.js';
import { FeatureFlag } from '../models/FeatureFlag.js';
import { Module } from '../models/Module.js';
import { Permission } from '../models/Permission.js';
import { TenantInvitation } from '../models/TenantInvitation.js';

/** Indexes made partial (rebuild when the stored definition differs). */
export const PARTIAL_UNIQUE_TARGETS = Object.freeze([
  { model: User, key: { tenantId: 1, email: 1 } },
  { model: User, key: { ssoProvider: 1, ssoSubject: 1 } },
  { model: Role, key: { tenantId: 1, name: 1 } },
  { model: UserRole, key: { tenantId: 1, userId: 1, roleId: 1, 'scope.resourceType': 1, 'scope.resourceId': 1 } },
  { model: Setting, key: { scope: 1, tenantId: 1, key: 1 } },
  { model: FeatureFlag, key: { key: 1 } },
  { model: Module, key: { key: 1 } },
  { model: Permission, key: { key: 1 } },
  { model: Permission, key: { module: 1, action: 1 } },
]);

/** Indexes that must no longer exist (invitation history must survive). */
export const DROP_TARGETS = Object.freeze([
  { model: TenantInvitation, key: { expiresAt: 1 }, onlyIf: (index) => index.expireAfterSeconds !== undefined },
]);

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function declaredOptions(model, key) {
  const found = model.schema.indexes().find(([fields]) => sameKey(fields, key));
  if (!found) throw new Error(`${model.modelName} does not declare an index on ${JSON.stringify(key)}`);
  const options = found[1] ?? {};
  const out = {};
  if (options.unique) out.unique = true;
  if (options.sparse) out.sparse = true;
  if (options.partialFilterExpression) out.partialFilterExpression = options.partialFilterExpression;
  return out;
}

function matchesDeclared(existing, declared) {
  if (Boolean(existing.unique) !== Boolean(declared.unique)) return false;
  if (Boolean(existing.sparse) !== Boolean(declared.sparse)) return false;
  if (existing.expireAfterSeconds !== undefined) return false;
  return JSON.stringify(existing.partialFilterExpression ?? null)
    === JSON.stringify(declared.partialFilterExpression ?? null);
}

async function existingIndexes(model) {
  try {
    return await model.collection.indexes();
  } catch (err) {
    if (err?.codeName === 'NamespaceNotFound' || err?.code === 26) return [];
    throw err;
  }
}

/**
 * Plan (and optionally apply) the member index changes.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.dryRun=true]
 * @returns {Promise<Array<{ model: string, key: Object, action: 'ok'|'create'|'rebuild'|'drop', index: string|null, applied: boolean, error: string|null }>>}
 */
export async function migrateMemberIndexes({ dryRun = true } = {}) {
  const report = [];

  for (const target of PARTIAL_UNIQUE_TARGETS) {
    const declared = declaredOptions(target.model, target.key);
    const existing = (await existingIndexes(target.model)).find((i) => sameKey(i.key, target.key)) ?? null;
    const action = !existing ? 'create' : (matchesDeclared(existing, declared) ? 'ok' : 'rebuild');
    const row = { model: target.model.modelName, key: target.key, action, index: existing?.name ?? null, applied: false, error: null };
    if (!dryRun && action !== 'ok') {
      try {
        if (action === 'rebuild') await target.model.collection.dropIndex(existing.name);
        await target.model.collection.createIndex(target.key, declared);
        row.applied = true;
      } catch (err) {
        row.error = err?.message ?? String(err);
      }
    }
    report.push(row);
  }

  for (const target of DROP_TARGETS) {
    const existing = (await existingIndexes(target.model)).find((i) => sameKey(i.key, target.key) && target.onlyIf(i)) ?? null;
    const row = { model: target.model.modelName, key: target.key, action: existing ? 'drop' : 'ok', index: existing?.name ?? null, applied: false, error: null };
    if (!dryRun && existing) {
      try {
        await target.model.collection.dropIndex(existing.name);
        row.applied = true;
      } catch (err) {
        row.error = err?.message ?? String(err);
      }
    }
    report.push(row);
  }

  return report;
}

export default { migrateMemberIndexes, PARTIAL_UNIQUE_TARGETS, DROP_TARGETS };
