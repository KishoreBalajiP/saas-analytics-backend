/**
 * Durable jobs (roadmap 1.4): two scheduler instances in two separate OS
 * processes, ticking the real report-schedule and alert-evaluation jobs at
 * the same moment against the same (in-memory) MongoDB.
 *
 * Exit criterion covered here: each due report and each due alert is
 * executed exactly once per tick - with the shared job lock, and with a lock
 * that always grants (lease lapse / split brain), where only the atomic
 * claims stand between the instances.
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMongo, stopMongo, resetMongo, getMongoUri } from '../helpers/mongo.js';
import { shortToken } from '../../src/utils/id.js';
import * as tenantService from '../../src/services/tenant.service.js';
import connectorRepository from '../../src/repositories/connector.repository.js';
import { ConnectorRow } from '../../src/models/ConnectorRow.js';
import { AlertEvent } from '../../src/models/AlertEvent.js';
import { Report } from '../../src/models/Report.js';
import { JobRun } from '../../src/models/JobRun.js';
import * as alertService from '../../src/services/alert.service.js';
import alertRepository from '../../src/repositories/alert.repository.js';
import * as reportService from '../../src/services/report.service.js';
import reportRepository from '../../src/repositories/report.repository.js';
import * as queueService from '../../src/services/queue.service.js';
// billing: tenants exercising paid features need a plan that includes them.
import { entitleTenant } from '../helpers/billing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const PASSWORD = 'Password123!';
const PAST = () => new Date(Date.now() - 120000);

before(async () => { await startMongo(); });
beforeEach(async () => { await resetMongo(); });
after(async () => {
  await queueService.closeAll();
  await stopMongo();
});

async function seedDueWork({ reports = 3, alerts = 3 } = {}) {
  const owner = { email: `owner-${shortToken(10).toLowerCase()}@example.com`, name: 'Owner', password: PASSWORD };
  const { tenant } = await tenantService.create({ tenant: { name: `Multi ${shortToken(10)}` }, owner, initialize: true, by: 'root' });
  await entitleTenant(tenant._id);
  const tenantId = String(tenant._id);
  const ownerId = tenant.ownerUserId?.toString?.() || null;
  const connector = await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active', createdBy: 'u1' });
  await ConnectorRow.insertMany([
    { tenantId, connectorId: connector._id, sourceRowId: 'r1', data: { amount: 100 }, ingestedAt: new Date('2024-01-02') },
    { tenantId, connectorId: connector._id, sourceRowId: 'r2', data: { amount: 200 }, ingestedAt: new Date('2024-01-03') },
  ]);
  const datasetId = String(connector._id);
  const reportIds = [];
  for (let i = 0; i < reports; i += 1) {
    const report = await reportService.create({
      tenantId, actorId: ownerId, name: `Scheduled ${i}`, source: 'query', format: 'csv',
      query: { datasetId }, schedule: { enabled: true, cron: '0 * * * *' },
    });
    await reportRepository.update(report._id, { nextRunAt: PAST() });
    reportIds.push(String(report._id));
  }
  const alertIds = [];
  for (let i = 0; i < alerts; i += 1) {
    const rule = await alertService.createRule({
      tenantId, actorId: ownerId, name: `Rule ${i}`, source: 'query',
      query: { datasetId }, metric: 'count', condition: 'gt', threshold: 1,
      cooldownMinutes: 0, schedule: { cron: '*/5 * * * *' }, enabled: true,
    });
    await alertRepository.updateRule(rule._id, { nextEvaluationAt: PAST() });
    alertIds.push(String(rule._id));
  }
  return { reportIds, alertIds };
}

/** Start one scheduler instance process; resolves once it is ready. */
function startInstance(name, { lockMode, tickAt }) {
  const child = spawn(process.execPath, [path.join(here, 'helpers', 'scheduler-instance.js')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      TEST_MONGO_URI: getMongoUri(),
      // Defensive: anything that resolved the app's own URI gets the test server too.
      MONGODB_URI: getMongoUri(),
      REDIS_URL: '',
      MAIL_PROVIDER: 'none',
      LOG_LEVEL: 'error',
      INSTANCE_NAME: name,
      LOCK_MODE: lockMode,
      TICK_AT: String(tickAt.getTime()),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const lines = readline.createInterface({ input: child.stdout });
  const queue = [];
  const waiters = [];
  lines.on('line', (line) => {
    if (!line.trim().startsWith('ready') && !line.trim().startsWith('[')) return; // ignore log lines
    if (waiters.length) waiters.shift()(line.trim());
    else queue.push(line.trim());
  });
  const nextLine = (timeoutMs = 30000) => new Promise((resolve, reject) => {
    if (queue.length) { resolve(queue.shift()); return; }
    const timer = setTimeout(() => reject(new Error(`${name}: no output in time. stderr: ${stderr}`)), timeoutMs);
    waiters.push((line) => { clearTimeout(timer); resolve(line); });
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, nextLine, exited, stderr: () => stderr };
}

async function runTwoInstances({ lockMode }) {
  const tickAt = new Date();
  const a = startInstance('process-a', { lockMode, tickAt });
  const b = startInstance('process-b', { lockMode, tickAt });
  try {
    assert.equal(await a.nextLine(), 'ready', a.stderr());
    assert.equal(await b.nextLine(), 'ready', b.stderr());
    // Release both at once.
    a.child.stdin.write('go\n');
    b.child.stdin.write('go\n');
    const [outA, outB] = await Promise.all([a.nextLine(), b.nextLine()]);
    const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
    assert.equal(codeA, 0, a.stderr());
    assert.equal(codeB, 0, b.stderr());
    return { a: JSON.parse(outA), b: JSON.parse(outB) };
  } finally {
    for (const p of [a, b]) if (p.child.exitCode === null) p.child.kill('SIGKILL');
  }
}

async function assertExactlyOnce({ reportIds, alertIds }) {
  for (const id of reportIds) {
    const doc = await Report.findById(id).lean();
    assert.equal(doc.runs.length, 1, `report ${id} ran exactly once`);
    assert.ok(doc.nextRunAt > new Date(), 'the schedule advanced');
    assert.equal(doc.lockedBy, null, 'claim released');
  }
  for (const id of alertIds) {
    assert.equal(await AlertEvent.countDocuments({ alertId: id }), 1, `alert ${id} fired exactly once`);
  }
}

test('two scheduler processes with the shared job lock: one runs each job, each item runs once', async () => {
  const work = await seedDueWork();
  const { a, b } = await runTwoInstances({ lockMode: 'real' });
  // Per job (report-schedule, alert-evaluation): one process ran it, the other was locked out.
  for (const index of [0, 1]) {
    const statuses = [a[index].status, b[index].status].sort();
    assert.deepEqual(statuses, ['skipped', 'succeeded'], JSON.stringify({ a, b }));
  }
  await assertExactlyOnce(work);
  assert.equal(await JobRun.countDocuments({ job: 'report-schedule' }), 1);
  assert.equal(await JobRun.countDocuments({ job: 'alert-evaluation' }), 1);
});

test('two scheduler processes with a lapsed lock: the atomic claims alone keep each item to one run', async () => {
  const work = await seedDueWork();
  const { a, b } = await runTwoInstances({ lockMode: 'open' });
  for (const index of [0, 1]) {
    assert.equal(a[index].status, 'succeeded', JSON.stringify(a));
    assert.equal(b[index].status, 'succeeded', JSON.stringify(b));
  }
  // Both processes scanned; together they claimed every item exactly once.
  assert.equal((a[0].counts?.claimed ?? 0) + (b[0].counts?.claimed ?? 0), work.reportIds.length, JSON.stringify({ a, b }));
  assert.equal((a[1].counts?.claimed ?? 0) + (b[1].counts?.claimed ?? 0), work.alertIds.length, JSON.stringify({ a, b }));
  await assertExactlyOnce(work);
  assert.equal(await JobRun.countDocuments({ job: 'report-schedule' }), 2, 'both processes ran the scan');
});
