const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readThreadDelta, commitThreadCursor } = require("../src/services/thread-sync-cursor");

function row(timestamp, text) {
  return { timestamp, type: "user", message: { content: text } };
}

function append(file, rows) {
  fs.appendFileSync(file, rows.map(JSON.stringify).join("\n") + "\n");
}

test("thread sync cursor reads append-only JSONL incrementally", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-sync-"));
  const file = path.join(dir, "thread.jsonl");
  const stateFile = path.join(dir, ".sync-state.json");
  append(file, [row("2026-08-10T01:00:00Z", "一"), row("2026-08-10T01:01:00Z", "二")]);

  const first = readThreadDelta(file, stateFile);
  assert.equal(first.mode, "full");
  assert.equal(first.messages.length, 2);
  commitThreadCursor(stateFile, first.nextState);

  append(file, [row("2026-08-10T01:02:00Z", "三")]);
  const second = readThreadDelta(file, stateFile);
  assert.equal(second.mode, "incremental");
  assert.equal(second.messages.length, 1);
  assert.ok(second.bytesRead < first.bytesRead);
  commitThreadCursor(stateFile, second.nextState);
  assert.equal(readThreadDelta(file, stateFile).mode, "unchanged");
});

test("thread sync cursor falls back to full reconciliation after rebuild", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-sync-rebuild-"));
  const file = path.join(dir, "thread.jsonl");
  const stateFile = path.join(dir, ".sync-state.json");
  append(file, [row("2026-08-10T01:00:00Z", "旧一"), row("2026-08-10T01:01:00Z", "旧二")]);
  const first = readThreadDelta(file, stateFile);
  commitThreadCursor(stateFile, first.nextState);

  fs.writeFileSync(file, JSON.stringify(row("2026-08-10T02:00:00Z", "重建后")) + "\n");
  const rebuilt = readThreadDelta(file, stateFile);
  assert.equal(rebuilt.mode, "full");
  assert.equal(rebuilt.messages.length, 1);
});

test("thread sync cursor does not commit a partially written JSONL record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-sync-partial-"));
  const file = path.join(dir, "thread.jsonl");
  const stateFile = path.join(dir, ".sync-state.json");
  append(file, [row("2026-08-10T01:00:00Z", "完整")]);
  const first = readThreadDelta(file, stateFile);
  commitThreadCursor(stateFile, first.nextState);

  fs.appendFileSync(file, '{"timestamp":"2026-08-10T01:01:00Z"');
  const partial = readThreadDelta(file, stateFile);
  assert.equal(partial.mode, "partial");
  assert.equal(partial.messages.length, 0);
  assert.equal(partial.nextState.offset, first.nextState.offset);
});
