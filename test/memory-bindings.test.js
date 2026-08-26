const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { MemoryStore } = require("../src/storage/memory-store");
const {
  planBinding,
  addBinding,
  listBindings,
  previewBindingImport,
  applyBindingImport,
  previewRevertImport,
  revertBindingImport,
} = require("../src/services/memory-bindings");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-bindings-"));
  const source = path.join(root, "source.json");
  fs.writeFileSync(source, JSON.stringify([
    { timestamp: "2026-08-20T01:00:00.000Z", role: "user", content: "第一条真实对话" },
    { timestamp: "2026-08-20T01:01:00.000Z", role: "assistant", content: "第二条真实对话" },
    { timestamp: "2026-08-20T01:02:00.000Z", role: "user", content: "<memory_context>\n历史注入，不应再次入库" },
  ]));
  const store = new MemoryStore({ memoryDir: path.join(root, "memory"), threadId: "memory-a" });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, store };
}

test("binding add and import are preview-first and preserve provenance", t => {
  const { source, store } = fixture(t);
  const input = { provider: "codex", externalThreadId: "external-a", threadFile: source, mode: "parallel" };
  const planned = planBinding(store, input);
  assert.equal(planned.action, "create");
  assert.equal(listBindings(store).length, 0);

  const created = addBinding(store, input);
  assert.equal(created.changed, true);
  assert.equal(listBindings(store).length, 1);

  const preview = previewBindingImport(store, created.binding.id);
  assert.equal(preview.ingest.candidates, 2);
  assert.equal(preview.ingest.filtered, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM messages").get().count, 0);

  const applied = applyBindingImport(store, created.binding.id);
  assert.equal(applied.inserted, 2);
  assert.equal(applied.filtered, 1);
  const rows = store.db.prepare(`SELECT text,binding_id bindingId,import_batch_id batchId,source_occurred_at sourceOccurredAt
    FROM messages ORDER BY timestamp`).all();
  assert.deepEqual(rows.map(row => row.text), ["第一条真实对话", "第二条真实对话"]);
  assert.ok(rows.every(row => row.bindingId === created.binding.id));
  assert.ok(rows.every(row => row.batchId === applied.batchId));
  assert.ok(rows.every(row => row.sourceOccurredAt));
  assert.throws(() => applyBindingImport(store, created.binding.id), /同一来源版本已经导入/);

  const revertPreview = previewRevertImport(store, applied.batchId);
  assert.equal(revertPreview.reversible, true);
  assert.equal(revertPreview.messageCount, 2);
  assert.equal(revertBindingImport(store, applied.batchId).removed, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM messages").get().count, 0);
});

test("revert refuses to detach evidence after a later mining completion", t => {
  const { source, store } = fixture(t);
  const binding = addBinding(store, { provider: "claude_code", externalThreadId: "external-b", threadFile: source }).binding;
  const applied = applyBindingImport(store, binding.id);
  store.setDayState("2026-08-20", {
    status: "completed",
    completedAt: new Date(Date.parse(applied.appliedAt) + 1000).toISOString(),
  });
  const preview = previewRevertImport(store, applied.batchId);
  assert.equal(preview.reversible, false);
  assert.equal(preview.minedAfterImport.length, 1);
  assert.throws(() => revertBindingImport(store, applied.batchId), /已有日期重新挖掘/);
  assert.equal(store.db.prepare("SELECT COUNT(*) count FROM messages").get().count, 2);
});
