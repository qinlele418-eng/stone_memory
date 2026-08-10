const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  enqueueRebuild,
  readQueue,
  removeQueuedRebuild,
  buildQueuedApplyArgs,
} = require("../src/services/rebuild-queue");

test("rebuild queue keeps one latest request per thread and applies through CLI args", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({ threadId: "a", window: 3, toolPairs: 10 }, file);
  enqueueRebuild({ threadId: "b", window: 4, toolPairs: 20 }, file);
  enqueueRebuild({ threadId: "a", window: 7, toolPairs: 30, watermark: true }, file);
  const rows = readQueue(file);
  assert.deepEqual(rows.map(row => row.threadId), ["b", "a"]);
  assert.notEqual(rows[0].requestId, rows[1].requestId);
  assert.deepEqual(buildQueuedApplyArgs(rows[1]), [
    "rebuild", "--thread", "a", "--window", "7", "--tool-pairs", "30",
    "--summary-limit", "0", "--min-importance", "0", "--trigger", "mcp", "--apply", "--watermark",
  ]);
  removeQueuedRebuild("a", file);
  assert.deepEqual(readQueue(file).map(row => row.threadId), ["b"]);
});

test("an old consumer cannot remove a newer request for the same thread", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-race-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldRequest = enqueueRebuild({ threadId: "thread-race", window: 3 }, file);
  const newRequest = enqueueRebuild({ threadId: "thread-race", window: 9 }, file);
  removeQueuedRebuild("thread-race", file, oldRequest);
  assert.deepEqual(readQueue(file).map(row => [row.threadId, row.window]), [["thread-race", 9]]);
  removeQueuedRebuild("thread-race", file, newRequest);
  assert.deepEqual(readQueue(file), []);
});

test("rebuild queue preserves an explicit trim plan until the next MCP startup", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queue-plan-"));
  const file = path.join(dir, "pending.json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  enqueueRebuild({
    threadId: "thread-plan",
    window: 3,
    toolPairs: 12,
    excludedMessages: ["message-1", "message-1"],
    excludedTools: ["tool-1"],
  }, file);
  const [row] = readQueue(file);
  assert.deepEqual(row.excludedMessages, ["message-1"]);
  assert.deepEqual(row.excludedTools, ["tool-1"]);
  assert.deepEqual(buildQueuedApplyArgs(row, { planFile: "/tmp/plan.json" }).slice(-3), [
    "--apply", "--plan", "/tmp/plan.json",
  ]);
});
