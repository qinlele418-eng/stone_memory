#!/usr/bin/env node
/**
 * stmem rebuild — 按 runtime 分流到对应 rebuild 脚本
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : null;
}

function readPlan(planFile) {
  if (!planFile) return {};
  return JSON.parse(fs.readFileSync(planFile, "utf8"));
}

function requestFromArgs(args, threadId, getCfg) {
  const plan = readPlan(valueAfter(args, "--plan"));
  const { normalizeRebuildRequest } = require("../src/services/rebuild-request");
  return { threadId, ...normalizeRebuildRequest({
    threadId,
    window: valueAfter(args, "--window") ?? getCfg("windowDays", threadId, 3),
    toolPairs: valueAfter(args, "--tool-pairs") ?? getCfg("keepToolPairs", threadId, 30),
    summaryLimit: valueAfter(args, "--summary-limit") ?? 0,
    minImportance: valueAfter(args, "--min-importance") ?? 0,
    watermark: args.includes("--watermark"),
    trigger: valueAfter(args, "--trigger") || "cli",
    excludedMessages: plan.excludedMessages || [],
    excludedTools: plan.excludedTools || [],
  }, { trigger: "cli" }) };
}

function runRuntimeRebuild({ threadId, summary, context, trim, trigger, planFile = "", apply = false }) {
  const { getCfg } = require("../src/config");
  if (apply && planFile) {
    const { permanentlyTrimThread } = require("../src/services/rebuild-workbench");
    const trimmed = permanentlyTrimThread(threadId, readPlan(planFile));
    console.log(`[stmem] permanent trim: messages=${trimmed.removedMessages}, tools=${trimmed.removedTools}, archive=${trimmed.archiveMessages}, full=${trimmed.fullRecords}`);
  }
  const runtime = getCfg("runtime", threadId, "claude");
  const script = path.join(__dirname, runtime === "codex" ? "rebuild-codex-thread.js" : "rebuild-thread.js");
  const spawnArgs = [script, "--thread", threadId];
  if (apply) spawnArgs.push("--apply");
  if (context.windowDays) spawnArgs.push("--window", String(context.windowDays));
  spawnArgs.push("--tool-pairs", String(context.toolPairs));
  if (planFile) spawnArgs.push("--plan", String(planFile));
  if (context.mode === "watermark") spawnArgs.push("--watermark");
  spawnArgs.push("--summary-limit", String(summary.limit));
  spawnArgs.push("--min-importance", String(summary.minImportance));
  if (trigger) spawnArgs.push("--trigger", String(trigger));
  console.log(`[stmem] ${runtime} rebuild ${threadId}, window=${context.windowDays}, pairs=${context.toolPairs}${context.mode === "watermark" ? ", watermark" : ""}...`);
  const result = spawnSync(process.execPath, spawnArgs, { stdio: "inherit", cwd: path.dirname(__dirname) });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

function runQueuedRequest(row) {
  let planDir = null;
  try {
    let planFile = "";
    if (row.trim.excludedMessages.length || row.trim.excludedTools.length) {
      planDir = fs.mkdtempSync(path.join(os.tmpdir(), "stmem-rebuild-queued-"));
      planFile = path.join(planDir, "plan.json");
      fs.writeFileSync(planFile, JSON.stringify({
        excludedMessages: row.trim.excludedMessages,
        excludedTools: row.trim.excludedTools,
      }), { encoding: "utf8", mode: 0o600 });
    }
    return runRuntimeRebuild({ ...row, planFile, apply: true });
  } finally {
    if (planDir) fs.rmSync(planDir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(3);
  const {
    enqueueRebuild,
    readQueue,
    removeQueuedRebuild,
    claimQueuedRebuilds,
    finishQueuedRebuildClaim,
  } = require("../src/services/rebuild-queue");
  if (args.includes("--run-pending")) {
    // bin/stmem 通过 require 进入本脚本时，进程命令行仍显示 bin/stmem；
    // 使用真实入口文件名识别锁持有者，避免长时间 rebuild 被误判为陈旧锁。
    const claim = claimQueuedRebuilds(undefined, { marker: path.basename(process.argv[1] || "stmem") });
    if (!claim.acquired) {
      console.log("[stmem] pending rebuild consumer already running; skipped");
      return;
    }
    try {
      if (!claim.rows.length) {
        console.log("[stmem] no pending rebuilds");
        return;
      }
      let failed = false;
      for (const row of claim.rows) {
        const status = runQueuedRequest(row);
        if (status === 0) removeQueuedRebuild(row.threadId, claim.processingFile, row);
        else failed = true;
      }
      if (failed) process.exitCode = 1;
    } finally {
      finishQueuedRebuildClaim(claim);
    }
    return;
  }
  const apply = args.includes("--apply");
  const threadId = args.find((a, i) => a === "--thread" && i + 1 < args.length)
    ? args[args.indexOf("--thread") + 1] : null;
  const { getCfg } = require("../src/config");
  if (!threadId) {
    console.log("请指定 --thread <id>");
    process.exit(1);
  }
  if (args.includes("--queue")) {
    const request = enqueueRebuild(requestFromArgs(args, threadId, getCfg));
    console.log(JSON.stringify({ queued: true, ...request }, null, 2));
    return;
  }
  if (args.includes("--check") || args.includes("--repair")) {
    const { checkThreadIntegrity, repairThreadIntegrity } = require("../src/services/rebuild-workbench");
    const result = args.includes("--repair") ? repairThreadIntegrity(threadId) : checkThreadIntegrity(threadId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const request = requestFromArgs(args, threadId, getCfg);
  if (apply) {
    // 立即应用也先替换为当前线程的最新请求，再只消费这一个 requestId。
    // 这样成功后不会遗留旧队列；失败也不会把即时操作变成未来的静默重试。
    const queued = enqueueRebuild(request);
    const status = runQueuedRequest(queued);
    removeQueuedRebuild(queued.threadId, undefined, queued);
    process.exit(status);
  }
  const status = runRuntimeRebuild({ ...request, planFile: valueAfter(args, "--plan"), apply: false });
  process.exit(status);
}

main();
