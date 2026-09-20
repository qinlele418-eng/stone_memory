#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readManagedPid } = require("../src/services/managed-local-process");

const STONE = path.join(os.homedir(), ".stone_memory");
const PID_FILE = path.join(STONE, "web.pid");
const MARKER = ["stmem-web-watch.js", "stmem-web.js", "stmem web"];
const WEB_SCRIPT = path.join(__dirname, "stmem-web.js");
const SOURCE_ROOT = path.join(__dirname, "..", "src");
const PUBLIC_ROOT = path.join(SOURCE_ROOT, "web", "public");
const args = process.argv.slice(2).filter(arg => arg !== "--foreground");

const existing = readManagedPid(PID_FILE, MARKER);
if (existing && existing !== process.pid) {
  console.error(`Stone Memory 前端已运行 (pid ${existing})`);
  process.exit(1);
}

fs.mkdirSync(STONE, { recursive:true });
fs.writeFileSync(PID_FILE, String(process.pid));

let child = null;
let stopping = false;
let restarting = false;
let restartTimer = null;
const directoryWatchers = new Map();

function startChild() {
  child = spawn(process.execPath, [WEB_SCRIPT, "serve", "--watch-child", ...args], {
    stdio:"inherit",
    env:process.env,
  });
  child.once("error", error => {
    console.error(error.message);
    if (!stopping) scheduleRestart("子进程启动失败");
  });
  child.once("exit", (code, signal) => {
    child = null;
    if (stopping) {
      cleanup();
      process.exit(0);
    }
    if (restarting) {
      restarting = false;
      startChild();
      return;
    }
    console.error(`Stone Memory Web 异常退出（${signal || `code ${code || 0}`}），正在重启`);
    scheduleRestart("异常退出");
  });
}

function shouldRestart(file) {
  if (!file) return true;
  const resolved = path.resolve(file);
  if (resolved === WEB_SCRIPT) return true;
  if (!resolved.startsWith(SOURCE_ROOT + path.sep)) return false;
  if (resolved === PUBLIC_ROOT || resolved.startsWith(PUBLIC_ROOT + path.sep)) return false;
  return /\.(?:js|cjs|json)$/u.test(resolved);
}

function scheduleRestart(reason) {
  if (stopping) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => restartChild(reason), 180);
}

function restartChild(reason) {
  if (stopping || restarting) return;
  console.log(`后端文件变化，重启 Stone Memory Web（${reason}）`);
  if (!child) return startChild();
  restarting = true;
  const current = child;
  current.kill("SIGTERM");
  const force = setTimeout(() => {
    if (child === current) current.kill("SIGKILL");
  }, 2_000);
  force.unref();
}

function watchDirectory(directory) {
  if (directoryWatchers.has(directory) || directory === PUBLIC_ROOT || directory.startsWith(PUBLIC_ROOT + path.sep)) return;
  let watcher;
  try {
    watcher = fs.watch(directory, (_event, filename) => {
      const changed = filename ? path.join(directory, String(filename)) : directory;
      if (shouldRestart(changed)) scheduleRestart(path.relative(path.join(__dirname, ".."), changed));
      refreshDirectories();
    });
  } catch { return; }
  directoryWatchers.set(directory, watcher);
}

function refreshDirectories() {
  const pending = [SOURCE_ROOT];
  while (pending.length) {
    const directory = pending.pop();
    watchDirectory(directory);
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isDirectory()) {
      const childDirectory = path.join(directory, entry.name);
      if (childDirectory !== PUBLIC_ROOT && !childDirectory.startsWith(PUBLIC_ROOT + path.sep)) pending.push(childDirectory);
    }
  }
}

function cleanup() {
  clearTimeout(restartTimer);
  for (const watcher of directoryWatchers.values()) watcher.close();
  directoryWatchers.clear();
  try {
    if (Number(fs.readFileSync(PID_FILE, "utf8")) === process.pid) fs.rmSync(PID_FILE, { force:true });
  } catch {}
}
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  if (child && !child.killed) child.kill(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("exit", cleanup);
refreshDirectories();
watchDirectory(__dirname);
startChild();
