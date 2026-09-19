const { loadConfig } = require("../config");
const { normalizeModelName } = require("../lib/model-name");
const { configuredRuntimeIds } = require("../services/mining-review-batch");
const { normalizeMiningApiProfile } = require("../services/mining-api-profile");
const { runStmemAsync, writePrivateBatch, parseStmemJson } = require("./cli-client");

const REVIEW_RULE_IDS = {
  sourceAware: "source-aware",
  relationshipPlatform: "platform-neutral",
  emotional: "personal-emotion",
  conflict: "conflict-context",
  intimacy: "intimate-facts",
  countLimit: "count-limit",
  strictBoundaries: "strict-importance",
};

function reviewProviders(threadId) {
  const config = loadConfig();
  const thread = config[threadId];
  if (!thread) throw new Error(`记忆体不存在：${threadId}`);
  return Object.entries(config.apiKeys || {}).flatMap(([id, credential]) =>
    credential?.key && (credential?.baseUrl || id === "deepseek")
      ? [{ id, label: id, defaultModel: String(credential.model || "") }]
      : []
  );
}

function reviewProfileFromInput(threadId, input = {}) {
  const channel = String(input.channel || "");
  const model = String(input.model || "").trim();
  normalizeModelName(model, { required: true, label: "模型名" });
  if (channel === "subagent") {
    const runtime = String(input.runtime || "");
    const config = loadConfig();
    if (!configuredRuntimeIds(config, threadId).has(runtime)) throw new Error("请选择设置中已经配置的本机 CLI");
    const reasoning = input.reasoning ? String(input.reasoning) : null;
    if (reasoning && runtime !== "codex") throw new Error("只有 Codex 支持 reasoning effort");
    if (reasoning && !["minimal", "low", "medium", "high", "xhigh"].includes(reasoning)) {
      throw new Error("Codex reasoning effort 无效");
    }
    return {
      id: `subagent:${runtime}:${model}:${reasoning || "default"}`,
      label: String(input.label || `${runtime === "codex" ? "Codex" : "Claude Code"} · ${model}`),
      channel, runtime, model, reasoning,
    };
  }
  if (channel === "api") {
    const provider = String(input.provider || "");
    const config = loadConfig();
    const credential = config.apiKeys?.[provider];
    if (!credential?.key || (!credential?.baseUrl && provider !== "deepseek")) {
      throw new Error(`API Provider ${provider || "未选择"} 尚未在设置中配置完整`);
    }
    return {
      id: `api:${provider}:${model}:${normalizeMiningApiProfile(input.apiProfile)}`,
      label: String(input.label || `${provider} · ${model} · ${normalizeMiningApiProfile(input.apiProfile) === "optimized" ? "优化版" : "原始版"}`),
      channel, provider, model, apiProfile: normalizeMiningApiProfile(input.apiProfile),
    };
  }
  throw new Error("请选择 Subagent 或 API 通道");
}

function reviewBatchPayload(threadId, input = {}) {
  const dates = [...new Set((Array.isArray(input.dates) ? input.dates : []).map(String))].sort();
  if (!dates.length || dates.length > 366 || dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
    throw new Error("请选择 1～366 个有效日期");
  }
  const ruleIds = Object.entries(REVIEW_RULE_IDS)
    .filter(([key]) => input.rules?.[key] === true)
    .map(([, id]) => id);
  return {
    dates,
    profile: reviewProfileFromInput(threadId, input.profile),
    groupDays: Number(input.groupDays),
    chunkKb: input.chunkKb === "auto" ? "auto" : Number(input.chunkKb),
    parallel: Number(input.parallel),
    ruleIds,
    additionalInstruction: String(input.additionalInstruction || "").trim().slice(0, 4000),
  };
}

function reviewBatchCommandArgs(action, threadId, value) {
  const args = ["mine-review", action, "--thread", threadId];
  if (action === "batch-create") args.push("--batch-file", value);
  else if (value) args.push("--batch", value);
  return args;
}

function runReviewBatchInBackground(threadId, batchId, action = "batch-run") {
  runStmemAsync(reviewBatchCommandArgs(action, threadId, batchId), { maxOutput: 2 * 1024 * 1024 })
    .catch(() => {});
}

function reviewCandidateForWeb(candidate) {
  const ruleIds = new Set(candidate.ruleIds || []);
  const rules = Object.fromEntries(Object.entries(REVIEW_RULE_IDS).map(([key, id]) => [key, ruleIds.has(id)]));
  const hybrid = candidate.profile?.id === "hybrid";
  const fusion = candidate.profile?.id === "fusion";
  return {
    ...candidate,
    model: hybrid ? "hybrid" : fusion ? "fusion" : candidate.profile?.id || "unknown",
    modelLabel: hybrid ? "混合精选" : fusion ? candidate.profile?.label || "同事件融合" : candidate.profile?.label || candidate.profile?.model || "候选",
    preset: ruleIds.size ? "custom" : "author",
    rules,
  };
}

async function executeReviewPreview(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const batch = writePrivateBatch({ profile: job.profile, ruleIds: job.ruleIds });
  try {
    const output = await runStmemAsync([
      "mine-review", "preview", "--thread", job.threadId, "--date", job.date,
      "--batch-file", batch.file,
    ], { maxOutput: 2 * 1024 * 1024 });
    job.candidate = reviewCandidateForWeb(parseStmemJson(output));
    job.candidateId = job.candidate.id;
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.error = String(error.message || error).slice(0, 2000);
  } finally {
    batch.cleanup();
    job.completedAt = new Date().toISOString();
  }
}

async function executeFusionPreview(job) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  const batch = writePrivateBatch({
    sourceCandidateId: job.sourceCandidateId,
    profile: job.profile,
  });
  try {
    const output = await runStmemAsync([
      "mine-review", "fuse", "--thread", job.threadId, "--batch-file", batch.file,
    ], { timeout: 25 * 60 * 1000, maxOutput: 2 * 1024 * 1024 });
    job.candidate = reviewCandidateForWeb(parseStmemJson(output));
    job.candidateId = job.candidate.id;
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.error = String(error.message || error).slice(0, 2000);
  } finally {
    batch.cleanup();
    job.completedAt = new Date().toISOString();
  }
}

module.exports = { REVIEW_RULE_IDS, reviewProviders, reviewProfileFromInput, reviewBatchPayload, reviewBatchCommandArgs, runReviewBatchInBackground, reviewCandidateForWeb, executeReviewPreview, executeFusionPreview };
