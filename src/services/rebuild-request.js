function normalizeIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => String(item || "").trim()).filter(Boolean))];
}

function normalizeRebuildRequest(input = {}, defaults = {}) {
  const summaryInput = input.summary || {};
  const contextInput = input.context || {};
  const trimInput = input.trim || {};
  const legacyLimit = Math.max(0, Number(input.summaryLimit) || 0);
  const legacyImportance = Math.max(0, Math.min(5, Number(input.minImportance) || 0));
  const summaryMode = summaryInput.mode === "limited"
    ? "limited"
    : summaryInput.mode === "default"
      ? "default"
      : (legacyLimit || legacyImportance ? "limited" : "default");
  const contextMode = contextInput.mode === "watermark" || input.watermark === true
    ? "watermark" : "active_days";

  return {
    summary: {
      mode: summaryMode,
      limit: summaryMode === "limited"
        ? Math.max(0, Number(summaryInput.limit ?? input.summaryLimit) || 0) : 0,
      minImportance: summaryMode === "limited"
        ? Math.max(0, Math.min(5, Number(summaryInput.minImportance ?? input.minImportance) || 0)) : 0,
    },
    context: {
      mode: contextMode,
      windowDays: Math.max(1, Number(contextInput.windowDays ?? input.window ?? input.windowDays ?? defaults.windowDays) || 3),
      toolPairs: Math.max(0, Number(contextInput.toolPairs ?? input.toolPairs ?? defaults.toolPairs) || 0),
    },
    trim: {
      excludedMessages: normalizeIds(trimInput.excludedMessages ?? input.excludedMessages),
      excludedTools: normalizeIds(trimInput.excludedTools ?? input.excludedTools),
    },
    bindingId: String(input.bindingId ?? "").trim() || null,
    trigger: ["cli", "web", "mcp"].includes(String(input.trigger || ""))
      ? String(input.trigger) : String(defaults.trigger || "cli"),
  };
}

function rebuildRequestCliArgs(request) {
  const row = normalizeRebuildRequest(request);
  const args = [
    "--window", String(row.context.windowDays),
    "--tool-pairs", String(row.context.toolPairs),
    "--summary-limit", String(row.summary.limit),
    "--min-importance", String(row.summary.minImportance),
    "--trigger", row.trigger,
  ];
  if (row.context.mode === "watermark") args.push("--watermark");
  if (row.bindingId) args.push("--binding", row.bindingId);
  return args;
}

function isUnsafeActiveClaudeApply(runtime, env = process.env) {
  return runtime !== "codex" && Boolean(String(env.CLAUDE_CODE_SESSION_ID || "").trim());
}

module.exports = { normalizeRebuildRequest, rebuildRequestCliArgs, isUnsafeActiveClaudeApply };
