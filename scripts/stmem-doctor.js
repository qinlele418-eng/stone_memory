#!/usr/bin/env node
const { listThreadIds } = require("../src/config");
const { diagnoseThread } = require("../src/services/system-doctor");

const args = process.argv.slice(2);
const threadIndex = args.indexOf("--thread");
const threadId = threadIndex >= 0 ? args[threadIndex + 1] : listThreadIds()[0];
const result = diagnoseThread(threadId);

if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Stone Memory Doctor

状态：${result.ok ? "可用" : "异常"}（${result.code}）
原因：${result.reason}
下一步：${result.nextCommand}
需要修改源码：否`);
  if (result.warnings?.length) {
    console.log("\n提醒：");
    for (const warning of result.warnings) console.log(`- ${warning.code}: ${warning.reason}；建议 ${warning.nextCommand}`);
  }
  if (!result.ok) console.log("\n禁止直接编辑 stmem.json、另造脚本、修改源码或绕过 dry-run。");
}

if (!result.ok) process.exitCode = 1;
