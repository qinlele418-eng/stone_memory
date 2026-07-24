const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMcpRebuildPreviewArgs } = require("../src/services/mcp-rebuild-preview");

test("MCP rebuild generates a CLI dry-run command without apply", () => {
  const args = buildMcpRebuildPreviewArgs("/project/bin/stmem", {
    threadId: "thread-1",
    windowDays: 5,
    toolPairs: 40,
  }, { summaryLimit: 200, minImportance: 3, watermark: true });
  assert.deepEqual(args, [
    "/project/bin/stmem",
    "rebuild",
    "--thread", "thread-1",
    "--window", "5",
    "--tool-pairs", "40",
    "--summary-limit", "200",
    "--min-importance", "3",
    "--trigger", "mcp",
    "--watermark",
  ]);
  assert.equal(args.includes("--apply"), false);
});
