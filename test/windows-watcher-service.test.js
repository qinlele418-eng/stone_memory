"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  TASK_NAME, taskXml, taskMatches, servicePaths, installWindowsWatcherService,
  windowsWatcherServiceStatus, repairWindowsWatcherService, removeWindowsWatcherService,
} = require("../src/services/windows-watcher-service");

const projectDir = "C:\\Users\\测试 用户\\Stone Memory";
const paths = {
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  watcherScript: path.win32.join(projectDir, "scripts", "watcher-supervisor.js"),
  workingDirectory: projectDir,
  userId: "DESKTOP-TEST\\测试 用户",
};

test("Windows watcher task XML is a hidden, current-user singleton with periodic recovery", () => {
  const xml = taskXml({ ...paths, now: new Date("2026-01-01T00:00:00Z") });
  assert.match(xml, /<LogonTrigger><Enabled>true<\/Enabled><\/LogonTrigger>/);
  assert.match(xml, /<Interval>PT5M<\/Interval>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<UserId>DESKTOP-TEST\\测试 用户<\/UserId>/);
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(xml, /<Arguments>&quot;C:\\Users\\测试 用户\\Stone Memory\\scripts\\watcher-supervisor\.js&quot;<\/Arguments>/);
  assert.match(xml, /<WorkingDirectory>C:\\Users\\测试 用户\\Stone Memory<\/WorkingDirectory>/);
  assert.doesNotMatch(xml, /cmd\.exe|powershell|%USERPROFILE%|~|<Command>\.\/|PATH=/i);
});

test("Windows watcher task XML escapes special characters without changing the expected action", () => {
  const special = { nodePath: "C:\\A&B\\node.exe", watcherScript: "C:\\A<B\\watcher.js", workingDirectory: "C:\\A\"B" };
  const xml = taskXml(special);
  assert.match(xml, /C:\\A&amp;B\\node\.exe/);
  assert.match(xml, /C:\\A&lt;B\\watcher\.js/);
  assert.match(xml, /C:\\A&quot;B/);
  assert.equal(taskMatches(xml, special), true);
});

test("install creates then runs exactly one named task through argument arrays", () => {
  const calls = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-windows-service-"));
  try {
    const result = installWindowsWatcherService({
      projectDir: root,
      platform: "win32",
      userId: paths.userId,
      execFile(file, args) { calls.push({ file, args }); return ""; },
    });
    assert.equal(result.taskName, TASK_NAME);
    assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [["/Create", "/TN"], ["/Run", "/TN"]]);
    assert.equal(calls[0].args[2], TASK_NAME);
    assert.equal(calls[1].args[2], TASK_NAME);
    assert.ok(calls[0].args.includes("/XML"));
    assert.ok(calls[0].file.endsWith("System32\\schtasks.exe"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("service status is unsupported outside Windows and repair replaces an unavailable task query", () => {
  assert.deepEqual(windowsWatcherServiceStatus({ projectDir, platform: "linux" }), { supported: false, installed: false, healthy: false });
  const calls = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-windows-repair-"));
  try {
    const result = repairWindowsWatcherService({
      projectDir: root,
      platform: "win32",
      userId: paths.userId,
      execFile(file, args) {
        calls.push(args);
        if (args[0] === "/Query") throw new Error("not found");
        return "";
      },
    });
    assert.equal(result.taskName, TASK_NAME);
    assert.deepEqual(calls.map(args => args[0]), ["/Query", "/Create", "/Run"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("remove deletes the task before gracefully stopping only the supervisor", () => {
  const events = [];
  const result = removeWindowsWatcherService({
    projectDir,
    platform: "win32",
    userId: paths.userId,
    execFile(file, args) {
      events.push(`task:${args[0]}`);
      return args[0] === "/Query" ? taskXml(servicePaths(projectDir, { userId: paths.userId })) : "";
    },
    readPid() { return 1234; },
    matches() { return events.includes("kill") ? false : true; },
    kill() { events.push("kill"); },
  });
  assert.equal(result.removed, true);
  assert.equal(result.stopped, true);
  assert.deepEqual(events, ["task:/Query", "task:/Delete", "kill"]);
});

test("remove refuses an unverified task and a scheduler query failure", () => {
  assert.throws(() => removeWindowsWatcherService({
    projectDir,
    platform: "win32",
    userId: paths.userId,
    execFile(file, args) { return args[0] === "/Query" ? "<Task><Actions/></Task>" : ""; },
  }), /拒绝删除/);
  assert.throws(() => removeWindowsWatcherService({
    projectDir,
    platform: "win32",
    userId: paths.userId,
    execFile() { throw new Error("access denied"); },
  }), /未删除任务或停止进程/);
});

test("a supervisor that ignores SIGTERM is reported as still running", () => {
  assert.equal(require("../src/services/windows-watcher-service").stopSupervisor({
    readPid: () => 1234,
    matches: () => true,
    kill() {},
    waitMs: 0,
  }), false);
});
