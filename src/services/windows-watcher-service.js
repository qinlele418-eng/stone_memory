"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { processMatches } = require("../lib/process-identity");

const TASK_NAME = "StoneMemory-watcher-supervisor";

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}

function taskXml({ nodePath, watcherScript, workingDirectory, userId, now = new Date() }) {
  const startBoundary = new Date(now.getTime() + 60_000).toISOString();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Stone Memory watcher supervisor</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
    <TimeTrigger><StartBoundary>${startBoundary}</StartBoundary><Enabled>true</Enabled><Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author">${userId ? `<UserId>${escapeXml(userId)}</UserId>` : ""}<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>${escapeXml(nodePath)}</Command><Arguments>&quot;${escapeXml(watcherScript)}&quot;</Arguments><WorkingDirectory>${escapeXml(workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

function servicePaths(projectDir) {
  const username = process.env.USERNAME;
  const userId = username ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ""}${username}` : null;
  return {
    nodePath: process.execPath,
    watcherScript: path.join(projectDir, "scripts", "watcher-supervisor.js"),
    workingDirectory: projectDir,
    userId,
  };
}

function schtasksPath() {
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "schtasks.exe");
}

function runSchtasks(args, { execFile = execFileSync } = {}) {
  return execFile(schtasksPath(), args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function queryTask(options = {}) {
  try {
    return { available: true, exists: true, xml: runSchtasks(["/Query", "/TN", TASK_NAME, "/XML"], options) };
  } catch (error) {
    // schtasks does not offer a locale-neutral distinction between a missing task
    // and an operational failure.  Do not turn access or scheduler failures into
    // a misleading "not installed" result.
    return { available: false, exists: null, error };
  }
}

function taskMatches(xml, paths) {
  return xml.includes(`<Command>${escapeXml(paths.nodePath)}</Command>`)
    && xml.includes(`<WorkingDirectory>${escapeXml(paths.workingDirectory)}</WorkingDirectory>`)
    && (!paths.userId || xml.includes(`<UserId>${escapeXml(paths.userId)}</UserId>`))
    && xml.includes(escapeXml(paths.watcherScript));
}

function installWindowsWatcherService({ projectDir, platform = process.platform, ...options }) {
  if (platform !== "win32") throw new Error("Windows Task Scheduler watcher service 仅支持 Windows");
  const paths = servicePaths(projectDir);
  if (!paths.userId) throw new Error("无法确定 Windows 当前用户，未创建 watcher 计划任务");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-watcher-task-"));
  const xmlFile = path.join(tempDir, "task.xml");
  try {
    fs.writeFileSync(xmlFile, Buffer.from(`\uFEFF${taskXml(paths)}`, "utf16le"));
    runSchtasks(["/Create", "/TN", TASK_NAME, "/XML", xmlFile, "/F"], options);
    runSchtasks(["/Run", "/TN", TASK_NAME], options);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
  return { taskName: TASK_NAME, ...paths };
}

function windowsWatcherServiceStatus({ projectDir, platform = process.platform, ...options }) {
  if (platform !== "win32") return { supported: false, installed: false, healthy: false };
  const paths = servicePaths(projectDir);
  const queried = queryTask(options);
  const expected = queried.available && taskMatches(queried.xml, paths);
  let pid = null;
  try { pid = Number(fs.readFileSync(path.join(os.homedir(), ".stone_memory", "watcher.pid"), "utf8")); } catch {}
  const running = !!pid && processMatches(pid, "watcher-supervisor.js");
  return {
    supported: true, installed: queried.exists, expected, running,
    pid: running ? pid : null, healthy: expected && running,
    queryError: queried.error?.message || null,
  };
}

function stopSupervisor({ kill = process.kill, matches = processMatches, readPid, waitMs = 5_000 } = {}) {
  let pid = null;
  try { pid = readPid ? readPid() : Number(fs.readFileSync(path.join(os.homedir(), ".stone_memory", "watcher.pid"), "utf8")); } catch {}
  if (!pid || !matches(pid, "watcher-supervisor.js")) return null;
  kill(pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && matches(pid, "watcher-supervisor.js")) {
    // This short synchronous wait is only used by the explicit remove command.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return !matches(pid, "watcher-supervisor.js");
}

function removeWindowsWatcherService({ projectDir, platform = process.platform, ...options }) {
  if (platform !== "win32") throw new Error("Windows Task Scheduler watcher service 仅支持 Windows");
  const queried = queryTask(options);
  if (!queried.available) throw new Error(`无法确认 watcher 计划任务状态，未删除任务或停止进程：${queried.error?.message || "未知错误"}`);
  const paths = servicePaths(projectDir);
  if (!taskMatches(queried.xml, paths)) throw new Error("同名计划任务不属于当前 Stone Memory 安装，拒绝删除");
  runSchtasks(["/Delete", "/TN", TASK_NAME, "/F"], options);
  const stopped = stopSupervisor(options);
  return { taskName: TASK_NAME, removed: true, stopped };
}

function repairWindowsWatcherService(input) {
  const status = windowsWatcherServiceStatus(input);
  if (!status.expected || !status.running) return installWindowsWatcherService(input);
  return { repaired: false, taskName: TASK_NAME };
}

module.exports = {
  TASK_NAME, escapeXml, taskXml, taskMatches, servicePaths,
  installWindowsWatcherService, windowsWatcherServiceStatus,
  repairWindowsWatcherService, removeWindowsWatcherService, stopSupervisor,
};
