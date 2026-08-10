#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getCfg, getThreadDir, listThreadIds, loadConfig } = require("../src/config");
const { MemoryMiner } = require("../src/services/memory-miner");
const { runSubagent } = require("../src/services/subagent-runner");
const { fuseReviewCandidate } = require("../src/services/review-fusion");
const {
  MiningReviewStore,
  buildReviewOverlay,
  nearDuplicateHints,
} = require("../src/services/mining-review");
const { resolveMiningApiCredentials } = require("../src/services/mining-engine-config");
const { normalizeMiningApiProfile, buildMiningApiBody } = require("../src/services/mining-api-profile");

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "mine-review") args.shift();
  const action = args[0] || "help";
  if (["help", "--help", "-h"].includes(action)) {
    printHelp();
    return;
  }
  const threadId = valueOf(args, "--thread");
  if (!threadId) throw new Error("mine-review requires --thread <id>");
  const config = loadConfig();
  if (!config[threadId] || typeof config[threadId] !== "object") throw new Error(`unknown configured thread: ${threadId}`);
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const reviews = new MiningReviewStore({ memoryDir, threadId });

  if (action === "list") {
    const candidates = reviews.list({ date: valueOf(args, "--date") || null });
    const pending = candidates.filter(candidate => candidate.status === "review_pending");
    const dates = [...new Set(pending.map(candidate => candidate.date))];
    const duplicateHints = dates.flatMap(date => nearDuplicateHints(
      pending.filter(candidate => candidate.date === date),
    ));
    return print({
      threadId,
      candidates,
      nearDuplicateHints: duplicateHints,
    });
  }

  if (action === "discard") {
    return print(reviews.discard(required(args, "--candidate")));
  }

  if (action === "apply") {
    return print(await reviews.apply(required(args, "--candidate")));
  }

  if (action === "mix") {
    const payload = readBatch(args);
    return print(reviews.mix({
      date: String(payload.date || valueOf(args, "--date") || ""),
      selection: payload.selection,
      enforceCountLimit: !!payload.enforceCountLimit,
    }));
  }

  if (action === "fuse") {
    const payload = readBatch(args);
    const resolved = resolveProfile(threadId, payload.profile);
    const sourceCandidateId = String(payload.sourceCandidateId || "");
    if (!sourceCandidateId) throw new Error("fuse requires sourceCandidateId");
    const candidate = await fuseReviewCandidate({
      reviews,
      sourceCandidateId,
      writerProfile: resolved.profile,
      generate: prompt => runFusionWriter(prompt, resolved, threadId),
    });
    return print(candidate);
  }

  if (action === "preview") {
    const date = required(args, "--date");
    const payload = readBatch(args, { optional: true });
    const { profile, deepseekConfig, subagentModel } = resolveProfile(threadId, payload.profile);
    const overlay = buildReviewOverlay({
      ruleIds: payload.ruleIds || [],
      additionalInstruction: payload.additionalInstruction || "",
    });
    const miner = new MemoryMiner({
      memoryDir,
      threadId,
      deepseekConfig,
      apiProfile: profile.apiProfile,
      personaConfig: {
        aiName: getCfg("ai", threadId),
        userName: getCfg("user", threadId),
        userGender: getCfg("userGender", threadId, "female"),
        purpose: getCfg("purpose", threadId),
        runtime: getCfg("runtime", threadId, "claude"),
      },
    });
    try {
      // MemoryMiner 的进度信息继续保留给 CLI 调试，但 mine-review 的
      // stdout 是机器接口，必须只输出最后一个 JSON 候选；否则 Web
      // review-lab 的 JSON 解析会被进度行污染。
      const result = await captureReviewDiagnostics(() => miner.preview(date, {
        promptOverlay: overlay.text,
        model: subagentModel,
        runtime: profile.runtime,
        reasoning: profile.reasoning,
      }));
      const candidate = reviews.createCandidate({
        ...result,
        date,
        profile,
        ruleIds: overlay.ruleIds,
        priorCounts: {
          feelings: miner.store.listFeelings({ date }).length,
          features: miner.store.listFeatures({ date }).length,
        },
      });
      return print(candidate);
    } finally {
      miner.store.close();
    }
  }

  throw new Error(`unknown mine-review action: ${action}`);
}

async function captureReviewDiagnostics(run) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.map(value => String(value)).join(" "));
  try {
    return await run();
  } finally {
    console.log = originalLog;
    for (const line of lines) process.stderr.write(`${line}\n`);
  }
}

function printHelp() {
  console.log(`stmem mine-review

Usage:
  stmem mine-review preview --thread <id> --date <YYYY-MM-DD> [--batch-file <json>]
  stmem mine-review list --thread <id> [--date <YYYY-MM-DD>]
  stmem mine-review mix --thread <id> --batch-file <json>
  stmem mine-review fuse --thread <id> --batch-file <json>
  stmem mine-review apply --thread <id> --candidate <candidate-id>
  stmem mine-review discard --thread <id> --candidate <candidate-id>

preview, mix and fuse never publish formal memories. apply rechecks the message
fingerprint, creates a SQLite backup, and then atomically replaces one day.`);
}

async function runFusionWriter(prompt, resolved, threadId) {
  if (resolved.profile.channel === "api") {
    const { apiKey, baseUrl, model } = resolved.deepseekConfig;
    const response = await fetch(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildMiningApiBody({
        profile: resolved.profile.apiProfile,
        model,
        temperature: 0.1,
        messages: [{ role: "user", content: prompt }],
      })),
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
    if (!response.ok) throw new Error(`fusion API request failed: HTTP ${response.status}`);
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error("fusion API returned an empty response");
    return content;
  }
  return runSubagent(prompt, {
    threadId,
    runtime: resolved.profile.runtime,
    model: resolved.subagentModel || undefined,
    reasoning: resolved.profile.reasoning || undefined,
    timeout: 20 * 60 * 1000,
  });
}


function resolveProfile(threadId, requested = {}) {
  const config = loadConfig();
  const thread = config[threadId] || {};
  const channel = String(requested.channel || thread.minerMode || "subagent");
  if (channel === "api") {
    if (requested.reasoning) throw new Error("reasoning effort is only supported by the Codex subagent");
    const provider = String(requested.provider || thread.apiProvider || "deepseek");
    const model = String(requested.model || config.apiKeys?.[provider]?.model || "").trim();
    if (model && !/^[A-Za-z0-9._:/+-]{1,128}$/.test(model)) throw new Error("review model name contains unsupported characters");
    const deepseekConfig = resolveMiningApiCredentials({
      config, threadId, provider, model,
    });
    const apiProfile = normalizeMiningApiProfile(requested.apiProfile);
    return {
      profile: {
        id: String(requested.id || `${provider}:${model}:${apiProfile}`),
        label: String(requested.label || `${model} · ${apiProfile === "optimized" ? "优化版" : "原始版"}`),
        channel,
        provider,
        model,
        apiProfile,
        reasoning: requested.reasoning || null,
      },
      deepseekConfig: { ...deepseekConfig, apiProfile },
      subagentModel: null,
    };
  }
  if (!["subagent", "configured"].includes(channel)) throw new Error(`unsupported review channel: ${channel}`);
  const runtime = String(requested.runtime || thread.runtime || "claude");
  if (!["claude", "codex"].includes(runtime)) throw new Error(`unsupported review runtime: ${runtime}`);
  const model = requested.model ? String(requested.model) : null;
  if (model && !/^[A-Za-z0-9._:/+-]{1,128}$/.test(model)) throw new Error("review model name contains unsupported characters");
  const reasoning = requested.reasoning ? String(requested.reasoning) : null;
  if (reasoning && runtime !== "codex") throw new Error("reasoning effort is only supported by Codex");
  if (reasoning && !["minimal", "low", "medium", "high", "xhigh"].includes(reasoning)) {
    throw new Error("unsupported Codex reasoning effort");
  }
  return {
    profile: {
      id: String(requested.id || (model ? `subagent:${runtime}:${model}` : `subagent:${runtime}:configured`)),
      label: String(requested.label || model || "Configured subagent"),
      channel: "subagent",
      runtime,
      provider: null,
      model,
      reasoning,
    },
    deepseekConfig: {},
    subagentModel: model,
  };
}

function readBatch(args, { optional = false } = {}) {
  const file = valueOf(args, "--batch-file");
  if (!file) {
    if (optional) return {};
    throw new Error("this action requires --batch-file <json>");
  }
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function required(args, name) {
  const value = valueOf(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function valueOf(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
  return value;
}

main().catch(error => {
  console.error(JSON.stringify({
    ok: false,
    code: error.code || "MINE_REVIEW_FAILED",
    error: error.message,
    details: error.details || null,
  }));
  process.exitCode = 1;
});

module.exports = { resolveProfile, runFusionWriter, captureReviewDiagnostics };
