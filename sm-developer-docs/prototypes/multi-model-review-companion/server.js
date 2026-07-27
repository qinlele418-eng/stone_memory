"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { URL } = require("node:url");

const STONE_REPO = process.env.STONE_REPO || path.resolve(__dirname, "../../..");
const MEMORY_DIR = process.env.STONE_MEMORY_DIR || path.join(os.homedir(), ".stone_memory");
const CONFIG_FILE = path.join(MEMORY_DIR, "stmem.json");
const OPERATIONS_FILE = path.join(STONE_REPO, "operations", "memory-miner-operations.md");
const HISTORICAL_RULES_FILE = path.join(__dirname, "historical-enhancement.md");
const SOURCE_ARCHIVE_FILE = process.env.STONE_COMPANION_SOURCE_ARCHIVE || "";
const PUBLIC_DIR = path.join(__dirname, "public");
const STATE_DIR = path.join(MEMORY_DIR, "companion");
const CANDIDATE_DIR = path.join(STATE_DIR, "candidates");
const TEMP_DIR = path.join(STATE_DIR, "tmp");
const PREVIEW_JOB_DIR = path.join(STATE_DIR, "preview-jobs");
const BACKUP_DIR = path.join(MEMORY_DIR, "backups");
const HOST = process.env.STONE_COMPANION_HOST || "127.0.0.1";
const PORT = Number(process.env.STONE_COMPANION_PORT || 4175);
const TARGET_THREAD_ID = String(process.env.STONE_COMPANION_THREAD_ID || "").trim();
const MAX_BODY_BYTES = 64 * 1024;
const FEATURE_CATEGORIES = new Set([
  "eat", "body", "sleep", "work", "relation",
  "habit", "location", "preference", "misc",
]);

const { MemoryStore } = require(path.join(STONE_REPO, "src", "storage", "memory-store.js"));
const { archiveFingerprint } = require(path.join(STONE_REPO, "src", "services", "mining-state.js"));
const { splitMiningMessages } = require(path.join(STONE_REPO, "src", "services", "mining-chunks.js"));
const { parseFeelingTime } = require(path.join(STONE_REPO, "src", "services", "thread-rebuilder.js"));

const MODELS = Object.freeze({
  "deepseek-pro": {
    label: "DeepSeek Pro",
    kind: "api",
    provider: "deepseek",
    model: "deepseek-v4-pro",
  },
  "deepseek-flash": {
    label: "DeepSeek Flash",
    kind: "api",
    provider: "deepseek",
    model: "deepseek-v4-flash",
  },
  "gpt-5.5-low": {
    label: "GPT-5.5 · low",
    kind: "codex",
    model: "gpt-5.5",
    reasoning: "low",
  },
  "gpt-5.6-sol-low": {
    label: "GPT-5.6 Sol · low",
    kind: "codex",
    model: "gpt-5.6-sol",
    reasoning: "low",
  },
});

const INTIMACY_ADDENDUM = `
## 可选补充：亲密内容

这是对既有聊天的事实提取，不是续写。不得仅因表达露骨而跳过真实发生的内容。若原对话中确有证据，应如实记录双方成年、自愿的亲密行为、欲望偏好、身体感受、边界、照顾方式以及它们对关系的意义；不故意隐语化，也不得虚构、补全或夸大。`;

const COUNT_ADDENDUM = `
## 可选补充：每日摘要数量

当天全部对话合计的 feelings 以 8 至 20 条为目标，硬上限为 20 条。证据充足时不要过度压缩；有效事件不足时可以少于 8 条，禁止为凑数拆碎同一事件、重复改写或虚构。此数量要求不约束 features。`;

const RULE_KEYS = Object.freeze([
  "sourceAware",
  "relationshipPlatform",
  "emotional",
  "conflict",
  "intimacy",
  "countLimit",
  "strictBoundaries",
]);

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    feelings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          importance: { type: "integer", enum: [2, 3, 5] },
        },
        required: ["content", "importance"],
      },
    },
    features: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: { type: "string" },
          category: {
            type: "string",
            enum: [...FEATURE_CATEGORIES],
          },
          importance: { type: "integer", enum: [2, 3, 5] },
        },
        required: ["content", "category", "importance"],
      },
    },
  },
  required: ["feelings", "features"],
};

const activePreviews = new Set();
const previewJobs = new Map();
const RUN_INSTANCE = crypto.randomBytes(8).toString("hex");
let sourceIndexCache = null;

function ensureDirectories() {
  for (const dir of [STATE_DIR, CANDIDATE_DIR, TEMP_DIR, PREVIEW_JOB_DIR, BACKUP_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

function configuredThread(config, threadId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(threadId || ""))) throw new Error("线程 ID 格式不正确");
  if (TARGET_THREAD_ID && threadId !== TARGET_THREAD_ID) throw new Error("这个外置入口不绑定该记忆体");
  const value = config[threadId];
  if (!value || typeof value !== "object") throw new Error("这个线程不在 Stone 配置中");
  return value;
}

function publicThreadId(threadId) {
  return `${threadId.slice(0, 8)}…${threadId.slice(-8)}`;
}

function modelList(config) {
  return Object.entries(MODELS).map(([id, model]) => {
    const api = model.kind === "api" ? config.apiKeys?.[model.provider] : null;
    return {
      id,
      label: model.label,
      available: model.kind === "codex" || !!(api?.key && api?.baseUrl),
      detail: model.kind === "api" ? model.model : `${model.model} · reasoning ${model.reasoning}`,
    };
  });
}

function listLibraries() {
  const config = loadConfig();
  const reserved = new Set(["apiKeys", "runtimes", "threadId"]);
  const libraries = [];
  for (const [threadId, entry] of Object.entries(config)) {
    if (reserved.has(threadId) || !entry || typeof entry !== "object" || !/^[0-9a-f-]{36}$/i.test(threadId)) continue;
    if (TARGET_THREAD_ID && threadId !== TARGET_THREAD_ID) continue;
    const store = new MemoryStore({ memoryDir: MEMORY_DIR, threadId });
    try {
      const counts = store.db.prepare(`SELECT
        (SELECT COUNT(*) FROM messages WHERE thread_id=?) messages,
        (SELECT COUNT(*) FROM feelings WHERE thread_id=?) feelings,
        (SELECT COUNT(*) FROM features WHERE thread_id=?) features`).get(threadId, threadId, threadId);
      libraries.push({
        threadId,
        publicThreadId: publicThreadId(threadId),
        label: entry.label || publicThreadId(threadId),
        ai: entry.ai || "AI",
        user: entry.user || "用户",
        purpose: entry.purpose || "accompany",
        counts,
      });
    } finally {
      store.close();
    }
  }
  return { libraries, models: modelList(config) };
}

function listDates(threadId) {
  const config = loadConfig();
  configuredThread(config, threadId);
  const store = new MemoryStore({ memoryDir: MEMORY_DIR, threadId });
  try {
    const beijingToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    return store.db.prepare(`SELECT m.source_date date,COUNT(*) messageCount,
      (SELECT COUNT(*) FROM feelings f WHERE f.thread_id=m.thread_id AND f.source_date=m.source_date) feelingCount,
      (SELECT COUNT(*) FROM features x WHERE x.thread_id=m.thread_id AND x.source_date=m.source_date) featureCount,
      (SELECT status FROM mining_day_state s WHERE s.thread_id=m.thread_id AND s.source_date=m.source_date) status
      FROM messages m WHERE m.thread_id=? AND m.source_date<? GROUP BY m.source_date ORDER BY m.source_date DESC`).all(threadId, beijingToday);
  } finally {
    store.close();
  }
}

function renderConversation(messages) {
  return messages.map(message => {
    const raw = String(message.timestamp || "");
    let time = raw.slice(11, 16);
    if (raw.endsWith("Z")) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) {
        time = new Date(parsed.getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16);
      }
    }
    const source = message.sourceLabel ? `${message.sourceLabel} ` : "";
    return `[${source}${time || "--:--"} ${message.type || "user"}] ${message.text || ""}`;
  }).join("\n");
}

function sourceKey(timestamp, role, content) {
  return JSON.stringify([String(timestamp || ""), String(role || ""), String(content || "")]);
}

function loadSourceIndex() {
  if (sourceIndexCache) return sourceIndexCache;
  const index = new Map();
  if (fs.existsSync(SOURCE_ARCHIVE_FILE)) {
    for (const line of fs.readFileSync(SOURCE_ARCHIVE_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        index.set(sourceKey(row.timestamp, row.role, row.content), row.source_file || "unknown");
      } catch {}
    }
  }
  sourceIndexCache = index;
  return index;
}

function attachHistoricalSources(messages) {
  const index = loadSourceIndex();
  const sourceRows = new Map();
  let matched = 0;
  for (const message of messages) {
    const sourceName = index.get(sourceKey(message.timestamp, message.type, message.text)) || "unmatched";
    if (sourceName !== "unmatched") matched++;
    if (!sourceRows.has(sourceName)) sourceRows.set(sourceName, []);
    sourceRows.get(sourceName).push(message);
  }
  const ordered = [...sourceRows.entries()].sort((left, right) =>
    String(left[1][0]?.timestamp || "").localeCompare(String(right[1][0]?.timestamp || "")));
  const labeled = [];
  ordered.forEach(([sourceName, rows], indexValue) => {
    const label = `来源${String.fromCharCode(65 + Math.min(indexValue, 25))}`;
    for (const row of rows) labeled.push({ ...row, sourceLabel: label, sourceName });
  });
  return {
    messages: labeled,
    matched,
    sourceCount: ordered.length,
    unmatched: messages.length - matched,
  };
}

function loadHistoricalRuleParts() {
  const raw = fs.readFileSync(HISTORICAL_RULES_FILE, "utf8");
  const sections = raw.split(/\n(?=## )/).filter(value => value.startsWith("## "));
  if (sections.length < 5) throw new Error("historical enhancement sections are incomplete");
  return {
    raw,
    parts: {
      sourceAware: sections[0].trim(),
      relationshipPlatform: sections[1].trim(),
      emotional: sections[2].trim(),
      conflict: sections[3].trim(),
      strictBoundaries: sections[4].split("\n\nDaily feelings")[0].trim(),
    },
  };
}

function normalizeRuleSelection(input) {
  const incoming = input?.rules && typeof input.rules === "object" ? input.rules : {};
  const legacyHistorical = !!input?.historical;
  return {
    sourceAware: incoming.sourceAware ?? legacyHistorical,
    relationshipPlatform: incoming.relationshipPlatform ?? legacyHistorical,
    emotional: incoming.emotional ?? legacyHistorical,
    conflict: incoming.conflict ?? legacyHistorical,
    intimacy: incoming.intimacy ?? !!input?.intimacy,
    countLimit: incoming.countLimit ?? !!input?.countLimit,
    strictBoundaries: incoming.strictBoundaries ?? legacyHistorical,
  };
}

function selectedRuleTexts(rules, historicalParts) {
  return [
    rules.sourceAware ? historicalParts.sourceAware : "",
    rules.relationshipPlatform ? historicalParts.relationshipPlatform : "",
    rules.emotional ? historicalParts.emotional : "",
    rules.conflict ? historicalParts.conflict : "",
    rules.intimacy ? INTIMACY_ADDENDUM : "",
    rules.countLimit ? COUNT_ADDENDUM : "",
    rules.strictBoundaries ? historicalParts.strictBoundaries : "",
  ].filter(Boolean);
}

function buildPrompt({ operations, ruleTexts = [], date, chunkIndex, chunkCount, previousFeelings }) {
  const [, month, day] = date.split("-");
  const dateLabel = `${Number(month)}?${Number(day)}?`;
  const additions = ruleTexts.join("\n\n");
  const chunkRule = chunkCount > 1
    ? `\n这是当天对话的第 ${chunkIndex + 1}/${chunkCount} 部分。只记录本部分真实出现的事件；不要补写前后块内容。内容较少时可以返回空数组。`
    : "";
  const previous = previousFeelings.length
    ? `\n上一块最后 ${Math.min(5, previousFeelings.length)} 条 feelings 如下，只用于理解指代和避免重复，禁止再次输出：\n${JSON.stringify(previousFeelings.slice(-5))}`
    : "";
  return `${operations}${additions ? `\n\n${additions}` : ""}

以下是 ${dateLabel} 的对话记录。你只能记录这一天实际发生的对话。即使对话提到别的日期，也只记录今天的交谈与今天发生的事。每条 feelings 必须以“${dateLabel}，”开头。${chunkRule}${previous}

只输出一个 JSON 对象：{"feelings":[...],"features":[...]}。不要输出 Markdown 或解释。`;
}

function parseModelJson(text) {
  const raw = String(text || "").trim();
  const attempts = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) attempts.push(fenced[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(raw.slice(first, last + 1));
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.feelings) && Array.isArray(parsed.features)) return parsed;
    } catch {}
  }
  throw new Error("模型返回内容不是 feelings/features JSON 对象");
}

async function callApiModel(model, systemPrompt, conversation, config) {
  const credentials = config.apiKeys?.[model.provider];
  if (!credentials?.key || !credentials?.baseUrl) throw new Error(`${model.label} 尚未配置可用 API`);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${credentials.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credentials.key}`,
        },
        body: JSON.stringify({
          model: model.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: conversation },
          ],
          temperature: 0.5,
          max_tokens: 6000,
        }),
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`API ${response.status}: ${body.slice(0, 300)}`);
      const payload = JSON.parse(body);
      return parseModelJson(payload?.choices?.[0]?.message?.content);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (2 ** attempt)));
    }
  }
  throw lastError;
}

function runCodex(model, systemPrompt, conversation) {
  ensureDirectories();
  const nonce = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const schemaFile = path.join(TEMP_DIR, `${nonce}.schema.json`);
  const outputFile = path.join(TEMP_DIR, `${nonce}.output.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(OUTPUT_SCHEMA), { mode: 0o600 });
  const prompt = `${systemPrompt}

<conversation>
${conversation}
</conversation>

只把最终 JSON 写到回答中，不要调用工具，不要修改文件。`;
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-s", "read-only",
    "-C", STATE_DIR,
    "-m", model.model,
    "-c", `model_reasoning_effort="${model.reasoning}"`,
    "--output-schema", schemaFile,
    "-o", outputFile,
    "-",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, HOME: "/home/ubuntu" },
    });
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1000);
    child.stderr.on("data", chunk => {
      if (stderr.length < 20000) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw new Error(`Codex 运行失败 (${code}): ${stderr.slice(-1000)}`);
        const result = parseModelJson(fs.readFileSync(outputFile, "utf8"));
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        for (const file of [schemaFile, outputFile]) {
          try { fs.unlinkSync(file); } catch {}
        }
      }
    });
    child.stdin.end(prompt, "utf8");
  });
}

function normalizeImportance(value) {
  const number = Number(value);
  if (number >= 5) return 5;
  if (number <= 2) return 2;
  return 3;
}

function eventTimeFor(content, date) {
  const parsed = parseFeelingTime(String(content || ""));
  if (parsed?.hour == null) return null;
  return new Date(`${date}T${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute || 0).padStart(2, "0")}:00+08:00`).toISOString();
}

function normalizeResults(rawFeelings, rawFeatures, date, countLimit) {
  const feelingSet = new Set();
  const feelings = rawFeelings.flatMap(row => {
    const content = String(row?.content || "").trim();
    if (!content || feelingSet.has(content)) return [];
    feelingSet.add(content);
    return [{
      content,
      importance: normalizeImportance(row.importance),
      eventTime: eventTimeFor(content, date),
    }];
  }).sort((a, b) => String(a.eventTime || "").localeCompare(String(b.eventTime || "")));
  const featureSet = new Set();
  const features = rawFeatures.flatMap(row => {
    const content = String(row?.content || "").trim();
    if (!content || featureSet.has(content)) return [];
    featureSet.add(content);
    const category = FEATURE_CATEGORIES.has(row.category) ? row.category : "misc";
    return [{ content, category, importance: normalizeImportance(row.importance) }];
  });
  return {
    feelings: countLimit ? feelings.slice(0, 20) : feelings,
    features,
    trimmedFeelings: countLimit ? Math.max(0, feelings.length - 20) : 0,
  };
}

async function generatePreview(input) {
  const config = loadConfig();
  const thread = configuredThread(config, input.threadId);
  const model = MODELS[input.model];
  if (!model) throw new Error("请选择有效模型");
  if (thread.purpose !== "accompany") throw new Error("作者陪伴提示词只用于陪伴型记忆体");
  const date = String(input.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("请选择有效日期");
  const lockKey = `${input.threadId}:${date}`;
  if (activePreviews.has(lockKey)) throw new Error("这一天已有候选正在生成");
  activePreviews.add(lockKey);
  const store = new MemoryStore({ memoryDir: MEMORY_DIR, threadId: input.threadId });
  try {
    const messages = store.listMessages({ date });
    if (!messages.length) throw new Error("这一天没有可挖掘对话");
    const operationsRaw = fs.readFileSync(OPERATIONS_FILE, "utf8");
    const operations = operationsRaw
      .split("{aiName}").join(thread.ai || "AI")
      .split("{userName}").join(thread.user || "用户");
    const rules = normalizeRuleSelection(input);
    const historical = loadHistoricalRuleParts();
    const ruleTexts = selectedRuleTexts(rules, historical.parts);
    const sourceContext = rules.sourceAware
      ? attachHistoricalSources(messages)
      : { messages, matched: 0, sourceCount: 0, unmatched: 0 };
    const chunks = splitMiningMessages(sourceContext.messages, { render: renderConversation });
    const rawFeelings = [];
    const rawFeatures = [];
    for (let index = 0; index < chunks.length; index++) {
      const prompt = buildPrompt({
        operations,
        ruleTexts,
        date,
        chunkIndex: index,
        chunkCount: chunks.length,
        previousFeelings: rawFeelings,
      });
      const conversation = renderConversation(chunks[index]);
      const result = model.kind === "api"
        ? await callApiModel(model, prompt, conversation, config)
        : await runCodex(model, prompt, conversation);
      rawFeelings.push(...result.feelings);
      rawFeatures.push(...result.features);
    }
    const normalized = normalizeResults(rawFeelings, rawFeatures, date, rules.countLimit);
    const now = new Date().toISOString();
    const candidate = {
      version: 1,
      id: `candidate-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
      threadId: input.threadId,
      publicThreadId: publicThreadId(input.threadId),
      libraryLabel: thread.label || publicThreadId(input.threadId),
      date,
      model: input.model,
      modelLabel: model.label,
      preset: ["author", "daily-intimacy", "july", "custom"].includes(input.preset)
        ? input.preset
        : "custom",
      rules,
      options: rules,
      historicalSourceAudit: rules.sourceAware ? {
        matchedMessages: sourceContext.matched,
        unmatchedMessages: sourceContext.unmatched,
        sourceCount: sourceContext.sourceCount,
      } : null,
      sourcePrompt: "operations/memory-miner-operations.md",
      sourcePromptSha256: crypto.createHash("sha256").update(operationsRaw).digest("hex"),
      historicalRulesSha256: ruleTexts.length
        ? crypto.createHash("sha256").update(ruleTexts.join("\n\n")).digest("hex")
        : null,
      archiveFingerprint: archiveFingerprint(messages),
      messageCount: messages.length,
      chunkCount: chunks.length,
      priorCounts: {
        feelings: store.listFeelings({ date }).length,
        features: store.listFeatures({ date }).length,
      },
      feelings: normalized.feelings,
      features: normalized.features,
      trimmedFeelings: normalized.trimmedFeelings,
      createdAt: now,
      status: "review_pending",
      appliedAt: null,
      backup: null,
    };
    fs.writeFileSync(path.join(CANDIDATE_DIR, `${candidate.id}.json`), JSON.stringify(candidate, null, 2), { mode: 0o600 });
    return candidate;
  } finally {
    store.close();
    activePreviews.delete(lockKey);
  }
}

function candidatePath(id) {
  if (!/^candidate-\d+-[0-9a-f]{10}$/.test(String(id || ""))) throw new Error("候选 ID 不正确");
  return path.join(CANDIDATE_DIR, `${id}.json`);
}

function loadCandidate(id) {
  return JSON.parse(fs.readFileSync(candidatePath(id), "utf8"));
}

function listCandidates(threadId, date) {
  ensureDirectories();
  return fs.readdirSync(CANDIDATE_DIR)
    .filter(name => name.endsWith(".json"))
    .flatMap(name => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(CANDIDATE_DIR, name), "utf8"));
        if (threadId && value.threadId !== threadId) return [];
        if (date && value.date !== date) return [];
        return [value];
      } catch {
        return [];
      }
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function previewJobPath(id) {
  if (!/^preview-\d+-[0-9a-f]{10}$/.test(String(id || ""))) throw new Error("预览任务 ID 不正确");
  return path.join(PREVIEW_JOB_DIR, `${id}.json`);
}

function friendlyPreviewError(error) {
  const message = String(error?.message || error || "候选生成失败").replace(/\s+/g, " ").trim();
  if (/524|A timeout occurred|<!DOCTYPE html/i.test(message)) {
    return "上游连接等待超时（524）。任务若已在服务器开始，候选可能仍会完成；请稍后刷新候选列表，避免立即重复调用模型。";
  }
  return message.slice(0, 1200);
}

function savePreviewJob(job) {
  ensureDirectories();
  previewJobs.set(job.id, job);
  fs.writeFileSync(previewJobPath(job.id), JSON.stringify(job, null, 2), { mode: 0o600 });
}

function loadPreviewJob(id) {
  if (previewJobs.has(id)) return previewJobs.get(id);
  const job = JSON.parse(fs.readFileSync(previewJobPath(id), "utf8"));
  if (["queued", "running"].includes(job.status) && job.runInstance !== RUN_INSTANCE) {
    job.status = "failed";
    job.error = "服务在任务期间重启。请先刷新候选列表；若没有新候选，再重新生成。";
    job.finishedAt = new Date().toISOString();
    savePreviewJob(job);
  }
  return job;
}

function publicPreviewJob(job) {
  const value = {
    id: job.id,
    status: job.status,
    threadId: job.threadId,
    date: job.date,
    model: job.model,
    modelLabel: job.modelLabel,
    preset: job.preset,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    candidateId: job.candidateId,
  };
  if (job.status === "completed" && job.candidateId) value.candidate = loadCandidate(job.candidateId);
  return value;
}

function prunePreviewJobs() {
  ensureDirectories();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(PREVIEW_JOB_DIR)) {
    if (!/^preview-\d+-[0-9a-f]{10}\.json$/.test(name)) continue;
    const file = path.join(PREVIEW_JOB_DIR, name);
    try {
      const job = JSON.parse(fs.readFileSync(file, "utf8"));
      const terminal = ["completed", "failed"].includes(job.status);
      const time = Date.parse(job.finishedAt || job.createdAt || "");
      if (terminal && Number.isFinite(time) && time < cutoff) {
        previewJobs.delete(job.id);
        fs.unlinkSync(file);
      }
    } catch {}
  }
}

function startPreviewJob(input) {
  prunePreviewJobs();
  const model = MODELS[input?.model];
  const now = new Date().toISOString();
  const job = {
    version: 1,
    id: `preview-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
    status: "queued",
    threadId: String(input?.threadId || ""),
    date: String(input?.date || ""),
    model: String(input?.model || ""),
    modelLabel: model?.label || String(input?.model || "未知模型"),
    preset: String(input?.preset || "custom"),
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    candidateId: null,
    error: null,
    runInstance: RUN_INSTANCE,
  };
  savePreviewJob(job);
  setImmediate(async () => {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    savePreviewJob(job);
    try {
      const candidate = await generatePreview(input);
      job.status = "completed";
      job.candidateId = candidate.id;
    } catch (error) {
      job.status = "failed";
      job.error = friendlyPreviewError(error);
      console.error(`[companion] preview job ${job.id}:`, job.error);
    } finally {
      job.finishedAt = new Date().toISOString();
      savePreviewJob(job);
    }
  });
  return publicPreviewJob(job);
}

function getPreviewJob(id) {
  return publicPreviewJob(loadPreviewJob(id));
}
function buildHybridSelection(parentCandidates, selection, enforceCountLimit = false) {
  const parents = new Map(parentCandidates.map(candidate => [candidate.id, candidate]));
  const output = { feelings: [], features: [] };
  const provenance = { feelings: [], features: [] };
  const exactDuplicatesDropped = { feelings: 0, features: 0 };

  for (const kind of ["feelings", "features"]) {
    const requested = Array.isArray(selection?.[kind]) ? selection[kind] : [];
    if (requested.length > 200) throw new Error("单类混合选择不能超过 200 条");
    const seenReferences = new Set();
    const seenContent = new Set();
    const picked = [];
    for (const reference of requested) {
      const candidateId = String(reference?.candidateId || "");
      const index = Number(reference?.index);
      const referenceKey = `${candidateId}:${index}`;
      if (seenReferences.has(referenceKey)) continue;
      seenReferences.add(referenceKey);
      const candidate = parents.get(candidateId);
      if (!candidate) throw new Error("混合选择引用了不存在的候选");
      if (candidate.status !== "review_pending") throw new Error("混合选择中包含已经处理过的候选");
      if (candidate.model === "hybrid") throw new Error("混合候选不能再次嵌套混合");
      if (!Number.isInteger(index) || index < 0 || index >= (candidate[kind]?.length || 0)) {
        throw new Error("混合选择中的条目位置不正确");
      }
      const sourceRow = candidate[kind][index];
      const row = { ...sourceRow };
      let edited = false;
      if (kind === "feelings" && Object.prototype.hasOwnProperty.call(reference, "content")) {
        const content = String(reference.content || "").trim();
        if (!content) throw new Error("修改后的摘要不能为空");
        if (content.length > 2000) throw new Error("修改后的摘要不能超过 2000 字");
        const eventTime = eventTimeFor(content, candidate.date);
        if (!eventTime) throw new Error("修改后的摘要必须保留完整日期和可识别的具体时间");
        edited = content !== String(sourceRow.content || "").trim();
        row.content = content;
        row.eventTime = eventTime;
      }
      const contentKey = String(row?.content || "").trim();
      if (!contentKey) continue;
      if (seenContent.has(contentKey)) {
        exactDuplicatesDropped[kind]++;
        continue;
      }
      seenContent.add(contentKey);
      picked.push({
        row: { ...row },
        provenance: {
          candidateId,
          model: candidate.model,
          modelLabel: candidate.modelLabel,
          originalIndex: index,
          edited,
          originalContentSha256: edited
            ? crypto.createHash("sha256").update(String(sourceRow.content || "")).digest("hex")
            : null,
        },
      });
    }
    if (kind === "feelings") {
      picked.sort((left, right) =>
        String(left.row.eventTime || "").localeCompare(String(right.row.eventTime || "")));
    }
    output[kind] = picked.map(item => item.row);
    provenance[kind] = picked.map(item => item.provenance);
  }

  if (!output.feelings.length && !output.features.length) throw new Error("请至少选择一条记忆");
  if (enforceCountLimit && output.feelings.length > 20) {
    throw new Error("已启用每日 8–20 条限制，混合摘要不能超过 20 条");
  }
  return { ...output, provenance, exactDuplicatesDropped };
}

function candidateEvidence(id, kind, index) {
  if (kind !== "feelings") throw new Error("当前仅支持查看摘要的时间附近原文");
  const candidate = loadCandidate(id);
  const itemIndex = Number(index);
  const row = candidate.feelings?.[itemIndex];
  if (!row || !Number.isInteger(itemIndex) || itemIndex < 0) throw new Error("候选摘要位置不正确");
  const targetTime = Date.parse(row.eventTime || "");
  if (!Number.isFinite(targetTime)) throw new Error("这条摘要没有可用于定位原文的事件时间");
  const store = new MemoryStore({ memoryDir: MEMORY_DIR, threadId: candidate.threadId });
  try {
    const messages = store.listMessages({ date: candidate.date });
    if (!messages.length) return { date: candidate.date, eventTime: row.eventTime, inferred: true, rows: [] };
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    messages.forEach((message, messageIndex) => {
      const timestamp = Date.parse(message.timestamp || "");
      const distance = Number.isFinite(timestamp) ? Math.abs(timestamp - targetTime) : Number.POSITIVE_INFINITY;
      if (distance < nearestDistance) {
        nearest = messageIndex;
        nearestDistance = distance;
      }
    });
    const start = Math.max(0, nearest - 3);
    const end = Math.min(messages.length, nearest + 4);
    return {
      date: candidate.date,
      eventTime: row.eventTime,
      inferred: true,
      note: "按摘要事件时间定位的附近原文，仅供人工核对，不代表模型提供了精确证据引用。",
      rows: messages.slice(start, end).map(message => ({
        timestamp: message.timestamp,
        role: message.type,
        text: message.text,
      })),
    };
  } finally {
    store.close();
  }
}

function createHybridCandidate(input) {
  ensureDirectories();
  const config = loadConfig();
  const thread = configuredThread(config, input.threadId);
  const date = String(input.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("请选择有效日期");
  const selection = input.selection && typeof input.selection === "object" ? input.selection : {};
  const references = [...(selection.feelings || []), ...(selection.features || [])];
  const parentIds = [...new Set(references.map(reference => String(reference?.candidateId || "")))];
  if (!parentIds.length) throw new Error("请至少选择一条记忆");
  const parents = parentIds.map(loadCandidate);
  for (const candidate of parents) {
    if (candidate.threadId !== input.threadId || candidate.date !== date) {
      throw new Error("只能混合同一记忆体、同一天的候选");
    }
  }
  const fingerprints = new Set(parents.map(candidate => candidate.archiveFingerprint));
  if (fingerprints.size !== 1) throw new Error("这些候选基于不同版本的原始对话，请重新生成");
  const enforceCountLimit = !!input.enforceCountLimit;
  const mixed = buildHybridSelection(parents, selection, enforceCountLimit);
  const store = new MemoryStore({ memoryDir: MEMORY_DIR, threadId: input.threadId });
  try {
    const messages = store.listMessages({ date });
    const currentFingerprint = archiveFingerprint(messages);
    if (currentFingerprint !== parents[0].archiveFingerprint) {
      throw new Error("原始对话在候选生成后发生变化，请重新生成候选");
    }
    const now = new Date().toISOString();
    const modelLabels = [...new Set(mixed.provenance.feelings
      .concat(mixed.provenance.features)
      .map(item => item.modelLabel))];
    const parentRules = Object.fromEntries(parents.map(candidate => [
      candidate.id,
      normalizeRuleSelection(candidate),
    ]));
    const candidate = {
      version: 2,
      id: `candidate-${Date.now()}-${crypto.randomBytes(5).toString("hex")}`,
      threadId: input.threadId,
      publicThreadId: publicThreadId(input.threadId),
      libraryLabel: thread.label || publicThreadId(input.threadId),
      date,
      model: "hybrid",
      modelLabel: `混合精选 · ${modelLabels.length} 个模型`,
      preset: "custom",
      rules: {},
      options: { hybrid: true, countLimit: enforceCountLimit },
      sourcePrompt: "mixed from reviewed model candidates",
      sourcePromptSha256: null,
      archiveFingerprint: currentFingerprint,
      messageCount: messages.length,
      chunkCount: null,
      priorCounts: {
        feelings: store.listFeelings({ date }).length,
        features: store.listFeatures({ date }).length,
      },
      feelings: mixed.feelings,
      features: mixed.features,
      trimmedFeelings: 0,
      hybrid: {
        parentCandidateIds: parentIds,
        modelLabels,
        enforceCountLimit,
        selectionProvenance: mixed.provenance,
        exactDuplicatesDropped: mixed.exactDuplicatesDropped,
        parentRules,
      },
      createdAt: now,
      status: "review_pending",
      appliedAt: null,
      backup: null,
    };
    fs.writeFileSync(candidatePath(candidate.id), JSON.stringify(candidate, null, 2), { mode: 0o600 });
    return candidate;
  } finally {
    store.close();
  }
}

function discardSiblingCandidates(appliedCandidate) {
  for (const candidate of listCandidates(appliedCandidate.threadId, appliedCandidate.date)) {
    if (candidate.id === appliedCandidate.id || candidate.status !== "review_pending") continue;
    candidate.status = "discarded";
    candidate.discardedAt = new Date().toISOString();
    candidate.discardReason = `superseded_by:${appliedCandidate.id}`;
    fs.writeFileSync(candidatePath(candidate.id), JSON.stringify(candidate, null, 2), { mode: 0o600 });
  }
}

async function applyCandidate(id) {
  const candidate = loadCandidate(id);
  if (candidate.status !== "review_pending") throw new Error("这份候选已经处理过，不能重复写入");
  const config = loadConfig();
  configuredThread(config, candidate.threadId);
  const store = new MemoryStore({ memoryDir: MEMORY_DIR, threadId: candidate.threadId });
  try {
    const messages = store.listMessages({ date: candidate.date });
    const currentFingerprint = archiveFingerprint(messages);
    if (currentFingerprint !== candidate.archiveFingerprint) throw new Error("原始对话在候选生成后发生变化，请重新生成候选");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const backupPath = path.join(BACKUP_DIR, `${stamp}-before-companion-${candidate.date}.db`);
    await store.db.backup(backupPath);
    const backupSha256 = crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex");
    const now = new Date().toISOString();
    const instruction = JSON.stringify({
      companion: true,
      candidateId: candidate.id,
      model: candidate.model,
      parentCandidateIds: candidate.hybrid?.parentCandidateIds || null,
      options: candidate.options,
      promptSha256: candidate.sourcePromptSha256,
    });
    const job = store.createJob({
      sourceDate: candidate.date,
      mode: "remine",
      triggerType: "web",
      publishStrategy: "replace",
      instruction,
    });
    store.updateJob(job.id, { status: "running", startedAt: now });
    try {
      const result = store.replaceDay(candidate.date, {
        feelings: candidate.feelings,
        features: candidate.features,
        source: "remine",
        miningJobId: job.id,
        dayState: {
          status: candidate.feelings.length || candidate.features.length ? "completed" : "completed_empty",
          messageCount: messages.length,
          feelingCount: candidate.feelings.length,
          featureCount: candidate.features.length,
          attempt: 1,
          archiveFingerprint: currentFingerprint,
          completedAt: now,
          updatedAt: now,
        },
      });
      store.updateJob(job.id, {
        status: "completed",
        feelingCount: candidate.feelings.length,
        featureCount: candidate.features.length,
        finishedAt: now,
        publishedAt: now,
      });
      candidate.status = "applied";
      candidate.appliedAt = now;
      candidate.backup = { path: backupPath, sha256: backupSha256 };
      fs.writeFileSync(candidatePath(id), JSON.stringify(candidate, null, 2), { mode: 0o600 });
      discardSiblingCandidates(candidate);
      return {
        ok: true,
        date: candidate.date,
        feelings: result.feelings.length,
        features: result.features.length,
        backup: { filename: path.basename(backupPath), sha256: backupSha256 },
      };
    } catch (error) {
      store.updateJob(job.id, {
        status: "failed",
        errorCode: error.code || "COMPANION_APPLY_FAILED",
        errorMessage: error.message,
        finishedAt: new Date().toISOString(),
      });
      throw error;
    }
  } finally {
    store.close();
  }
}

function discardCandidate(id) {
  const candidate = loadCandidate(id);
  if (candidate.status !== "review_pending") throw new Error("这份候选已经处理过");
  candidate.status = "discarded";
  candidate.discardedAt = new Date().toISOString();
  fs.writeFileSync(candidatePath(id), JSON.stringify(candidate, null, 2), { mode: 0o600 });
  return { ok: true };
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  return "application/octet-stream";
}

function send(res, status, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
  res.writeHead(status, {
    "content-length": data.length,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(data);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8" });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function servePublic(res, pathname) {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-z0-9._-]+$/i.test(name)) return false;
  const file = path.join(PUBLIC_DIR, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  send(res, 200, fs.readFileSync(file), { "content-type": contentType(file) });
  return true;
}

async function route(req, res) {
  const url = new URL(req.url || "/", "http://stone-companion.local");
  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/libraries") return json(res, 200, listLibraries());
    if (req.method === "GET" && url.pathname === "/api/dates") {
      return json(res, 200, { dates: listDates(url.searchParams.get("threadId")) });
    }
    if (req.method === "GET" && url.pathname === "/api/candidates") {
      return json(res, 200, {
        candidates: listCandidates(url.searchParams.get("threadId"), url.searchParams.get("date")),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/preview") {
      const body = await readJson(req);
      return json(res, 202, { job: startPreviewJob(body) });
    }
    const previewJobMatch = url.pathname.match(/^\/api\/preview-jobs\/([^/]+)$/);
    if (req.method === "GET" && previewJobMatch) {
      return json(res, 200, { job: getPreviewJob(previewJobMatch[1]) });
    }
    if (req.method === "POST" && url.pathname === "/api/hybrid") {
      const body = await readJson(req);
      return json(res, 200, { candidate: createHybridCandidate(body) });
    }
    const evidenceMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/evidence$/);
    if (req.method === "GET" && evidenceMatch) {
      return json(res, 200, candidateEvidence(
        evidenceMatch[1],
        String(url.searchParams.get("kind") || ""),
        Number(url.searchParams.get("index")),
      ));
    }
    const candidateMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/(apply|discard)$/);
    if (req.method === "POST" && candidateMatch) {
      return json(res, 200, candidateMatch[2] === "apply"
        ? await applyCandidate(candidateMatch[1])
        : discardCandidate(candidateMatch[1]));
    }
    if (req.method === "GET" && servePublic(res, url.pathname)) return;
    send(res, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
  } catch (error) {
    console.error(`[companion] ${req.method} ${url.pathname}:`, error);
    json(res, 400, { error: error.message || String(error) });
  }
}

if (require.main === module) {
  ensureDirectories();
  const server = http.createServer((req, res) => route(req, res));
  server.listen(PORT, HOST, () => {
    process.stdout.write(`stone-memory-companion listening on ${HOST}:${PORT}\n`);
  });
}

module.exports = {
  MODELS,
  RULE_KEYS,
  attachHistoricalSources,
  buildHybridSelection,
  buildPrompt,
  candidateEvidence,
  createHybridCandidate,
  friendlyPreviewError,
  getPreviewJob,
  loadHistoricalRuleParts,
  normalizeResults,
  normalizeRuleSelection,
  parseModelJson,
  renderConversation,
  selectedRuleTexts,
};
