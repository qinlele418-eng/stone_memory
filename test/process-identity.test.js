"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { processCommand, processMatches } = require("../src/lib/process-identity");

test("process identity requires both a live pid and the expected command marker", () => {
  const adapters = {
    platform: "win32",
    kill: () => {},
    execFileSync: (command, args) => {
      assert.equal(command, "powershell.exe");
      assert.match(args.at(-1), /ProcessId=123/);
      return "node C:\\repo\\test\\process-identity.test.js\n";
    },
  };
  assert.match(processCommand(123, adapters), /node/);
  assert.equal(processMatches(123, "process-identity.test.js", adapters), true);
  assert.equal(processMatches(123, "watcher-supervisor.js", adapters), false);
  assert.equal(processMatches(-1, "watcher-supervisor.js", adapters), false);
});
