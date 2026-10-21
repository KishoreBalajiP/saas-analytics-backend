/**
 * One scheduler instance, run as a separate OS process by
 * `tests/jobs/scheduler-multiprocess.integration.test.js`.
 *
 * It connects to the test's in-memory MongoDB (never the default URI),
 * prints `ready`, waits for `go` on stdin (so both instances start together),
 * runs one tick of the real `report-schedule` and `alert-evaluation` jobs
 * through `runJob` and prints the outcomes as one JSON line.
 *
 * Env:
 *   TEST_MONGO_URI  in-memory MongoDB URI (required; must not be :27017)
 *   INSTANCE_NAME   instance id recorded on job runs and claims
 *   LOCK_MODE       'real' (shared MongoDB job lock) | 'open' (always granted,
 *                   so only the atomic claims stand between the instances)
 *   TICK_AT         scheduled tick time (epoch ms) shared by both instances
 */

import mongoose from 'mongoose';
import readline from 'node:readline';

const uri = process.env.TEST_MONGO_URI ?? '';
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || /:27017\//.test(uri)) {
  process.stderr.write('scheduler-instance: TEST_MONGO_URI must be the in-memory test server\n');
  process.exit(2);
}

await mongoose.connect(uri);
const { runJob } = await import('../../../src/jobs/scheduler.js');
const { default: reportScheduleJob } = await import('../../../src/jobs/reportSchedule.job.js');
const { default: alertEvalJob } = await import('../../../src/jobs/alertEval.job.js');
const queueService = await import('../../../src/services/queue.service.js');

const instanceId = process.env.INSTANCE_NAME ?? `instance-${process.pid}`;
const tickAt = new Date(Number(process.env.TICK_AT) || Date.now());
const openLock = { acquire: async () => 'token', renew: async () => true, release: async () => true };
const lockOption = process.env.LOCK_MODE === 'open' ? { lock: openLock } : {};

process.stdout.write('ready\n');
const rl = readline.createInterface({ input: process.stdin });
await new Promise((resolve) => rl.once('line', resolve));
rl.close();

const outcomes = await Promise.all([
  runJob(reportScheduleJob, { instanceId, tickAt, ...lockOption }),
  runJob(alertEvalJob, { instanceId, tickAt, ...lockOption }),
]);
process.stdout.write(`${JSON.stringify(outcomes.map((o) => ({ status: o.status, reason: o.reason ?? null, counts: o.counts ?? null })))}\n`);

await queueService.closeAll();
await mongoose.disconnect();
process.exit(0);
