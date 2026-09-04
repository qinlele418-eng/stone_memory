#!/usr/bin/env node
"use strict";

const path = require("path");
const os = require("os");
const { readManagedPid, startManagedProcess, stopManagedProcess } = require("../src/services/managed-local-process");

const STONE = path.join(os.homedir(), ".stone_memory");
const PID_FILE = path.join(STONE, "watcher.pid");
const LOG_FILE = path.join(STONE, "watcher-supervisor.log");
const SCRIPT = path.join(__dirname, "watcher-supervisor.js");
const MARKER = "watcher-supervisor.js";
const invokedThroughCli = path.basename(process.argv[1] || "") === "stmem";
const action = process.argv[invokedThroughCli ? 3 : 2] || "status";

if (!new Set(["start", "stop", "restart", "status"]).has(action)) throw new Error("用法：stmem supervisor <start|stop|restart|status>");
if (action === "status") {
  const pid = readManagedPid(PID_FILE, MARKER);
  console.log(`watcher supervisor：${pid ? `运行中 (pid ${pid})` : "未运行"}`);
  return;
}
if (action === "stop" || action === "restart") {
  const result = stopManagedProcess({ pidFile: PID_FILE, marker: MARKER });
  console.log(result.stopped ? `watcher supervisor 已停止 (pid ${result.pid})` : "watcher supervisor 原本未运行");
}
if (action === "start" || action === "restart") {
  const result = startManagedProcess({
    script: SCRIPT,
    pidFile: PID_FILE,
    marker: MARKER,
    logFile: LOG_FILE,
    env: { ...process.env, STMEM_SUPERVISOR_SELF_HEAL: "1" },
  });
  console.log(result.started ? `watcher supervisor 已启动 (pid ${result.pid})` : `watcher supervisor 已在运行 (pid ${result.pid})`);
}
