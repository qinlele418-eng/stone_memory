"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { childEnvWithHome } = require("../test-support/child-env");

const projectRoot = path.join(__dirname, "..");

function loadRuntimeWithHome(home) {
  const previous = process.env.HOME;
  const originalHomedir = os.homedir;
  process.env.HOME = home;
  os.homedir = () => home;
  for (const modulePath of ["../src/config", "../src/services/watcher-runtime"]) {
    delete require.cache[require.resolve(modulePath)];
  }
  const runtime = require("../src/services/watcher-runtime");
  process.env.HOME = previous;
  os.homedir = originalHomedir;
  return runtime;
}

test("watcher eligibility is isolated per memory body", () => {
  const { enabledThreadIds, watcherEnabled, watcherActions, developerWatcherEnabled } = loadRuntimeWithHome(os.tmpdir());
  assert.equal(watcherEnabled({
    automaticFullMining: false,
    automaticMemoryMaintenance: false,
    automaticCompression: false,
    automaticDream: false,
  }), false);
  assert.equal(watcherEnabled({
    automaticFullMining: true,
    automaticMemoryMaintenance: false,
  }), true);
  const noCoreActions = { automaticFullMining: false, automaticMemoryMaintenance: false, automaticCompression: false };
  assert.equal(watcherEnabled({ ...noCoreActions, watcherModules: { "dev-custom-hook": true } }), true);
  assert.equal(watcherEnabled({ ...noCoreActions, watcherModules: { "custom-hook": true } }), false);
  assert.equal(watcherEnabled({ ...noCoreActions, watcherModules: { "dev-custom-hook": true }, watcherEnabled: false }), false);
  assert.equal(developerWatcherEnabled({ watcherModules: { "dev-custom-hook": true } }), true);
  assert.equal(developerWatcherEnabled({ watcherModules: { "dev-custom_hook": true } }), false);
  assert.deepEqual(watcherActions({
    automaticFullMining: false,
    automaticMemoryMaintenance: true,
  }), { sync: false, mine: true, compact: false, dream: false });
  assert.deepEqual(watcherActions({ automaticDream: true, watcherModules: { "dev-dream": true } }), {
    sync: true, mine: true, compact: false, dream: true,
  });
  assert.deepEqual(enabledThreadIds({
    enabled: { automaticFullMining: true },
    disabled: { automaticFullMining: false, automaticMemoryMaintenance: false },
  }, ["enabled", "disabled"]), ["enabled"]);
});

test("worker runtime files live inside their memory body directory", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-watcher-state-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stone = path.join(home, ".stone_memory");
  const id = "thread-state-test";
  fs.mkdirSync(stone, { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    [id]: { runtime: "codex", purpose: "coding" },
  }));
  const runtime = loadRuntimeWithHome(home);
  const state = runtime.writeWatcherState(id, { status: "running", pid: 999999 });
  assert.equal(state.threadId, id);
  assert.equal(fs.existsSync(path.join(stone, "watcher-state.json")), false);
  assert.equal(fs.existsSync(path.join(stone, "runtimes", "codex", "coding", id, "watcher-state.json")), true);
  assert.equal(runtime.readWatcherState(id).status, "stale");
});

test("watcher CLI only changes the selected memory body's desired state", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-watcher-cli-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const stone = path.join(home, ".stone_memory");
  fs.mkdirSync(stone, { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify({
    alpha: { label: "A", runtime: "codex", purpose: "coding", automaticFullMining: true, automaticMemoryMaintenance: false },
    beta: { label: "B", runtime: "codex", purpose: "coding", automaticFullMining: true, automaticMemoryMaintenance: false },
  }));
  const result = spawnSync(process.execPath, [path.join(projectRoot, "bin", "stmem"), "watcher", "set", "--thread", "alpha", "--archive", "off", "--dream", "on", "--dev-custom-hook", "on"], {
    env: childEnvWithHome(home), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(stone, "stmem.json"), "utf8"));
  assert.equal(config.alpha.automaticFullMining, false);
  assert.equal(config.alpha.watcherModules.archive, false);
  assert.equal(config.alpha.watcherModules.dream, true);
  assert.equal(config.alpha.watcherModules["dev-custom-hook"], true);
  assert.equal(config.beta.automaticFullMining, true);
  assert.equal(fs.existsSync(path.join(stone, "watcher.pid")), false);

  const unprefixed = spawnSync(process.execPath, [path.join(projectRoot, "bin", "stmem"), "watcher", "set", "--thread", "alpha", "--custom-hook", "on"], {
    env: childEnvWithHome(home), encoding: "utf8",
  });
  assert.notEqual(unprefixed.status, 0);
  assert.match(unprefixed.stderr, /必须使用 dev- 前缀/);

  const off = spawnSync(process.execPath, [path.join(projectRoot, "bin", "stmem"), "watcher", "off", "--thread", "alpha"], {
    env: childEnvWithHome(home), encoding: "utf8",
  });
  assert.equal(off.status, 0, off.stderr);
  const disabled = JSON.parse(fs.readFileSync(path.join(stone, "stmem.json"), "utf8"));
  assert.equal(disabled.alpha.watcherEnabled, false);
  assert.equal(disabled.beta.watcherEnabled, undefined);
  assert.equal(fs.existsSync(path.join(stone, "watcher.pid")), false);
});
