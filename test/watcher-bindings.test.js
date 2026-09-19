const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  MAX_ENABLED_BINDINGS,
  bindingCursorFile,
  rebalanceWatcherBindings,
  validateEnabledBindingLimit,
} = require("../src/services/watcher-bindings");

test("watcher accepts at most five enabled live bindings", () => {
  const five = Array.from({ length: MAX_ENABLED_BINDINGS }, (_, index) => ({ id: `b-${index}`, enabled: true, mode: "parallel" }));
  assert.equal(validateEnabledBindingLimit(five), 5);
  assert.throws(() => validateEnabledBindingLimit([...five, { id: "b-5", enabled: true, mode: "parallel" }]), /最多同时监听 5 个/);
  assert.equal(validateEnabledBindingLimit([...five, { id: "disabled", enabled: false, mode: "parallel" }]), 5);
  assert.equal(validateEnabledBindingLimit([...five, { id: "import", enabled: true, mode: "import_only" }]), 5);
});

test("each formal binding receives an independent sync cursor", () => {
  const first = bindingCursorFile("memory-a", { id: "binding-one" });
  const second = bindingCursorFile("memory-a", { id: "binding-two" });
  assert.notEqual(first, second);
  assert.equal(path.basename(first), "binding-one.json");
  assert.match(first, /[\\/]\.sync-state[\\/]/u);
});

test("binding records are unlimited while live listeners are capped and oldest activity is stopped", () => {
  const bindings = Array.from({ length: 6 }, (_, index) => ({
    id: `b-${index}`,
    enabled: true,
    mode: "parallel",
    lastActivityAt: new Date(2026, 0, index + 1).toISOString(),
  }));
  const result = rebalanceWatcherBindings(bindings);
  assert.equal(result.bindings.length, 6);
  assert.deepEqual(result.stoppedBindingIds, ["b-0"]);
  assert.equal(result.bindings.find(item => item.id === "b-0").enabled, false);
  assert.equal(result.bindings.filter(item => item.enabled !== false && item.mode !== "import_only").length, MAX_ENABLED_BINDINGS);
});

function runWithHome(home, code) {
  const env = { ...process.env, HOME: home };
  if (process.platform === "win32") env.USERPROFILE = home;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["-e", code], { cwd: path.resolve(__dirname, ".."), env, encoding: "utf8" });
}

test("legacy windows without an explicit external thread id keep their memory-id fallback", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-watcher-legacy-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const memoryId = "019d9abc-ea95-7312-9354-4e44ec138aae";
  const sessionDir = path.join(home, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${memoryId}.jsonl`), `${JSON.stringify({ session_id: memoryId })}\n`);
  fs.mkdirSync(path.join(home, ".stone_memory"), { recursive: true });
  fs.writeFileSync(path.join(home, ".stone_memory", "stmem.json"), JSON.stringify({
    [memoryId]: { sessionDir, runtime: "claude", label: "legacy memory" },
  }));
  const modulePath = path.join(__dirname, "..", "src", "services", "watcher-bindings");
  const result = runWithHome(home, `const { enabledWatcherBindings } = require(${JSON.stringify(modulePath)}); console.log(JSON.stringify(enabledWatcherBindings(${JSON.stringify(memoryId)})));`);
  assert.equal(result.status, 0, result.stderr);
  const bindings = JSON.parse(result.stdout);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].id, "legacy-primary");
  assert.equal(bindings[0].externalThreadId, memoryId);
  assert.ok(bindings[0].threadFile.endsWith(`${memoryId}.jsonl`));
});
