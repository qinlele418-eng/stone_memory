const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { miningBatchAction } = require("../scripts/stmem-mine-batch");
const { buildReviewBatchPlan, MiningReviewBatchStore } = require("../src/services/mining-review-batch");
const { MiningReviewStore } = require("../src/services/mining-review");

test("formal mining batch management remains an internal protocol", () => {
  assert.equal(miningBatchAction(["--batch-create"]), "create");
  assert.equal(miningBatchAction(["--batch-run", "--batch", "batch-1"]), "run");
  assert.equal(miningBatchAction(["--all"]), null);
});

test("formal mining batches group consecutive dates and bound concurrency", () => {
  const plan = buildReviewBatchPlan({
    dates: ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-05"],
    groupDays: 3,
    chunkKb: 100,
    parallel: 2,
    profile: { channel: "subagent", runtime: "codex" },
  }, { config: { runtimes: { codex: {} } }, threadId: "thread" });
  assert.deepEqual(plan.groups, [
    ["2026-08-01", "2026-08-02", "2026-08-03"],
    ["2026-08-05"],
  ]);
  assert.equal(plan.parallel, 2);
});

test("formal and review batches use isolated state directories", () => {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-formal-batch-"));
  const formal = new MiningReviewBatchStore({ memoryDir, threadId: "thread", directoryName: "mining-batches" });
  const review = new MiningReviewBatchStore({ memoryDir, threadId: "thread" });
  const formalCandidates = new MiningReviewStore({ memoryDir, threadId: "thread", candidateDirectoryName: "mining-candidates" });
  const reviewCandidates = new MiningReviewStore({ memoryDir, threadId: "thread" });
  assert.equal(formal.dir, path.join(memoryDir, "mining-batches"));
  assert.equal(review.dir, path.join(memoryDir, "review-batches"));
  assert.equal(formalCandidates.candidateDir, path.join(memoryDir, "mining-candidates"));
  assert.equal(reviewCandidates.candidateDir, path.join(memoryDir, "review-candidates"));
  fs.rmSync(memoryDir, { recursive: true, force: true });
});
