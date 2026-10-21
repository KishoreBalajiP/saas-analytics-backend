#!/usr/bin/env node
/**
 * Audit hash-chain verification (operator step, roadmap 2.5; finding gov.13).
 *
 * WHY IT EXISTS
 *   Every audit row is sealed into a hash chain (`utils/auditChain.js`). This
 *   script walks the chain and reports any row that was edited, deleted or
 *   inserted around the application. It is READ-ONLY: it never writes, so
 *   run it with a read-only database user (or against a replica).
 *
 * USAGE
 *   node scripts/ci/verify-audit-chain.js
 *   node scripts/ci/verify-audit-chain.js --expect-head <seq>:<hash>
 *   node scripts/ci/verify-audit-chain.js --json
 *
 *   --expect-head  a head printed by an earlier run (store it outside the
 *                  database, e.g. in your monitoring system). The run fails
 *                  if that row is gone or changed, which is how truncation
 *                  of the newest rows is detected.
 *   --json         print the report as JSON (for schedulers / alerting).
 *
 *   Uses MONGODB_URI from the environment. Rows sealed with HMAC need
 *   AUDIT_CHAIN_KEY (and AUDIT_CHAIN_PREVIOUS_KEYS after a rotation) to be
 *   verified; without them they are reported as `unverifiable`.
 *
 * EXIT CODE
 *   0 = chain intact, 1 = broken chain or the run failed, 2 = bad arguments.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse `--expect-head <seq>:<hash>` and `--json`. */
export function parseArgs(argv = []) {
  const out = { json: argv.includes('--json'), expectHead: null, error: null };
  const index = argv.indexOf('--expect-head');
  if (index !== -1) {
    const value = argv[index + 1] ?? '';
    const match = /^(\d+):([0-9a-f]{64})$/i.exec(value);
    if (!match) out.error = '--expect-head must look like <seq>:<64 hex characters>';
    else out.expectHead = { seq: Number(match[1]), hash: match[2].toLowerCase() };
  }
  return out;
}

/** Human-readable summary lines for a report. */
export function formatReport(report) {
  const lines = [];
  lines.push(`checked ${report.checked} chained row(s), seq ${report.firstSeq ?? '-'}..${report.lastSeq ?? '-'}`);
  if (report.anchored) lines.push(`anchored at seq ${report.firstSeq} (older rows were purged by retention)`);
  if (report.legacyUnchained > 0) lines.push(`${report.legacyUnchained} legacy row(s) written before the chain existed`);
  if (report.unverifiable > 0) lines.push(`${report.unverifiable} HMAC row(s) unverifiable: configure AUDIT_CHAIN_KEY / AUDIT_CHAIN_PREVIOUS_KEYS`);
  if (report.head) lines.push(`head ${report.head.seq}:${report.head.hash}`);
  for (const error of report.errors) {
    lines.push(`ERROR ${error.type}${error.seq !== undefined ? ` seq=${error.seq}` : ''}${error.id ? ` id=${error.id}` : ''}${error.detail ? ` (${error.detail})` : ''}`);
  }
  if (report.errorCount > report.errors.length) lines.push(`... and ${report.errorCount - report.errors.length} more error(s)`);
  lines.push(report.ok ? 'audit chain OK' : `audit chain BROKEN (${report.errorCount} error(s))`);
  return lines;
}

/**
 * Verify against the current Mongoose connection. Exported so tests run it
 * against the in-memory server without connecting anywhere else.
 *
 * @param {Object} [opts]
 * @param {{ seq: number, hash: string }|null} [opts.expectHead]
 * @param {boolean} [opts.json=false]
 * @param {(line: string) => void} [opts.log=console.log]
 * @returns {Promise<Object>} the verification report.
 */
export async function run({ expectHead = null, json = false, log = console.log } = {}) {
  const { verifyAuditChain } = await import('../../src/services/auditChain.service.js');
  const report = await verifyAuditChain({ expectHead });
  if (json) log(JSON.stringify(report, null, 2));
  else for (const line of formatReport(report)) log(line);
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    process.exitCode = 2;
    return;
  }
  const { connectDatabase, disconnectDatabase } = await import('../../src/config/database.js');
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) {
    console.error('Could not connect to MongoDB (check MONGODB_URI).');
    process.exitCode = 1;
    return;
  }
  try {
    const report = await run({ expectHead: args.expectHead, json: args.json });
    if (!report.ok) process.exitCode = 1;
  } finally {
    await disconnectDatabase();
  }
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
