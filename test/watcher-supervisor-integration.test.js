"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const supervisorScript = path.join(__dirname, "..", "scripts", "watcher-supervisor.js");

function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try { if (predicate()) return resolve(); } catch {}
      if (Date.now() - started >= timeoutMs) return reject(new Error("timed out waiting for watcher state"));
      setTimeout(check, 50);
    };
    check();
  });
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode) return resolve();
    const timer = setTimeout(() => reject(new Error("process did not exit")), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

test("one supervisor converges ON memory body to one worker and OFF to zero", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-supervisor-"));
  const stone = path.join(home, ".stone_memory");
  const onId = "watcher-on", offId = "watcher-off";
  const config = {
    [onId]: {
      label: "ON", runtime: "codex", purpose: "coding", sessionDir: path.join(home, "sessions"),
      watcherEnabled: true,
      watcherModules: { archive: false, miner: false, compression: false, dream: false },
    },
    [offId]: {
      label: "OFF", runtime: "codex", purpose: "coding", sessionDir: path.join(home, "sessions"),
      watcherEnabled: false,
      watcherModules: { archive: true, miner: true, compression: false, dream: false },
    },
  };
  fs.mkdirSync(stone, { recursive: true });
  fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(stone, "stmem.json"), JSON.stringify(config));
  const env = { ...process.env, HOME: home };
  const first = spawn(process.execPath, [supervisorScript, "--interval", "2"], { env, stdio: "ignore" });
  t.after(async () => {
    try { first.kill("SIGTERM"); } catch {}
    try { await waitForExit(first); } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  });

  const onStateFile = path.join(stone, "runtimes", "codex", "coding", onId, "watcher-state.json");
  const offStateFile = path.join(stone, "runtimes", "codex", "coding", offId, "watcher-state.json");
  await waitFor(() => {
    const on = JSON.parse(fs.readFileSync(onStateFile, "utf8"));
    const off = JSON.parse(fs.readFileSync(offStateFile, "utf8"));
    return on.status === "running" && Number(on.pid) > 0 && off.status === "disabled" && off.pid == null;
  });
  const firstPid = Number(fs.readFileSync(path.join(stone, "watcher.pid"), "utf8"));
  assert.equal(firstPid, first.pid);

  const contender = spawn(process.execPath, [supervisorScript, "--interval", "2"], { env, stdio: "ignore" });
  await waitForExit(contender);
  assert.equal(Number(fs.readFileSync(path.join(stone, "watcher.pid"), "utf8")), first.pid);
  assert.equal(fs.readdirSync(stone).filter(name => name.startsWith(".watcher-worker-")).length, 0);
});
