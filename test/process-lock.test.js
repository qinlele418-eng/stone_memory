"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireProcessLock, inspectProcessLock } = require("../src/lib/process-lock");

test("process lock admits one owner and only the owner can release it", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-process-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, "supervisor.lock");
  const first = acquireProcessLock(lockDir, { marker: "process-lock.test.js" });
  assert.equal(first.acquired, true);
  assert.equal(inspectProcessLock(lockDir, "process-lock.test.js").active, true);
  const second = acquireProcessLock(lockDir, { marker: "process-lock.test.js", waitMs: 40, pollMs: 5 });
  assert.equal(second.acquired, false);
  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(first.release(), false);
});

test("a lock with no owner is treated as initializing before it can become stale", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-process-lock-init-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, "worker.lock");
  fs.mkdirSync(lockDir);
  const pending = acquireProcessLock(lockDir, { marker: "process-lock.test.js", waitMs: 30, pollMs: 5, staleMs: 5_000 });
  assert.equal(pending.acquired, false);
  assert.equal(pending.pending, true);
  assert.equal(fs.existsSync(lockDir), true);
});

test("an ownerless lock is recoverable only after the stale threshold", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-process-lock-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lockDir = path.join(root, "stale.lock");
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - 5_000);
  fs.utimesSync(lockDir, old, old);
  const recovered = acquireProcessLock(lockDir, { marker: "process-lock.test.js", staleMs: 100, waitMs: 40, pollMs: 5 });
  assert.equal(recovered.acquired, true);
  assert.equal(recovered.release(), true);
});
