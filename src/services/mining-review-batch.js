const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { normalizeMiningApiProfile } = require("./mining-api-profile");

const ALLOWED_GROUP_DAYS = new Set([2, 3]);
const ALLOWED_CHUNK_KB = new Set([50, 100, 150, 200]);
const ALLOWED_PARALLEL = new Set([1, 2, 3]);
const ALLOWED_REASONING = new Set(["minimal", "low", "medium", "high", "xhigh"]);

function normalizeDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00Z`).getTime())) {
    throw new Error(`invalid batch date: ${date || "(empty)"}`);
  }
  return date;
}

function isConsecutive(left, right) {
  return new Date(`${right}T00:00:00Z`).getTime() - new Date(`${left}T00:00:00Z`).getTime() === 86400000;
}

function groupReviewDates(input, groupDays = 3) {
  const max = Number(groupDays);
  if (!ALLOWED_GROUP_DAYS.has(max)) throw new Error("groupDays must be 2 or 3");
  const dates = [...new Set((input || []).map(normalizeDate))].sort();
  const groups = [];
  let current = [];
  for (const date of dates) {
    if (current.length && (!isConsecutive(current.at(-1), date) || current.length >= max)) {
      groups.push(current);
      current = [];
    }
    current.push(date);
  }
  if (current.length) groups.push(current);
  return groups;
}

function configuredRuntimeIds(config = {}, threadId = "") {
  const ids = new Set(["claude", "codex", ...Object.keys(config.runtimes || {})]);
  const current = String(config[threadId]?.runtime || "").trim();
  if (current) ids.add(current);
  return ids;
}

function safeModel(value) {
  const model = String(value || "").trim();
  if (model && !/^[A-Za-z0-9._:/+-]{1,128}$/.test(model)) {
    throw new Error("batch model name contains unsupported characters");
  }
  return model || null;
}

function normalizeProfile(profile, { config = {}, threadId = "" } = {}) {
  if (!profile || typeof profile !== "object") throw new Error("batch requires one profile");
  const channel = String(profile.channel || "");
  const model = safeModel(profile.model);
  if (channel === "api") {
    const provider = String(profile.provider || config[threadId]?.apiProvider || "").trim();
    if (!provider || !config.apiKeys?.[provider]) throw new Error(`batch API provider is not configured: ${provider || "(empty)"}`);
    const apiProfile = normalizeMiningApiProfile(profile.apiProfile);
    return {
      id: String(profile.id || `api:${provider}:${model || "configured"}:${apiProfile}`).slice(0, 180),
      label: String(profile.label || `${provider} · ${model || "已配置模型"}`).trim().slice(0, 120),
      channel: "api",
      provider,
      model,
      apiProfile,
      runtime: null,
      reasoning: null,
    };
  }
  if (channel !== "subagent") throw new Error(`unsupported batch channel: ${channel || "(empty)"}`);
  const runtime = String(profile.runtime || config[threadId]?.runtime || "").trim();
  if (!configuredRuntimeIds(config, threadId).has(runtime)) {
    throw new Error(`batch runtime is not configured: ${runtime || "(empty)"}`);
  }
  const reasoning = String(profile.reasoning || "").trim() || null;
  if (reasoning && runtime !== "codex") throw new Error("reasoning effort is only supported by Codex");
  if (reasoning && !ALLOWED_REASONING.has(reasoning)) throw new Error("unsupported Codex reasoning effort");
  return {
    id: String(profile.id || `subagent:${runtime}:${model || "configured"}:${reasoning || "default"}`).slice(0, 180),
    label: String(profile.label || `${runtime} · ${model || "已配置模型"}`).trim().slice(0, 120),
    channel: "subagent",
    runtime,
    model,
    reasoning,
    provider: null,
    apiProfile: null,
  };
}

function buildReviewBatchPlan(input, { config = {}, threadId = "" } = {}) {
  const groupDays = Number(input?.groupDays ?? 3);
  const requestedChunkKb = input?.chunkKb ?? 100;
  const chunkKb = requestedChunkKb === "auto" || requestedChunkKb === null ? null : Number(requestedChunkKb);
  const parallel = Number(input?.parallel ?? 2);
  if (chunkKb !== null && !ALLOWED_CHUNK_KB.has(chunkKb)) {
    throw new Error("chunkKb must be auto or one of 50, 100, 150 or 200");
  }
  if (!ALLOWED_PARALLEL.has(parallel)) throw new Error("parallel must be 1, 2 or 3");
  const groups = groupReviewDates(input?.dates, groupDays);
  if (!groups.length) throw new Error("batch requires at least one date");
  const profile = normalizeProfile(input?.profile, { config, threadId });
  const tasks = groups.map((dates, groupIndex) => {
    const fingerprint = crypto.createHash("sha256")
      .update(JSON.stringify({ dates, profile, chunkKb }))
      .digest("hex")
      .slice(0, 12);
    return {
      id: `task-${groupIndex + 1}-${fingerprint}`,
      groupIndex,
      dates,
      profile,
      chunkKb,
      action: dates.length === 1 ? "preview" : "preview-merged",
      status: "queued",
      candidateIds: [],
      error: null,
      startedAt: null,
      completedAt: null,
    };
  });
  return { groupDays, chunkKb, parallel, dates: groups.flat(), groups, profile, tasks };
}

class MiningReviewBatchStore {
  constructor({ memoryDir, threadId }) {
    if (!memoryDir || !threadId) throw new Error("memoryDir and threadId are required");
    this.threadId = threadId;
    this.dir = path.join(memoryDir, "review-batches");
  }

  create(input, options = {}) {
    const plan = buildReviewBatchPlan(input, { ...options, threadId: this.threadId });
    const now = new Date().toISOString();
    const record = {
      version: 1,
      id: `batch-${crypto.randomUUID()}`,
      threadId: this.threadId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      groupDays: plan.groupDays,
      chunkKb: plan.chunkKb,
      parallel: plan.parallel,
      dates: plan.dates,
      groups: plan.groups,
      profile: plan.profile,
      tasks: plan.tasks,
      ruleIds: [...new Set((input.ruleIds || []).map(String))],
      additionalInstruction: String(input.additionalInstruction || "").trim().slice(0, 4000),
    };
    this.write(record);
    return record;
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir)
      .filter(name => /^batch-[0-9a-f-]+\.json$/.test(name))
      .flatMap(name => {
        try {
          const row = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8"));
          return row.threadId === this.threadId ? [row] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  load(id) {
    if (!/^batch-[0-9a-f-]+$/.test(String(id || ""))) throw new Error("invalid batch id");
    const record = JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8"));
    if (record.threadId !== this.threadId || record.id !== id) throw new Error("batch identity mismatch");
    return record;
  }

  update(id, mutate) {
    const record = this.load(id);
    mutate(record);
    record.updatedAt = new Date().toISOString();
    this.write(record);
    return record;
  }

  write(record) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = path.join(this.dir, `${record.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 0o600); } catch {}
  }

  acquireRunner(id) {
    const lock = path.join(this.dir, `${id}.lock`);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      fs.mkdirSync(lock);
    } catch {
      throw new Error("batch runner is already active");
    }
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid), { mode: 0o600 });
    return () => { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} };
  }
}

function taskCandidateIds(result) {
  const candidates = result?.candidates || (result?.id ? [result] : []);
  return candidates.map(candidate => candidate?.id).filter(Boolean);
}

async function runReviewBatch(store, batchId, executeTask) {
  if (typeof executeTask !== "function") throw new Error("batch runner requires executeTask");
  const release = store.acquireRunner(batchId);
  let record = store.update(batchId, row => {
    if (!row.startedAt) row.startedAt = new Date().toISOString();
    row.status = "running";
  });
  const workers = Array.from({ length: record.parallel }, async () => {
    while (true) {
      let task = null;
      record = store.update(batchId, row => {
        task = row.tasks.find(item => item.status === "queued") || null;
        if (task) {
          task.status = "running";
          task.startedAt = new Date().toISOString();
          task.error = null;
        }
      });
      if (!task) return;
      try {
        const output = await executeTask(task, record);
        const candidateIds = taskCandidateIds(output);
        store.update(batchId, row => {
          const current = row.tasks.find(item => item.id === task.id);
          Object.assign(current, {
            candidateIds,
            status: candidateIds.length ? "completed" : "completed_empty",
            completedAt: new Date().toISOString(),
          });
        });
      } catch (error) {
        store.update(batchId, row => {
          const current = row.tasks.find(item => item.id === task.id);
          Object.assign(current, {
            status: "failed",
            error: String(error.message || error).slice(0, 1000),
            completedAt: new Date().toISOString(),
          });
        });
      }
    }
  });
  try {
    await Promise.all(workers);
    return store.update(batchId, row => {
      row.status = row.tasks.some(task => task.status === "failed") ? "completed_with_failures" : "completed";
      row.completedAt = new Date().toISOString();
    });
  } finally {
    release();
  }
}

function prepareReviewBatchRetry(store, id) {
  return store.update(id, row => {
    for (const task of row.tasks) {
      if (task.status === "failed" || task.status === "running") {
        Object.assign(task, {
          status: "queued",
          error: null,
          candidateIds: [],
          startedAt: null,
          completedAt: null,
        });
      }
    }
    row.status = "queued";
    row.completedAt = null;
  });
}

module.exports = {
  ALLOWED_CHUNK_KB,
  buildReviewBatchPlan,
  configuredRuntimeIds,
  groupReviewDates,
  MiningReviewBatchStore,
  prepareReviewBatchRetry,
  runReviewBatch,
};
