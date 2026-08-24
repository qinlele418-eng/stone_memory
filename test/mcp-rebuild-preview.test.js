const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMcpRebuildRequest, buildMcpRebuildPreviewArgs, buildMcpRebuildQueueArgs, buildMcpRebuildExecuteArgs } = require("../src/services/mcp-rebuild-preview");

test("MCP preview and queue share the structured rebuild request", () => {
  const request = buildMcpRebuildRequest({ threadId: "thread-1", windowDays: 5, toolPairs: 40 }, {
    summaryLimit: 200, minImportance: 3, watermark: true,
  });
  assert.deepEqual(request, {
    threadId: "thread-1",
    summary: { mode: "limited", limit: 200, minImportance: 3 },
    context: { mode: "watermark", windowDays: 5, toolPairs: 40 },
    trim: { excludedMessages: [], excludedTools: [] },
    trigger: "mcp",
  });
});

test("MCP accepts the same nested request shape as Web and stamps its own trigger", () => {
  const request = buildMcpRebuildRequest({ threadId: "thread-2", windowDays: 3, toolPairs: 30 }, {
    summary: { mode: "default", limit: 999, minImportance: 5 },
    context: { mode: "active_days", windowDays: 7, toolPairs: 12 },
    trim: { excludedMessages: ["m1"], excludedTools: ["t1"] },
    trigger: "web",
  });
  assert.deepEqual(request, {
    threadId: "thread-2",
    summary: { mode: "default", limit: 0, minImportance: 0 },
    context: { mode: "active_days", windowDays: 7, toolPairs: 12 },
    trim: { excludedMessages: ["m1"], excludedTools: ["t1"] },
    trigger: "mcp",
  });
});

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

test("MCP rebuild queue uses the same CLI arguments and explicitly queues", () => {
  const args = buildMcpRebuildQueueArgs("/project/bin/stmem", {
    threadId: "thread-1",
    windowDays: 5,
    toolPairs: 40,
  }, { summaryLimit: 200, minImportance: 3, watermark: true });
  assert.equal(args.includes("--apply"), false);
  assert.equal(args.at(-1), "--queue");
});

test("MCP execution routes Codex to apply and Claude Code to queue", () => {
  const base = { threadId: "thread-1", windowDays: 5, toolPairs: 40 };
  const codex = buildMcpRebuildExecuteArgs("/project/bin/stmem", { ...base, runtime: "codex" });
  const claude = buildMcpRebuildExecuteArgs("/project/bin/stmem", { ...base, runtime: "claude" });
  assert.equal(codex.at(-1), "--apply");
  assert.equal(codex.includes("--queue"), false);
  assert.equal(claude.at(-1), "--queue");
  assert.equal(claude.includes("--apply"), false);
});
