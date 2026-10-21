/**
 * The artefact row safety cap (roadmap 1.5): ARTIFACT_MAX_ROWS is a hard,
 * configurable limit. A result with MORE rows than the cap produces a file
 * with exactly `cap` rows and `truncated: true` (with `rowLimit`); a result
 * of exactly `cap` rows is complete and not truncated.
 *
 * Runs in its own process with ARTIFACT_MAX_ROWS=1000 (set before the app
 * modules load).
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.ARTIFACT_MAX_ROWS = '1000';

const { default: mongoose } = await import('mongoose');
const { default: ExcelJS } = await import('exceljs');
const { parse: parseCsv } = await import('csv-parse/sync');
const { startMongo, stopMongo, resetMongo } = await import('../helpers/mongo.js');
const { factories } = await import('../helpers/factories.js');
const { ConnectorRow } = await import('../../src/models/ConnectorRow.js');
const { default: connectorRepository } = await import('../../src/repositories/connector.repository.js');
const reportService = await import('../../src/services/report.service.js');
const artifactService = await import('../../src/services/artifact.service.js');
const storageService = await import('../../src/services/storage.service.js');
const { default: env } = await import('../../src/config/env.js');

let tenantId;
let datasetId;

before(async () => { await startMongo(); });
after(async () => { await stopMongo(); });
beforeEach(async () => {
  await resetMongo();
  tenantId = String((await factories.tenant.create({ status: 'active' }))._id);
  datasetId = String((await connectorRepository.create({ tenantId, type: 'csv', name: 'Orders', status: 'active' }))._id);
});

async function seed(n) {
  const connectorId = new mongoose.Types.ObjectId(datasetId);
  await ConnectorRow.collection.insertMany(Array.from({ length: n }, (_, i) => ({
    tenantId, connectorId, sourceRowId: `r${i}`, data: { i, region: i % 2 ? 'EU' : 'US' },
  })));
}

async function generate(reportId, format) {
  const { runId } = await reportService.run({ tenantId, reportId, format });
  await reportService.processRun({ tenantId, reportId, runId });
  const report = await reportService.getById({ tenantId, reportId });
  const run = report.runs.find((r) => String(r._id) === runId);
  assert.equal(run.status, 'ready', run.error ?? 'run should succeed');
  return run;
}

test('the cap is read from ARTIFACT_MAX_ROWS', () => {
  assert.equal(env.artifacts.maxRows, 1000);
});

test('a result larger than the cap is written up to the cap and marked truncated (CSV, XLSX, JSON)', async () => {
  await seed(1_250);
  const report = await reportService.create({ tenantId, name: 'Capped', source: 'query', format: 'csv', query: { datasetId } });
  const reportId = String(report._id);

  const csvRun = await generate(reportId, 'csv');
  assert.equal(csvRun.rowCount, 1000);
  assert.equal(csvRun.truncated, true);
  assert.equal(csvRun.rowLimit, 1000);
  const rows = parseCsv((await storageService.get(csvRun.resultKey)).toString('utf8'), { columns: true });
  assert.equal(rows.length, 1000);

  const xlsxRun = await generate(reportId, 'xlsx');
  assert.equal(xlsxRun.rowCount, 1000);
  assert.equal(xlsxRun.truncated, true);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await storageService.get(xlsxRun.resultKey));
  assert.equal(workbook.worksheets[0].actualRowCount, 1001);

  const jsonRun = await generate(reportId, 'json');
  const body = JSON.parse((await storageService.get(jsonRun.resultKey)).toString('utf8'));
  assert.equal(body.rows.length, 1000);
  assert.equal(body.truncated, true);
  assert.equal(body.rowLimit, 1000);

  const descriptor = await reportService.download({ tenantId, reportId, runId: String(xlsxRun._id) });
  assert.equal(descriptor.truncated, true);
  assert.equal(descriptor.rowLimit, 1000);
});

test('a result of exactly the cap is complete, not truncated', async () => {
  await seed(1_000);
  const report = await reportService.create({ tenantId, name: 'Exact', source: 'query', format: 'csv', query: { datasetId } });
  const run = await generate(String(report._id), 'csv');
  assert.equal(run.rowCount, 1000);
  assert.equal(run.truncated, false);
  assert.equal(run.rowLimit, null);
});

test('writeQueryArtifact honours an explicit cap and the XLSX sheet limit', async () => {
  await seed(30);
  const out = await artifactService.writeQueryArtifact({
    query: { tenantId, connectorIds: [datasetId], pagination: { page: 2, limit: 5 } },
    format: 'csv',
    key: `tests/${tenantId}/cap.csv`,
    maxRows: 7,
  });
  assert.equal(out.rowCount, 7, 'pagination never limits an artefact; the cap does');
  assert.equal(out.truncated, true);
  assert.equal(out.rowLimit, 7);
  assert.equal(artifactService.XLSX_MAX_DATA_ROWS, 1_048_575);
});
