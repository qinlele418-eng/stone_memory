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
    // The baseline fixture stays intact: only the nine migrated public tools
    // leave Core. Restricted child-mode definitions remain byte-for-byte equal.
    const migrated = new Set(["stmem_notebook_status", "stmem_notebook_query", "stmem_notebook_read", "stmem_notebook_topic_manage", "stmem_notebook_write", "stmem_notebook_delegate", "stmem_dream_latest", "stmem_dream_status", "stmem_dream_get"]);
    const expected = mode === "normal" ? snapshots[key].filter(tool => !migrated.has(tool.name)) : snapshots[key];
    assert.deepEqual(JSON.parse(result.stdout).result.tools, expected);
  });
}
