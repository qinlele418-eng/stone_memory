const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const stmem = path.join(root, "bin", "stmem");

function run(home, args) {
  const env = { ...process.env, HOME: home };
  if (process.platform === "win32") env.USERPROFILE = home;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [stmem, ...args], {
    cwd: root, env, encoding: "utf8",
  });
}

function runCode(home, code, args = []) {
  const env = { ...process.env, HOME: home };
  if (process.platform === "win32") env.USERPROFILE = home;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["-e", code, ...args], { cwd: root, env, encoding: "utf8" });
}

test("memory-first init creates an unbound draft and later keeps its stable identity", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-first-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const created = run(home, ["memory", "create"]);
  assert.equal(created.status, 0, created.stderr);
  const memory = JSON.parse(created.stdout).memory;
  assert.match(memory.memoryId, /^[0-9a-f-]{36}$/);
  assert.equal(memory.label, "新建记忆体");
  assert.equal(memory.status, "draft");
  assert.deepEqual(memory.bindings, []);

  const settingsFile = path.join(home, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({
    label: "我的记忆", purpose: "coding", ai: "石头", user: "用户",
    miner: { mode: "subagent" }, rebuild: { windowDays: 5, keepToolPairs: 12 },
  }));
  const validated = run(home, ["memory", "settings", "--memory", memory.memoryId, "--batch-file", settingsFile, "--validate"]);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).changed, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "memories", memory.memoryId, "memory.json"), "utf8")).label, "新建记忆体");
  const appliedSettings = run(home, ["memory", "settings", "--memory", memory.memoryId, "--batch-file", settingsFile, "--apply"]);
  assert.equal(appliedSettings.status, 0, appliedSettings.stderr);
  assert.equal(JSON.parse(appliedSettings.stdout).settings.label, "我的记忆");
  const repeatedSettings = run(home, ["memory", "settings", "--memory", memory.memoryId, "--batch-file", settingsFile, "--apply"]);
  assert.equal(JSON.parse(repeatedSettings.stdout).changed, false);

  const sessionDir = path.join(home, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "thread-abc.jsonl"), "{}\n");
  const inputFile = path.join(home, "bind.json");
  fs.writeFileSync(inputFile, JSON.stringify({
    libraryName: "我的记忆", threadId: "thread-abc", ai: "石头", user: "用户",
    runtime: "codex", purpose: "accompany", sessionDir, minerMode: "subagent",
  }));
  const bound = run(home, ["init", "--memory", memory.memoryId, "--thread", "thread-abc", "--batch-file", inputFile]);
  assert.equal(bound.status, 0, bound.stderr);

  const config = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "stmem.json"), "utf8"));
  assert.equal(config["thread-abc"].memoryId, memory.memoryId);
  assert.equal(config.memories[memory.memoryId].status, "active");
  assert.equal(config.memories[memory.memoryId].label, "我的记忆");
  assert.equal(config.memories[memory.memoryId].bindings[0].threadId, "thread-abc");
  const root = path.join(home, ".stone_memory", "memories", memory.memoryId);
  assert.equal(fs.existsSync(path.join(root, "memory.json")), true);
  assert.equal(fs.existsSync(path.join(root, "bindings.json")), true);
  assert.equal(fs.existsSync(path.join(root, "watcher.json")), true);
  assert.equal(fs.existsSync(path.join(home, ".stone_memory", "stone-memory.db")), true);
  assert.equal(fs.existsSync(path.join(home, ".stone_memory", "runtimes", "codex", "accompany", "thread-abc")), false);
});

test("formal memory-first creation stores settings, binding and watcher state without a legacy thread entry", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-formal-create-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const memory = JSON.parse(run(home, ["memory", "create", "--name", "新记忆"]).stdout).memory;
  const sessionRoot = path.join(home, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, "rollout-real-thread.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "real-thread", base_instructions: "test" } })}\n`);

  const settingsFile = path.join(home, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify({
    label: "正式记忆", purpose: "coding", ai: "石头", user: "用户",
    miner: { mode: "subagent", apiProfile: null }, rebuild: { windowDays: 7, keepToolPairs: 18 },
  }));
  assert.equal(run(home, ["memory", "settings", "--memory", memory.memoryId, "--batch-file", settingsFile, "--validate"]).status, 0);
  assert.equal(run(home, ["memory", "settings", "--memory", memory.memoryId, "--batch-file", settingsFile, "--apply"]).status, 0);
  const unboundWeb = runCode(home, `
    const { listLibraries, overview } = require("./src/web/server");
    console.log(JSON.stringify({ library: listLibraries()[0], overview: overview(process.argv[1]) }));
  `, [memory.memoryId]);
  assert.equal(unboundWeb.status, 0, unboundWeb.stderr);
  const unbound = JSON.parse(unboundWeb.stdout);
  assert.equal(unbound.library.configured, true);
  assert.equal(unbound.library.bound, false);
  assert.equal(unbound.library.threadId, memory.memoryId);
  assert.deepEqual(unbound.overview.recent, []);

  const bindingFile = path.join(home, "binding.json");
  fs.writeFileSync(bindingFile, JSON.stringify({ provider: "codex", externalThreadId: "real-thread", sessionRoot, mode: "primary" }));
  assert.equal(run(home, ["binding", "add", "--memory", memory.memoryId, "--batch-file", bindingFile]).status, 0);
  assert.equal(run(home, ["binding", "add", "--memory", memory.memoryId, "--batch-file", bindingFile, "--apply"]).status, 0);
  assert.equal(run(home, ["watcher", "set", "--memory", memory.memoryId, "--archive", "on", "--miner", "on", "--compression", "off"]).status, 0);
  assert.equal(run(home, ["watcher", "on", "--memory", memory.memoryId]).status, 0);

  const root = path.join(home, ".stone_memory", "memories", memory.memoryId);
  const config = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "stmem.json"), "utf8"));
  const settings = JSON.parse(fs.readFileSync(path.join(root, "memory.json"), "utf8"));
  const bindings = JSON.parse(fs.readFileSync(path.join(root, "bindings.json"), "utf8"));
  const watcher = JSON.parse(fs.readFileSync(path.join(root, "watcher.json"), "utf8"));
  assert.equal(config["real-thread"], undefined);
  assert.equal(config.memories[memory.memoryId].status, "active");
  assert.equal(settings.status, "active");
  assert.equal(settings.label, "正式记忆");
  assert.equal(bindings.bindings[0].externalThreadId, "real-thread");
  assert.equal(watcher.enabled, true);
  assert.deepEqual(watcher.modules, { archive: true, miner: true, compression: false, dream: false });
  const listed = runCode(home, `
    const { listLibraries, overview } = require("./src/web/server");
    const libraries = listLibraries();
    console.log(JSON.stringify({ libraries, overview: overview(process.argv[1]) }));
  `, [memory.memoryId]);
  assert.equal(listed.status, 0, listed.stderr);
  const web = JSON.parse(listed.stdout);
  assert.equal(web.libraries.length, 1);
  assert.equal(web.libraries[0].memoryId, memory.memoryId);
  assert.equal(web.libraries[0].threadId, memory.memoryId);
  assert.equal(web.libraries[0].externalThreadId, "real-thread");
  assert.equal(web.libraries[0].configured, true);
  assert.equal(web.overview.libraryName, "正式记忆");
});

test("API profiles are validated before their secrets are written", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-api-profile-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const batch = path.join(home, "profile.json");
  fs.writeFileSync(batch, JSON.stringify({ id: "proxy", key: "secret", baseUrl: "https://example.test/v1", model: "model-1" }));
  assert.equal(run(home, ["api-profile", "set", "--batch-file", batch, "--validate"]).status, 0);
  assert.equal(fs.existsSync(path.join(home, ".stone_memory", "stmem.json")), false);
  assert.equal(run(home, ["api-profile", "set", "--batch-file", batch, "--apply"]).status, 0);
  const config = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "stmem.json"), "utf8"));
  assert.deepEqual(config.apiKeys.proxy, { key: "secret", baseUrl: "https://example.test/v1", model: "model-1" });
});

test("binding rejects an unknown memory without creating a thread", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-first-missing-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = run(home, ["init", "--memory", "missing", "--thread", "thread-a", "--batch", "{}"]) ;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /记忆体不存在/);
  assert.equal(fs.existsSync(path.join(home, ".stone_memory", "stmem.json")), false);
});

test("commands never select the first memory when the target is ambiguous or writable", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-selection-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const first = JSON.parse(run(home, ["memory", "create", "--name", "一号"]).stdout).memory;
  assert.notEqual(run(home, ["mine", "--stop"]).status, 0, "write command must require an explicit memory even when only one exists");
  JSON.parse(run(home, ["memory", "create", "--name", "二号"]).stdout);

  for (const args of [
    ["binding", "list"],
    ["rules", "list"],
    ["feature-phrases", "--json"],
    ["doctor", "--json"],
  ]) {
    const result = run(home, args);
    assert.notEqual(result.status, 0, `${args.join(" ")} must not guess the first memory`);
    assert.match(result.stderr, /多个记忆体|显式指定/);
  }
  assert.equal(run(home, ["binding", "list", "--memory", first.memoryId]).status, 0);
});

test("draft deletion previews first and moves data to a recoverable backup", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-delete-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const created = JSON.parse(run(home, ["memory", "create", "--name", "临时草稿"]).stdout).memory;
  const root = path.join(home, ".stone_memory", "memories", created.memoryId);
  const preview = run(home, ["memory", "delete", "--memory", created.memoryId]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  assert.equal(fs.existsSync(root), true);
  const removed = run(home, ["memory", "delete", "--memory", created.memoryId, "--apply"]);
  assert.equal(removed.status, 0, removed.stderr);
  const result = JSON.parse(removed.stdout);
  assert.equal(result.recoverable, true);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(result.backup), true);
  const config = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "stmem.json"), "utf8"));
  assert.equal(config.memories[created.memoryId], undefined);
});

test("draft deletion recovers an interrupted creation with missing canonical files", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-broken-draft-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const created = JSON.parse(run(home, ["memory", "create", "--name", "中断草稿"]).stdout).memory;
  const root = path.join(home, ".stone_memory", "memories", created.memoryId);
  fs.rmSync(path.join(root, "memory.json"));
  fs.rmSync(path.join(root, ".layout-v1.json"));

  const preview = run(home, ["memory", "delete", "--memory", created.memoryId]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).recoverable, true);
  const removed = run(home, ["memory", "delete", "--memory", created.memoryId, "--apply"]);
  assert.equal(removed.status, 0, removed.stderr);
  const result = JSON.parse(removed.stdout);
  assert.equal(fs.existsSync(root), false);
  assert.equal(fs.existsSync(result.backup), true);
  const config = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "stmem.json"), "utf8"));
  assert.equal(config.memories[created.memoryId], undefined);
});

test("new binding configuration is validated, persisted by memory id and mirrored for import provenance", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-memory-binding-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const created = JSON.parse(run(home, ["memory", "create"]).stdout).memory;
  const sessionRoot = path.join(home, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadFile = path.join(sessionRoot, "rollout-external-1.jsonl");
  fs.writeFileSync(threadFile, [
    { timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "external-1", base_instructions: "test" } },
    { timestamp: "2026-09-01T00:01:00Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    { timestamp: "2026-09-01T00:02:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const batch = path.join(home, "binding.json");
  fs.writeFileSync(batch, JSON.stringify({ provider: "codex", externalThreadId: "external-1", sessionRoot, mode: "parallel" }));

  const preview = run(home, ["binding", "add", "--memory", created.memoryId, "--batch-file", batch]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun, true);
  const before = JSON.parse(fs.readFileSync(path.join(home, ".stone_memory", "memories", created.memoryId, "bindings.json"), "utf8"));
  assert.equal(before.bindings.length, 0);

  const applied = run(home, ["binding", "add", "--memory", created.memoryId, "--batch-file", batch, "--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  const result = JSON.parse(applied.stdout);
  assert.equal(result.changed, true);
  assert.equal(result.binding.externalThreadId, "external-1");
  assert.equal(result.config.primaryBindingId, result.binding.id);
  const repeated = JSON.parse(run(home, ["binding", "add", "--memory", created.memoryId, "--batch-file", batch, "--apply"]).stdout);
  assert.equal(repeated.changed, false);

  const listed = JSON.parse(run(home, ["binding", "list", "--memory", created.memoryId]).stdout);
  assert.equal(listed.primaryBindingId, result.binding.id);
  assert.equal(listed.bindings.length, 1);

  const moduleContextResult = runCode(home, `
    const { createModuleContext } = require("./src/services/developer-module-runtime");
    const context = createModuleContext({ id: "test-memory-module", scope: "memory" }, { memoryId: process.argv[1] });
    console.log(JSON.stringify({ memoryId: context.memoryId, threadId: context.threadId, dataDir: context.moduleDataDir,
      memories: context.core.listMemoryIds(), bindings: context.core.listBindings(context.memoryId) }));
  `, [created.memoryId]);
  assert.equal(moduleContextResult.status, 0, moduleContextResult.stderr);
  const moduleContext = JSON.parse(moduleContextResult.stdout);
  assert.equal(moduleContext.memoryId, created.memoryId);
  assert.equal(moduleContext.threadId, created.memoryId);
  assert.equal(moduleContext.dataDir, path.join(home, ".stone_memory", "developer-module-data", created.memoryId, "test-memory-module"));
  assert.ok(moduleContext.memories.includes(created.memoryId));
  assert.equal(moduleContext.bindings[0].externalThreadId, "external-1");

  const synced = run(home, ["sync", "--thread", created.memoryId]);
  assert.equal(synced.status, 0, synced.stderr);
  assert.match(synced.stdout, /archive \+2 条/);

  const Database = require("better-sqlite3");
  const db = new Database(path.join(home, ".stone_memory", "stone-memory.db"), { readonly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) count FROM threads WHERE id=?").get(created.memoryId).count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM memory_bindings WHERE memory_id=?").get(created.memoryId).count, 1);
  } finally { db.close(); }

  const rebuilt = run(home, ["rebuild", "--thread", created.memoryId]);
  assert.equal(rebuilt.status, 0, rebuilt.stderr);
  assert.match(rebuilt.stdout, /Loading: .*rollout-external-1\.jsonl/);

  const secondFile = path.join(sessionRoot, "rollout-external-2.jsonl");
  fs.writeFileSync(secondFile, fs.readFileSync(threadFile, "utf8").replaceAll("external-1", "external-2"));
  const secondBatch = path.join(home, "binding-2.json");
  fs.writeFileSync(secondBatch, JSON.stringify({ provider: "codex", externalThreadId: "external-2", sessionRoot, mode: "parallel" }));
  const second = JSON.parse(run(home, ["binding", "add", "--memory", created.memoryId, "--batch-file", secondBatch, "--apply"]).stdout);
  const stalePlan = JSON.parse(run(home, ["binding", "switch", "--memory", created.memoryId, "--binding", second.binding.id]).stdout);
  fs.appendFileSync(secondFile, "\n");
  const staleSwitch = run(home, ["binding", "switch", "--memory", created.memoryId, "--binding", second.binding.id, "--confirmed-plan", stalePlan.planToken, "--apply"]);
  assert.notEqual(staleSwitch.status, 0);
  assert.match(staleSwitch.stderr, /计划已过期/);
  assert.equal(JSON.parse(run(home, ["binding", "list", "--memory", created.memoryId]).stdout).primaryBindingId, result.binding.id);

  const switchPlan = JSON.parse(run(home, ["binding", "switch", "--memory", created.memoryId, "--binding", second.binding.id]).stdout);
  assert.equal(switchPlan.action, "switch");
  const watcherOn = run(home, ["watcher", "on", "--memory", created.memoryId]);
  assert.equal(watcherOn.status, 0, watcherOn.stderr);
  const watcherFile = path.join(home, ".stone_memory", "memories", created.memoryId, "watcher.json");
  assert.equal(JSON.parse(fs.readFileSync(watcherFile, "utf8")).enabled, true);
  const watchedSwitch = run(home, ["binding", "switch", "--memory", created.memoryId, "--binding", second.binding.id, "--confirmed-plan", switchPlan.planToken, "--apply"]);
  assert.notEqual(watchedSwitch.status, 0);
  assert.match(watchedSwitch.stderr, /watcher 正在运行/);
  assert.equal(run(home, ["watcher", "off", "--memory", created.memoryId]).status, 0);
  const switched = run(home, ["binding", "switch", "--memory", created.memoryId, "--binding", second.binding.id, "--confirmed-plan", switchPlan.planToken, "--apply"]);
  assert.equal(switched.status, 0, switched.stderr);
  const switchResult = JSON.parse(switched.stdout);
  assert.equal(switchResult.toBindingId, second.binding.id);
  assert.equal(fs.existsSync(switchResult.backup), true);
  const afterSwitch = JSON.parse(run(home, ["binding", "list", "--memory", created.memoryId]).stdout);
  assert.equal(afterSwitch.primaryBindingId, second.binding.id);
  assert.equal(afterSwitch.bindings.find(item => item.id === second.binding.id).mode, "primary");

  const disabledPrimary = JSON.parse(run(home, ["binding", "disable", "--memory", created.memoryId, "--binding", second.binding.id, "--apply"]).stdout);
  assert.equal(disabledPrimary.config.primaryBindingId, second.binding.id);
  assert.equal(disabledPrimary.config.bindings.find(item => item.id === second.binding.id).enabled, false);
  const disabled = JSON.parse(run(home, ["binding", "disable", "--memory", created.memoryId, "--binding", result.binding.id, "--apply"]).stdout);
  assert.equal(disabled.changed, true);
  assert.equal(disabled.config.bindings.find(item => item.id === result.binding.id).enabled, false);
  const enabled = JSON.parse(run(home, ["binding", "enable", "--memory", created.memoryId, "--binding", result.binding.id, "--apply"]).stdout);
  assert.equal(enabled.config.bindings.find(item => item.id === result.binding.id).enabled, true);
  const removed = JSON.parse(run(home, ["binding", "remove", "--memory", created.memoryId, "--binding", result.binding.id, "--apply"]).stdout);
  assert.equal(removed.config.bindings.some(item => item.id === result.binding.id), false);
  const provenanceDb = new Database(path.join(home, ".stone_memory", "stone-memory.db"), { readonly: true });
  try {
    const provenance = provenanceDb.prepare("SELECT enabled FROM memory_bindings WHERE memory_id=? AND external_thread_id=?")
      .get(created.memoryId, "external-1");
    assert.equal(provenance.enabled, 0);
  } finally { provenanceDb.close(); }
});
