#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { listScenarios, getScenario, scenarioId } = require("../src/services/scenario-registry");
const { loadConfig, CONFIG_PATH, getThreadDir } = require("../src/config");
const { resolveMiningPrompts } = require("../src/services/prompt-resolver");

function main() {
  const args = process.argv.slice(3);
  const action = args[0] || "list";
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (action === "list") return listScenarios().map(({ directory, ...row }) => row);
  if (action === "inspect") { const { directory, ...row } = getScenario(args[1]); return row; }
  if (action !== "set") throw new Error("用法：stmem scenario list|inspect <id>|set --thread <id> --scenario <id> [--dry-run|--apply]");
  const threadId = value("--thread"), config = loadConfig();
  if (!threadId || !Object.hasOwn(config, threadId) || !config[threadId]?.runtime) throw new Error("需要有效的 --thread");
  const scenario = getScenario(value("--scenario"));
  const entry = { ...config[threadId], scenario: scenario.id };
  resolveMiningPrompts(entry, { memoryDir: path.join(getThreadDir(threadId), "memory") });
  const result = { threadId, previous: scenarioId(config[threadId]), scenario: scenario.id,
    directory: getThreadDir(threadId), historicalMemoriesChanged: false, applied: false };
  if (args.includes("--apply") && args.includes("--dry-run")) throw new Error("--apply 与 --dry-run 不能同时使用");
  if (args.includes("--apply")) {
    config[threadId] = entry;
    const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, CONFIG_PATH);
    result.applied = true;
  }
  return result;
}
try { console.log(JSON.stringify(main(), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
