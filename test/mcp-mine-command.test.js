const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMcpMineArgs } = require("../src/services/mcp-mine-command");

test("MCP mining delegates to the formal CLI without shell interpolation", () => {
  assert.deepEqual(buildMcpMineArgs("/project/bin/stmem", "thread;touch /tmp/nope", {
    date: "2026-07-29;echo nope",
    force: true,
  }), [
    "/project/bin/stmem",
    "mine",
    "--date", "2026-07-29;echo nope",
    "--thread", "thread;touch /tmp/nope",
    "--force",
  ]);
});
