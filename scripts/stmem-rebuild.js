#!/usr/bin/env node
/**
 * stmem rebuild — 按 runtime 分流到对应 rebuild 脚本
 */
const { spawnSync } = require("child_process");
const path = require("path");
const os = require("os");

function main() {
  const args = process.argv.slice(3);
  const {
    enqueueRebuild,
    readQueue,
    removeQueuedRebuild,
    buildQueuedApplyArgs,
  } = require("../src/services/rebuild-queue");
  if (args.includes("--run-pending")) {
    const cli = path.join(path.dirname(__dirname), "bin", "stmem");
    const rows = readQueue();
    if (!rows.length) {
      console.log("[stmem] no pending rebuilds");
      return;
    }
    let failed = false;
    for (const row of rows) {
      const result = spawnSync(process.execPath, [cli, ...buildQueuedApplyArgs(row)], {
        stdio: "inherit",
        cwd: path.dirname(__dirname),
      });
      if (result.status === 0) removeQueuedRebuild(row.threadId);
      else failed = true;
    }
    if (failed) process.exit(1);
    return;
  }
  const apply = args.includes("--apply");
  const threadId = args.find((a, i) => a === "--thread" && i + 1 < args.length)
    ? args[args.indexOf("--thread") + 1] : null;
  const windowIdx = args.indexOf("--window");
  const toolPairsIdx = args.indexOf("--tool-pairs");
  const planIdx = args.indexOf("--plan");
  const triggerIdx = args.indexOf("--trigger");
  const summaryLimitIdx = args.indexOf("--summary-limit");
  const minImportanceIdx = args.indexOf("--min-importance");
  const watermark = args.includes("--watermark");

  const { getCfg } = require("../src/config");
  if (!threadId) {
    console.log("请指定 --thread <id>");
    process.exit(1);
  }
  if (args.includes("--queue")) {
    const request = enqueueRebuild({
      threadId,
      window: windowIdx >= 0 ? args[windowIdx + 1] : getCfg("windowDays", threadId, 3),
      toolPairs: toolPairsIdx >= 0 ? args[toolPairsIdx + 1] : getCfg("keepToolPairs", threadId, 30),
      summaryLimit: summaryLimitIdx >= 0 ? args[summaryLimitIdx + 1] : 0,
      minImportance: minImportanceIdx >= 0 ? args[minImportanceIdx + 1] : 0,
      watermark,
    });
    console.log(JSON.stringify({ queued: true, ...request }, null, 2));
    return;
  }
  if (args.includes("--check") || args.includes("--repair")) {
    const { checkThreadIntegrity, repairThreadIntegrity } = require("../src/services/rebuild-workbench");
    const result = args.includes("--repair") ? repairThreadIntegrity(threadId) : checkThreadIntegrity(threadId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const runtime = getCfg("runtime", threadId, "claude");
  const window = windowIdx >= 0 ? args[windowIdx + 1] : getCfg("windowDays", threadId, 3);
  const toolPairs = toolPairsIdx >= 0 ? args[toolPairsIdx + 1] : "";
  const plan = planIdx >= 0 ? args[planIdx + 1] : "";

  if (apply && plan) {
    const fs = require("fs");
    const { permanentlyTrimThread } = require("../src/services/rebuild-workbench");
    const trimPlan = JSON.parse(fs.readFileSync(plan, "utf8"));
    const trimmed = permanentlyTrimThread(threadId, trimPlan);
    console.log(`[stmem] permanent trim: messages=${trimmed.removedMessages}, tools=${trimmed.removedTools}, archive=${trimmed.archiveMessages}, full=${trimmed.fullRecords}`);
  }

  const script = path.join(__dirname, runtime === "codex" ? "rebuild-codex-thread.js" : "rebuild-thread.js");
  const spawnArgs = [script, "--thread", threadId];
  if (apply) spawnArgs.push("--apply");
  if (window) { spawnArgs.push("--window"); spawnArgs.push(String(window)); }
  if (toolPairs) { spawnArgs.push("--tool-pairs"); spawnArgs.push(String(toolPairs)); }
  if (plan) { spawnArgs.push("--plan"); spawnArgs.push(String(plan)); }
  if (watermark) spawnArgs.push("--watermark");
  if (summaryLimitIdx >= 0 && args[summaryLimitIdx + 1] !== undefined) spawnArgs.push("--summary-limit", args[summaryLimitIdx + 1]);
  if (minImportanceIdx >= 0 && args[minImportanceIdx + 1] !== undefined) spawnArgs.push("--min-importance", args[minImportanceIdx + 1]);
  if (triggerIdx >= 0 && args[triggerIdx + 1]) { spawnArgs.push("--trigger"); spawnArgs.push(args[triggerIdx + 1]); }

  console.log(`[stmem] ${runtime} rebuild ${threadId}, window=${window}${toolPairs ? `, pairs=${toolPairs}` : ""}${watermark ? ", watermark" : ""}...`);
  const result = spawnSync(process.execPath, spawnArgs, { stdio: "inherit", cwd: path.dirname(__dirname) });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  process.exit(result.status);
}

main();
