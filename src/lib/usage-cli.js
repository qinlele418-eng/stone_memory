// stmem usage 子命令实现 — Pando 当前窗口 identity/usage 遥测读写面（TASK-0422）。
// bin/stmem 的 `case "usage"` 直接 require 本模块（scripts/ 目录不在本卡 allowed_files 内）。
// report 是遥测唯一写入口（Pando 宿主只经此上报）；show 是只读 JSON 面。
// 遥测是运维观测数据，不进记忆内容面（archive/feelings/full），无线程文件语义。

const { resolveMemoryArg } = require("./memory-cli");
const { KINDS, MAX_SESSIONS_PER_SOURCE, reportUsage, usageTelemetrySummary } = require("../services/usage-telemetry");

function value(args, key) {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : null;
}

function hasFlag(args, key) {
  return args.includes(key);
}

function usage() {
  return `用法：
  stmem usage report --memory <id> --source pando --session <id> [--kind search|ingest|other] [--at <ISO时间>]
  stmem usage show --memory <id> [--source pando]

说明：
  report      记录一条 usage 遥测（唯一写入口）。--kind 缺省 other；--at 缺省当前时间（存 UTC，
              展示按记忆体时区口径）。同 (session, kind, at) 重复上报幂等，不重复计数。
  show        只读输出遥测 JSON；文件缺失/损坏时 available:false（reason: missing|corrupt），不抛错。
  遥测存储于记忆体 logs/usage-telemetry.json，按 source 分桶；每 source 只保留最近
  ${MAX_SESSIONS_PER_SOURCE} 个 session 桶，单文件有界。遥测不写入 archive/feelings/full，也不写线程文件。`;
}

function runUsageCommand(args = process.argv.slice(3)) {
  const action = args[0];
  if (["help", "--help", "-h"].includes(action)) return console.log(usage());
  if (action === "report") {
    if (hasFlag(args, "--kind") && !KINDS.includes(value(args, "--kind"))) {
      throw new Error(`--kind 非法："${value(args, "--kind")}"（可选 ${KINDS.join("|")}）`);
    }
    if (value(args, "--session") !== null && !String(value(args, "--session")).trim()) {
      throw new Error("--session 非法：不能为空白");
    }
    const memoryId = resolveMemoryArg(args);
    const result = reportUsage({
      memoryId,
      source: value(args, "--source"),
      session: value(args, "--session"),
      kind: value(args, "--kind") || "other",
      at: value(args, "--at"),
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return result;
  }
  if (action === "show") {
    const memoryId = resolveMemoryArg(args);
    const rawSource = value(args, "--source");
    const source = rawSource === null ? null : (String(rawSource).trim() || null);
    const result = { memoryId, ...usageTelemetrySummary(memoryId, { source }) };
    if (result.reason === "unknown-memory") throw new Error(`记忆体不存在：${memoryId}（请用 --memory 指定已配置记忆体）`);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  throw new Error(usage());
}

module.exports = { runUsageCommand, usage };
