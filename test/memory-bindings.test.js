const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// HOME must be redirected before any src require: src/config.js bakes CONFIG_PATH
// from os.homedir() at module load. All pando binding tests below depend on that.
const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-pando-bindings-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { MemoryStore } = require("../src/storage/memory-store");
const {
  planBinding,
  addBinding,
  listBindings,
  setBindingEnabled,
  previewBindingImport,
  applyBindingImport,
  previewRevertImport,
  revertBindingImport,
} = require("../src/services/memory-bindings");
const {
  readBindingConfig, validateBindingInput, applyBindingAdd,
  planBindingSwitch, applyBindingState, resolvePrimaryBinding,
} = require("../src/services/memory-binding-config");
const { loadConfig, CONFIG_PATH } = require("../src/config");
const { saveConfig } = require("../src/services/thread-setup");
const { canonicalMemoryDir } = require("../src/services/memory-identity");
const { writeJson, ensureMemoryScaffold } = require("../src/services/memory-setup");
const { resolveMcpThread } = require("../src/services/mcp-thread-resolution");

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

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

// TASK-0376: provider=pando 接入。固定 memoryId=finn（唯一稳定），无会话文件。
function createFinnMemory() {
  const root = canonicalMemoryDir(path.dirname(CONFIG_PATH), "finn");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeJson(path.join(root, "memory.json"), {
    schemaVersion: 1, memoryId: "finn", label: "Finn", status: "draft",
    purpose: null, ai: "", user: "", userGender: "unspecified",
    relationshipTimeline: [],
    mcpModules: ["notebook-lab", "dream-lab"], mcpModuleConfigVersion: 1,
    miner: { mode: null, apiProfile: null },
    rebuild: { windowDays: 1, keepToolPairs: 15, contextWindowTokens: null, mcpRebuildDefaultsEnabled: false, mcpSummaryLimit: 0, mcpMinImportance: 0 },
    createdAt: now, updatedAt: now,
  });
  writeJson(path.join(root, "bindings.json"), { schemaVersion: 1, revision: 0, primaryBindingId: null, bindings: [] });
  writeJson(path.join(root, "watcher.json"), { schemaVersion: 1, enabled: false, modules: { archive: false, miner: false, compression: false, dream: false } });
  writeJson(path.join(root, ".layout-v1.json"), { schemaVersion: 1, status: "complete", memoryId: "finn", origin: "created", completedAt: now });
  ensureMemoryScaffold(root);
  const config = loadConfig();
  config.memories = config.memories || {};
  config.memories.finn = { memoryId: "finn", label: "Finn", status: "draft", createdAt: now, updatedAt: now, bindings: [] };
  saveConfig(config);
  return root;
}

test("generic binding model accepts a pando provider without any thread file", t => {
  const { store } = fixture(t);
  const created = addBinding(store, { provider: "pando", externalThreadId: "pando-conv-generic", mode: "import_only" });
  assert.equal(created.changed, true);
  assert.equal(created.binding.provider, "pando");
  assert.equal(created.binding.threadFile, null);
  const stored = listBindings(store)[0];
  assert.equal(stored.enabled, true);
  assert.equal(setBindingEnabled(store, stored.id, false).enabled, false);
  assert.equal(setBindingEnabled(store, stored.id, true).enabled, true);
});

test("pando provider binds memoryId=finn without session files, persistently and idempotently", () => {
  const root = createFinnMemory();
  const input = { provider: "pando", externalThreadId: "pando-conv-001", mode: "import_only" };
  const applied = applyBindingAdd("finn", input);
  assert.equal(applied.changed, true);
  assert.equal(applied.automationEnabled, true);
  assert.equal(applied.binding.provider, "pando");
  assert.equal(applied.binding.externalThreadId, "pando-conv-001");
  assert.equal(applied.binding.sessionRoot, null);
  assert.equal(applied.binding.resolvedThreadFile, null);

  const config = readBindingConfig("finn");
  assert.equal(config.bindings.length, 1);
  assert.equal(config.primaryBindingId, config.bindings[0].id);
  assert.equal(config.bindings[0].enabled, true);

  const store = new MemoryStore({ memoryDir: path.join(root, "memory"), threadId: "finn" });
  try {
    assert.deepEqual(
      store.db.prepare("SELECT provider,external_thread_id,thread_file,mode,enabled FROM memory_bindings").all(),
      [{ provider: "pando", external_thread_id: "pando-conv-001", thread_file: null, mode: "primary", enabled: 1 }],
    );
  } finally { store.close(); }

  const repeat = applyBindingAdd("finn", input);
  assert.equal(repeat.changed, false);
  const after = readBindingConfig("finn");
  assert.equal(after.bindings.length, 1);
  assert.equal(after.revision, 1);
});

test("pando binding defaults to import_only mode and supports enable/disable and remove guards", () => {
  createFinnMemory();
  const first = applyBindingAdd("finn", { provider: "pando", externalThreadId: "pando-conv-001" });
  const second = applyBindingAdd("finn", { provider: "pando", externalThreadId: "pando-conv-002" });
  assert.equal(second.binding.mode, "import_only");
  assert.equal(second.changed, true);

  const disabled = applyBindingState("finn", second.binding.id, "disable");
  assert.equal(disabled.changed, true);
  assert.equal(readBindingConfig("finn").bindings.find(item => item.id === second.binding.id).enabled, false);
  const reEnabled = applyBindingState("finn", second.binding.id, "enable");
  assert.equal(reEnabled.changed, true);
  assert.equal(readBindingConfig("finn").bindings.find(item => item.id === second.binding.id).enabled, true);

  assert.throws(() => applyBindingState("finn", first.binding.id, "remove"), /不能删除主 Binding/);
  const removed = applyBindingState("finn", second.binding.id, "remove");
  assert.equal(removed.changed, true);
  assert.equal(readBindingConfig("finn").bindings.length, 1);
});

test("pando primary binding resolves without a file and refuses rebuild-style switch", () => {
  createFinnMemory();
  const applied = applyBindingAdd("finn", { provider: "pando", externalThreadId: "pando-conv-001" });
  const primary = resolvePrimaryBinding("finn");
  assert.equal(primary.provider, "pando");
  assert.equal(primary.resolvedThreadFile, null);
  assert.throws(() => planBindingSwitch("finn", applied.binding.id), /不支持 rebuild 式切换/);
});

test("pando binding input validation fails explicitly on wrong provider or illegal thread", () => {
  createFinnMemory();
  assert.throws(() => validateBindingInput("finn", { provider: "vscode", externalThreadId: "conv-x" }), /claude、codex 或 pando/);
  assert.throws(() => validateBindingInput("finn", { provider: "pando", externalThreadId: "" }), /合法的外部线程 ID/);
  assert.throws(() => validateBindingInput("finn", { provider: "pando", externalThreadId: "has space" }), /合法的外部线程 ID/);
  assert.throws(() => validateBindingInput("finn", { provider: "pando", externalThreadId: "conv-x", mode: "watch" }), /不支持的 Binding 模式/);
  // 既有 provider 仍强制会话文件校验（零回归锚点）
  assert.throws(() => validateBindingInput("finn", { provider: "codex", externalThreadId: "conv-x" }), /线程搜索目录不存在/);
});

test("a bound pando window resolves queries without any session file", () => {
  createFinnMemory();
  applyBindingAdd("finn", { provider: "pando", externalThreadId: "pando-conv-001" });
  const memoryId = resolveMcpThread({ thread: "pando-conv-001" }, loadConfig(), [], {});
  assert.equal(memoryId, "finn");
});
