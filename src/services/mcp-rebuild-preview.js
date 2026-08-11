const { normalizeRebuildRequest, rebuildRequestCliArgs } = require("./rebuild-request");

function buildMcpRebuildRequest(resolved, args = {}) {
  if (!resolved?.threadId) throw new Error("thread rebuild request requires a thread");
  const structured = args.summary || args.context || args.trim;
  return {
    threadId: resolved.threadId,
    ...normalizeRebuildRequest(structured ? {
      summary: args.summary,
      context: args.context,
      trim: args.trim,
      trigger: "mcp",
    } : {
      summary: {
        mode: (Number(args.summaryLimit) || Number(args.minImportance)) ? "limited" : "default",
        limit: args.summaryLimit,
        minImportance: args.minImportance,
      },
      context: {
        mode: args.watermark === true ? "watermark" : "active_days",
        windowDays: args.window ?? resolved.windowDays,
        toolPairs: args.toolPairs ?? resolved.toolPairs,
      },
      trim: { excludedMessages: [], excludedTools: [] },
      trigger: "mcp",
    }, { windowDays: resolved.windowDays || 3, toolPairs: resolved.toolPairs ?? 30, trigger: "mcp" }),
  };
}

function buildMcpRebuildPreviewArgs(cli, resolved, args = {}) {
  if (!cli || !resolved?.threadId) throw new Error("thread rebuild preview requires a CLI and thread");
  const request = buildMcpRebuildRequest(resolved, args);
  const result = [
    cli,
    "rebuild",
    "--thread", resolved.threadId,
    ...rebuildRequestCliArgs(request),
  ];
  return result;
}

function buildMcpRebuildQueueArgs(cli, resolved, args = {}) {
  const result = buildMcpRebuildPreviewArgs(cli, resolved, args);
  result.push("--queue");
  return result;
}

function buildMcpRebuildExecuteArgs(cli, resolved, args = {}) {
  const result = buildMcpRebuildPreviewArgs(cli, resolved, args);
  result.push(resolved.runtime === "codex" ? "--apply" : "--queue");
  return result;
}

module.exports = { buildMcpRebuildRequest, buildMcpRebuildPreviewArgs, buildMcpRebuildQueueArgs, buildMcpRebuildExecuteArgs };
