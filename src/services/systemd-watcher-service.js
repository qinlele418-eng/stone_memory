"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { watcherServiceContent } = require("../lib/systemd-watcher-service");

const UNIT = "stmem-watcher.service";
const MARKER = "Description=STMEM Memory Watcher";

function servicePath(home = os.homedir()) {
  return path.join(home, ".config", "systemd", "user", UNIT);
}

function command(args, run = execFileSync) {
  return String(run("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "").trim();
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
  command(["daemon-reload"], options.run);
  command(["enable", "--now", UNIT], options.run);
  return { installed: true, enabled: true, running: true, unit: UNIT, file };
}

function systemdWatcherServiceStatus(options = {}) {
  const file = servicePath(options.home || os.homedir());
  const installed = fs.existsSync(file);
  if (installed) assertOwned(file);
  let enabled = false, running = false;
  try { enabled = command(["is-enabled", UNIT], options.run) === "enabled"; } catch {}
  try { running = command(["is-active", UNIT], options.run) === "active"; } catch {}
  return { installed, enabled, running, healthy: installed && enabled && running, unit: UNIT, file };
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
