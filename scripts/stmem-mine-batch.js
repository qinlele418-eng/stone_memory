const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { getThreadDir, loadConfig } = require("../src/config");
const { MiningReviewStore } = require("../src/services/mining-review");
const {
  MiningReviewBatchStore,
  prepareReviewBatchRetry,
  runReviewBatch,
} = require("../src/services/mining-review-batch");
const { normalizeMiningApiProfile } = require("../src/services/mining-api-profile");
const activeBatchChildren = new Set();

// Internal protocol used by the Web adapter to inspect/resume a persisted job.
// It is intentionally absent from the public CLI help; normal callers submit
// dates once and let runMiningSelection choose the execution strategy.
function miningBatchAction(args) {
  for (const action of ["create", "run", "retry", "status", "list"]) {
    if (args.includes(`--batch-${action}`)) return action;
  }
  return null;
}

async function runMiningSelection(input, { threadId, mode, apiProfile = "optimized", model = "" }) {
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const batches = new MiningReviewBatchStore({ memoryDir, threadId, directoryName: "mining-batches" });
  const reviews = new MiningReviewStore({ memoryDir, threadId, candidateDirectoryName: "mining-candidates" });
  let batch;
  if (input.resumeBatchId) {
    batch = prepareReviewBatchRetry(batches, String(input.resumeBatchId));
    if (!batch.autoApply) throw new Error("不能从正式挖掘入口续跑审阅室批次");
  } else {
    const config = loadConfig();
    const thread = config[threadId] || {};
    const profile = buildFormalProfile({ input, thread, mode, apiProfile, model });
    batch = batches.create({
      dates: input.dates,
      groupDays: input.groupDays ?? 3,
      chunkKb: input.chunkKb ?? 100,
      parallel: input.parallel ?? 2,
      profile,
      autoApply: true,
    }, { config });
  }
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    for (const child of activeBatchChildren) {
      try { child.kill("SIGTERM"); } catch {}
    }
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  let publishTail = Promise.resolve();
  try {
    const result = await runReviewBatch(batches, batch.id, async (task, record) => {
      if (cancelled) throw new Error("批量挖掘已由用户停止");
      const generated = await executeGenerationTask(task, record);
      if (cancelled) throw new Error("批量挖掘已由用户停止");
      const candidates = generated.candidates || (generated.id ? [generated] : []);
      // Model generation may run concurrently. SQLite backup + publication stays
      // serialized so two completed groups cannot contend for the same database.
      const previousPublish = publishTail;
      let releasePublish;
      publishTail = new Promise(resolve => { releasePublish = resolve; });
      await previousPublish;
      try {
        const applied = [];
        for (const candidate of candidates) applied.push(await reviews.apply(candidate.id));
        return { candidates, applied };
      } finally { releasePublish(); }
    });
    if (cancelled) {
      result.status = "cancelled";
      result.completedAt = new Date().toISOString();
      batches.write(result);
    }
    return result;
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}

function buildFormalProfile({ input, thread, mode, apiProfile, model }) {
  if (mode === "api") return {
    channel: "api",
    provider: String(input.provider || thread.apiProvider || ""),
    model: String(input.model || model || "") || null,
    apiProfile: normalizeMiningApiProfile(input.apiProfile || apiProfile),
  };
  if (mode !== "subagent") throw new Error("批量挖掘需要 API 或 Subagent 通道");
  return {
    channel: "subagent",
    runtime: String(input.runtime || thread.runtime || "claude"),
    model: String(input.model || model || "") || null,
    reasoning: input.reasoning || null,
  };
}

async function handleMiningBatch(args, { threadId }) {
  const action = miningBatchAction(args);
  if (!action) return null;
  const memoryDir = path.join(getThreadDir(threadId), "memory");
  const batches = new MiningReviewBatchStore({ memoryDir, threadId, directoryName: "mining-batches" });
  const reviews = new MiningReviewStore({ memoryDir, threadId, candidateDirectoryName: "mining-candidates" });
  if (action === "create") {
    const input = readBatchFile(args);
    const config = loadConfig();
    const thread = config[threadId] || {};
    const mode = input.mode === "api" ? "api" : input.mode === "subagent" ? "subagent" : null;
    if (!mode) throw new Error("批量挖掘需要 mode=api 或 mode=subagent");
    const profile = buildFormalProfile({ input, thread, mode, apiProfile: input.apiProfile, model: input.model });
    return batches.create({
      dates: input.dates,
      groupDays: input.groupDays ?? 3,
      chunkKb: input.chunkKb ?? 100,
      parallel: input.parallel ?? 2,
      profile,
      autoApply: true,
    }, { config });
  }
  if (action === "list") return { threadId, batches: batches.list().filter(row => row.autoApply) };
  const batchId = requiredValue(args, "--batch");
  if (action === "status") return batches.load(batchId);
  if (action === "retry") prepareReviewBatchRetry(batches, batchId);
  const record = batches.load(batchId);
  if (!record.autoApply) throw new Error("该批次属于记忆审阅室，不能由正式挖掘入口自动发布");
  return runReviewBatch(batches, batchId, async (task, batch) => {
    const generated = await executeGenerationTask(task, batch);
    const candidates = generated.candidates || (generated.id ? [generated] : []);
    const applied = [];
    for (const candidate of candidates) applied.push(await reviews.apply(candidate.id));
    return { candidates, applied };
  });
}

function executeGenerationTask(task, batch) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-mining-batch-task-"));
    const file = path.join(dir, "batch.json");
    fs.writeFileSync(file, JSON.stringify({
      profile: task.profile,
      dates: task.dates,
      chunkKb: task.chunkKb,
      batch: { id: batch.id, taskId: task.id, groupDates: task.dates, autoApply: true },
    }), { mode: 0o600 });
    const command = [path.join(__dirname, "..", "bin", "stmem"), "mine-review", task.action,
      "--thread", batch.threadId, "--batch-file", file, "--candidate-dir", "mining-candidates"];
    if (task.action === "preview") command.push("--date", task.dates[0]);
    const child = spawn(process.execPath, command, {
      cwd: path.join(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    });
    activeBatchChildren.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.once("error", finish);
    child.once("close", code => {
      if (code !== 0) return finish(new Error(lastError(stderr) || `批量挖掘子任务失败（退出码 ${code}）`));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new Error("批量挖掘子任务返回了无法识别的结果")); }
    });
    function finish(error, result) {
      activeBatchChildren.delete(child);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      if (error) reject(error); else resolve(result);
    }
  });
}

function readBatchFile(args) {
  const filename = requiredValue(args, "--batch-file");
  return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8"));
}

function requiredValue(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : "";
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function lastError(stderr) {
  return String(stderr || "").split(/\r?\n/).reverse().find(Boolean) || "";
}

module.exports = { handleMiningBatch, miningBatchAction, runMiningSelection };
