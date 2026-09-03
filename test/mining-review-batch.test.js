const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildReviewBatchPlan,
  groupReviewDates,
  MiningReviewBatchStore,
  prepareReviewBatchRetry,
  runReviewBatch,
} = require("../src/services/mining-review-batch");

const config = {
  runtimes: { codex: { command: "codex exec" } },
  thread: { runtime: "codex" },
  apiKeys: { deepseek: { model: "configured-model" } },
};

test("batch planner groups only consecutive dates and keeps a single-day tail", () => {
  assert.deepEqual(groupReviewDates([
    "2026-06-05", "2026-06-03", "2026-06-02", "2026-06-01", "2026-06-03", "2026-06-10",
  ], 3), [
    ["2026-06-01", "2026-06-02", "2026-06-03"], ["2026-06-05"], ["2026-06-10"],
  ]);
  assert.throws(() => groupReviewDates([], 4), /groupDays/);
  assert.throws(() => groupReviewDates(["bad"], 3), /invalid batch date/);
});

test("batch plan accepts one explicit API or CLI profile without hidden fallback", () => {
  const api = buildReviewBatchPlan({
    dates: ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"],
    groupDays: 3,
    chunkKb: 100,
    parallel: 2,
    profile: { channel: "api", provider: "deepseek", model: "configured-model", apiProfile: "optimized" },
  }, { config, threadId: "thread" });
  assert.equal(api.tasks.length, 2);
  assert.deepEqual(api.tasks.map(task => task.action), ["preview-merged", "preview"]);
  assert.ok(api.tasks.every(task => task.profile.channel === "api" && task.profile.apiProfile === "optimized"));

  const cli = buildReviewBatchPlan({
    dates: ["2026-06-01"],
    chunkKb: "auto",
    profile: { channel: "subagent", runtime: "codex", model: "gpt-test", reasoning: "low" },
  }, { config, threadId: "thread" });
  assert.equal(cli.chunkKb, null);
  assert.equal(cli.tasks[0].profile.runtime, "codex");
  assert.throws(() => buildReviewBatchPlan({ dates: ["2026-06-01"], profile: null }, { config, threadId: "thread" }), /one profile/);
  assert.throws(() => buildReviewBatchPlan({ dates: ["2026-06-01"], chunkKb: 300, profile: cli.profile }, { config, threadId: "thread" }), /chunkKb/);
});

test("batch profiles accept provider model identifiers with context suffixes", () => {
  const plan = buildReviewBatchPlan({
    dates: ["2026-06-01", "2026-06-02"],
    profile: { channel: "api", provider: "deepseek", model: "deepseek-v4-flash[1m]", apiProfile: "optimized" },
  }, { config, threadId: "thread" });
  assert.equal(plan.profile.model, "deepseek-v4-flash[1m]");
});

test("batch runner respects concurrency, continues failures and retries only failures", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-review-batch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new MiningReviewBatchStore({ memoryDir: dir, threadId: "thread" });
  const created = store.create({
    dates: ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06"],
    groupDays: 2,
    chunkKb: 100,
    parallel: 2,
    profile: { channel: "subagent", runtime: "codex", model: "gpt-test" },
    additionalInstruction: "synthetic instruction",
  }, { config });
  let active = 0;
  let peak = 0;
  const result = await runReviewBatch(store, created.id, async task => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (task.groupIndex === 1) throw new Error("synthetic failure");
    return { candidates: [{ id: `candidate-${task.groupIndex}` }] };
  });
  assert.equal(peak, 2);
  assert.deepEqual(result.tasks.map(task => task.status), ["completed", "failed", "completed"]);
  assert.equal(result.status, "completed_with_failures");
  const recordPath = path.join(dir, "review-batches", `${created.id}.json`);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(fs.readFileSync(recordPath, "utf8"), /conversation text|api[_ ]?key/i);

  prepareReviewBatchRetry(store, created.id);
  let retried = 0;
  const retriedResult = await runReviewBatch(store, created.id, async task => {
    retried++;
    return { candidates: [{ id: `candidate-retry-${task.groupIndex}` }] };
  });
  assert.equal(retried, 1);
  assert.equal(retriedResult.status, "completed");
  assert.equal(retriedResult.tasks[0].candidateIds[0], "candidate-0");
});
