"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runDeepSearch } = require("../src/services/deep-search-service");

test("shared deep search exposes only read-only child tools and does not persist a topic", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-deep-search-service-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const threadRoot = path.join(root, "thread");
  fs.mkdirSync(path.join(projectRoot, "operations"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "operations", "memory-subagent-operations.md"), "search operation", "utf8");
  fs.writeFileSync(path.join(projectRoot, "mcp-server.js"), "", "utf8");
  let captured;

  const result = runDeepSearch({ threadId: "thread-test", query: "生成专题时间线" }, {
    projectRoot,
    getThreadDirImpl: () => threadRoot,
    runSubagentImpl: (prompt, options) => {
      captured = { prompt, options };
      return "只读搜索结果";
    },
  });

  const config = JSON.parse(fs.readFileSync(path.join(threadRoot, "tmp", "deep-search-mcp.json"), "utf8"));
  assert.equal(result, "只读搜索结果");
  assert.match(captured.prompt, /生成专题时间线/);
  assert.deepEqual(captured.options.allowedTools, [
    "mcp__stone_memory_search__memory_keyword_search",
    "mcp__stone_memory_search__memory_archive_context",
  ]);
  assert.equal(config.mcpServers.stone_memory_search.env.STMEM_SEARCH_ONLY, "1");
  assert.equal(config.mcpServers.stone_memory_search.env.STMEM_THREAD_ID, "thread-test");
  assert.equal(fs.existsSync(path.join(threadRoot, "memory", "topics")), false);
});
