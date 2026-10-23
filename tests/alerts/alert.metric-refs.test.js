/**
 * Reports and alerts reject `metric:<key>` references that are not approved
 * (draft, archived or missing), like dashboards do.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useMongo, resetMongo } from "../helpers/index.js";
import { factories } from "../helpers/factories.js";
import connectorRepository from "../../src/repositories/connector.repository.js";
import * as alertService from "../../src/services/alert.service.js";
import * as reportService from "../../src/services/report.service.js";
import * as metricService from "../../src/services/metricDefinition.service.js";
import * as cacheService from "../../src/services/cache.service.js";
import { entitleTenant } from "../helpers/billing.js";

useMongo();

let tenantId;
let datasetId;

beforeEach(async () => {
  await resetMongo();
  await cacheService.flushAll();
  tenantId = String((await factories.tenant.create({ status: "active" }))._id);
  await entitleTenant(tenantId);
  datasetId = String(
    (
      await connectorRepository.create({
        tenantId,
        type: "csv",
        name: "Orders",
        status: "active",
      })
    )._id,
  );
  await metricService.create({
    tenantId,
    input: {
      key: "draft_orders",
      label: "Draft orders",
      connectorId: datasetId,
      aggregation: "count",
    },
  });
});

const inactive = (e) =>
  e.statusCode === 400 && /not an active metric/.test(JSON.stringify(e.errors));

for (const ref of ["metric:draft_orders", "metric:missing"]) {
  test(`alerts reject ${ref}`, async () => {
    await assert.rejects(
      () =>
        alertService.createRule({
          tenantId,
          name: "A",
          source: "query",
          query: { datasetId, metrics: [{ ref, alias: "m" }] },
          metric: "m",
          condition: "gt",
          threshold: 0,
        }),
      inactive,
    );
  });

  test(`reports reject ${ref}`, async () => {
    await assert.rejects(
      () =>
        reportService.create({
          tenantId,
          name: "R",
          source: "query",
          query: { datasetId, metrics: [{ ref, alias: "m" }] },
        }),
      inactive,
    );
  });
}

test("approved metric references are accepted", async () => {
  await metricService.approve({ tenantId, key: "draft_orders", version: 1 });
  const rule = await alertService.createRule({
    tenantId,
    name: "A",
    source: "query",
    query: { datasetId, metrics: [{ ref: "metric:draft_orders", alias: "m" }] },
    metric: "m",
    condition: "gt",
    threshold: 0,
  });
  assert.ok(rule._id);
});
