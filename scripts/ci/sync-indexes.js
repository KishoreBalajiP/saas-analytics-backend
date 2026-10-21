#!/usr/bin/env node
/**
 * Index provisioning for MongoDB (deploy step).
 *
 * WHY IT EXISTS
 *   `config/database.js` disables `autoIndex` in production, so the unique
 *   and TTL indexes the models declare (tenant slug, {tenantId,email},
 *   session/token hashes, webhook event ids, usage counters, TTL cleanup)
 *   only exist if something creates them. This script is that something.
 *
 * USAGE
 *   npm run db:indexes                 # dry run: report missing / extra indexes
 *   npm run db:indexes -- --apply      # create missing indexes (never drops)
 *
 * SAFETY
 *   - Uses MONGODB_URI from the environment (same loader as the app).
 *   - Never drops an index: extra indexes are only reported, because they
 *     may have been created by hand on purpose.
 *   - Creating a UNIQUE index fails if duplicates already exist; the error is
 *     reported per model so the duplicates can be resolved first.
 */

import mongoose from 'mongoose';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';

const apply = process.argv.includes('--apply');
const here = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.resolve(here, '../../src/models');

async function loadModels() {
  const files = (await readdir(modelsDir)).filter((f) => f.endsWith('.js'));
  for (const file of files) await import(pathToFileURL(path.join(modelsDir, file)).href);
  return mongoose.modelNames().sort();
}

/**
 * Mongoose reports a missing index either as its key object or as a
 * `[keys, options]` pair. Show the keys plus the options that matter when
 * reviewing the diff (unique builds fail on existing duplicates).
 */
function describeIndex(entry, declared) {
  const [keys, reported] = Array.isArray(entry) ? entry : [entry];
  const options = reported ?? declared.get(JSON.stringify(keys)) ?? {};
  const flags = [
    options.unique && 'unique',
    options.sparse && 'sparse',
    options.partialFilterExpression && 'partial',
    options.expireAfterSeconds !== undefined && `ttl=${options.expireAfterSeconds}s`,
  ].filter(Boolean);
  return JSON.stringify(keys) + (flags.length ? ` (${flags.join(', ')})` : '');
}

async function main() {
  const names = await loadModels();
  // Never let Mongoose auto-build indexes on connect: only --apply creates.
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  let failures = 0;
  for (const name of names) {
    const model = mongoose.model(name);
    try {
      const { toCreate, toDrop } = await model.diffIndexes();
      const declared = new Map(
        model.schema.indexes().map(([keys, options]) => [JSON.stringify(keys), options ?? {}]),
      );
      const create = toCreate.map((entry) => describeIndex(entry, declared));
      const extra = toDrop.map((i) => (typeof i === 'string' ? i : JSON.stringify(i)));
      if (!create.length && !extra.length) {
        console.log(`ok       ${name}`);
        continue;
      }
      if (create.length) console.log(`missing  ${name}: ${create.join(', ')}`);
      if (extra.length) console.log(`extra    ${name}: ${extra.join(', ')} (not dropped)`);
      if (apply && create.length) {
        await model.createIndexes();
        console.log(`created  ${name}`);
      }
    } catch (err) {
      failures += 1;
      console.error(`error    ${name}: ${err.message}`);
    }
  }
  if (!apply) console.log('\nDry run only. Re-run with --apply to create missing indexes.');
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase());
