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

test("Windows process identity keeps a bounded lookup timeout and treats lookup failure as inactive", () => {
  let options;
  const adapters = {
    platform: "win32",
    kill: () => {},
    execFileSync: (command, args, execOptions) => {
      assert.equal(command, "powershell.exe");
      assert.match(args.at(-1), /ProcessId=123/);
      options = execOptions;
      const error = new Error("PowerShell lookup timed out");
      error.code = "ETIMEDOUT";
      throw error;
    },
  };

  assert.equal(processCommand(123, adapters), "");
  assert.equal(processMatches(123, "node.exe", adapters), false);
  assert.deepEqual(options, { encoding: "utf8", timeout: 8000, windowsHide: true });
});
