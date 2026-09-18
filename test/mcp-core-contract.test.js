const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const snapshots = require("./fixtures/mcp/core-tools.json");
for (const [mode, key] of [["normal", "TOOLS"], ["search", "SEARCH_TOOLS"], ["notebook", "NOTEBOOK_STEWARD_TOOLS"]]) {
  test(`MCP complete tool contract: ${mode}`, t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-contract-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [path.join(__dirname, "../mcp-server.js")], {
      env: { ...process.env, HOME: home, USERPROFILE: home, STMEM_SKIP_PENDING_REBUILDS: "1", STMEM_SEARCH_ONLY: mode === "search" ? "1" : "0", STMEM_NOTEBOOK_STEWARD: mode === "notebook" ? "1" : "0" },
      input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n", encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result.tools, snapshots[key]);
  });
}
