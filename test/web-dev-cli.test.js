"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("web dev uses Node watch while preserving the existing managed web boundary", () => {
  const root = path.resolve(__dirname, "..");
  const script = fs.readFileSync(path.join(root, "scripts", "stmem-web.js"), "utf8");
  const watcher = fs.readFileSync(path.join(root, "scripts", "stmem-web-watch.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const cli = fs.readFileSync(path.join(root, "bin", "stmem"), "utf8");
  assert.equal(manifest.scripts.dev, "node bin/stmem web dev");
  assert.match(script, /script: WATCH_SCRIPT/u);
  assert.match(watcher, /"--watch", "--watch-preserve-output"/u);
  assert.match(watcher, /writePrivateFile\(PID_FILE, String\(process\.pid\)\)/u);
  assert.match(watcher, /ensurePrivateDirectory\(STONE\)/u);
  assert.match(watcher, /child\.kill\(signal\)/u);
  assert.match(script, /请先执行 stmem web stop/u);
  assert.match(script, /readManagedPid\(PID_FILE, MARKER\)/u);
  assert.match(cli, /stmem web dev/u);
});
