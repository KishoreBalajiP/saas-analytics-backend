#!/usr/bin/env node
/**
 * Restore drill (operator step, roadmap 2.9).
 *
 * WHY IT EXISTS
 *   A backup nobody has restored is a hope, not a backup. The quarterly
 *   drill restores a tenant export archive into a SCRATCH database, proves
 *   the restored data matches the archive manifest (counts and content
 *   checksums per collection, dataset row counts), and writes an evidence
 *   report (JSON + Markdown) with timings for the RTO record. See
 *   `src/docs/development/runbooks/backup-and-restore.md`.
 *
 * USAGE
 *   npm run db:restore-drill -- --source <archive.tar.gz|dir> --target <mongodb-uri> [options]
 *
 *   --source <path>           export archive (.tar.gz) or an extracted directory (required)
 *   --target <uri>            scratch database URI, explicit database name (required;
 *                             never read from MONGODB_URI)
 *   --mode clone|preserve     clone (default): new ids, tenant created disabled;
 *                             preserve: original ids, target must not hold the tenant
 *   --expect-sha256 <hex>     refuse an archive whose SHA-256 differs (from the export record)
 *   --report-dir <dir>        where the evidence report is written (default ./restore-drill-reports)
 *   --operator <name>         recorded in the report
 *   --keep                    keep the restored data (default: kept; see --cleanup)
 *   --cleanup                 remove the restored tenant from the target after verifying
 *   --allow-unsafe-target     run against a target that looks like the default,
 *                             the application or a production database
 *
 * SAFETY
 *   - The target is ONLY taken from --target and is opened on its own
 *     connection; the application's MONGODB_URI is never used.
 *   - Refuses, unless --allow-unsafe-target is given: the default local URI
 *     (127.0.0.1:27017/saas_analytics), the configured MONGODB_URI, any
 *     mongodb+srv:// or *.mongodb.net host (Atlas), and database names that
 *     look like production (prod, production, live, main, saas_analytics).
 *   - Always refuses a URI without a database name.
 *   - The archive is untrusted: manifest, file checksums and record
 *     ownership are verified before anything is written.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_URI = 'mongodb://127.0.0.1:27017/saas_analytics';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);
const PRODUCTION_DB = /(^|[_.-])(prod|production|live|main|master)([_.-]|$)/i;
const PRODUCTION_HOST = /(\.mongodb\.net|\.mongodb\.com)$/i;

/** Parse CLI flags. */
export function parseArgs(argv = []) {
  const out = {
    source: null,
    target: null,
    mode: 'clone',
    expectSha256: null,
    reportDir: 'restore-drill-reports',
    operator: null,
    cleanup: false,
    allowUnsafeTarget: false,
  };
  const valueOf = (i) => (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? String(argv[i + 1]) : null);
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--source': out.source = valueOf(i); i += 1; break;
      case '--target': out.target = valueOf(i); i += 1; break;
      case '--mode': out.mode = valueOf(i); i += 1; break;
      case '--expect-sha256': out.expectSha256 = valueOf(i)?.toLowerCase() ?? null; i += 1; break;
      case '--report-dir': out.reportDir = valueOf(i); i += 1; break;
      case '--operator': out.operator = valueOf(i); i += 1; break;
      case '--cleanup': out.cleanup = true; break;
      case '--keep': out.cleanup = false; break;
      case '--allow-unsafe-target': out.allowUnsafeTarget = true; break;
      default:
        throw new Error(`Unknown option "${flag}"`);
    }
  }
  return out;
}

/**
 * Parse a MongoDB connection string far enough to judge it (hosts and
 * database name). Credentials are dropped.
 *
 * @param {string} uri
 * @returns {{ scheme: string, hosts: Array<{ host: string, port: number }>, database: string|null }}
 */
export function parseMongoUri(uri) {
  const match = /^(mongodb(?:\+srv)?):\/\/([^/?#]*)(?:\/([^?#]*))?/i.exec(String(uri ?? '').trim());
  if (!match) throw new Error('The target must be a mongodb:// or mongodb+srv:// connection string');
  const scheme = match[1].toLowerCase();
  const authority = match[2].includes('@') ? match[2].slice(match[2].lastIndexOf('@') + 1) : match[2];
  const hosts = authority.split(',').filter(Boolean).map((entry) => {
    const ipv6 = /^(\[[^\]]+\])(?::(\d+))?$/.exec(entry);
    if (ipv6) return { host: ipv6[1].toLowerCase(), port: ipv6[2] ? Number(ipv6[2]) : 27017 };
    const [host, port] = entry.split(':');
    return { host: host.toLowerCase(), port: port ? Number(port) : 27017 };
  });
  if (hosts.length === 0) throw new Error('The target URI names no host');
  const database = match[3] ? decodeURIComponent(match[3]) : null;
  return { scheme, hosts, database: database || null };
}

/** The target URI without credentials or options (safe for reports and logs). */
export function redactUri(uri) {
  try {
    const { scheme, hosts, database } = parseMongoUri(uri);
    return `${scheme}://${hosts.map((h) => `${h.host}:${h.port}`).join(',')}/${database ?? ''}`;
  } catch {
    return '(unparseable)';
  }
}

function sameDatabase(a, b) {
  if (!a || !b) return false;
  if (a.database !== b.database) return false;
  const key = (h) => `${LOCAL_HOSTS.has(h.host) ? 'localhost' : h.host}:${h.port}`;
  const aHosts = new Set(a.hosts.map(key));
  return b.hosts.some((h) => aHosts.has(key(h)));
}

/**
 * Judge a restore target.
 *
 * @param {string} uri
 * @param {Object} [options]
 * @param {string|null} [options.appUri] - the application's MONGODB_URI.
 * @returns {{ ok: boolean, blocking: Array<{ code: string, message: string }>, unsafe: Array<{ code: string, message: string }> }}
 *   `blocking` problems can never be overridden; `unsafe` ones need --allow-unsafe-target.
 */
export function assessTarget(uri, { appUri = null } = {}) {
  const blocking = [];
  const unsafe = [];
  let parsed;
  try {
    parsed = parseMongoUri(uri);
  } catch (err) {
    blocking.push({ code: 'TARGET_INVALID', message: err.message });
    return { ok: false, blocking, unsafe };
  }
  if (!parsed.database) {
    blocking.push({ code: 'TARGET_DATABASE_MISSING', message: 'Name the scratch database explicitly in the URI (mongodb://host:port/<scratch-db>)' });
  }
  const isDefaultHost = parsed.hosts.some((h) => LOCAL_HOSTS.has(h.host) && h.port === 27017);
  if (sameDatabase(parsed, parseMongoUri(DEFAULT_URI)) || (isDefaultHost && parsed.database === 'saas_analytics')) {
    unsafe.push({ code: 'TARGET_IS_DEFAULT', message: 'The target is the default application database (127.0.0.1:27017/saas_analytics)' });
  }
  if (appUri) {
    let app = null;
    try { app = parseMongoUri(appUri); } catch { app = null; }
    if (sameDatabase(parsed, app)) unsafe.push({ code: 'TARGET_IS_APP_DATABASE', message: 'The target is the database configured in MONGODB_URI' });
  }
  if (parsed.scheme === 'mongodb+srv') unsafe.push({ code: 'TARGET_LOOKS_PRODUCTION', message: 'mongodb+srv:// targets are hosted clusters (Atlas)' });
  if (parsed.hosts.some((h) => PRODUCTION_HOST.test(h.host))) unsafe.push({ code: 'TARGET_LOOKS_PRODUCTION', message: 'The target host is a hosted MongoDB cluster' });
  if (parsed.database && (PRODUCTION_DB.test(parsed.database) || parsed.database === 'saas_analytics')) {
    unsafe.push({ code: 'TARGET_LOOKS_PRODUCTION', message: `The database name "${parsed.database}" looks like a production database` });
  }
  return { ok: blocking.length === 0 && unsafe.length === 0, blocking, unsafe };
}

function markdownReport(report) {
  const lines = [
    `# Restore drill evidence - ${report.startedAt}`,
    '',
    `- Result: **${report.result.toUpperCase()}**`,
    `- Operator: ${report.operator ?? '(not recorded)'}`,
    `- Source archive: ${report.source.path}${report.source.sha256 ? ` (sha256 ${report.source.sha256})` : ''}`,
    `- Export: ${report.manifest?.exportId ?? '-'} of workspace ${report.manifest?.tenantId ?? '-'} created ${report.manifest?.createdAt ?? '-'}`,
    `- Target: ${report.target.uri} (mode ${report.mode})`,
    `- Restored workspace id: ${report.restoredTenantId ?? '-'}`,
    `- Timings (ms): open ${report.timings.openMs ?? '-'}, verify archive ${report.timings.verifyArchiveMs ?? '-'}, import ${report.timings.importMs ?? '-'}, verify restore ${report.timings.verifyRestoreMs ?? '-'}, total ${report.timings.totalMs ?? '-'}`,
    '',
  ];
  if (report.errors.length > 0) {
    lines.push('## Errors', '', ...report.errors.map((e) => `- ${e.code}: ${e.message}`), '');
  }
  if (report.archive) {
    const bad = report.archive.files.filter((f) => !f.ok);
    lines.push('## Archive integrity', '', `- Files checked: ${report.archive.files.length}, mismatched: ${bad.length}, unexpected: ${report.archive.unexpected.length}`, '');
  }
  if (report.verification) {
    lines.push('## Collections', '', '| Collection | Expected | Restored | Checksum |', '|---|---:|---:|---|');
    for (const c of report.verification.collections) {
      lines.push(`| ${c.collection} | ${c.expected.count} | ${c.actual.count} | ${c.ok ? 'match' : 'MISMATCH'} |`);
    }
    lines.push('');
    if (report.verification.datasets.length > 0) {
      lines.push('## Datasets', '', '| Connector | Expected rows | Restored rows | Result |', '|---|---:|---:|---|');
      for (const d of report.verification.datasets) lines.push(`| ${d.connectorId} | ${d.expectedRows} | ${d.actualRows} | ${d.ok ? 'match' : 'MISMATCH'} |`);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Run the drill. Exported so tests run it against mongodb-memory-server.
 *
 * @param {Object} opts - parsed CLI options (see parseArgs).
 * @param {string|null} [opts.appUri] - application MONGODB_URI (refused as a target).
 * @param {(line: string) => void} [opts.log=console.log]
 * @returns {Promise<Object>} the report (also written to disk unless refused).
 */
export async function run({
  source,
  target,
  mode = 'clone',
  expectSha256 = null,
  reportDir = 'restore-drill-reports',
  operator = null,
  cleanup = false,
  allowUnsafeTarget = false,
  appUri = null,
  log = console.log,
} = {}) {
  const startedAt = new Date();
  const report = {
    tool: 'restore-drill',
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    result: 'failed',
    operator,
    mode,
    source: { path: source ? path.resolve(source) : null, sha256: null, bytes: null },
    target: { uri: target ? redactUri(target) : null },
    manifest: null,
    restoredTenantId: null,
    archive: null,
    verification: null,
    cleanedUp: false,
    timings: {},
    errors: [],
    reportFiles: [],
  };

  if (!source || !target) {
    report.result = 'refused';
    report.errors.push({ code: 'ARGUMENTS_MISSING', message: '--source and --target are required' });
    log('refused: --source and --target are required');
    return report;
  }
  if (!['clone', 'preserve'].includes(mode)) {
    report.result = 'refused';
    report.errors.push({ code: 'MODE_INVALID', message: '--mode must be clone or preserve' });
    log('refused: --mode must be clone or preserve');
    return report;
  }
  const assessment = assessTarget(target, { appUri });
  if (assessment.blocking.length > 0 || (assessment.unsafe.length > 0 && !allowUnsafeTarget)) {
    report.result = 'refused';
    report.errors.push(...assessment.blocking, ...(allowUnsafeTarget ? [] : assessment.unsafe));
    for (const problem of report.errors) log(`refused: ${problem.message}`);
    if (assessment.unsafe.length > 0 && assessment.blocking.length === 0) {
      log('Pass --allow-unsafe-target only if you are certain this is not a production database.');
    }
    return report;
  }
  if (assessment.unsafe.length > 0) {
    for (const problem of assessment.unsafe) log(`warning (overridden by --allow-unsafe-target): ${problem.message}`);
  }

  const { default: mongoose } = await import('mongoose');
  const importService = await import('../../src/services/tenantImport.service.js');

  let opened = null;
  let connection = null;
  let result = null;
  try {
    let t = Date.now();
    opened = await importService.openArchive({ source });
    report.timings.openMs = Date.now() - t;
    report.source.sha256 = opened.archive.sha256;
    report.source.bytes = opened.archive.bytes;
    report.manifest = {
      exportId: opened.manifest.exportId,
      tenantId: opened.manifest.tenant.id,
      createdAt: opened.manifest.createdAt ?? null,
      collections: opened.manifest.collections.length,
      datasets: (opened.manifest.datasets ?? []).length,
    };
    if (expectSha256 && opened.archive.sha256 && opened.archive.sha256 !== expectSha256) {
      throw Object.assign(new Error('The archive SHA-256 differs from --expect-sha256'), { code: 'ARCHIVE_SHA256_MISMATCH' });
    }
    log(`archive ${opened.manifest.exportId}: ${report.manifest.collections} collections, ${report.manifest.datasets} datasets`);

    t = Date.now();
    report.archive = await importService.verifyArchive({ dir: opened.dir, manifest: opened.manifest });
    report.timings.verifyArchiveMs = Date.now() - t;
    if (!report.archive.ok) {
      throw Object.assign(new Error('Archive files do not match the manifest checksums'), { code: 'ARCHIVE_CHECKSUM_MISMATCH' });
    }
    log('archive checksums verified');

    connection = mongoose.createConnection(target, { autoIndex: true, serverSelectionTimeoutMS: 10000 });
    await connection.asPromise();

    t = Date.now();
    result = await importService.importTenant({
      dir: opened.dir,
      manifest: opened.manifest,
      connection,
      mode,
      buildIndexes: true,
    });
    report.timings.importMs = Date.now() - t;
    report.restoredTenantId = result.tenantId;
    log(`restored workspace ${result.tenantId} (${mode})`);

    t = Date.now();
    report.verification = await importService.verifyImport({ manifest: opened.manifest, result, connection });
    report.timings.verifyRestoreMs = Date.now() - t;
    for (const c of report.verification.collections) {
      log(`${c.ok ? 'ok      ' : 'MISMATCH'} ${c.collection}: ${c.actual.count}/${c.expected.count}`);
    }
    report.result = report.verification.ok ? 'passed' : 'failed';
    if (!report.verification.ok) report.errors.push({ code: 'RESTORE_MISMATCH', message: 'Restored data does not match the manifest' });

    if (cleanup) {
      await importService.rollbackImport({ connection, result });
      report.cleanedUp = true;
      log('restored workspace removed from the target (--cleanup)');
    }
  } catch (err) {
    report.result = 'failed';
    report.errors.push({ code: err?.code && /^[A-Z][A-Z0-9_]+$/.test(String(err.code)) ? err.code : 'DRILL_FAILED', message: String(err?.message ?? err).split('\n')[0] });
    log(`failed: ${String(err?.message ?? err).split('\n')[0]}`);
  } finally {
    if (connection) await connection.close().catch(() => null);
    if (opened) await opened.cleanup().catch(() => null);
  }

  const finishedAt = new Date();
  report.finishedAt = finishedAt.toISOString();
  report.timings.totalMs = finishedAt.getTime() - startedAt.getTime();

  if (reportDir) {
    await fsp.mkdir(reportDir, { recursive: true });
    const stamp = report.startedAt.replace(/[:.]/g, '-');
    const jsonFile = path.join(reportDir, `restore-drill-${stamp}.json`);
    const mdFile = path.join(reportDir, `restore-drill-${stamp}.md`);
    report.reportFiles = [path.resolve(jsonFile), path.resolve(mdFile)];
    await fsp.writeFile(jsonFile, `${JSON.stringify(report, null, 2)}\n`);
    await fsp.writeFile(mdFile, markdownReport(report));
    log(`evidence written to ${mdFile}`);
  }
  log(`restore drill ${report.result.toUpperCase()}`);
  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  // The application's configured database (MONGODB_URI, .env included) is
  // only read to REFUSE it as a target; the drill never connects to it.
  const { default: env } = await import('../../src/config/env.js');
  const report = await run({ ...options, appUri: env.database.uri ?? null });
  process.exitCode = report.result === 'passed' ? 0 : report.result === 'refused' ? 2 : 1;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
