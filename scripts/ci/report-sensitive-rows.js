#!/usr/bin/env node
/**
 * Dry-run report: count ConnectorRows whose `data` still contains
 * credential-like keys (see src/utils/sensitiveFields.js), per tenant and
 * connector. READ-ONLY: nothing is modified, deleted or migrated. Rows
 * ingested before the ingestion sanitizer are already hidden at query time.
 *
 * USAGE  npm run db:report-sensitive-rows [-- --json]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Scan the current Mongoose connection. Exported for tests. */
export async function reportSensitiveRows({ batchSize = 500 } = {}) {
  const { ConnectorRow } = await import('../../src/models/ConnectorRow.js');
  const { sensitiveKeysIn } = await import('../../src/utils/sensitiveFields.js');
  const groups = new Map();
  let scanned = 0;
  const cursor = ConnectorRow.find({}, { tenantId: 1, connectorId: 1, data: 1 }).lean().cursor({ batchSize });
  for await (const row of cursor) {
    scanned += 1;
    const keys = sensitiveKeysIn(row.data);
    if (!keys.length) continue;
    const id = `${row.tenantId}:${row.connectorId}`;
    const g = groups.get(id) ?? { tenantId: String(row.tenantId), connectorId: String(row.connectorId), rows: 0, keys: {} };
    g.rows += 1;
    for (const k of keys) g.keys[k] = (g.keys[k] ?? 0) + 1;
    groups.set(id, g);
  }
  const results = [...groups.values()].sort((a, b) => b.rows - a.rows);
  return { dryRun: true, scanned, affectedRows: results.reduce((n, g) => n + g.rows, 0), groups: results };
}

async function main() {
  const { connectDatabase, disconnectDatabase } = await import('../../src/config/database.js');
  const connected = await connectDatabase({ autoIndex: false });
  if (!connected) { console.error('Could not connect to MongoDB (check MONGODB_URI).'); process.exitCode = 1; return; }
  try {
    const summary = await reportSensitiveRows();
    if (process.argv.includes('--json')) console.log(JSON.stringify(summary, null, 2));
    else {
      console.log(`[dry-run] scanned ${summary.scanned} rows; ${summary.affectedRows} contain sensitive keys`);
      for (const g of summary.groups) console.log(`  tenant=${g.tenantId} connector=${g.connectorId} rows=${g.rows} keys=${Object.keys(g.keys).join(',')}`);
    }
  } finally {
    await disconnectDatabase();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((err) => { console.error(err); process.exitCode = 1; });
