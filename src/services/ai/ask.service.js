/**
 * Ask a question (ai-ask, roadmap 4.A2): gate -> context -> planner ->
 * validator (one repair round, then abstain) -> strict engine execution ->
 * result checks -> answer with plan, assumptions and provenance.
 *
 * The engine injects the caller's tenant, so tenant isolation never depends
 * on the model. Logs and the AiQuestion record keep the plan, validator
 * outcome, dataset ids, latency, usage and a prompt hash, never rows.
 */
import ApiError from "../../utils/ApiError.js";
import env from "../../config/env.js";
import logger from "../../utils/logger.js";
import * as engine from "../analytics.engine.js";
import aiRepository from "../../repositories/ai.repository.js";
import gate from "./gate.js";
import { buildContext, hashPrompt } from "./context.js";
import { PLAN_SCHEMA, SYSTEM_PROMPT, buildPrompt } from "./planner.js";
import { validatePlan } from "./validator.js";
import { recommendVisualization } from "./visualization.js";

const addUsage = (a, b) => ({
  inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
  outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
});

async function record(entry) {
  const doc = await aiRepository.createQuestion(entry);
  logger.info(
    {
      aiQuestionId: String(doc._id),
      tenantId: entry.tenantId,
      outcome: entry.outcome,
      reason: entry.reason,
      datasetIds: entry.datasetIds,
      latencyMs: entry.latencyMs,
      usage: entry.usage,
      promptHash: entry.promptHash,
      validator: entry.validator,
    },
    "ai question",
  );
  return doc;
}

/**
 * Follow-ups: the prior question must belong to the same tenant AND actor;
 * anything else is treated as not found (no cross-user context leaks).
 */
async function loadPrevious({ tenantId, actorId, previousQuestionId }) {
  if (!previousQuestionId) return null;
  const doc = await aiRepository.findQuestion({
    tenantId,
    id: previousQuestionId,
  });
  if (!doc || String(doc.actorId ?? "") !== String(actorId ?? ""))
    throw ApiError.notFound("Previous question not found");
  return {
    question: doc.question,
    plan: doc.plan ?? null,
    datasetIds: doc.datasetIds ?? [],
  };
}

/**
 * No dataset the caller may query has a schema yet: answer truthfully
 * without spending a model call.
 */
async function finishEarly({ tenantId, actorId, text, previous, previousQuestionId, provider, started }) {
  const doc = await record({
    tenantId,
    actorId,
    question: text,
    ...(previous ? { previousQuestionId: String(previousQuestionId) } : {}),
    provider: provider.name,
    model: env.ai.model,
    outcome: "unanswerable",
    reason: "no_datasets",
    latencyMs: Date.now() - started,
  });
  return {
    id: String(doc._id),
    outcome: "unanswerable",
    reason: "no_datasets",
    message:
      "There is no ready dataset you can query yet. Upload a file or sync a data source in Datasets, then ask again.",
    scope: { available: 0, offered: 0, truncated: false },
  };
}

export async function ask({
  tenantId,
  actorId = null,
  question,
  previousQuestionId = null,
}) {
  const text = typeof question === "string" ? question.trim() : "";
  if (!text)
    throw ApiError.badRequest("question is required", [
      { field: "question", message: "is required" },
    ]);
  if (text.length > env.ai.maxQuestionLength) {
    throw ApiError.badRequest("question is too long", [
      {
        field: "question",
        message: `at most ${env.ai.maxQuestionLength} characters`,
      },
    ]);
  }
  const provider = await gate.check({ tenantId, actorId });
  const previous = await loadPrevious({
    tenantId,
    actorId,
    previousQuestionId,
  });
  const started = Date.now();
  const ctx = await buildContext({
    tenantId,
    question: previous ? `${previous.question} ${text}` : text,
    preferDatasetIds: previous?.datasetIds ?? [],
  });
  // Which datasets the planner saw; a truncated search is said out loud.
  const scope = ctx.scope;
  const scopeNote = scope.truncated
    ? ` Only the ${scope.offered} most relevant of your ${scope.available} datasets were searched; name the dataset in your question to search a specific one.`
    : "";
  if (!ctx.datasets.length) {
    return finishEarly({
      tenantId,
      actorId,
      text,
      previous,
      previousQuestionId,
      provider,
      started,
    });
  }
  const base = {
    tenantId,
    actorId,
    question: text,
    ...(previous ? { previousQuestionId: String(previousQuestionId) } : {}),
    provider: provider.name,
    model: env.ai.model,
  };
  let usage = null;
  let repairErrors = null;
  let promptHash = null;
  let validated = null;
  let lastPlan = null;
  const finish = async (outcome, extra = {}) => {
    const doc = await record({
      ...base,
      outcome,
      usage,
      promptHash,
      latencyMs: Date.now() - started,
      ...extra,
    });
    return { id: String(doc._id), outcome, ...extra.response };
  };

  for (let round = 0; round < 2; round += 1) {
    const prompt = buildPrompt({
      data: ctx.data,
      question: text,
      repairErrors,
      previous,
    });
    promptHash = hashPrompt(`${SYSTEM_PROMPT}\n${prompt}`);
    const out = await provider.plan({
      system: SYSTEM_PROMPT,
      prompt,
      schema: PLAN_SCHEMA,
      maxTokens: env.ai.maxOutputTokens,
    });
    usage = addUsage(usage, out.usage);
    if (!out.ok) {
      return finish("unanswerable", {
        reason: out.reason,
        response: {
          reason: "provider_declined",
          message: "The question could not be answered. Try the query builder.",
          scope,
        },
      });
    }
    const o = out.output ?? {};
    if (o.kind === "clarify") {
      const clarify = {
        question: String(o.clarify?.question ?? "").slice(0, 300),
        options: (o.clarify?.options ?? [])
          .slice(0, 4)
          .map((x) => String(x).slice(0, 120)),
      };
      return finish("clarify", { response: { clarify } });
    }
    if (o.kind !== "plan") {
      const reason = String(o.unanswerable?.reason ?? "out_of_scope").slice(
        0,
        40,
      );
      return finish("unanswerable", {
        reason,
        response: {
          reason,
          message: `Your data does not contain what this question needs.${scopeNote}`,
          missing: (o.unanswerable?.missing ?? [])
            .slice(0, 10)
            .map((x) => String(x).slice(0, 100)),
          scope,
        },
      });
    }
    lastPlan = o.plan;
    validated = validatePlan(o.plan, ctx);
    if (validated.ok) break;
    if (round === 0) {
      repairErrors = validated.errors;
      continue;
    }
  }
  if (!validated?.ok) {
    return finish("unanswerable", {
      reason: "invalid_plan",
      plan: lastPlan,
      validator: {
        passed: false,
        repaired: true,
        errors: (validated?.errors ?? []).slice(0, 20),
      },
      response: {
        reason: "invalid_plan",
        message: `The question could not be mapped to your data.${scopeNote}`,
        scope,
      },
    });
  }

  const result = await engine.queryRows({
    ...validated.query,
    tenantId,
    connectorIds: [validated.datasetId],
  });
  const checks = [];
  if (!result.rows.length) checks.push("empty_result");
  if (result.total > result.rows.length) checks.push("truncated");
  const dataset = ctx.datasets.find((d) => d.id === validated.datasetId);
  const provenance = {
    datasetId: validated.datasetId,
    datasetName: dataset?.name ?? null,
    query: validated.query,
    window: result.window,
    timezone: result.timezone,
    rowCount: result.rows.length,
    total: result.total,
    executedAt: result.executedAt,
  };
  return finish("answered", {
    plan: validated.query,
    datasetIds: [validated.datasetId],
    rowCount: result.rows.length,
    validator: {
      passed: true,
      repaired: Boolean(repairErrors),
      errors: repairErrors ?? [],
    },
    response: {
      plan: validated.query,
      assumptions: (lastPlan?.assumptions ?? [])
        .slice(0, 10)
        .map((a) => String(a).slice(0, 200)),
      result: { rows: result.rows, columns: result.columns },
      checks,
      visualization: recommendVisualization({
        query: validated.query,
        rows: result.rows,
        columns: result.columns,
      }),
      ...(previous ? { previousQuestionId: String(previousQuestionId) } : {}),
      provenance,
      scope,
    },
  });
}

export async function getQuestion({ tenantId, id }) {
  const doc = await aiRepository.findQuestion({ tenantId, id });
  if (!doc) throw ApiError.notFound("Question not found");
  return doc;
}

export async function feedback({ tenantId, id, actorId, rating, comment }) {
  if (!["up", "down"].includes(rating))
    throw ApiError.badRequest("rating must be up or down", [
      { field: "rating", message: "must be up or down" },
    ]);
  await getQuestion({ tenantId, id });
  return aiRepository.setFeedback({
    tenantId,
    id,
    feedback: {
      rating,
      comment: comment ? String(comment).slice(0, 1000) : null,
      at: new Date(),
      by: actorId,
    },
  });
}

export async function setConsent({ tenantId, actorId, granted }) {
  const doc = await aiRepository.setConsent({
    tenantId,
    granted: Boolean(granted),
    by: actorId,
  });
  return {
    granted: doc.granted,
    grantedAt: doc.grantedAt,
    revokedAt: doc.revokedAt,
  };
}

export default { ask, getQuestion, feedback, setConsent, status: gate.status };
