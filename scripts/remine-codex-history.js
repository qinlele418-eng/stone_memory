#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { MemoryStore } = require("../src/storage/memory-store");
const { getThreadDir } = require("../src/config");

const args = process.argv.slice(2);
const threadIndex = args.indexOf("--thread");
const threadId = threadIndex >= 0 ? args[threadIndex + 1] : null;
if (!threadId) throw new Error("usage: remine-codex-history.js --thread <id>");

const threadDir = getThreadDir(threadId);
const memoryDir = path.join(threadDir, "memory");
const progressFile = path.join(threadDir, "codex-remine-progress.json");
const logFile = path.join(threadDir, "codex-remine.log");
const store = new MemoryStore({ memoryDir, threadId });
const allDates = store.listMessageDates();
const completed = new Set(store.db.prepare(
  "SELECT DISTINCT source_date FROM feelings WHERE thread_id=? AND source='remine'"
).all(threadId).map(row => row.source_date));
store.close();

const pending = allDates.filter(date => !completed.has(date));
const state = {
  threadId,
  modelSource: "codex-subagent",
  totalDates: allDates.length,
  alreadyCompleted: completed.size,
  pendingAtStart: pending.length,
  completedDates: [...completed].sort(),
  failedDates: [],
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: "running",
};

function save() {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(progressFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function log(message) {
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, { mode: 0o600 });
}

save();
log(`starting ${pending.length} pending dates`);
for (const date of pending) {
  log(`start ${date}`);
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "stmem-mine.js"),
    "--thread", threadId,
    "--date", date,
    "--subagent",
    "--force",
  ], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
    maxBuffer: 30 * 1024 * 1024,
  });
  if (result.status === 0) {
    state.completedDates.push(date);
    state.completedDates = [...new Set(state.completedDates)].sort();
    log(`completed ${date}`);
  } else {
    state.failedDates.push({
      date,
      status: result.status,
      signal: result.signal,
      error: String(result.error?.message || result.stderr || result.stdout || "unknown error").slice(0, 1000),
    });
    log(`failed ${date}: ${state.failedDates.at(-1).error}`);
  }
  save();
}
state.status = state.failedDates.length ? "completed_with_failures" : "completed";
state.finishedAt = new Date().toISOString();
save();
log(`finished: ${state.completedDates.length}/${state.totalDates}, failures=${state.failedDates.length}`);
