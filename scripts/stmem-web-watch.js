#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readManagedPid } = require("../src/services/managed-local-process");
const { ensurePrivateDirectory, writePrivateFile } = require("../src/security/local-data-permissions");

const STONE = path.join(os.homedir(), ".stone_memory");
const PID_FILE = path.join(STONE, "web.pid");
const MARKER = ["stmem-web-watch.js", "stmem-web.js", "stmem web"];
const WEB_SCRIPT = path.join(__dirname, "stmem-web.js");
const args = process.argv.slice(2).filter(arg => arg !== "--foreground");

const existing = readManagedPid(PID_FILE, MARKER);
if (existing && existing !== process.pid) {
  console.error(`Stone Memory 前端已运行 (pid ${existing})`);
  process.exit(1);
}

ensurePrivateDirectory(STONE);
writePrivateFile(PID_FILE, String(process.pid));

const child = spawn(process.execPath, ["--watch", "--watch-preserve-output", WEB_SCRIPT, "serve", "--watch-child", ...args], {
  stdio:"inherit",
  env:process.env,
});

let stopping = false;
function cleanup() {
  try {
    if (Number(fs.readFileSync(PID_FILE, "utf8")) === process.pid) fs.rmSync(PID_FILE, { force:true });
  } catch {}
}
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("exit", cleanup);
child.once("error", error => {
  console.error(error.message);
  cleanup();
  process.exit(1);
});
child.once("exit", (code, signal) => {
  cleanup();
  if (!stopping && code) console.error(`Stone Memory Web watch 异常退出（${signal || `code ${code}`}）`);
  process.exit(stopping ? 0 : (code || 0));
});
