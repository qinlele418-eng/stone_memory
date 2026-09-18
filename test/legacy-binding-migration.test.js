const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const originalHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-legacy-binding-"));
process.env.HOME = home;

const { createMemory } = require("../src/services/memory-setup");
const {
  migrateLegacyBinding, readBindingConfig, applyBindingAdd, applyBindingPrimary,
  applyBindingState, resolvePrimaryBinding,
} = require("../src/services/memory-binding-config");

test.after(() => {
  process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test("legacy configured window becomes the first primary binding exactly once", () => {
  const memory = createMemory({ label: "旧记忆" });
  const sessionRoot = path.join(home, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, "rollout-old-window.jsonl"), "{}\n");
  const configFile = path.join(home, ".stone_memory", "stmem.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config["old-window"] = {
    memoryId: memory.memoryId,
    label: "旧记忆",
    runtime: "codex",
    purpose: "coding",
    sessionDir: sessionRoot,
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

  const migrated = migrateLegacyBinding(memory.memoryId, { apply: true });
  assert.equal(migrated.changed, true);
  const bindings = readBindingConfig(memory.memoryId);
  assert.equal(bindings.bindings.length, 1);
  assert.equal(bindings.primaryBindingId, bindings.bindings[0].id);
  assert.equal(bindings.bindings[0].externalThreadId, "old-window");
  assert.equal(bindings.bindings[0].enabled, true);

  const repeated = migrateLegacyBinding(memory.memoryId, { apply: true });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.reason, "bindings-exist");

  fs.writeFileSync(path.join(sessionRoot, "rollout-new-window.jsonl"), "{}\n");
  const second = applyBindingAdd(memory.memoryId, {
    provider: "codex", externalThreadId: "new-window", sessionRoot, mode: "parallel",
  });
  const selected = applyBindingPrimary(memory.memoryId, second.binding.id);
  assert.equal(selected.changed, true);
  const afterPrimary = readBindingConfig(memory.memoryId);
  assert.equal(afterPrimary.primaryBindingId, second.binding.id);
  assert.equal(afterPrimary.bindings.find(item => item.id === second.binding.id).mode, "primary");
  assert.equal(afterPrimary.bindings.find(item => item.externalThreadId === "old-window").mode, "parallel");

  applyBindingState(memory.memoryId, second.binding.id, "disable");
  assert.equal(readBindingConfig(memory.memoryId).primaryBindingId, second.binding.id);
  assert.equal(resolvePrimaryBinding(memory.memoryId).id, second.binding.id);
  assert.throws(() => applyBindingState(memory.memoryId, second.binding.id, "remove"), /不能删除主 Binding/);
});
