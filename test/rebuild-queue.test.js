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
  assert.deepEqual(buildQueuedApplyArgs(rows[1]), [
    "rebuild", "--thread", "a", "--window", "7", "--tool-pairs", "30",
    "--summary-limit", "0", "--min-importance", "0", "--trigger", "mcp", "--apply", "--watermark",
  ]);
  removeQueuedRebuild("a", file);
  assert.deepEqual(readQueue(file).map(row => row.threadId), ["b"]);
});
