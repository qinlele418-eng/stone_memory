"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
