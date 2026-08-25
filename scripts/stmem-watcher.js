#!/usr/bin/env node
/**
 * stmem watcher — 只修改/查看每个记忆体的 watcher 期望状态。
 * 进程启停与自愈全部由常驻 supervisor 根据 stmem.json 收敛。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { loadConfig, listThreadIds } = require("../src/config");
const { saveConfig } = require("../src/services/thread-setup");
const { processMatches } = require("../src/lib/process-identity");
const { readWatcherState, watcherActions, watcherEnabled } = require("../src/services/watcher-runtime");
const {
  installWindowsWatcherService, windowsWatcherServiceStatus,
  repairWindowsWatcherService, removeWindowsWatcherService,
} = require("../src/services/windows-watcher-service");

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
const threadId = threadIndex >= 0 ? args[threadIndex + 1] : null;

function selectedConfig() {
  if (!threadId) throw new Error("watcher 状态是每记忆体配置，请加 --thread <id>");
  const config = loadConfig();
  if (!config[threadId] || typeof config[threadId] !== "object") throw new Error(`记忆体不存在：${threadId}`);
  return config;
}

function parseOnOff(value, label) {
  if (!new Set(["on", "off"]).has(value)) throw new Error(`${label} 必须指定 on 或 off`);
  return value === "on";
}

function saveExpectedState(mutator) {
  const config = selectedConfig();
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
  if (process.platform !== "win32") throw new Error("watcher service 子命令当前仅支持 Windows；Linux 请使用 systemd user service");
  const projectDir = path.resolve(__dirname, "..");
  if (action === "install") {
    const result = installWindowsWatcherService({ projectDir });
    console.log(`watcher Task Scheduler 服务已安装并启动：${result.taskName}`);
  } else if (action === "status") {
    const result = windowsWatcherServiceStatus({ projectDir });
    console.log(`watcher service: ${result.healthy ? "正常" : "需要修复"}`);
    console.log(`  task: ${result.installed ? (result.expected ? "已安装" : "定义漂移") : "未安装"}`);
    console.log(`  supervisor: ${result.running ? `运行中 (pid ${result.pid})` : "未运行"}`);
  } else if (action === "repair") {
    const result = repairWindowsWatcherService({ projectDir });
    console.log(result.repaired === false ? "watcher service 已正常" : `watcher service 已修复：${result.taskName}`);
  } else {
    const result = removeWindowsWatcherService({ projectDir });
    console.log(`watcher service 已移除${result.stopped ? "，supervisor 已停止" : ""}`);
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
      if (flag === "--thread") { index += 1; continue; }
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

if (subcmd !== "status") throw new Error("用法：stmem watcher [status|on|off|set|service] --thread <id>");

let supervisorPid = null;
try { supervisorPid = Number(fs.readFileSync(path.join(STONE, "watcher.pid"), "utf8")); } catch {}
const supervisorRunning = !!supervisorPid && processMatches(supervisorPid, "watcher-supervisor.js");
const config = loadConfig();
const ids = threadId ? [threadId] : listThreadIds();
console.log(`watcher supervisor: ${supervisorRunning ? `运行中 (pid ${supervisorPid})` : "未运行"}`);
for (const id of ids) {
  const entry = config[id];
  if (!entry || typeof entry !== "object") continue;
  const enabled = watcherEnabled(entry), actions = watcherActions(entry), state = readWatcherState(id);
  const actual = !enabled ? "OFF" : state?.status === "running" ? `运行中 (pid ${state.pid})` : state?.status || "等待 supervisor 应用";
  console.log(`  ${entry.label || id}: 期望 ${enabled ? "ON" : "OFF"} · 实际 ${actual}`);
  console.log(`    archive ${actions.sync ? "on" : "off"} · miner ${actions.mine ? "on" : "off"} · compression ${actions.compact ? "on" : "off"} · dream ${actions.dream ? "on" : "off"}`);
}
