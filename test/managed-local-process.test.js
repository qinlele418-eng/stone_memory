"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readManagedPid, startManagedProcess, stopManagedProcess } = require("../src/services/managed-local-process");

test("readManagedPid rejects stale or unrelated pid files", () => {
  assert.equal(readManagedPid("pid", "stmem-web.js", { readFileSync: () => "42", processMatches: () => false }), null);
  assert.equal(readManagedPid("pid", "stmem-web.js", { readFileSync: () => "42", processMatches: (pid, marker) => pid === 42 && marker === "stmem-web.js" }), 42);
});

test("readManagedPid accepts any supported launch marker", () => {
  assert.equal(readManagedPid("pid", ["stmem-web.js", "stmem web"], {
    readFileSync: () => "43",
    processMatches: (_pid, marker) => marker === "stmem web",
  }), 43);
});

test("startManagedProcess is idempotent", () => {
  let spawned = false;
  const result = startManagedProcess({ script: "/app/web.js", pidFile: "/tmp/web.pid", marker: "web.js" }, {
    readFileSync: () => "31", processMatches: () => true, spawn: () => { spawned = true; },
  });
  assert.equal(result.started, false);
  assert.equal(result.pid, 31);
  assert.equal(spawned, false);
});

test("POSIX managed-process logs never follow a replaced symlink", t => {
  if (process.platform === "win32") return t.skip("Windows does not provide the POSIX no-follow guarantee exercised here");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-managed-log-"));
  const stone = path.join(root, ".stone_memory");
  const logFile = path.join(stone, "web.log");
  const external = path.join(root, "outside.log");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(stone, { recursive: true, mode: 0o700 });
  fs.writeFileSync(external, "outside log", { mode: 0o640 });
  fs.chmodSync(external, 0o640);
  const before = fs.statSync(external);
  fs.symlinkSync(external, logFile);
  let spawned = false;
  assert.throws(() => startManagedProcess({ script: "ignored.js", pidFile: path.join(stone, "web.pid"), marker: "ignored", logFile }, {
    spawn: () => { spawned = true; return { pid: 123, unref() {} }; },
  }), /符号链接/);
  const after = fs.statSync(external);
  assert.equal(spawned, false);
  assert.equal(fs.readFileSync(external, "utf8"), "outside log");
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("stopManagedProcess signals the matching process once", () => {
  let alive = true;
  const signals = [];
  const result = stopManagedProcess({ pidFile: "/tmp/web.pid", marker: "web.js" }, {
    readFileSync: () => "55", processMatches: () => alive,
    kill: (pid, signal) => { signals.push([pid, signal]); alive = false; }, wait: () => {}, rmSync: () => {},
  });
  assert.equal(result.stopped, true);
  assert.deepEqual(signals, [[55, "SIGTERM"]]);
});
