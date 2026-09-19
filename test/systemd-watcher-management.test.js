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
    if (action === "enable --now stmem-watcher.service") { enabled = true; active = true; return ""; }
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

test("Linux watcher service refuses to overwrite or remove an unrelated unit", t => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(servicePath(f.home)), { recursive: true });
  fs.writeFileSync(servicePath(f.home), "[Service]\nExecStart=/bin/other\n");
  assert.throws(() => installSystemdWatcherService(f), /拒绝覆盖非 Stone Memory unit/);
  assert.throws(() => removeSystemdWatcherService(f), /拒绝覆盖非 Stone Memory unit/);
});
