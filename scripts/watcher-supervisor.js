#!/usr/bin/env node
/**
 * SM Watcher Supervisor
 *
 * 只负责进程生命周期：每个已配置 thread 保证恰好一个 watcher worker。
 * sync/mine/compact 均由 worker 自己串行处理，不在 supervisor 内执行。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { listMemoryIds, getMemoryRuntimeConfig } = require("../src/config");
const { processMatches } = require("../src/lib/process-identity");
const { acquireProcessLock, inspectProcessLock, removeIfUnchanged } = require("../src/lib/process-lock");
const { enabledThreadIds, watcherActions, watcherPaths, writeWatcherState } = require("../src/services/watcher-runtime");

const STONE = path.join(os.homedir(), ".stone_memory");
const LOG_DIR = path.join(STONE, "logs");
const PID_FILE = path.join(STONE, "watcher.pid");
const LOCK_DIR = path.join(STONE, ".watcher-supervisor.lock");
const WORKER_SCRIPT = path.join(__dirname, "watcher.js");
const args = process.argv.slice(2);
const intervalIndex = args.indexOf("--interval");
const intervalSec = intervalIndex >= 0 ? Math.max(2, Number(args[intervalIndex + 1]) || 10) : 10;
const workers = new Map();
let stopping = false;
let supervisorLease = null;

function log(message) {
  const timestamp = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  const line = `[${timestamp}] [supervisor] ${message}`;
  console.log(line);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, "watcher.log"), `${line}\n`, "utf8");
}

function externalWorkerOwner(threadId) {
  const { lockDir } = watcherPaths(threadId);
  const info = inspectProcessLock(lockDir, "scripts/watcher.js");
  if (!info.exists) return null;
  if (info.active) return info.owner;
  if (info.ageMs < 30_000) return { pending: true, owner: info.owner };
  removeIfUnchanged(lockDir, info.signature);
  return null;
}

function stopExternalWorker(threadId, reason) {
  const owner = externalWorkerOwner(threadId);
  if (!owner) return;
  log(`[${threadId}] 停止遗留 worker pid=${owner.pid}（${reason}）`);
  try { process.kill(owner.pid, "SIGTERM"); } catch {}
  writeWatcherState(threadId, { status: "stopping", pid: owner.pid, supervisorPid: process.pid, reason });
}

function acquireLock() {
  supervisorLease = acquireProcessLock(LOCK_DIR, { marker: "watcher-supervisor.js" });
  return supervisorLease.acquired;
}

function cleanupLegacyWorkerLocks() {
  let names = [];
  try { names = fs.readdirSync(STONE); } catch { return; }
  for (const name of names.filter(item => /^\.watcher-worker-[a-f0-9]+\.lock$/.test(item))) {
    const legacy = path.join(STONE, name);
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(legacy, "owner.json"), "utf8")); } catch {}
    if (owner?.pid && processMatches(owner.pid, "scripts/watcher.js")) {
      try { process.kill(owner.pid, "SIGTERM"); } catch {}
      log(`[${owner.threadId || "unknown"}] 停止旧版遗留 worker pid=${owner.pid}`);
    }
    try { fs.rmSync(legacy, { recursive: true, force: true }); } catch {}
  }
  try { fs.rmSync(path.join(STONE, "watcher-workers.json"), { force: true }); } catch {}
  try { fs.rmSync(path.join(STONE, ".archive-off"), { force: true }); } catch {}
  try { fs.rmSync(path.join(STONE, ".miner-off"), { force: true }); } catch {}
  try { fs.rmSync(path.join(STONE, ".watcher-off"), { force: true }); } catch {}
}

function writeState() {
  for (const [threadId, entry] of workers) {
    writeWatcherState(threadId, {
      status: "running",
      pid: entry.child.pid,
      supervisorPid: process.pid,
      startedAt: entry.startedAt,
      actions: watcherActions(getMemoryRuntimeConfig(threadId)),
    });
  }
}

function startWorker(threadId) {
  if (workers.has(threadId) || stopping) return;
  const child = spawn(process.execPath, [WORKER_SCRIPT, "--thread", threadId, "--supervisor-pid", String(process.pid)], {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });
  const entry = { child, startedAt: new Date().toISOString() };
  workers.set(threadId, entry);
  log(`[${threadId}] worker 启动 pid=${child.pid}`);
  writeState();
  child.on("exit", (code, signal) => {
    if (workers.get(threadId)?.child !== child) return;
    workers.delete(threadId);
    writeWatcherState(threadId, {
      status: stopping ? "stopped" : "exited",
      pid: null,
      supervisorPid: process.pid,
      exitCode: code,
      exitSignal: signal || null,
    });
    if (!stopping) {
      entry.restartNotBefore = Date.now() + 30_000;
      restartHistory.set(threadId, entry);
      log(`[${threadId}] worker 退出 code=${code ?? "-"} signal=${signal || "-"}，稍后由 supervisor 接管`);
    }
  });
  child.on("error", error => log(`[${threadId}] worker 启动失败: ${error.message}`));
}

function stopWorker(threadId, reason) {
  const entry = workers.get(threadId);
  if (!entry) return Promise.resolve();
  workers.delete(threadId);
  log(`[${threadId}] worker 停止（${reason}）`);
  const exited = new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      writeWatcherState(threadId, {
        status: "stopped", pid: null, supervisorPid: process.pid, reason,
      });
      resolve();
    };
    entry.child.once("exit", finish);
    setTimeout(() => {
      try { entry.child.kill("SIGKILL"); } catch {}
      finish();
    }, 5_000).unref();
  });
  try { entry.child.kill("SIGTERM"); } catch {}
  writeWatcherState(threadId, { status: "stopping", pid: entry.child.pid, reason });
  return exited;
}

const restartHistory = new Map();

function markDisabled(threadId, threadConfig) {
  let current = null;
  try {
    const { stateFile } = watcherPaths(threadId);
    current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {}
  const actions = watcherActions(threadConfig);
  if (current?.status === "disabled" && current.pid == null
      && current.supervisorPid === process.pid
      && JSON.stringify(current.actions || {}) === JSON.stringify(actions)) return;
  writeWatcherState(threadId, {
    status: "disabled", pid: null, supervisorPid: process.pid, actions,
  });
}

function syncRunningState(threadId, pid, threadConfig, startedAt = null) {
  let current = null;
  try {
    const { stateFile } = watcherPaths(threadId);
    current = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {}
  const actions = watcherActions(threadConfig);
  if (current?.status === "running" && current.pid === pid
      && current.supervisorPid === process.pid
      && JSON.stringify(current.actions || {}) === JSON.stringify(actions)) return;
  writeWatcherState(threadId, {
    status: "running", pid, supervisorPid: process.pid,
    startedAt: startedAt || current?.startedAt || null, actions,
  });
}

function reconcile() {
  const configured = new Set(listMemoryIds());
  const config = Object.fromEntries([...configured].map(memoryId => [memoryId, getMemoryRuntimeConfig(memoryId)]));
  const enabled = new Set(enabledThreadIds(config, [...configured]));
  for (const threadId of workers.keys()) {
    if (!configured.has(threadId)) stopWorker(threadId, "线程已从配置移除");
    else if (!enabled.has(threadId)) stopWorker(threadId, "该记忆体 watcher 已设为 OFF");
  }
  for (const threadId of configured) {
    if (!enabled.has(threadId)) {
      stopExternalWorker(threadId, "该记忆体 watcher 已设为 OFF");
      markDisabled(threadId, config[threadId] || {});
      continue;
    }
    const prior = restartHistory.get(threadId);
    if (prior?.restartNotBefore > Date.now()) continue;
    const managed = workers.get(threadId);
    if (managed) {
      syncRunningState(threadId, managed.child.pid, config[threadId] || {}, managed.startedAt);
      continue;
    }
    const external = externalWorkerOwner(threadId);
    if (external?.pending) {
      writeWatcherState(threadId, {
        status: "starting", pid: null, supervisorPid: process.pid,
        actions: watcherActions(config[threadId] || {}),
      });
      continue;
    }
    if (external) {
      syncRunningState(threadId, external.pid, config[threadId] || {}, external.createdAt || null);
      continue;
    }
    startWorker(threadId);
    restartHistory.delete(threadId);
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，停止 ${workers.size} 个 worker`);
  await Promise.all([...workers.keys()].map(threadId => stopWorker(threadId, signal)));
  supervisorLease?.release();
  supervisorLease = null;
  try { fs.rmSync(PID_FILE, { force: true }); } catch {}
  process.exit(0);
}

async function main() {
  const delayIndex = args.indexOf("--delay");
  const delaySec = delayIndex >= 0 ? Math.max(0, Number(args[delayIndex + 1]) || 0) : 0;
  if (delaySec) await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
  if (!acquireLock()) {
    log("已有 watcher supervisor 正在运行，本进程退出");
    return;
  }
  cleanupLegacyWorkerLocks();
  fs.writeFileSync(PID_FILE, String(process.pid));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("exit", () => {
    supervisorLease?.release();
  });
  log(`启动 pid=${process.pid}；配置巡检 ${intervalSec}s`);
  while (!stopping) {
    try { reconcile(); } catch (error) { log(`配置巡检失败: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, intervalSec * 1000));
  }
}

main().catch(error => {
  log(`FATAL: ${error.stack || error.message}`);
  if (process.env.STMEM_SUPERVISOR_SELF_HEAL === "1") {
    try {
      const replacement = spawn(process.execPath, [__filename, "--delay", "30"], {
        detached: true, stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
        env: { ...process.env, STMEM_SUPERVISOR_SELF_HEAL: "1" },
      });
      replacement.unref();
      log(`supervisor 自愈：已安排 30 秒后重启 pid=${replacement.pid}`);
    } catch (restartError) {
      log(`supervisor 自愈安排失败: ${restartError.message}`);
    }
  }
  shutdown("fatal");
});
