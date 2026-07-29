const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("deep-search child MCP exposes only its two read-only search tools", () => {
  const server = path.join(__dirname, "..", "mcp-server.js");
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ].map(message => JSON.stringify(message)).join("\n") + "\n";
  const child = spawnSync(process.execPath, [server], {
    env: Object.fromEntries(Object.entries({
      ...process.env, STMEM_SEARCH_ONLY: "1", STMEM_THREAD_ID: "test-thread",
    }).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    input,
    encoding: "utf8",
    timeout: 2000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const responses = child.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.deepEqual(responses[1].result.tools.map(tool => tool.name), [
    "memory_keyword_search",
    "memory_archive_context",
  ]);
});
