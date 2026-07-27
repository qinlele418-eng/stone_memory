#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { getCfg, getThreadDir, listThreadIds, loadConfig } = require("../src/config");
const { MemoryMiner } = require("../src/services/memory-miner");
const {
  MiningReviewStore,
  buildReviewOverlay,
  nearDuplicateHints,
} = require("../src/services/mining-review");

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
      personaConfig: {
        aiName: getCfg("ai", threadId),
        userName: getCfg("user", threadId),
        userGender: getCfg("userGender", threadId, "female"),
        purpose: getCfg("purpose", threadId),
      },
    });
    try {
      const result = await miner.preview(date, {
        promptOverlay: overlay.text,
        model: subagentModel,
      });
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

function printHelp() {
  console.log(`stmem mine-review

Usage:
  stmem mine-review preview --thread <id> --date <YYYY-MM-DD> [--batch-file <json>]
  stmem mine-review list --thread <id> [--date <YYYY-MM-DD>]
  stmem mine-review mix --thread <id> --batch-file <json>
  stmem mine-review apply --thread <id> --candidate <candidate-id>
  stmem mine-review discard --thread <id> --candidate <candidate-id>

preview and mix never publish formal memories. apply rechecks the message
fingerprint, creates a SQLite backup, and then atomically replaces one day.`);
}


function resolveProfile(threadId, requested = {}) {
  if (requested.reasoning) throw new Error("per-call reasoning override is not supported yet");
  const config = loadConfig();
  const thread = config[threadId] || {};
  const channel = String(requested.channel || thread.minerMode || "subagent");
  if (channel === "api") {
    const provider = String(requested.provider || thread.apiProvider || "deepseek");
    const credential = config.apiKeys?.[provider] || {};
    const model = String(requested.model || credential.model || "").trim();
    const baseUrl = String(credential.baseUrl || (provider === "deepseek" ? "https://api.deepseek.com" : "")).trim();
    if (!credential.key) throw new Error(`API profile ${provider} has no configured key`);
    if (!model) throw new Error(`API profile ${provider} has no model`);
    if (!baseUrl) throw new Error(`API profile ${provider} has no baseUrl`);
    return {
      profile: {
        id: String(requested.id || `${provider}:${model}`),
        label: String(requested.label || model),
        channel,
        provider,
        model,
        reasoning: requested.reasoning || null,
      },
      deepseekConfig: { apiKey: credential.key, baseUrl, model },
      subagentModel: null,
    };
  }
  if (!["subagent", "configured"].includes(channel)) throw new Error(`unsupported review channel: ${channel}`);
  const model = requested.model ? String(requested.model) : null;
  return {
    profile: {
      id: String(requested.id || (model ? `subagent:${model}` : "configured-subagent")),
      label: String(requested.label || model || "Configured subagent"),
      channel: "subagent",
      provider: null,
      model,
      reasoning: requested.reasoning || null,
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

module.exports = { resolveProfile };
