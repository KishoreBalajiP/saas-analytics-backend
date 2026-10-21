#!/usr/bin/env node
/**
 * Encrypt legacy plaintext secret settings (operator step, roadmap 2.4).
 *
 * WHY IT EXISTS
 *   Secret settings (`isSecret: true`, e.g. `email.smtp_password`) are now
 *   encrypted at rest: the AES-GCM envelope lives in `Setting.secret` and the
 *   plaintext `value` stays empty. Rows written before this change still
 *   hold the plaintext in `value`. They keep working (reads fall back to the
 *   plaintext), but should be encrypted once.
 *
 * USAGE
 *   npm run db:encrypt-setting-secrets              # dry run: count candidates
 *   npm run db:encrypt-setting-secrets -- --apply   # encrypt them
 *
 * SAFETY
 *   - Uses MONGODB_URI from the environment and never builds indexes.
 *   - Dry run by default: nothing is written without --apply.
 *   - Prints counts only; never prints a key's value.
 *   - Idempotent: encrypted rows are no longer candidates.
 *
 * AUDIT TRAIL (read-only report)
 *   Before secrets were encrypted, the Setting model's row-level audit
 *   recorded the plaintext `value` of secret rows. The script COUNTS such
 *   audit rows (it never changes them: the trail is append-only and any
 *   redaction is a governance decision for the audit owners).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run against the current Mongoose connection (exported for tests).
 *
 * @param {{ apply?: boolean, log?: (line: string) => void }} [opts]
 */
export async function run({ apply = false, log = console.log } = {}) {
  const { encryptLegacySecrets } = await import('../../src/services/setting.service.js');
  const summary = await encryptLegacySecrets({ dryRun: !apply });
  log(`${summary.candidates} plaintext secret setting(s) found, ${summary.encrypted} encrypted.`);
  const auditRows = await countPlaintextSecretAuditRows();
  if (auditRows > 0) {
    log(`${auditRows} audit row(s) recorded a secret setting value before encryption at rest (not modified; see the operator notes).`);
  }
  if (!apply) log('Dry run only. Re-run with --apply to encrypt.');
  return { ...summary, auditRows };
}

/**
 * Count row-level audit entries of secret settings that carry a non-empty
 * `value` (written before encryption at rest). Read-only.
 */
export async function countPlaintextSecretAuditRows() {
  const { AuditLog } = await import('../../src/models/AuditLog.js');
  const leaked = (side) => ({
    [`${side}.isSecret`]: true,
    [`${side}.value`]: { $nin: [null, '', '[REDACTED]'] },
  });
  return AuditLog.countDocuments({ module: 'platform.settings', $or: [leaked('after'), leaked('before')] });
}

async function main() {
  const apply = process.argv.slice(2).includes('--apply');
  const { connectDatabase, disconnectDatabase } = await import('../../src/config/database.js');
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  try {
    await run({ apply });
  } finally {
    await disconnectDatabase();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exitCode = 1;
  });
}
