"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { watcherServiceContent } = require("../lib/systemd-watcher-service");
const { readManagedPid, startManagedProcess } = require("./managed-local-process");

const UNIT = "stmem-watcher.service";
const MARKER = "Description=STMEM Memory Watcher";
const PROCESS_MARKER = "watcher-supervisor.js";

function servicePath(home = os.homedir()) {
  return path.join(home, ".config", "systemd", "user", UNIT);
}

function runtimePaths(home = os.homedir(), projectDir) {
  return {
    pidFile: path.join(home, ".stone_memory", "watcher.pid"),
    logFile: path.join(home, ".stone_memory", "watcher-supervisor.log"),
    script: path.join(projectDir, "scripts", "watcher-supervisor.js"),
  };
}

function enableLinkPath(home = os.homedir()) {
  return path.join(home, ".config", "systemd", "user", "default.target.wants", UNIT);
}

function command(args, run = execFileSync) {
  return String(run("systemctl", ["--user", ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000,
  }) || "").trim();
}

function expectedService({ home = os.homedir(), nodePath = process.execPath, projectDir } = {}) {
  if (!projectDir) throw new Error("缺少 Stone Memory 项目目录");
  return watcherServiceContent({ nodePath, watcherScript: path.join(projectDir, "scripts", "watcher-supervisor.js"), home });
}

function assertOwned(file) {
  if (!fs.existsSync(file)) return;
  if (!fs.readFileSync(file, "utf8").includes(MARKER)) throw new Error(`拒绝覆盖非 Stone Memory unit：${file}`);
}

function installSystemdWatcherService(options = {}) {
  const home = options.home || os.homedir();
  const file = servicePath(home);
  assertOwned(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = expectedService({ ...options, home });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    // 保留旧版已长期使用的分步 systemd 安装链路，便于准确定位失败步骤。
    command(["daemon-reload"], options.run);
    command(["enable", UNIT], options.run);
    command(["start", UNIT], options.run);
    return { installed: true, enabled: true, running: true, manager: "systemd", unit: UNIT, file };
  } catch (error) {
    // user manager 不可用时恢复旧版行为：至少保证 supervisor 真正常驻工作。
    const paths = runtimePaths(home, options.projectDir);
    const start = options.startFallback || (settings => startManagedProcess(settings));
    const fallback = start({
      script: paths.script,
      pidFile: paths.pidFile,
      marker: PROCESS_MARKER,
      logFile: paths.logFile,
      env: { ...process.env, STMEM_SUPERVISOR_SELF_HEAL: "1" },
    });
    return {
      installed: true,
      enabled: fs.existsSync(enableLinkPath(home)),
      running: !!fallback.running,
      manager: "local",
      pid: fallback.pid || null,
      systemdError: error.message,
      unit: UNIT,
      file,
    };
  }
}

function systemdWatcherServiceStatus(options = {}) {
  const home = options.home || os.homedir();
  const file = servicePath(home);
  const installed = fs.existsSync(file);
  if (installed) assertOwned(file);
  let enabled = fs.existsSync(enableLinkPath(home)), systemdRunning = false, queryError = null;
  try { enabled = command(["is-enabled", UNIT], options.run) === "enabled"; } catch (error) { queryError = error.message; }
  try { systemdRunning = command(["is-active", UNIT], options.run) === "active"; } catch (error) { queryError ||= error.message; }
  const paths = options.projectDir ? runtimePaths(home, options.projectDir) : { pidFile: path.join(home, ".stone_memory", "watcher.pid") };
  const readPid = options.readPid || (pidFile => readManagedPid(pidFile, PROCESS_MARKER));
  const pid = readPid(paths.pidFile);
  const running = systemdRunning || !!pid;
  return {
    installed, enabled, running, systemdRunning, pid: pid || null,
    manager: systemdRunning ? "systemd" : pid ? "local" : null,
    queryError, healthy: installed && enabled && running, unit: UNIT, file,
  };
}

function repairSystemdWatcherService(options = {}) {
  const before = systemdWatcherServiceStatus(options);
  if (before.healthy && fs.readFileSync(before.file, "utf8") === expectedService(options)) return { ...before, repaired: false };
  return { ...installSystemdWatcherService(options), repaired: true };
}

function removeSystemdWatcherService(options = {}) {
  const file = servicePath(options.home || os.homedir());
  if (!fs.existsSync(file)) return { removed: false, unit: UNIT, file };
  assertOwned(file);
  command(["disable", "--now", UNIT], options.run);
  fs.unlinkSync(file);
  command(["daemon-reload"], options.run);
  return { removed: true, unit: UNIT, file };
}

module.exports = {
  UNIT, servicePath, installSystemdWatcherService, systemdWatcherServiceStatus,
  repairSystemdWatcherService, removeSystemdWatcherService,
};
