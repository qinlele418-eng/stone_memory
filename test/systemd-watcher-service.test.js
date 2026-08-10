"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { systemdUserPath, watcherServiceContent } = require("../src/lib/systemd-watcher-service");

test("watcher service includes user-local CLI path without using a shell", () => {
  const content = watcherServiceContent({
    nodePath: "/usr/bin/node",
    watcherScript: "/opt/stmem/scripts/watcher-supervisor.js",
    home: "/home/alice",
  });
  assert.match(content, /Environment="PATH=\/home\/alice\/\.local\/bin:/);
  assert.match(content, /ExecStart=\/usr\/bin\/node \/opt\/stmem\/scripts\/watcher-supervisor\.js/);
  assert.doesNotMatch(content, /ExecStopPost/);
  assert.match(content, /KillMode=control-group/);
  assert.doesNotMatch(content, /\/bin\/sh|-c /);
});

test("systemd user path retains standard system locations", () => {
  assert.equal(
    systemdUserPath("/home/alice"),
    "/home/alice/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  );
});
