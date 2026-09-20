#!/usr/bin/env node
/**
 * stmem watcher — 只修改/查看每个记忆体的 watcher 期望状态。
 * 进程启停与自愈全部由常驻 supervisor 根据 stmem.json 收敛。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadConfig, listMemoryIds, getMemoryContext, getMemoryRuntimeConfig } = require("../src/config");
const { saveConfig } = require("../src/services/thread-setup");
const { writeJson } = require("../src/services/memory-setup");
const { readManagedPid } = require("../src/services/managed-local-process");
const { readWatcherState, watcherActions, watcherEnabled } = require("../src/services/watcher-runtime");
const {
  installWindowsWatcherService, windowsWatcherServiceStatus,
  repairWindowsWatcherService, removeWindowsWatcherService,
} = require("../src/services/windows-watcher-service");
const {
  installSystemdWatcherService, systemdWatcherServiceStatus,
  repairSystemdWatcherService, removeSystemdWatcherService,
} = require("../src/services/systemd-watcher-service");

const STONE = path.join(os.homedir(), ".stone_memory");
const LEGACY_KEYS = {
  archive: "automaticFullMining",
  miner: "automaticMemoryMaintenance",
  compression: "automaticCompression",
  dream: "automaticDream",
};
const CORE_MODULES = new Set(Object.keys(LEGACY_KEYS));
const args = process.argv.slice(3);
const subcmd = args[0] || "status";
const threadIndex = args.indexOf("--thread");
const memoryIndex = args.indexOf("--memory");
const legacyThreadId = threadIndex >= 0 ? args[threadIndex + 1] : null;
const explicitMemoryId = memoryIndex >= 0 ? args[memoryIndex + 1] : null;
if (legacyThreadId && explicitMemoryId && legacyThreadId !== explicitMemoryId) {
  throw new Error("--memory 与兼容参数 --thread 不能指向不同记忆体");
}
const threadId = explicitMemoryId || legacyThreadId;

function selectedConfig() {
  if (!threadId) throw new Error("watcher 状态是每记忆体配置，请加 --memory <id>");
  const context = getMemoryContext(threadId);
  return { context, config: loadConfig() };
}

function parseOnOff(value, label) {
  if (!new Set(["on", "off"]).has(value)) throw new Error(`${label} 必须指定 on 或 off`);
  return value === "on";
}

function saveExpectedState(mutator) {
  const { context, config } = selectedConfig();
  if (context.layout === "memory-v1") {
    const file = path.join(context.root, "watcher.json");
    const next = { schemaVersion: 1, enabled: false, modules: {}, ...(context.watcherConfig || {}) };
    const compatibility = {
      get watcherEnabled() { return next.enabled; },
      set watcherEnabled(value) { next.enabled = value; },
      get watcherModules() { return next.modules; },
      set watcherModules(value) { next.modules = value; },
    };
    mutator(compatibility);
    next.updatedAt = new Date().toISOString();
    writeJson(file, next);
    return getMemoryRuntimeConfig(threadId);
  }
  mutator(config[threadId]);
  saveConfig(config);
  return config[threadId];
}

function setModule(entry, name, enabled) {
  entry.watcherModules = { ...(entry.watcherModules || {}), [name]: enabled };
  // 内置四项兼容尚未迁移的 reader；开发者插件无需核心字段。
  if (LEGACY_KEYS[name]) entry[LEGACY_KEYS[name]] = enabled;
}

if (subcmd === "service") {
  const action = args[1];
  if (!new Set(["install", "status", "repair", "remove"]).has(action)) {
    throw new Error("用法：stmem watcher service <install|status|repair|remove>");
  }
  const projectDir = path.resolve(__dirname, "..");
  if (process.platform === "linux") {
    const options = { projectDir };
    if (action === "install") {
      const result = installSystemdWatcherService(options);
      console.log(`watcher systemd 用户服务已安装并启动：${result.unit}`);
    } else if (action === "status") {
      const result = systemdWatcherServiceStatus(options);
      console.log(`watcher supervisor: ${result.running ? `运行中${result.pid ? ` (pid ${result.pid})` : ""}` : "未运行"}`);
      console.log(`  systemd unit: ${result.installed ? "已安装" : "未安装"} · ${result.enabled ? "已启用" : "未启用"} · ${result.systemdRunning ? "active" : "inactive"}`);
      if (result.manager === "local") console.log("  当前由本地常驻 supervisor 接管（systemd user manager 不可用）");
      if (result.queryError) console.log(`  systemd query: ${result.queryError}`);
    } else if (action === "repair") {
      const result = repairSystemdWatcherService(options);
      console.log(result.repaired === false ? "watcher service 已正常" : `watcher service 已修复：${result.unit}`);
    } else {
      const result = removeSystemdWatcherService(options);
      console.log(result.removed ? "watcher systemd 用户服务已移除" : "watcher systemd 用户服务原本未安装");
    }
    return;
  }
  if (process.platform !== "win32") throw new Error("watcher service 当前支持 Linux systemd 与 Windows Task Scheduler");
  if (action === "install") {
    const result = installWindowsWatcherService({ projectDir });
    console.log(`watcher Task Scheduler 服务已安装并启动：${result.taskName}`);
  } else if (action === "status") {
    const result = windowsWatcherServiceStatus({ projectDir });
    console.log(`watcher service: ${result.healthy ? "正常" : "需要修复"}`);
    console.log(`  task: ${result.queryError ? "无法查询" : result.installed ? (result.expected ? "已安装" : "定义漂移") : "未安装"}`);
    if (result.queryError) console.log(`  query: ${result.queryError}`);
    console.log(`  supervisor: ${result.running ? `运行中 (pid ${result.pid})` : "未运行"}`);
  } else if (action === "repair") {
    const result = repairWindowsWatcherService({ projectDir });
    console.log(result.repaired === false ? "watcher service 已正常" : `watcher service 已修复：${result.taskName}`);
  } else {
    const result = removeWindowsWatcherService({ projectDir });
    console.log(`watcher service 已移除${result.stopped === true ? "，supervisor 已停止" : result.stopped === false ? "；supervisor 在截止时间后仍运行，请手动检查" : "；未发现运行中的 supervisor"}`);
  }
  return;
}

if (subcmd === "on" || subcmd === "off") {
  const enabled = subcmd === "on";
  saveExpectedState(entry => { entry.watcherEnabled = enabled; });
  console.log(`记忆体 ${threadId} watcher 已设为 ${enabled ? "ON" : "OFF"}；supervisor 将自动应用`);
  return;
}

if (subcmd === "set") {
  const changed = [];
  const entry = saveExpectedState(item => {
    for (let index = 1; index < args.length; index++) {
      const flag = args[index];
      if (flag === "--thread" || flag === "--memory") { index += 1; continue; }
      if (!flag.startsWith("--")) continue;
      const name = flag.slice(2);
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error(`非法 watcher 模块名：${name}`);
      if (!CORE_MODULES.has(name) && !name.startsWith("dev-")) {
        throw new Error(`开发者 watcher 模块必须使用 dev- 前缀，例如 --dev-${name} on`);
      }
      const enabled = parseOnOff(args[index + 1], flag);
      setModule(item, name, enabled);
      changed.push(`${name}=${enabled ? "on" : "off"}`);
      index += 1;
    }
    if (!changed.length) throw new Error("set 至少需要一个模块开关，例如 --archive on 或 --dream off");
  });
  console.log(`记忆体 ${threadId} watcher 模块已更新：${changed.join(" · ")}；总开关 ${watcherEnabled(entry) ? "ON" : "OFF"}`);
  return;
}

if (subcmd !== "status") throw new Error("用法：stmem watcher [status|on|off|set|service] --memory <id>");

const supervisorPid = readManagedPid(path.join(STONE, "watcher.pid"), "watcher-supervisor.js");
const supervisorRunning = !!supervisorPid;
const config = loadConfig();
const ids = threadId ? [threadId] : listMemoryIds();
console.log(`watcher supervisor: ${supervisorRunning ? `运行中 (pid ${supervisorPid})` : "未运行"}`);
for (const id of ids) {
  let entry;
  try { entry = getMemoryRuntimeConfig(id); } catch { continue; }
  const enabled = watcherEnabled(entry), actions = watcherActions(entry), state = readWatcherState(id);
  const actual = !enabled ? "OFF" : state?.status === "running" ? `运行中 (pid ${state.pid})` : state?.status || "等待 supervisor 应用";
  console.log(`  ${entry.label || id}: 期望 ${enabled ? "ON" : "OFF"} · 实际 ${actual}`);
  console.log(`    archive ${actions.sync ? "on" : "off"} · miner ${actions.mine ? "on" : "off"} · compression ${actions.compact ? "on" : "off"} · dream ${actions.dream ? "on" : "off"}`);
}
