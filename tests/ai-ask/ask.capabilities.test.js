/**
 * ai-ask capabilities: auto dataset resolution under data-access rules,
 * top-N, compare, recommended visualization from the result shape, and
 * follow-ups scoped to the same tenant + user.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMongo, stopMongo, resetMongo } from "../helpers/mongo.js";
import { startHttp, stopHttp, api } from "../helpers/http.js";
import rbacCache from "../../src/services/rbac.cache.service.js";
import * as cacheService from "../../src/services/cache.service.js";
import * as featureFlagService from "../../src/services/featureFlag.service.js";
import connectorRepository from "../../src/repositories/connector.repository.js";
import entitlementOverrideService from "../../src/services/entitlementOverride.service.js";
import { ConnectorRow } from "../../src/models/ConnectorRow.js";
import {
  setSdkFactory,
  _forceProvider,
} from "../../src/services/aiProvider.adapter.js";
import {
  onboardTenant,
  memberOf,
  captureLogs,
} from "../platform-config/helpers.js";
import { entitleTenant } from "../helpers/billing.js";
import * as datasetSchemaService from "../../src/services/datasetSchema.service.js";

let replies = [];
let calls = [];
const fakeSdk = () => ({
  models: {
    generateContent: async (params) => {
      calls.push(params);
      const next = replies.shift() ?? {
        kind: "unanswerable",
        unanswerable: { reason: "out_of_scope" },
      };
      if (next.stop)
        return {
          candidates: [{ finishReason: next.stop }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
          text: "",
        };
      return {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
        text: JSON.stringify(next),
      };
    },
  },
});

before(async () => {
  await startMongo();
  await startHttp();
  setSdkFactory(fakeSdk);
});
beforeEach(async () => {
  await resetMongo();
  await rbacCache.clearAll();
  await cacheService.flushAll();
  replies = [];
  calls = [];
  _forceProvider("gemini");
});
after(async () => {
  _forceProvider(null);
  setSdkFactory(null);
  await stopHttp();
  await stopMongo();
});

async function setup() {
  const t = await onboardTenant();
  await entitleTenant(t.tenantId);
  const c = await connectorRepository.create({
    tenantId: t.tenantId,
    type: "csv",
    name: "Orders",
    status: "active",
    createdBy: "u",
  });
  await ConnectorRow.insertMany([
    {
      tenantId: t.tenantId,
      connectorId: c._id,
      sourceRowId: "1",
      data: { region: "EU", amount: 10, email: "a@x.io" },
    },
    {
      tenantId: t.tenantId,
      connectorId: c._id,
      sourceRowId: "2",
      data: { region: "US", amount: 5, email: "b@x.io" },
    },
  ]);
  await datasetSchemaService.profileConnector({
    tenantId: t.tenantId,
    connectorId: String(c._id),
  });
  await featureFlagService.ensureDefaults();
  await featureFlagService.updateFlag({
    key: "ai.assistant",
    patch: { rollout: { strategy: "tenantId", tenantIds: [t.tenantId] } },
    actor: { type: "admin", id: "a" },
  });
  await api("/api/v1/ai/consent", {
    method: "PUT",
    headers: t.headers,
    body: { granted: true },
  });
  return { ...t, ds: String(c._id) };
}
const ask = (headers, question = "Revenue by region") =>
  api("/api/v1/ai/questions", { method: "POST", headers, body: { question } });

import dataAccessService from "../../src/services/dataAccess.service.js";
import { recommendVisualization } from "../../src/services/ai/visualization.js";

test("no dataset selection: planner sees authorised datasets only", async () => {
  const t = await setup();
  const c2 = await connectorRepository.create({
    tenantId: t.tenantId,
    type: "csv",
    name: "Secret",
    status: "active",
    createdBy: "u",
  });
  await ConnectorRow.insertMany([
    {
      tenantId: t.tenantId,
      connectorId: c2._id,
      sourceRowId: "1",
      data: { salary: 1 },
    },
  ]);
  await datasetSchemaService.profileConnector({
    tenantId: t.tenantId,
    connectorId: String(c2._id),
  });
  await dataAccessService.setDatasetAccess({
    tenantId: t.tenantId,
    connectorId: String(c2._id),
    restricted: true,
    grants: [],
  });
  const viewer = await memberOf(t.tenantId, "Viewer");
  replies = [
    {
      kind: "plan",
      plan: { datasetId: String(c2._id), metrics: [{ op: "count" }] },
    },
    {
      kind: "plan",
      plan: { datasetId: String(c2._id), metrics: [{ op: "count" }] },
    },
  ];
  const res = await ask(viewer.headers, "How many rows in the hidden one?");
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.outcome, "unanswerable");
  assert.equal(res.json.data.reason, "invalid_plan");
  const prompt = JSON.stringify(calls[0]);
  assert.ok(
    prompt.includes("Orders") &&
      !prompt.includes("Secret") &&
      !prompt.includes("salary"),
    "restricted dataset not offered",
  );
});

test("top-N with orderBy+limit, kpi for a single value, compare previous period", async () => {
  const t = await setup();
  replies = [
    {
      kind: "plan",
      plan: {
        datasetId: t.ds,
        metrics: [{ op: "sum", field: "amount", alias: "revenue" }],
        groupBy: [{ field: "region" }],
        orderBy: [{ field: "revenue", direction: "desc" }],
        limit: 1,
      },
    },
  ];
  const top = (await ask(t.headers, "Top region by revenue")).json.data;
  assert.equal(top.outcome, "answered", JSON.stringify(top));
  assert.deepEqual(
    top.result.rows.map((r) => r.region),
    ["EU"],
  );
  assert.equal(top.visualization.type, "pie");
  assert.ok(top.visualization.alternatives.includes("bar"));

  replies = [
    { kind: "plan", plan: { datasetId: t.ds, metrics: [{ op: "count" }] } },
  ];
  const kpi = (await ask(t.headers, "How many orders?")).json.data;
  assert.equal(kpi.visualization.type, "kpi");

  replies = [
    {
      kind: "plan",
      plan: {
        datasetId: t.ds,
        metrics: [{ op: "count" }],
        compare: { type: "previous_period" },
      },
    },
  ];
  const noRange = (await ask(t.headers, "vs last month")).json.data;
  assert.equal(
    noRange.outcome,
    "unanswerable",
    "compare without a dateRange is repaired or abstains, never executed",
  );
  assert.ok(
    JSON.stringify(calls.at(-1)).includes("compare: needs a dateRange"),
  );
  assert.ok(
    JSON.stringify(calls[0]).includes("this_month"),
    "prompt lists date presets",
  );
});

test("follow-up gets the prior question and plan; other users cannot reference it", async () => {
  const t = await setup();
  replies = [
    { kind: "plan", plan: { datasetId: t.ds, metrics: [{ op: "count" }] } },
  ];
  const first = (await ask(t.headers, "How many orders?")).json.data;
  replies = [
    {
      kind: "plan",
      plan: {
        datasetId: t.ds,
        metrics: [{ op: "count" }],
        groupBy: [{ field: "region" }],
      },
    },
  ];
  const res = await api("/api/v1/ai/questions", {
    method: "POST",
    headers: t.headers,
    body: { question: "by region", previousQuestionId: first.id },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.previousQuestionId, first.id);
  const prompt = JSON.stringify(calls.at(-1));
  assert.ok(prompt.includes("PREVIOUS") && prompt.includes("How many orders?"));
  assert.equal(res.json.data.visualization.type, "pie");

  const other = await memberOf(t.tenantId, "Admin");
  const denied = await api("/api/v1/ai/questions", {
    method: "POST",
    headers: other.headers,
    body: { question: "by region", previousQuestionId: first.id },
  });
  assert.equal(denied.status, 404);
});

test("recommendVisualization follows the result shape", () => {
  const series = recommendVisualization({
    query: { groupBy: [{ field: "d", bucket: "month" }] },
    columns: ["d", "n"],
    rows: [
      { d: "2026-01", n: 1 },
      { d: "2026-02", n: 2 },
    ],
  });
  assert.equal(series.type, "line");
  const many = Array.from({ length: 10 }, (_, i) => ({ city: `c${i}`, n: i }));
  assert.equal(
    recommendVisualization({
      query: { groupBy: [{ field: "city" }] },
      columns: ["city", "n"],
      rows: many,
    }).type,
    "bar",
  );
  assert.equal(
    recommendVisualization({
      query: {
        groupBy: [{ field: "city" }],
        compare: { type: "previous_period" },
      },
      columns: ["city", "n"],
      rows: many.slice(0, 3),
    }).type,
    "bar",
  );
  assert.equal(
    recommendVisualization({ query: {}, columns: ["n"], rows: [] }).type,
    "table",
  );
});
