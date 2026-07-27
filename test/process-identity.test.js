"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { processCommand, processMatches } = require("../src/lib/process-identity");

test("process identity requires both a live pid and the expected command marker", () => {
  assert.match(processCommand(process.pid), /node/);
  assert.equal(processMatches(process.pid, "process-identity.test.js"), true);
  assert.equal(processMatches(process.pid, "watcher-supervisor.js"), false);
  assert.equal(processMatches(-1, "watcher-supervisor.js"), false);
});
