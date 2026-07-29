function buildMcpRebuildPreviewArgs(cli, resolved, args = {}) {
  if (!cli || !resolved?.threadId) throw new Error("thread rebuild preview requires a CLI and thread");
  const result = [
    cli,
    "rebuild",
    "--thread", resolved.threadId,
    "--window", String(args.window || resolved.windowDays || 3),
    "--tool-pairs", String(args.toolPairs ?? resolved.toolPairs ?? 30),
    "--summary-limit", String(Math.max(0, Number(args.summaryLimit) || 0)),
    "--min-importance", String(Math.max(0, Math.min(5, Number(args.minImportance) || 0))),
    "--trigger", "mcp",
  ];
  if (args.watermark === true) result.push("--watermark");
  return result;
}

function buildMcpRebuildQueueArgs(cli, resolved, args = {}) {
  const result = buildMcpRebuildPreviewArgs(cli, resolved, args);
  result.push("--queue");
  return result;
}

module.exports = { buildMcpRebuildPreviewArgs, buildMcpRebuildQueueArgs };
