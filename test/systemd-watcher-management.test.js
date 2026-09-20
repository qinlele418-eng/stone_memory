const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  servicePath, installSystemdWatcherService, systemdWatcherServiceStatus,
  repairSystemdWatcherService, removeSystemdWatcherService,
} = require("../src/services/systemd-watcher-service");

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-systemd-service-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  let enabled = false, active = false;
  const run = (_command, args) => {
    calls.push(args);
    const action = args.slice(1).join(" ");
    if (action === "enable stmem-watcher.service") { enabled = true; return ""; }
    if (action === "start stmem-watcher.service") { active = true; return ""; }
    if (action === "disable --now stmem-watcher.service") { enabled = false; active = false; return ""; }
    if (action === "is-enabled stmem-watcher.service") {
      if (!enabled) throw new Error("disabled");
      return "enabled\n";
    }
    if (action === "is-active stmem-watcher.service") {
      if (!active) throw new Error("inactive");
      return "active\n";
    }
    return "";
  };
  return { home, calls, run, projectDir: "/opt/stone_memory", nodePath: "/usr/bin/node" };
}

test("Linux watcher service install, status, repair and remove use the owned user unit", t => {
  const f = fixture(t);
  const installed = installSystemdWatcherService(f);
  assert.equal(installed.running, true);
  const content = fs.readFileSync(servicePath(f.home), "utf8");
  assert.match(content, /Description=STMEM Memory Watcher/);
  assert.match(content, /ExecStart=\/usr\/bin\/node \/opt\/stone_memory\/scripts\/watcher-supervisor\.js/);
  assert.equal(systemdWatcherServiceStatus(f).healthy, true);
  assert.equal(repairSystemdWatcherService(f).repaired, false);
  assert.equal(removeSystemdWatcherService(f).removed, true);
  assert.equal(fs.existsSync(servicePath(f.home)), false);
  assert.ok(f.calls.some(args => args.includes("daemon-reload")));
});

test("Linux watcher service restores the legacy detached supervisor fallback", t => {
  const f = fixture(t);
  let settings = null;
  f.run = () => { throw new Error("user manager unavailable"); };
  f.startFallback = value => {
    settings = value;
    return { running: true, started: true, pid: 4321 };
  };
  const result = installSystemdWatcherService(f);
  assert.equal(result.manager, "local");
  assert.equal(result.running, true);
  assert.equal(result.pid, 4321);
  assert.match(settings.script, /scripts\/watcher-supervisor\.js$/);
  assert.equal(settings.env.STMEM_SUPERVISOR_SELF_HEAL, "1");
});

test("Linux watcher status trusts a live supervisor PID when systemd cannot be queried", t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(servicePath(f.home)), { recursive: true });
  fs.writeFileSync(servicePath(f.home), "Description=STMEM Memory Watcher\n");
  fs.mkdirSync(path.join(f.home, ".config", "systemd", "user", "default.target.wants"), { recursive: true });
  fs.symlinkSync(servicePath(f.home), path.join(f.home, ".config", "systemd", "user", "default.target.wants", "stmem-watcher.service"));
  f.run = () => { throw new Error("cannot connect to user bus"); };
  f.readPid = () => 9876;
  const result = systemdWatcherServiceStatus(f);
  assert.equal(result.enabled, true);
  assert.equal(result.running, true);
  assert.equal(result.manager, "local");
  assert.equal(result.healthy, true);
  assert.match(result.queryError, /cannot connect/);
});

test("Linux watcher service refuses to overwrite or remove an unrelated unit", t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(servicePath(f.home)), { recursive: true });
  fs.writeFileSync(servicePath(f.home), "[Service]\nExecStart=/bin/other\n");
  assert.throws(() => installSystemdWatcherService(f), /拒绝覆盖非 Stone Memory unit/);
  assert.throws(() => removeSystemdWatcherService(f), /拒绝覆盖非 Stone Memory unit/);
});
